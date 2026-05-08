import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTaskForExecution,
  markActiveTaskStepFailed,
  markTaskFailed,
  markTaskRunning,
  markTaskSucceeded,
  recordModelCall,
  updateTaskStep,
} from "./task-service.mjs";
import {
  assertTaskActive,
  createWorkflowExecutionContext,
  isTaskCanceledError,
  setWorkflowStepPending,
} from "./workflow-step-executor.mjs";
import { XIAOHONGSHU_WORKFLOW_ID } from "./workflow-definitions.mjs";
import {
  runGenerateWritebackStep,
  runContentPlanStep,
  runDraftGenerationStep,
  runPackageWritebackStep,
  runPlanWritebackStep,
  runQualityCheckStep,
  runReceiveTaskStep,
  runRequirementStructuringStep,
  runReviewWritebackStep,
  runResearchAndStrategyStep,
  runSyncPackageIndexStep,
} from "./xiaohongshu-workflow-steps.mjs";
import { selectKnowledgeForWorkflow } from "./knowledge-service.mjs";
import { getIntel } from "./intel-service.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || "", ".openclaw");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const NOTION_CONFIG_PATH = path.join(ROOT, "notion-ai-intel.config.json");
const DEFAULT_WORKFLOW_MODEL_TIMEOUT_MS = Number(process.env.WECHAT_WORKFLOW_MODEL_TIMEOUT_MS || 180000);
const DATA_DIR = process.env.XIAOLONGXIA_DATA_DIR || path.join(ROOT, "data", "runtime");
const LOG_PATH = process.env.XIAOLONGXIA_WORKFLOW_LOG_PATH || path.join(DATA_DIR, "workflow-runner.log");
const WORKFLOW_SKILL_DEFAULTS = {
  requirement: { name: "需求结构化", description: "把输入主题整理成目标人群、内容目标、约束和缺失信息。", enabled: true, profile: "standard", timeoutSeconds: 60, fallbackOnError: true, notes: "", focusOptions: ["优先发现缺失信息", "明确目标人群", "保留业务约束"], selectedFocuses: ["优先发现缺失信息", "明确目标人群"], outputRequirement: "输出主题、人群、内容目标、约束、缺失信息和风险提示。" },
  strategy: { name: "策略判断", description: "判断内容该走经验分享、教程、避坑、案例还是热点解读。", enabled: true, profile: "standard", timeoutSeconds: 60, fallbackOnError: true, notes: "", focusOptions: ["降低营销感", "强化平台适配", "降低 AI 味", "强化收藏价值"], selectedFocuses: ["降低营销感", "强化平台适配"], outputRequirement: "输出内容类型、标题方向、正文结构、图片策略、必须使用和必须避免的点。" },
  plan: { name: "内容方案", description: "把策略变成可执行的正文大纲、场景设计和图片规划。", enabled: true, profile: "standard", timeoutSeconds: 60, fallbackOnError: true, notes: "", focusOptions: ["更重视真实场景", "强化图片可执行性", "强化结构完整性", "减少空泛表达"], selectedFocuses: ["更重视真实场景", "强化图片可执行性"], outputRequirement: "输出内容角度、开头方式、正文大纲、场景设计、图片计划和人工确认项。" },
  deliveryGate: { name: "质量检查", description: "判断发布包是否可交付，是否需要复核，以及必须修改项。", enabled: true, profile: "strict", timeoutSeconds: 60, fallbackOnError: true, notes: "", focusOptions: ["检查硬广风险", "检查图片正文匹配", "检查是否可交付", "优先列出必须修改项"], selectedFocuses: ["检查硬广风险", "检查是否可交付"], outputRequirement: "输出可交付判断、评分、必须修改、可选优化、风险提示和运营备注。" },
};

process.env.XIAOLONGXIA_DATA_DIR = DATA_DIR;

let xiaohongshuWorkflowModule = null;
let aiIntelWorkflowModule = null;

async function loadXiaohongshuWorkflow() {
  xiaohongshuWorkflowModule ||= await import("../../../xiaohongshu-draft-workflow.mjs");
  return xiaohongshuWorkflowModule;
}

async function loadAiIntelWorkflow() {
  aiIntelWorkflowModule ||= await import("../../../notion-ai-intel-workflow.mjs");
  return aiIntelWorkflowModule;
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildDirectApiMode(providerId, provider, model) {
  if (!provider?.baseUrl || !provider?.apiKey) {
    throw new Error(`Provider ${providerId} is missing baseUrl or apiKey`);
  }
  return {
    mode: "direct-api",
    providerId,
    baseUrl: ensureTrailingSlash(String(provider.baseUrl)),
    apiKey: String(provider.apiKey),
    model,
  };
}

function buildOpenClawAgentMode(providerId, model) {
  return {
    mode: "openclaw-agent",
    providerId,
    model,
  };
}

export async function loadWorkflowRuntimeConfig() {
  const notionConfig = await readJson(NOTION_CONFIG_PATH, {});
  const configuredSeconds = Number(notionConfig?.workflow?.model_timeout_seconds);
  const configuredMs = Number.isFinite(configuredSeconds) ? configuredSeconds * 1000 : DEFAULT_WORKFLOW_MODEL_TIMEOUT_MS;
  const skills = {};
  for (const [id, defaults] of Object.entries(WORKFLOW_SKILL_DEFAULTS)) {
    const raw = notionConfig?.workflow?.skills?.[id] || {};
    const timeoutSeconds = Number(raw.timeout_seconds);
    const optional = id === "deliveryGate";
    skills[id] = {
      ...defaults,
      enabled: optional ? raw.enabled !== false : true,
      profile: String(raw.profile || defaults.profile),
      timeoutSeconds: Math.max(30, Math.min(Number.isFinite(timeoutSeconds) ? timeoutSeconds : defaults.timeoutSeconds, 180)),
      fallbackOnError: raw.fallback_on_error !== false,
      notes: String(raw.notes || ""),
      focusOptions: defaults.focusOptions || [],
      selectedFocuses: Array.isArray(raw.selected_focuses) ? raw.selected_focuses : defaults.selectedFocuses || [],
      outputRequirement: String(raw.output_requirement || defaults.outputRequirement || ""),
    };
  }
  return {
    modelTimeoutMs: Math.max(30000, Math.min(configuredMs, 600000)),
    skillProfile: String(notionConfig?.workflow?.skill_profile || "standard"),
    skillNotes: String(notionConfig?.workflow?.skill_notes || ""),
    enableSkillFallback: notionConfig?.workflow?.enable_skill_fallback !== false,
    hermesConfig: notionConfig?.hermes || {},
    humanEditorRules: notionConfig?.human_editor_rules || notionConfig?.humanEditorRules || {},
    skills,
  };
}

export async function loadWorkflowLlm() {
  const bridgeConfig = await readJson(path.join(ROOT, "wechat-bridge.config.json"), {});
  const oc = await readJson(OPENCLAW_CONFIG_PATH, {});
  const configuredModes = bridgeConfig?.modes && typeof bridgeConfig.modes === "object" ? bridgeConfig.modes : {};
  const activeModeName = process.env.WECHAT_BRIDGE_ACTIVE_MODE || bridgeConfig?.active_mode || "gpt-account";
  const activeMode = configuredModes[activeModeName];

  if (activeMode?.type === "provider") {
    const providerId = String(activeMode.provider_id || "").trim();
    const model = String(activeMode.model || "gpt-4o").trim();
    const provider = oc?.models?.providers?.[providerId];
    return { activeModeName, llm: buildDirectApiMode(providerId, provider, model) };
  }

  if (activeMode?.type === "openclaw-agent") {
    const providerId = String(activeMode.provider_id || "openai-codex").trim();
    const model = String(activeMode.model || "gpt-5.4").trim();
    return { activeModeName, llm: buildOpenClawAgentMode(providerId, model) };
  }

  const primaryModel = process.env.WECHAT_BRIDGE_MODEL || oc?.agents?.defaults?.model?.primary || "openai-codex/gpt-5.4";
  const [providerId, modelId] = String(primaryModel).split("/");
  const provider = oc?.models?.providers?.[providerId];
  if (provider?.baseUrl && provider?.apiKey) {
    return { activeModeName: "fallback-provider", llm: buildDirectApiMode(providerId, provider, modelId || "gpt-4o") };
  }
  return {
    activeModeName: "fallback-openclaw-agent",
    llm: buildOpenClawAgentMode(providerId || "openai-codex", modelId || "gpt-5.4"),
  };
}

export async function appendRunnerLog(level, message, detail = {}) {
  const line = `[${new Date().toISOString()}] [${level}] ${message} ${JSON.stringify(detail)}\n`;
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fs.appendFile(LOG_PATH, line, "utf8");
  } catch {
    // Logging should not block local workflow execution.
  }
}

function buildWorkflowInput(task) {
  const inputText = String(task?.inputText || "").trim();
  if (/小红书/u.test(inputText)) return inputText;
  return `请基于下面需求生成一套小红书发布包：\n${inputText}`;
}

function readableListCount(items, unit = "项") {
  return Array.isArray(items) ? `${items.length}${unit}` : `0${unit}`;
}

function compactStepValue(value) {
  if (value === null || value === undefined || value === "") return "无";
  if (typeof value === "string") return value.trim() || "无";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stepBlock(title, value) {
  return `【${title}】\n${compactStepValue(value)}`;
}

function joinStepBlocks(blocks) {
  return blocks.filter(Boolean).join("\n\n");
}

function shortStepSummary(text, fallback, maxLength = 56) {
  const value = String(text || "").trim();
  if (!value) return fallback;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function summarizeRequirementStep(requirement) {
  const topic = shortStepSummary(requirement?.topic || requirement?.summary, "主题已识别", 34);
  const audience = shortStepSummary(requirement?.audience, "人群待确认", 20);
  const missing = readableListCount(requirement?.missing_info, "项");
  return `明确主题：${topic}；目标人群：${audience}；缺失信息：${missing}`;
}

function summarizeStrategyStep(strategy) {
  const type = shortStepSummary(strategy?.type, "内容类型已确认", 24);
  const structure = shortStepSummary(strategy?.structure, "结构方向已确认", 28);
  const risks = readableListCount(strategy?.risk_controls || strategy?.risks, "项");
  return `确定类型：${type}；结构方向：${structure}；风险约束：${risks}`;
}

function summarizePlanStep(contentPlan) {
  const angle = shortStepSummary(contentPlan?.angle, "内容角度已确定", 34);
  const sections = readableListCount(contentPlan?.outline || contentPlan?.sections, "段");
  const images = readableListCount(contentPlan?.image_plan, "张");
  return `确定角度：${angle}；正文结构：${sections}；图片规划：${images}`;
}

function summarizeGenerateStep(draft) {
  const title = shortStepSummary(draft?.title, "标题已生成", 34);
  const paragraphs = String(draft?.post_text || "").split(/\n+/).filter(Boolean).length;
  const tags = readableListCount(draft?.hashtags, "个");
  return `生成标题：${title}；正文段落：${paragraphs || 0}段；话题：${tags}`;
}

function summarizeReviewStep(workflow, businessFlow) {
  const gate = workflow?.qualityGate;
  if (gate) {
    const decision = gate.decision === "blocked" ? "需返工" : gate.decision === "ready" ? "可交付" : "需复核";
    const mustFix = readableListCount(gate.must_fix_items, "项");
    return `交付判断：${decision}；评分：${gate.score ?? "-"}；必须处理：${mustFix}`;
  }
  const review = businessFlow?.qualityReview;
  if (review) return `质检评分：${review.score ?? "-"}；问题：${readableListCount(review.issues, "项")}`;
  return "已完成真实感、AI 味、软广风险和交付质量检查";
}

function summarizeHermesExecution(businessFlow) {
  const mode = businessFlow?.contentBrainMode === "hermes-content-brain" ? "已运行" : "未接管";
  const executor = businessFlow?.hermesBrainExecutor || businessFlow?.hermesBrainProvider || "-";
  const status = businessFlow?.hermesBrainStatus || "-";
  const error = businessFlow?.hermesBrainError ? `；降级原因：${shortStepSummary(businessFlow.hermesBrainError, "未知错误", 120)}` : "";
  return `Hermes Agent：${mode}；执行器：${executor}；状态：${status}${error}`;
}

function summarizeHermesResearchStatus(hermesResearch) {
  if (!hermesResearch) return "Hermes Worker：未启用研究增强";
  const provider = hermesResearch.provider || "本地研究增强";
  if (provider === "hermes-worker" && hermesResearch.status === "completed") {
    return "Hermes Worker 已完成研究增强";
  }
  if (provider === "hermes-worker" && hermesResearch.status === "fallback") {
    return "Hermes Worker 未返回有效结果，已使用本地研究兜底";
  }
  if (hermesResearch.status === "completed") {
    return `${provider} 已完成研究增强`;
  }
  if (hermesResearch.status === "fallback") {
    return `${provider} 不可用，已使用本地研究兜底`;
  }
  if (hermesResearch.status === "disabled") return "研究增强未启用";
  return "研究增强已处理";
}

function summarizeHermesResearchDetail(hermesResearch) {
  if (!hermesResearch) return "";
  return [
    summarizeHermesResearchStatus(hermesResearch),
    hermesResearch.recommended_angle ? `推荐角度：${shortStepSummary(hermesResearch.recommended_angle, "", 90)}` : "",
    hermesResearch.warning ? `提示：${shortStepSummary(hermesResearch.warning, "", 100)}` : "",
  ].filter(Boolean).join("\n");
}

function summarizeContentBrainStep(businessFlow, strategy) {
  if (businessFlow?.contentBrainMode === "hermes-content-brain") {
    return "Hermes Agent 已接管核心内容生成：研究、策略、内容方案、初稿和自检已完成";
  }
  if (businessFlow?.hermesResearch) {
    return [
      summarizeHermesResearchDetail(businessFlow.hermesResearch),
      strategy ? `小龙虾策略判断结果：${summarizeStrategyStep(strategy)}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "Hermes Agent 未接管，本次使用小龙虾稳定多步流程继续执行",
    businessFlow?.hermesBrainError ? `降级原因：${shortStepSummary(businessFlow.hermesBrainError, "未知错误", 140)}` : "",
    strategy ? `小龙虾策略判断结果：${summarizeStrategyStep(strategy)}` : "",
  ].filter(Boolean).join("\n");
}

function updateTaskProgressFromLog(id, message, detail = {}) {
  const step = Number(detail.step);
  const totalSteps = Number(detail.totalSteps);
  const purpose = String(detail.purpose || "");
  const isApiCall = message === "AI API call";
  const isApiCompleted = message === "AI API call completed";

  if (message === "Hermes Worker research started") {
    updateTaskStep(id, "strategy", {
      status: "running",
      inputSummary: `Hermes Worker 正在接收研究增强任务\n地址：${detail.workerUrl || "-"}`,
      outputSummary: "Hermes Worker 正在分析主题、目标人群、内容角度、图片策略和风险边界。",
    });
    return;
  }

  if (message === "Hermes Worker research completed") {
    updateTaskStep(id, "strategy", {
      status: "running",
      inputSummary: "Hermes Worker 已返回研究增强结果，准备交给小龙虾策略判断。",
      outputSummary: "Hermes Worker 已完成研究增强，正在进入小龙虾稳定多步流程。",
    });
    return;
  }

  if (message === "Hermes Worker research failed; using fallback") {
    updateTaskStep(id, "strategy", {
      status: "running",
      inputSummary: `Hermes Worker 不可用，已启用本地研究兜底。\n地址：${detail.workerUrl || "-"}`,
      outputSummary: `Hermes Worker 未返回有效结果，任务继续使用小龙虾稳定流程。原因：${shortStepSummary(detail.error, "未知错误", 120)}`,
    });
    return;
  }

  if (isApiCall && step === 2 && totalSteps === 3) {
    const executor = detail.executor || detail.providerId || detail.mode || "Hermes Agent";
    const target = detail.wslDistro ? `${executor} / ${detail.wslDistro}` : executor;
    updateTaskStep(id, "structure", {
      status: "completed",
      outputSummary: "已完成任务输入整理，交给 Hermes Agent 连续生成核心内容",
    });
    updateTaskStep(id, "strategy", {
      status: "running",
      inputSummary: `执行器：${target}\n命令：${detail.command || "-"}\n用途：${purpose || "一体化内容生成"}`,
      outputSummary: `${purpose || "Hermes Agent 正在完成研究、策略、内容方案、初稿和自检"}\n执行器：${target}`,
    });
    updateTaskStep(id, "plan", {
      status: "pending",
      outputSummary: "等待 Hermes Agent 输出内容方案",
    });
    updateTaskStep(id, "generate", {
      status: "pending",
      outputSummary: "等待 Hermes Agent 输出发布包内容",
    });
    return;
  }

  if (isApiCompleted && step === 2 && totalSteps === 3) {
    const executor = detail.executor || detail.providerId || detail.mode || "Hermes Agent";
    const target = detail.wslDistro ? `${executor} / ${detail.wslDistro}` : executor;
    updateTaskStep(id, "strategy", {
      status: "completed",
      outputSummary: `Hermes Agent 已完成研究、策略判断、内容方案、初稿生成和自检\n执行器：${target}`,
    });
    updateTaskStep(id, "plan", {
      status: "completed",
      outputSummary: "内容方案已从 Hermes Agent 结果中沉淀",
    });
    updateTaskStep(id, "generate", {
      status: "completed",
      outputSummary: "发布包内容已由 Hermes Agent 生成",
    });
    updateTaskStep(id, "review", {
      status: "running",
      outputSummary: "正在做小龙虾质量检查",
    });
    return;
  }

  if (message === "Hermes Agent fallback") {
    updateTaskStep(id, "strategy", {
      status: "completed",
      inputSummary: `执行器：${detail.executor || "-"}\n失败后降级：${detail.fallback || "stable-multi-step"}`,
      outputSummary: `Hermes Agent 未完成，本次已降级到小龙虾稳定多步流程。原因：${shortStepSummary(detail.error, "未知错误", 140)}`,
    });
    updateTaskStep(id, "plan", {
      status: "running",
      outputSummary: "正在使用小龙虾稳定多步流程继续生成内容",
    });
    return;
  }

  if (isApiCompleted && step === 2 && totalSteps === 7) {
    updateTaskStep(id, "structure", {
      status: "completed",
      outputSummary: "已提取主题、人群、内容目标、约束和缺失信息",
    });
    updateTaskStep(id, "strategy", {
      status: "running",
      outputSummary: "正在判断内容类型、表达边界和发布策略",
    });
    return;
  }

  if (isApiCall && step === 3 && totalSteps === 7) {
    updateTaskStep(id, "strategy", {
      status: "running",
      outputSummary: "正在判断内容类型、表达边界和发布策略",
    });
    return;
  }

  if (isApiCompleted && step === 3 && totalSteps === 7) {
    updateTaskStep(id, "strategy", {
      status: "completed",
      outputSummary: "已确认内容类型、结构方向、图片策略和风险边界",
    });
    updateTaskStep(id, "plan", {
      status: "running",
      outputSummary: "正在设计正文结构、真实场景、图片规划和人工确认项",
    });
    return;
  }

  if (isApiCall && step === 4 && totalSteps === 7) {
    updateTaskStep(id, "plan", {
      status: "running",
      outputSummary: "正在设计正文结构、真实场景、图片规划和人工确认项",
    });
    return;
  }

  if (isApiCompleted && step === 4 && totalSteps === 7) {
    updateTaskStep(id, "plan", {
      status: "completed",
      outputSummary: "已完成正文方案、场景设计、图片计划和人工确认项",
    });
    updateTaskStep(id, "generate", {
      status: "running",
      outputSummary: "正在生成标题、正文、话题、配图提示词和发布检查项",
    });
    return;
  }

  if (isApiCall && step === 4 && totalSteps === 6) {
    updateTaskStep(id, "generate", {
      status: "running",
      outputSummary: "正在生成标题、正文、话题、配图提示词和发布检查项",
    });
    return;
  }

  if (isApiCompleted && step === 4 && totalSteps === 6) {
    updateTaskStep(id, "generate", {
      status: "completed",
      outputSummary: "已生成发布包正文、话题和配图提示词",
    });
    updateTaskStep(id, "review", {
      status: "running",
      outputSummary: "正在检查真实感、AI 味、软广风险和交付质量",
    });
    return;
  }

  if (isApiCall && (step === 5 || step === 6) && totalSteps === 6) {
    updateTaskStep(id, "generate", {
      status: "completed",
      outputSummary: "已生成发布包正文、话题和配图提示词",
    });
    updateTaskStep(id, "review", {
      status: "running",
      outputSummary: "正在检查真实感、AI 味、软广风险和交付质量",
    });
    return;
  }

  if (isApiCompleted && step === 6 && totalSteps === 7) {
    updateTaskStep(id, "generate", {
      status: "completed",
      outputSummary: "已生成发布包正文、话题和配图提示词",
    });
    updateTaskStep(id, "review", {
      status: "completed",
      outputSummary: "已完成发布包质量检查",
    });
    updateTaskStep(id, "package", {
      status: "running",
      outputSummary: "正在生成图片素材并保存发布包",
    });
    return;
  }

  if (message === "AI image call") {
    const imageKind = detail.imageKind === "cover" ? "封面图" : "正文图";
    updateTaskStep(id, "review", {
      status: "completed",
      outputSummary: "已完成发布包质量检查",
    });
    updateTaskStep(id, "package", {
      status: "running",
      outputSummary: `正在生成${imageKind}素材`,
    });
    return;
  }

  if (message === "Xiaohongshu publish package completed") {
    updateTaskStep(id, "package", {
      status: "completed",
      outputSummary: `发布包已保存，图片 ${detail.imageFileCount ?? 0} 张`,
    });
    updateTaskStep(id, "sync", {
      status: "running",
      outputSummary: "正在同步发布包索引",
    });
  }
}

function stepKeyFromModelCall(detail = {}) {
  const step = Number(detail.step);
  const totalSteps = Number(detail.totalSteps);
  if (totalSteps === 7) {
    if (step === 1) return "research";
    if (step === 2) return "structure";
    if (step === 3) return "strategy";
    if (step === 4) return "plan";
    if (step === 5 || step === 6) return "review";
    if (step >= 7) return "package";
  }
  if (totalSteps === 6) {
    if (step === 1) return "strategy";
    if (step === 2 || step === 3) return "strategy";
    if (step === 4) return "generate";
    if (step === 5 || step === 6) return "review";
  }
  if (totalSteps === 3) {
    if (step === 1) return "structure";
    if (step === 2) return "strategy";
    if (step === 3) return "review";
  }
  return "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function intelItemToWorkflowMaterial(item) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.title || "",
    summary: item.summary || item.evaluationReason || item.usage || "",
    usage: item.usage || item.evaluationReason || "",
    link: item.sourceUrl || item.url || "",
    url: item.sourceUrl || item.url || "",
    sourceUrl: item.sourceUrl || item.url || "",
    source: item.source || "情报库",
    category: item.category || "情报",
    tags: item.tags || [],
    fitFor: item.fitFor || [],
    publishedAt: item.publishedAt || "",
    provider: "direct-intel",
  };
}

function skippedOpportunityScore(items = []) {
  return {
    status: "skipped",
    provider: "lightweight-material-selection",
    reason: "任务已经进入小红书内容生成流程，跳过模型机会评分，直接沿用当前素材进入策略判断。",
    scored_items: items.map((item, index) => ({
      index,
      title: item?.title || "",
      total_score: 100,
      reason: "已作为当前任务素材使用。",
    })),
    recommended_indexes: items.map((_, index) => index).slice(0, 3),
  };
}

function recordModelUsageFromLog(runId, detail = {}) {
  const usage = detail.modelUsage;
  if (!usage || typeof usage !== "object") return;
  try {
    recordModelCall({
      runId,
      stepKey: stepKeyFromModelCall(detail),
      callType: "text",
      provider: usage.provider || detail.providerId || detail.mode || "",
      model: usage.model || detail.model || "",
      purpose: usage.purpose || detail.purpose || "",
      status: usage.status || "succeeded",
      durationMs: usage.durationMs ?? detail.durationMs,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      error: usage.error || "",
    });
  } catch (error) {
    void appendRunnerLog("WARN", "Failed to record model usage", {
      workflowRunId: runId,
      source: "local-api",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordFailedModelUsageFromLog(runId, detail = {}) {
  if (detail?.modelUsage) {
    recordModelUsageFromLog(runId, detail);
    return;
  }
  try {
    recordModelCall({
      runId,
      stepKey: stepKeyFromModelCall(detail),
      callType: "text",
      provider: detail.providerId || detail.mode || "",
      model: detail.model || "",
      purpose: detail.purpose || "模型调用",
      status: "failed",
      durationMs: detail.durationMs,
      promptTokens: 0,
      completionTokens: 0,
      error: detail.error || "",
    });
  } catch (error) {
    void appendRunnerLog("WARN", "Failed to record failed model usage", {
      workflowRunId: runId,
      source: "local-api",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordImageUsageFromLog(runId, detail = {}) {
  const usage = detail.imageUsage || detail.modelUsage || {};
  try {
    recordModelCall({
      runId,
      stepKey: "package",
      callType: "image",
      provider: detail.providerId || detail.mode || "image-generation",
      model: detail.model || "",
      purpose: detail.purpose || "生图调用",
      status: detail.error ? "failed" : "succeeded",
      durationMs: detail.durationMs,
      promptTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0,
      completionTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0,
      error: detail.error || "",
    });
  } catch (error) {
    void appendRunnerLog("WARN", "Failed to record image usage", {
      workflowRunId: runId,
      source: "local-api",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function executeXiaohongshuWorkflowRun(id) {
  const task = getTaskForExecution(id);
  if (!task || task.status === "succeeded" || task.status === "running") return;
  if (task.workflowId !== XIAOHONGSHU_WORKFLOW_ID) {
    markTaskFailed(id, `Unsupported workflow: ${task.workflowId}`);
    return;
  }
  if (!markTaskRunning(id)) return;

  const startedAt = Date.now();
  const { activeModeName, llm } = await loadWorkflowLlm();
  const runtimeConfig = await loadWorkflowRuntimeConfig();
  const logger = (level, message, detail = {}) => {
    if (message === "AI API call completed" && detail?.modelUsage) recordModelUsageFromLog(id, detail);
    if (message === "AI API call failed") recordFailedModelUsageFromLog(id, detail);
    if (message === "AI image call completed") recordImageUsageFromLog(id, detail);
    updateTaskProgressFromLog(id, message, detail);
    void appendRunnerLog(level, message, {
      workflowRunId: id,
      source: "local-api",
      activeModeName,
      ...detail,
    });
  };
  const context = createWorkflowExecutionContext({
    runId: id,
    task,
    llm,
    runtimeConfig,
    logger,
  });
  try {
    await runReceiveTaskStep(context);
    const workflowInput = buildWorkflowInput(task);
    const {
      buildIntelRequestV2,
      inferTopicLabelV2,
      maybeRunHermesResearch,
      maybeRunXiaohongshuDraftWorkflow,
      runContentPlanSkill,
      runContentStrategySkill,
      runDraftGenerationSkill,
      runQualityCheckSkill,
      runRequirementStructuringSkill,
    } = await loadXiaohongshuWorkflow();
    const { maybeRunAiIntelWorkflow } = await loadAiIntelWorkflow();
    const topicLabel = inferTopicLabelV2(workflowInput) || shortStepSummary(task.inputText, "小红书内容任务", 40);
    const precomputedRequirement = await runRequirementStructuringStep(context, {
      workflowInput,
      topicLabel,
      skillRunner: runRequirementStructuringSkill,
    });
    const directIntelItem = task.entryType === "intel" && task.entryMessageId
      ? intelItemToWorkflowMaterial(getIntel(task.entryMessageId))
      : null;
    const intelResult = directIntelItem
      ? {
          handled: true,
          skipped: true,
          debug: { items: [directIntelItem] },
          reason: "direct-intel-task",
        }
      : await maybeRunAiIntelWorkflow({
          baseDir: ROOT,
          llm,
          userText: buildIntelRequestV2(workflowInput),
          logger,
          modelTimeoutMs: runtimeConfig.modelTimeoutMs,
          force: true,
          aiCallMeta: {
            workflow: "小红书发布包",
            step: 1,
            totalSteps: 6,
            purpose: "情报素材筛选：先找和选题相关的可用素材",
          },
        });
    const intelItems = directIntelItem ? [directIntelItem] : Array.isArray(intelResult?.debug?.items) ? intelResult.debug.items : [];
    const knowledgeItems = selectKnowledgeForWorkflow({
      userText: workflowInput,
      topicLabel,
      limit: 5,
    });
    const strategyMaterials = [...knowledgeItems, ...intelItems];
    setWorkflowStepPending(id, "strategy", {
      outputSummary: "等待需求结构化完成",
    });
    setWorkflowStepPending(id, "plan", {
      outputSummary: "等待策略判断完成",
    });
    setWorkflowStepPending(id, "generate", {
      outputSummary: `等待调用 ${llm.model} 生成发布包`,
    });
    const precomputedStrategy = await runResearchAndStrategyStep(context, {
      workflowInput,
      topicLabel,
      requirementResult: precomputedRequirement,
      intelItems: strategyMaterials,
      hermesConfig: runtimeConfig.hermesConfig,
      researchRunner: maybeRunHermesResearch,
      opportunityScorer: async ({ intelItems }) => skippedOpportunityScore(intelItems),
      intelSelector: (items) => asArray(items).slice(0, 3),
      strategyRunner: runContentStrategySkill,
      directIntelMode: Boolean(directIntelItem),
    });
    const precomputedContentPlan = await runContentPlanStep(context, {
      workflowInput,
      topicLabel,
      requirementResult: precomputedRequirement,
      strategyResult: precomputedStrategy.strategyResult,
      intelItems: [...knowledgeItems, ...asArray(precomputedStrategy.selectedIntelItems)],
      hermesResearch: precomputedStrategy.hermesResearch,
      skillRunner: runContentPlanSkill,
    });
    const precomputedDraft = await runDraftGenerationStep(context, {
      workflowInput,
      topicLabel,
      requirementResult: precomputedRequirement,
      strategyResult: precomputedStrategy.strategyResult,
      contentPlanResult: precomputedContentPlan,
      intelItems: [...knowledgeItems, ...asArray(precomputedStrategy.selectedIntelItems)],
      hermesResearch: precomputedStrategy.hermesResearch,
      skillRunner: runDraftGenerationSkill,
    });
    const precomputedQualityCheck = await runQualityCheckStep(context, {
      workflowInput,
      topicLabel,
      requirementResult: precomputedRequirement,
      strategyResult: precomputedStrategy.strategyResult,
      contentPlanResult: precomputedContentPlan,
      draftResult: precomputedDraft.draft,
      selectedIntelItems: asArray(precomputedStrategy.selectedIntelItems),
      opportunityScore: precomputedStrategy.opportunityScore,
      repairResult: precomputedDraft.repairResult,
      humanEditorRules: runtimeConfig.humanEditorRules,
      skillRunner: runQualityCheckSkill,
    });

    logger("INFO", "Workflow task started", {
      workflowId: task.workflowId,
      model: llm.model,
      llmMode: llm.mode,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      skillProfile: runtimeConfig.skillProfile,
    });

    const result = await maybeRunXiaohongshuDraftWorkflow({
      baseDir: ROOT,
      llm,
      userText: workflowInput,
      logger,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      workflowRuntimeConfig: {
        ...runtimeConfig,
        precomputed: {
          ...(runtimeConfig.precomputed || {}),
          requirement: precomputedRequirement,
          topicLabel,
          intelResult,
          intelItems,
          knowledgeItems,
          hermesResearch: precomputedStrategy.hermesResearch,
          opportunityScore: precomputedStrategy.opportunityScore,
          selectedIntelItems: asArray(precomputedStrategy.selectedIntelItems),
          strategy: precomputedStrategy.strategyResult,
          contentPlan: precomputedContentPlan,
          draft: precomputedDraft.draft,
          repairResult: precomputedDraft.repairResult,
          qualityCheck: precomputedQualityCheck,
        },
      },
    });

    assertTaskActive(id);

    if (!result?.handled) {
      throw new Error("小红书发布包流程未命中，请检查任务需求是否足够明确。");
    }

    const workflowDebug = result.debug?.workflow || {};
    const businessFlow = result.debug?.businessFlow || {};
    const requirementResult = workflowDebug.requirement || businessFlow.requirementSkill || null;
    const strategyResult = workflowDebug.strategy || businessFlow.strategySkill || null;
    const contentPlanResult = precomputedContentPlan || workflowDebug.contentPlan || businessFlow.contentPlanSkill || null;
    const draftResult = precomputedQualityCheck.draft || precomputedDraft.draft || result.debug?.draft || null;
    const qualityResult = {
      humanEditorReview: precomputedQualityCheck.humanEditorReview || businessFlow.humanEditorReview || null,
      qualityReview: precomputedQualityCheck.qualityReview || businessFlow.qualityReview || null,
      deliveryGate: precomputedQualityCheck.deliveryGate || workflowDebug.qualityGate || businessFlow.deliveryGateSkill || null,
      ruleValidation: precomputedQualityCheck.repairResult || businessFlow.ruleValidation || null,
    };
    const packageResult = {
      saved: result.debug?.saved || null,
      imageResult: result.debug?.imageResult || null,
      notion: result.debug?.notion || null,
    };

    const knowledgeContext = [
      ...knowledgeItems,
      ...asArray(workflowDebug.knowledgeContext),
      ...asArray(precomputedStrategy.selectedIntelItems),
      ...asArray(businessFlow.selectedSourceIndexes),
    ];
    await runPlanWritebackStep(context, {
      strategyResult,
      knowledgeContext,
      contentPlanResult,
    });
    await runGenerateWritebackStep(context, {
      requirementResult,
      strategyResult,
      contentPlanResult,
      draftResult,
    });
    await runReviewWritebackStep(context, {
      draftResult,
      qualityResult,
    });
    await runPackageWritebackStep(context, {
      draftResult,
      qualityResult,
      packageResult,
    });
    const { packageId } = await runSyncPackageIndexStep(context, result.debug?.saved || null);
    context.assertActive();
    markTaskSucceeded(id, {
      packageId,
      outputSummary: joinStepBlocks([
        stepBlock("本地索引结果", {
          packageId,
          packageDir: result.debug?.saved?.packageDir || "",
          jsonPath: result.debug?.saved?.jsonPath || "",
          mdPath: result.debug?.saved?.mdPath || "",
          status: "synced",
        }),
      ]),
    });

    logger("INFO", "Workflow task completed", {
      durationMs: Date.now() - startedAt,
      packageId,
      packageDir: result.debug?.saved?.packageDir || null,
      title: result.debug?.draft?.title || null,
    });
  } catch (error) {
    if (isTaskCanceledError(error) || getTaskForExecution(id)?.status === "canceled") {
      logger("INFO", "Workflow task canceled; skip failure mark", {
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    markActiveTaskStepFailed(id, message);
    markTaskFailed(id, message);
    logger("ERROR", "Workflow task failed", {
      durationMs: Date.now() - startedAt,
      error: message,
    });
  }
}
