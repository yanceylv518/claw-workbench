import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maybeRunXiaohongshuDraftWorkflow } from "./xiaohongshu-draft-workflow.mjs";
import { runOpenClawAgent, buildWechatSessionId } from "./openclaw-agent-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PORT = Number(process.env.XLX_CONSOLE_PORT || 3100);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || "", ".openclaw");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const WORKFLOW_MODEL_TIMEOUT_MS = Number(process.env.WECHAT_WORKFLOW_MODEL_TIMEOUT_MS || 180000);
const DATA_DIR = process.env.XIAOLONGXIA_DATA_DIR || (await existsPath("D:\\XiaolongxiaData")
  ? "D:\\XiaolongxiaData"
  : path.join(ROOT, ".wechat-direct-bridge"));

const PATHS = {
  bridgeConfig: path.join(ROOT, "wechat-bridge.config.json"),
  notionConfig: path.join(ROOT, "notion-ai-intel.config.json"),
  bridgeLog: process.env.XIAOLONGXIA_LOG_PATH || path.join(DATA_DIR, "wechat-direct-bridge.log"),
  runtime: DATA_DIR,
  drafts: path.join(DATA_DIR, "xiaohongshu-drafts"),
  prefillStatus: path.join(DATA_DIR, "xiaohongshu-prefill-status.json"),
  contentOptions: path.join(DATA_DIR, "content-console-options.json"),
  knowledgeBase: path.join(DATA_DIR, "content-knowledge-base.json"),
  entryConfig: path.join(DATA_DIR, "entry-config.json"),
};

const DEFAULT_CONTENT_OPTIONS = {
  knowledgeScopes: ["暂不使用知识库", "AI 工具基础设施知识库", "疗愈知识库", "使用全部可用知识库"],
  materialSources: ["手动素材优先", "情报库优先", "知识库优先", "手动素材 + 情报库 + 知识库"],
  styleReferenceTypes: ["不使用风格参考", "参考我的历史内容", "参考风格样例库", "参考某个账号/作者的结构特征", "参考手动粘贴样例"],
  imitationStrengths: ["轻：只参考选题角度和结构，不模仿语句", "中：参考节奏、开头方式和表达密度", "强：高度贴近表达习惯，但不能复刻原句或冒充本人"],
  aiFlavorControls: ["强：删编号、打碎结构、加入真实犹豫和具体细节", "中：保持清晰但避免模板腔", "轻：只做基础自然化"],
  outputModes: ["生成完整发布包，但不自动发布", "先生成选题方案，不写正文", "生成正文和配图提示词，不预填发布页"],
};

const DEFAULT_KNOWLEDGE_BASE = {
  topics: [
    { id: "ai-infra", name: "AI 工具基础设施", description: "Token 代理、模型 API、Base URL、开发者工作流。", enabled: true },
    { id: "healing", name: "疗愈", description: "焦虑、自我成长、亲密关系、职场压力等内容方向。", enabled: true },
  ],
  knowledgePoints: [
    { id: "kp-token-proxy", topicId: "ai-infra", title: "Token 代理不是 AI Agent", content: "Token 代理更接近 API Key 中转、Base URL 转发和模型接口代理，不是替用户完成任务的智能体。", enabled: true },
    { id: "kp-healing-detail", topicId: "healing", title: "疗愈文案要从具体身体感受进入", content: "不要一上来讲大道理，先写失眠、胸口发紧、反复刷手机、明明很累却停不下来这类可感知细节。", enabled: true },
  ],
  styleSamples: [
    { id: "style-real-review", name: "真实复盘型", content: "开头承认一个具体问题，中段讲尝试和误判，结尾给出阶段性结论，不要写成万能教程。", enabled: true },
    { id: "style-soft-note", name: "小红书轻经验型", content: "段落短、语气像聊天，少用宏大判断，多用“我后来发现”“这一步挺关键”。", enabled: true },
  ],
  writingRules: [
    { id: "rule-no-hard-ad", name: "软广不过度", content: "广告只作为解决方案的一部分出现，不要承诺效果，不要写成销售页。", enabled: true },
    { id: "rule-human-trace", name: "保留真人痕迹", content: "允许一点犹豫、转折和没完全讲满的感觉，避免每段都像标准答案。", enabled: true },
  ],
};

const DEFAULT_ENTRY_CONFIG = {
  entries: [
    {
      id: "wechat",
      name: "微信入口",
      type: "wechat",
      enabled: true,
      status: "active",
      description: "小龙虾现在最主要的轻量入口。适合随手发指令、收结果、看简短反馈。",
      triggers: ["早报", "今天有什么热点", "小红书 token代理", "爆款拆解 + 小红书链接", "菜单"],
      workflows: ["热点情报", "小红书发布包", "爆款拆解", "帮助菜单"],
      notes: "微信入口负责接收任务，不承载复杂筛选。复杂配置建议在网页后台完成。",
    },
    {
      id: "web-console",
      name: "网页后台入口",
      type: "web",
      enabled: true,
      status: "active",
      description: "适合做配置、筛选、爆款拆解、知识库维护、查看日志和发布包。",
      triggers: ["http://localhost:3101/", "后台", "内容工作台"],
      workflows: ["内容工作台", "入口管理", "知识库", "运行日志"],
      notes: "后台是内容生产控制台，不只是 OpenClaw Dashboard。",
    },
    {
      id: "scheduled-morning",
      name: "8点晨报定时入口",
      type: "schedule",
      enabled: true,
      status: "active",
      description: "每天固定时间主动触发热点/情报晨报，并通过微信推送摘要。",
      triggers: ["每天 08:00", "XiaolongxiaMorningPush"],
      workflows: ["8点晨报", "热点情报"],
      notes: "依赖 Windows 任务计划程序和 run-morning-ai-brief.ps1。",
    },
    {
      id: "feishu",
      name: "飞书入口",
      type: "feishu",
      enabled: false,
      status: "planned",
      description: "团队协作入口，后续可接飞书机器人、审批和群消息。",
      triggers: ["飞书机器人", "群聊指令"],
      workflows: ["团队内容协作", "日报推送"],
      notes: "当前仅保留配置位，还未接入飞书 API。",
    },
    {
      id: "dingtalk",
      name: "钉钉入口",
      type: "dingtalk",
      enabled: false,
      status: "planned",
      description: "企业内部入口，后续可接钉钉机器人和工作通知。",
      triggers: ["钉钉机器人", "工作通知"],
      workflows: ["企业通知", "任务流转"],
      notes: "当前仅保留配置位，还未接入钉钉 API。",
    },
  ],
};

const WORKFLOWS = [
  {
    id: "intel",
    name: "情报模式",
    slogan: "发现今天值得看的信息",
    trigger: "今天有什么热点 / 今天AI有什么值得看 / 有什么适合做内容的选题",
    output: "微信简报、情报库记录、可转内容的候选选题",
    status: "基础可用",
  },
  {
    id: "content",
    name: "内容模式",
    slogan: "把一个方向变成可发布内容",
    trigger: "小红书 焦虑疗愈 / 小红书 token代理 / 把第2条做成小红书",
    output: "发布文档、本地素材包、Notion内容库页面、配图提示词",
    status: "当前主线",
  },
  {
    id: "admin",
    name: "管理模式",
    slogan: "查看、配置、维护小龙虾",
    trigger: "帮助 / 菜单 / 查看发布包 / 配置Notion / 查看日志",
    output: "后台控制台、开关状态、运行日志、历史素材",
    status: "本次新增",
  },
];

const WORKFLOW_DETAILS = [
  {
    id: "intel",
    name: "情报流：今天有什么值得看",
    role: "负责发现素材，不直接写成最终内容。",
    examples: ["今天有什么热点", "今天 AI 有什么值得看", "今天哪些适合做内容"],
    decision: "识别为热点/情报/选题类请求时进入；优先抓取配置的 RSS/信息源。",
    steps: [
      "接收微信文本，判断这是情报请求还是内容请求。",
      "抓取配置源，清洗标题、摘要、链接和时间。",
      "调用 AI 做筛选、去重、分类和摘要。",
      "写入情报库；如果 Notion 关闭，则只回微信摘要。",
      "返回微信：给出值得看的条目和可转内容机会。",
    ],
    aiCalls: ["信息筛选与摘要：1 次左右，按源数量和去重策略变化。"],
    outputs: ["微信摘要", "情报库记录", "可加工选题候选"],
    fallback: "抓取源失败时返回可读提示；Notion 失败不阻塞微信回复。",
  },
  {
    id: "content",
    name: "内容流：小红书发布包",
    role: "OpenClaw 做流程手，Hermes 做内容脑。",
    examples: ["小红书 token代理", "小红书 焦虑疗愈", "把第2条做成小红书"],
    decision: "识别到“小红书/发布包/文案”等意图时进入；先找素材，再交给 Hermes 内容脑。",
    steps: [
      "微信收到指令后，先回复等待提示，避免你不知道有没有触发。",
      "读取情报/素材，按主题找相关条目。",
      "Hermes 内容脑完成研究、判断、质检、改写和最终文案。",
      "应用去 AI 味后台规则：禁用词、真实细节、字数范围、软广边界。",
      "生成配图建议和生图提示词；当前默认不自动生图。",
      "保存本地发布包：正文、复制版、流程文档、质检记录、配图说明。",
      "按开关写入 Notion 内容库；失败不阻塞本地发布包。",
      "微信返回简短结果：标题、质检分、路径、是否写入 Notion。",
    ],
    aiCalls: [
      "情报素材筛选：通常 1 次。",
      "Hermes 内容脑：通常 1 次，负责主文案。",
      "备用流程才会额外调用去 AI 味质检/质量检查。",
    ],
    outputs: ["本地发布包", "最终文案", "去 AI 味质检", "配图提示词", "Notion 内容页"],
    fallback: "Hermes 输出异常时自动降级到稳定多步流程；Notion/预填失败不影响本地包。",
  },
  {
    id: "admin",
    name: "管理流：后台配置与复盘",
    role: "负责看状态、改开关、调规则、查日志。",
    examples: ["帮助", "菜单", "查看发布包", "查看日志", "配置规则"],
    decision: "识别为管理类请求或直接访问后台页面。",
    steps: [
      "查看服务是否运行、模型是否正确、Notion/生图/预填是否开启。",
      "维护去 AI 味规则：一条规则一个输入框，保存后下次生成生效。",
      "查看本地发布包，复制正文或手工发布。",
      "按工作流查看日志：每次微信任务聚合成一张卡。",
      "排查 AI 调用、Hermes 降级、Notion 写入、生图和小红书预填问题。",
    ],
    aiCalls: ["管理页本身不调用 AI，只读取配置和日志。"],
    outputs: ["配置状态", "运行日志", "发布包列表", "规则配置"],
    fallback: "后台端口冲突时可临时用 3101；核心微信流程不依赖后台页面打开。",
  },
];

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendHtml(res, body, status = 200) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function existsPath(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
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

async function loadConsoleWorkflowLlm() {
  const bridgeConfig = await readJson(PATHS.bridgeConfig, {});
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
  return { activeModeName: "fallback-openclaw-agent", llm: buildOpenClawAgentMode(providerId || "openai-codex", modelId || "gpt-5.4") };
}

async function appendBridgeLog(level, message, detail = {}) {
  const line = `[${new Date().toISOString()}] [${level}] ${message} ${JSON.stringify(detail)}\n`;
  try {
    await fs.mkdir(path.dirname(PATHS.bridgeLog), { recursive: true });
    await fs.appendFile(PATHS.bridgeLog, line, "utf8");
  } catch {
    // Logging must never block a console-triggered workflow.
  }
}

function buildConsoleContentTaskPrompt(payload = {}) {
  const knowledgeBlock = buildKnowledgePromptBlock(payload.selectedKnowledge);
  const parts = [
    `小红书 ${String(payload.topic || "").trim()}`,
    payload.contentType ? `内容类型：${payload.contentType}` : "",
    payload.goal ? `内容目标：${payload.goal}` : "",
    payload.audience ? `目标受众：${payload.audience}` : "",
    payload.style ? `表达风格：${payload.style}` : "",
    payload.knowledgeScope ? `知识库范围：${payload.knowledgeScope}` : "",
    payload.materialSource ? `素材来源：${payload.materialSource}` : "",
    payload.styleReferenceType ? `风格参考类型：${payload.styleReferenceType}` : "",
    payload.styleReference ? `风格参考内容：${payload.styleReference}` : "",
    payload.imitationStrength ? `参考强度：${payload.imitationStrength}` : "",
    payload.aiFlavorControl ? `AI味控制：${payload.aiFlavorControl}` : "",
    payload.adLevel ? `软广强度：${payload.adLevel}` : "",
    payload.productMention ? `产品/广告植入：${payload.productMention}` : "",
    payload.wordRange ? `字数范围：${payload.wordRange}` : "",
    payload.outputMode ? `产出要求：${payload.outputMode}` : "",
    payload.material ? `补充素材：${payload.material}` : "",
    payload.requirements ? `额外要求：${payload.requirements}` : "",
    knowledgeBlock,
    "请生成完整小红书发布包：标题、正文、标签、封面文案、配图建议和详细生图提示词。默认不自动发布。",
  ].filter(Boolean);
  return parts.join("\n");
}

function extractJsonObject(text) {
  const input = String(text || "").trim();
  if (!input) throw new Error("Empty model output");
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1].trim() : input;
  try {
    return JSON.parse(source);
  } catch {
    const starts = [];
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === "{") starts.push(i);
    }
    for (let s = starts.length - 1; s >= 0; s -= 1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = starts[s]; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === "\"") inString = false;
          continue;
        }
        if (ch === "\"") inString = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            return JSON.parse(source.slice(starts[s], i + 1));
          }
        }
      }
    }
    throw new Error(`No JSON object found in model output: ${input.slice(0, 240)}`);
  }
}

async function callConsoleJsonModel(llm, prompt, timeoutMs, meta = {}) {
  const startedAt = Date.now();
  meta.logger?.("INFO", "AI API call", {
    workflow: meta.workflow || "控制台 AI 任务",
    step: meta.step || 1,
    totalSteps: meta.totalSteps || 1,
    purpose: meta.purpose || "生成结构化结果",
    mode: llm.mode,
    providerId: llm.providerId,
    model: llm.model,
    endpoint: llm.mode === "openclaw-agent" ? "openclaw-agent" : "chat/completions",
  });

  if (llm.mode === "openclaw-agent") {
    const sessionId = buildWechatSessionId("console-viral-analysis", `${Date.now()}-${prompt.slice(0, 160)}`);
    const result = await runOpenClawAgent({
      sessionId,
      message: [
        "你是小龙虾内容生产控制台里的结构化分析助手。",
        "请严格只输出 JSON，不要输出 markdown 代码块，不要解释。",
        prompt,
      ].join("\n\n"),
      timeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      thinking: "medium",
    });
    const parsed = extractJsonObject(result.text);
    meta.logger?.("INFO", "AI API call completed", {
      workflow: meta.workflow || "控制台 AI 任务",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "生成结构化结果",
      model: llm.model,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("chat/completions", llm.baseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: "你是小龙虾内容生产控制台里的结构化分析助手。严格只输出 JSON。" },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Model call failed: ${res.status} ${text}`);
    const content = JSON.parse(text)?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(content);
    meta.logger?.("INFO", "AI API call completed", {
      workflow: meta.workflow || "控制台 AI 任务",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "生成结构化结果",
      model: llm.model,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function buildViralAnalysisPrompt(payload = {}) {
  const parsed = payload.parsedReference || null;
  const parsedBlock = parsed ? [
    "已解析到的小红书页面信息：",
    parsed.finalUrl ? `最终链接：${parsed.finalUrl}` : "",
    parsed.title ? `标题：${parsed.title}` : "",
    parsed.description ? `摘要/描述：${parsed.description}` : "",
    Array.isArray(parsed.images) && parsed.images.length ? `原图 URL（${parsed.images.length} 张）：\n${parsed.images.slice(0, 12).join("\n")}` : "",
    parsed.warning ? `解析提醒：${parsed.warning}` : "",
  ].filter(Boolean).join("\n") : "";
  return [
    "你是小红书爆款拆解和参考创作顾问。任务不是洗稿，而是提取底层创作逻辑，并迁移到用户自己的账号方向。",
    "请根据用户提供的小红书分享内容、链接、标题、正文、截图描述、图片描述进行分析。如果信息不足，要明确说明缺什么，不要假装已经解析到完整原文。",
    "",
    "用户输入：",
    String(payload.sourceText || "").trim() || "（空）",
    parsedBlock,
    "",
    `账号方向：${String(payload.accountDirection || "未填写").trim() || "未填写"}`,
    `想迁移到的主题：${String(payload.targetTopic || "未填写").trim() || "未填写"}`,
    `软广/产品：${String(payload.productMention || "无").trim() || "无"}`,
    "",
    "输出必须是 JSON，字段如下：",
    "{",
    '  "reference_summary": "对参考内容的简短概括，不能编造未提供的信息",',
    '  "available_signals": ["已经能确定的信息"],',
    '  "missing_info": ["还缺的信息"],',
    '  "viral_logic": { "hook": "...", "pain_or_desire": "...", "emotion": "...", "structure": "...", "why_it_works": "..." },',
    '  "image_strategy": { "cover_role": "...", "visual_style": "...", "new_image_directions": ["新图方向1", "新图方向2", "新图方向3"] },',
    '  "migration_angles": [',
    '    { "title": "迁移方向标题", "angle": "如何换主题/人群/场景", "fit_score": 0, "risk": "重复/侵权/过度相似风险", "why": "为什么值得做" }',
    "  ],",
    '  "recommended_direction": { "title": "...", "reason": "..." },',
    '  "draft_brief": { "topic": "可带入内容工作台的主题", "goal": "内容目标", "audience": "目标受众", "style": "表达风格", "material": "应该带入的素材说明", "image_prompt_brief": "配图提示词方向" },',
    '  "safety_notes": ["避免直接搬运原图原文", "需要人工确认的地方"]',
    "}",
  ].join("\n");
}

function classifyViralSourceInput(sourceText) {
  const text = String(sourceText || "").trim();
  const hasUrl = /https?:\/\/|xhslink\.com|xiaohongshu\.com|xsec_token|share_id|appuid|apptime/i.test(text);
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
  const looksLikeOnlyLink = hasUrl && chineseChars < 12 && lineCount <= 3;
  return {
    hasUrl,
    chineseChars,
    lineCount,
    looksLikeOnlyLink,
  };
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .trim();
}

function extractFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s"'<>，。；、）)]+/i);
  return match ? match[0] : "";
}

function getTagAttr(tag, attr) {
  const match = String(tag || "").match(new RegExp(`${attr}=[\"']([^\"']+)[\"']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function getMetaContents(html, names = []) {
  const wanted = new Set(names.map((item) => String(item).toLowerCase()));
  const values = [];
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (getTagAttr(tag, "property") || getTagAttr(tag, "name")).toLowerCase();
    if (!wanted.has(key)) continue;
    const content = getTagAttr(tag, "content");
    if (content) values.push(content);
  }
  return values;
}

function extractXhsInitialState(html) {
  const match = String(html || "").match(/<script>\s*window\.__INITIAL_STATE__=([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/\bundefined\b/g, "null"));
  } catch {
    return null;
  }
}

function findPrimaryXhsNote(initialState) {
  const noteMap = initialState?.note?.noteDetailMap;
  if (!noteMap || typeof noteMap !== "object") return null;
  const currentId = initialState?.note?.currentNoteId || initialState?.note?.firstNoteId || "";
  const current = currentId ? noteMap[currentId]?.note : null;
  if (current) return current;
  const first = Object.values(noteMap).find((item) => item?.note);
  return first?.note || null;
}

function extractXhsNoteImages(note) {
  const imageList = Array.isArray(note?.imageList) ? note.imageList : [];
  const urls = [];
  for (const image of imageList) {
    const infoList = Array.isArray(image?.infoList) ? image.infoList : [];
    const dft = infoList.find((item) => String(item?.imageScene || "").toUpperCase() === "WB_DFT")?.url;
    const prv = infoList.find((item) => String(item?.imageScene || "").toUpperCase() === "WB_PRV")?.url;
    const fallback = image?.urlDefault || image?.urlPre || infoList.find((item) => item?.url)?.url;
    const url = dft || fallback || prv;
    if (url) urls.push(url);
  }
  return uniqueList(urls.map(normalizeXhsImageUrl), 20);
}

function uniqueList(values, limit = 30) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = decodeHtml(String(value || "")).replace(/\\u0026/g, "&");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    output.push(cleaned);
    if (output.length >= limit) break;
  }
  return output;
}

function normalizeXhsImageUrl(url) {
  return decodeHtml(String(url || ""))
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
}

function getXhsImageIdentity(url) {
  const clean = normalizeXhsImageUrl(url);
  const noteMatch = clean.match(/notes_pre_post\/([^!?#]+)/i);
  if (noteMatch) return `note:${noteMatch[1]}`;
  const genericMatch = clean.match(/\/([a-z0-9]{18,})(?:!|[?#]|$)/i);
  if (genericMatch) return `generic:${genericMatch[1]}`;
  return clean.split(/[?#]/)[0].replace(/!(?:nd|sns|large|small|webp|jpg)[^/?#]*/i, "");
}

function scoreXhsImageUrl(url) {
  const clean = normalizeXhsImageUrl(url);
  let score = 0;
  if (/notes_pre_post/i.test(clean)) score += 100;
  if (/sns-webpic|xhscdn/i.test(clean)) score += 20;
  if (/!nd_dft/i.test(clean)) score += 10;
  if (/webp|jpg|jpeg|png/i.test(clean)) score += 5;
  if (/avatar|profile|icon|logo|qrcode|qr_code|comment|emoji|sticker|recommend|feed|search|user/i.test(clean)) score -= 80;
  if (!/notes_pre_post/i.test(clean)) score -= 30;
  return score;
}

function filterXhsNoteImages(values, limit = 12) {
  const rawCandidates = uniqueList(values, 120)
    .map((url, index) => ({
      url: normalizeXhsImageUrl(url),
      index,
      identity: getXhsImageIdentity(url),
      score: scoreXhsImageUrl(url),
    }))
    .filter((item) => item.url && item.score > 0 && !/avatar|profile|icon|logo|qrcode|qr_code/i.test(item.url));
  const noteImages = rawCandidates.filter((item) => /notes_pre_post/i.test(item.url));
  const candidates = noteImages.length ? noteImages : rawCandidates;

  const bestById = new Map();
  for (const item of candidates) {
    const existing = bestById.get(item.identity);
    if (!existing || item.score > existing.score || (item.score === existing.score && item.index < existing.index)) {
      bestById.set(item.identity, item);
    }
  }

  return Array.from(bestById.values())
    .sort((left, right) => left.index - right.index)
    .slice(0, limit)
    .map((item) => item.url);
}

async function parseXiaohongshuReference(sourceText) {
  const sourceUrl = extractFirstUrl(sourceText);
  if (!sourceUrl) return { ok: false, error: "???????" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    const html = await response.text();
    const initialState = extractXhsInitialState(html);
    const note = findPrimaryXhsNote(initialState);
    const title = decodeHtml(
      note?.title
      || getMetaContents(html, ["og:title", "twitter:title"])[0]
      || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
      || "",
    ).replace(/\s*-\s*[^-\s]{2,8}\s*$/, "");
    const description = decodeHtml(note?.desc || getMetaContents(html, ["description", "og:description", "twitter:description"])[0] || "");
    const metaImages = getMetaContents(html, ["og:image", "twitter:image"]);
    const cdnImages = Array.from(html.matchAll(/https?:\/\/[^"'<>\\\s]+(?:xhscdn|sns-webpic)[^"'<>\\\s]*/gi)).map((item) => item[0]);
    const noteImages = extractXhsNoteImages(note);
    const rawImages = uniqueList([...metaImages, ...cdnImages], 120);
    const images = noteImages.length ? noteImages : filterXhsNoteImages(rawImages, 12);
    return {
      ok: Boolean(title || description || images.length),
      sourceUrl,
      finalUrl: response.url || sourceUrl,
      statusCode: response.status,
      title,
      description,
      images,
      imageCount: images.length,
      rawImageCount: Math.max(rawImages.length, noteImages.length),
      parseSource: note ? "xhs_initial_state" : "html_meta",
      warning: images.length ? "" : "??????????????? URL?",
    };
  } catch (error) {
    return {
      ok: false,
      sourceUrl,
      error: error.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildNeedsMoreInfoViralResult(sourceText, payload = {}) {
  const targetTopic = String(payload.targetTopic || "").trim();
  const accountDirection = String(payload.accountDirection || "").trim();
  return {
    mode: "needs_more_info",
    reference_summary: "当前只识别到小红书分享链接/分享参数，还没有拿到正文、标题、图片内容，所以不能做真正的爆款拆解。",
    available_signals: [
      "用户提供了小红书分享链接或分享参数",
      targetTopic ? `目标迁移主题：${targetTopic}` : "尚未填写明确迁移主题",
      accountDirection ? `账号方向：${accountDirection}` : "尚未填写账号方向",
    ],
    missing_info: [
      "参考笔记标题",
      "参考笔记正文或至少前 200 字",
      "封面图/正文图截图，或用文字描述图片内容",
      "如果想分析评论区，还需要粘贴 3-5 条高赞评论",
    ],
    viral_logic: {
      hook: "暂无法判断，缺少标题/开头。",
      pain_or_desire: targetTopic ? `可以先围绕「${targetTopic}」构造用户痛点，但这不是原笔记拆解。` : "暂无法判断，缺少正文。",
      emotion: "暂无法判断，缺少正文和画面信息。",
      structure: "暂无法判断，缺少正文结构。",
      why_it_works: "当前只有链接，不能可靠判断原文为什么有效。",
    },
    image_strategy: {
      cover_role: "需要补充封面截图或描述后才能判断。",
      visual_style: "需要补充图片截图或描述后才能判断。",
      new_image_directions: [
        "补充封面截图后，可拆解构图、色彩、主体和文字策略。",
        "补充正文图后，可设计新的图片顺序和信息任务。",
        targetTopic ? `可以先围绕「${targetTopic}」设计原创配图方向。` : "也可以直接填写目标主题，跳过参考图拆解。",
      ],
    },
    migration_angles: [
      {
        title: targetTopic ? `${targetTopic}：先做原创选题，不依赖原链接` : "先补充截图或正文，再做拆解",
        angle: "如果只有链接，建议不要假装解析原文。要么补充截图/正文，要么直接按目标主题做原创发布包。",
        fit_score: targetTopic ? 68 : 30,
        risk: "信息不足，继续拆解会变成模型猜测。",
        why: "小红书反爬环境下，Web 端无法稳定直接解析分享链接内容；分享 App 模式才适合自动拿素材。",
      },
    ],
    recommended_direction: {
      title: targetTopic ? `直接围绕「${targetTopic}」做原创发布包` : "先补充参考笔记截图/正文",
      reason: targetTopic ? "当前没有参考正文，但已有目标主题，可以先走原创内容生产。" : "补齐素材后，拆解结果才会可信。",
    },
    draft_brief: {
      topic: targetTopic || "",
      goal: "基于用户补充素材或目标主题，生成一篇不复刻原文原图的原创小红书发布包。",
      audience: accountDirection || "",
      style: "真实、有具体场景、避免模板化拆解腔",
      material: [
        `原始分享内容：${sourceText}`,
        "注意：当前只有链接/参数，不能当作已解析原文。",
        "建议补充：标题、正文、截图、图片描述或评论区反馈。",
      ].join("\n"),
      image_prompt_brief: "暂不生成同款图，先补充参考图截图或改用原创配图策略。",
    },
    safety_notes: [
      "不要直接搬运原文原图。",
      "只有链接时不要生成“伪拆解”，否则内容质量会虚。",
      "Web 版不建议硬爬小红书链接；App 分享入口更适合后续升级。",
    ],
  };
}

async function runViralAnalysis(payload = {}) {
  const sourceText = String(payload.sourceText || "").trim();
  if (!sourceText) throw new Error("请先粘贴小红书分享文案、链接、截图文字或图片描述。");
  const sourceKind = classifyViralSourceInput(sourceText);
  const parsedReference = payload.parsedReference?.ok
    ? payload.parsedReference
    : sourceKind.hasUrl
      ? await parseXiaohongshuReference(sourceText)
      : null;
  if (sourceKind.looksLikeOnlyLink && !parsedReference?.ok) {
    return {
      taskId: `console-viral-local-${Date.now()}`,
      durationMs: 0,
      sourceKind,
      parsedReference,
      result: buildNeedsMoreInfoViralResult(sourceText, payload),
    };
  }
  const { activeModeName, llm } = await loadConsoleWorkflowLlm();
  const taskId = `console-viral-${Date.now()}`;
  const startedAt = Date.now();
  const logger = (level, message, detail = {}) => appendBridgeLog(level, message, {
    workflowRunId: taskId,
    source: "console",
    activeModeName,
    ...detail,
  });
  logger("INFO", "Viral analysis started", {
    model: llm.model,
    llmMode: llm.mode,
    targetTopic: payload.targetTopic || null,
  });
  const result = await callConsoleJsonModel(llm, buildViralAnalysisPrompt({ ...payload, parsedReference }), Math.min(WORKFLOW_MODEL_TIMEOUT_MS, 120000), {
    logger,
    workflow: "爆款拆解",
    step: 1,
    totalSteps: 1,
    purpose: "爆款拆解：分析参考内容逻辑、图片策略和可迁移方向",
  });
  logger("INFO", "Viral analysis completed", {
    durationMs: Date.now() - startedAt,
    angleCount: Array.isArray(result?.migration_angles) ? result.migration_angles.length : 0,
  });
  return {
    taskId,
    durationMs: Date.now() - startedAt,
    parsedReference,
    result,
  };
}

function toOptionLines(input, fallback = []) {
  const values = Array.isArray(input)
    ? input
    : String(input || "")
      .split(/\r?\n/);
  const cleaned = values
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return cleaned.length ? [...new Set(cleaned)] : fallback;
}

function normalizeContentOptions(value = {}) {
  return {
    knowledgeScopes: toOptionLines(value.knowledgeScopes, DEFAULT_CONTENT_OPTIONS.knowledgeScopes),
    materialSources: toOptionLines(value.materialSources, DEFAULT_CONTENT_OPTIONS.materialSources),
    styleReferenceTypes: toOptionLines(value.styleReferenceTypes, DEFAULT_CONTENT_OPTIONS.styleReferenceTypes),
    imitationStrengths: toOptionLines(value.imitationStrengths, DEFAULT_CONTENT_OPTIONS.imitationStrengths),
    aiFlavorControls: toOptionLines(value.aiFlavorControls, DEFAULT_CONTENT_OPTIONS.aiFlavorControls),
    outputModes: toOptionLines(value.outputModes, DEFAULT_CONTENT_OPTIONS.outputModes),
  };
}

function slugifyId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeKnowledgeBase(value = {}) {
  const normalizeItems = (items, fallback, mapper) => {
    const source = Array.isArray(items) && items.length ? items : fallback;
    return source
      .map(mapper)
      .filter((item) => item.name || item.title || item.content);
  };
  const topics = normalizeItems(value.topics, DEFAULT_KNOWLEDGE_BASE.topics, (item) => ({
    id: String(item.id || slugifyId("topic")),
    name: String(item.name || "").trim(),
    description: String(item.description || "").trim(),
    enabled: item.enabled !== false,
  }));
  const validTopicIds = new Set(topics.map((item) => item.id));
  const fallbackTopicId = topics[0]?.id || "general";
  return {
    topics,
    knowledgePoints: normalizeItems(value.knowledgePoints, DEFAULT_KNOWLEDGE_BASE.knowledgePoints, (item) => ({
      id: String(item.id || slugifyId("kp")),
      topicId: validTopicIds.has(String(item.topicId || "")) ? String(item.topicId) : fallbackTopicId,
      title: String(item.title || "").trim(),
      content: String(item.content || "").trim(),
      enabled: item.enabled !== false,
    })),
    styleSamples: normalizeItems(value.styleSamples, DEFAULT_KNOWLEDGE_BASE.styleSamples, (item) => ({
      id: String(item.id || slugifyId("style")),
      name: String(item.name || "").trim(),
      content: String(item.content || "").trim(),
      enabled: item.enabled !== false,
    })),
    writingRules: normalizeItems(value.writingRules, DEFAULT_KNOWLEDGE_BASE.writingRules, (item) => ({
      id: String(item.id || slugifyId("rule")),
      name: String(item.name || "").trim(),
      content: String(item.content || "").trim(),
      enabled: item.enabled !== false,
    })),
  };
}

async function getKnowledgeBase() {
  return normalizeKnowledgeBase(await readJson(PATHS.knowledgeBase, {}));
}

function normalizeLineArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEntryConfig(value = {}) {
  const saved = Array.isArray(value.entries) ? value.entries : [];
  const savedById = new Map(saved.map((item) => [String(item.id || ""), item]));
  const defaults = DEFAULT_ENTRY_CONFIG.entries.map((entry) => {
    const savedItem = savedById.get(entry.id) || {};
    return {
      ...entry,
      ...savedItem,
      id: entry.id,
      name: String(savedItem.name || entry.name).trim(),
      type: entry.type,
      enabled: typeof savedItem.enabled === "boolean" ? savedItem.enabled : entry.enabled !== false,
      status: String(savedItem.status || entry.status || "inactive").trim(),
      description: String(savedItem.description || entry.description || "").trim(),
      triggers: normalizeLineArray(savedItem.triggers || entry.triggers),
      workflows: normalizeLineArray(savedItem.workflows || entry.workflows),
      notes: String(savedItem.notes || entry.notes || "").trim(),
      updated_at: savedItem.updated_at || null,
    };
  });
  const custom = saved
    .filter((item) => item?.id && !DEFAULT_ENTRY_CONFIG.entries.some((entry) => entry.id === String(item.id)))
    .map((item) => ({
      id: String(item.id),
      name: String(item.name || item.id).trim(),
      type: String(item.type || "custom").trim(),
      enabled: item.enabled !== false,
      status: String(item.status || "custom").trim(),
      description: String(item.description || "").trim(),
      triggers: normalizeLineArray(item.triggers),
      workflows: normalizeLineArray(item.workflows),
      notes: String(item.notes || "").trim(),
      updated_at: item.updated_at || null,
    }));
  return { entries: [...defaults, ...custom] };
}

async function getEntryConfig() {
  return normalizeEntryConfig(await readJson(PATHS.entryConfig, {}));
}

async function updateEntryConfig(patch = {}) {
  const current = await getEntryConfig();
  const id = String(patch.id || "").trim();
  if (!id) throw new Error("Missing entry id");
  const index = current.entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error("Unknown entry id");
  current.entries[index] = {
    ...current.entries[index],
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.entries[index].enabled,
    triggers: normalizeLineArray(patch.triggers ?? current.entries[index].triggers),
    workflows: normalizeLineArray(patch.workflows ?? current.entries[index].workflows),
    notes: String(patch.notes ?? current.entries[index].notes ?? "").trim(),
    updated_at: new Date().toISOString(),
  };
  const normalized = normalizeEntryConfig(current);
  await writeJson(PATHS.entryConfig, normalized);
  return { entryConfig: normalized };
}

function selectKnowledgeForTask(knowledgeBase, payload = {}) {
  const scope = String(payload.knowledgeScope || "");
  if (!scope || /暂不使用/.test(scope)) return null;
  const topics = knowledgeBase.topics.filter((topic) => topic.enabled);
  const matchedTopic = topics.find((topic) => scope.includes(topic.name) || topic.name.includes(scope));
  const topicIds = /全部/.test(scope) ? topics.map((topic) => topic.id) : matchedTopic ? [matchedTopic.id] : topics.map((topic) => topic.id);
  const knowledgePoints = knowledgeBase.knowledgePoints
    .filter((item) => item.enabled && topicIds.includes(item.topicId))
    .slice(0, 8);
  const styleSamples = knowledgeBase.styleSamples.filter((item) => item.enabled).slice(0, 4);
  const writingRules = knowledgeBase.writingRules.filter((item) => item.enabled).slice(0, 8);
  return { topics: topics.filter((topic) => topicIds.includes(topic.id)), knowledgePoints, styleSamples, writingRules };
}

function buildKnowledgePromptBlock(selected) {
  if (!selected) return "";
  const lines = ["可用知识库内容："];
  if (selected.topics?.length) {
    lines.push("主题：" + selected.topics.map((item) => `${item.name}：${item.description}`).join("；"));
  }
  if (selected.knowledgePoints?.length) {
    lines.push("知识点：");
    selected.knowledgePoints.forEach((item, index) => lines.push(`${index + 1}. ${item.title}：${item.content}`));
  }
  if (selected.styleSamples?.length) {
    lines.push("风格样例规则：");
    selected.styleSamples.forEach((item, index) => lines.push(`${index + 1}. ${item.name}：${item.content}`));
  }
  if (selected.writingRules?.length) {
    lines.push("写作规则：");
    selected.writingRules.forEach((item, index) => lines.push(`${index + 1}. ${item.name}：${item.content}`));
  }
  lines.push("请只学习知识、结构和表达原则，不要复刻样例原句。");
  return lines.join("\n");
}

async function updateKnowledgeBase(patch = {}) {
  const current = await getKnowledgeBase();
  const next = structuredClone(current);
  const type = String(patch.type || "");
  const id = String(patch.id || "");
  const enabled = typeof patch.enabled === "boolean" ? patch.enabled : true;
  if (type === "topic") {
    const item = {
      id: id || slugifyId("topic"),
      name: String(patch.name || "").trim(),
      description: String(patch.description || "").trim(),
      enabled,
    };
    const index = next.topics.findIndex((entry) => entry.id === id);
    if (index >= 0) next.topics[index] = item;
    else next.topics.push(item);
  } else if (type === "knowledgePoint") {
    const item = {
      id: id || slugifyId("kp"),
      topicId: String(patch.topicId || next.topics[0]?.id || "general"),
      title: String(patch.title || "").trim(),
      content: String(patch.content || "").trim(),
      enabled,
    };
    const index = next.knowledgePoints.findIndex((entry) => entry.id === id);
    if (index >= 0) next.knowledgePoints[index] = item;
    else next.knowledgePoints.push(item);
  } else if (type === "styleSample") {
    const item = {
      id: id || slugifyId("style"),
      name: String(patch.name || "").trim(),
      content: String(patch.content || "").trim(),
      enabled,
    };
    const index = next.styleSamples.findIndex((entry) => entry.id === id);
    if (index >= 0) next.styleSamples[index] = item;
    else next.styleSamples.push(item);
  } else if (type === "writingRule") {
    const item = {
      id: id || slugifyId("rule"),
      name: String(patch.name || "").trim(),
      content: String(patch.content || "").trim(),
      enabled,
    };
    const index = next.writingRules.findIndex((entry) => entry.id === id);
    if (index >= 0) next.writingRules[index] = item;
    else next.writingRules.push(item);
  } else {
    throw new Error("Unknown knowledge item type");
  }
  const normalized = normalizeKnowledgeBase(next);
  await writeJson(PATHS.knowledgeBase, normalized);
  return { knowledgeBase: normalized };
}

async function deleteKnowledgeBaseItem(patch = {}) {
  const current = await getKnowledgeBase();
  const next = structuredClone(current);
  const type = String(patch.type || "");
  const id = String(patch.id || "");
  if (!id) throw new Error("Missing knowledge item id");
  if (type === "topic") {
    next.topics = next.topics.filter((item) => item.id !== id);
    next.knowledgePoints = next.knowledgePoints.filter((item) => item.topicId !== id);
  } else if (type === "knowledgePoint") {
    next.knowledgePoints = next.knowledgePoints.filter((item) => item.id !== id);
  } else if (type === "styleSample") {
    next.styleSamples = next.styleSamples.filter((item) => item.id !== id);
  } else if (type === "writingRule") {
    next.writingRules = next.writingRules.filter((item) => item.id !== id);
  } else {
    throw new Error("Unknown knowledge item type");
  }
  const normalized = normalizeKnowledgeBase(next);
  await writeJson(PATHS.knowledgeBase, normalized);
  return { knowledgeBase: normalized };
}

async function getContentOptions() {
  return normalizeContentOptions(await readJson(PATHS.contentOptions, {}));
}

async function updateContentOptions(patch = {}) {
  const next = normalizeContentOptions(patch);
  await writeJson(PATHS.contentOptions, next);
  return { contentOptions: next };
}

async function runConsoleContentTask(payload = {}) {
  const topic = String(payload.topic || "").trim();
  if (!topic) throw new Error("请先填写内容主题。");
  const { activeModeName, llm } = await loadConsoleWorkflowLlm();
  const knowledgeBase = await getKnowledgeBase();
  const selectedKnowledge = selectKnowledgeForTask(knowledgeBase, payload);
  const userText = buildConsoleContentTaskPrompt({ ...payload, selectedKnowledge });
  const startedAt = Date.now();
  const taskId = `console-content-${Date.now()}`;
  const logger = (level, message, detail = {}) => {
    appendBridgeLog(level, message, {
      workflowRunId: taskId,
      source: "console",
      activeModeName,
      ...detail,
    });
  };
  logger("INFO", "Console content task started", {
    topic,
    platform: payload.platform || "小红书",
    knowledgeScope: payload.knowledgeScope || null,
    selectedKnowledgePointCount: selectedKnowledge?.knowledgePoints?.length || 0,
    model: llm.model,
    llmMode: llm.mode,
  });
  const result = await maybeRunXiaohongshuDraftWorkflow({
    baseDir: ROOT,
    llm,
    userText,
    logger,
    modelTimeoutMs: WORKFLOW_MODEL_TIMEOUT_MS,
  });
  if (!result?.handled) {
    throw new Error("没有命中小红书发布包流程，请检查主题或内容类型。");
  }
  logger("INFO", "Console content task completed", {
    topic,
    durationMs: Date.now() - startedAt,
    packageName: result.debug?.saved?.packageName || null,
    packageDir: result.debug?.saved?.dir || null,
  });
  return {
    taskId,
    replyText: result.replyText,
    packageName: result.debug?.saved?.packageName || null,
    packageDir: result.debug?.saved?.dir || null,
    title: result.debug?.draft?.title || null,
    notion: result.debug?.notion || null,
    imageMode: result.debug?.imageMode || null,
    durationMs: Date.now() - startedAt,
  };
}

async function previewConsoleContentTask(payload = {}) {
  const knowledgeBase = await getKnowledgeBase();
  const selectedKnowledge = selectKnowledgeForTask(knowledgeBase, payload);
  const prompt = buildConsoleContentTaskPrompt({ ...payload, selectedKnowledge });
  return {
    topic: String(payload.topic || "").trim(),
    knowledgeScope: payload.knowledgeScope || "",
    selectedKnowledge: selectedKnowledge || {
      topics: [],
      knowledgePoints: [],
      styleSamples: [],
      writingRules: [],
    },
    promptPreview: prompt.slice(0, 3000),
  };
}

function maskSecret(value) {
  if (!value || typeof value !== "string") return value;
  if (value.length <= 12) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sanitizeConfig(value) {
  if (Array.isArray(value)) return value.map(sanitizeConfig);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /token|api[_-]?key|authorization|secret|password/i.test(key)
      ? maskSecret(item)
      : sanitizeConfig(item);
  }
  return output;
}

function safeName(value) {
  const name = decodeURIComponent(String(value || ""));
  if (!name || name.includes("..") || path.isAbsolute(name)) return null;
  return name;
}

function safeJoin(base, name) {
  const full = path.join(base, name);
  const relative = path.relative(base, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return full;
}

async function findFirstFile(dir, candidates) {
  for (const candidate of candidates) {
    const file = path.join(dir, candidate);
    if (await existsPath(file)) return file;
  }
  return null;
}

async function readPackageJson(dir) {
  const file = await findFirstFile(dir, ["发布包数据.json", "package.json"]);
  return file ? { file, data: await readJson(file, null) } : { file: null, data: null };
}

async function listDraftPackages() {
  if (!(await existsPath(PATHS.drafts))) return [];
  const entries = await fs.readdir(PATHS.drafts, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    const full = path.join(PATHS.drafts, entry.name);
    const stat = await fs.stat(full);
    if (entry.isFile()) {
      if (!/\.(json|md)$/i.test(entry.name)) continue;
      packages.push({
        kind: "legacy-file",
        name: entry.name,
        title: entry.name.replace(/\.(json|md)$/i, ""),
        path: full,
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const { file, data } = await readPackageJson(full);
    const imageDir = path.join(full, "图片素材");
    let imageCount = 0;
    if (await existsPath(imageDir)) {
      const imageEntries = await fs.readdir(imageDir, { withFileTypes: true });
      imageCount = imageEntries.filter((item) => item.isFile()).length;
    }
    packages.push({
      kind: "publish-package",
      name: entry.name,
      title: data?.draft?.title || entry.name.replace(/^\d{4}-\d{2}-\d{2}[T_][^_]+_?/, ""),
      path: full,
      packageJson: file,
      updatedAt: stat.mtime.toISOString(),
      publishStatus: data?.publishStatus || data?.prefillStatus?.stage || "本地已保存",
      notionStatus: data?.notion?.status || null,
      imageCount,
    });
  }
  return packages.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 100);
}

async function getPackageDetail(name) {
  const safe = safeName(name);
  if (!safe) return null;
  const dir = safeJoin(PATHS.drafts, safe);
  if (!dir || !(await existsPath(dir))) return null;
  const { data } = await readPackageJson(dir);
  const files = {
    finalPost: await findFirstFile(dir, ["最终成稿.txt", "正文.txt"]),
    copyPost: await findFirstFile(dir, ["复制发布版.txt"]),
    workflow: await findFirstFile(dir, ["生成与重写流程.md"]),
    manual: await findFirstFile(dir, ["手工发布说明.txt", "README.txt"]),
    imageGuide: await findFirstFile(dir, ["图片使用说明.txt"]),
    quality: await findFirstFile(dir, ["内容质检.txt"]),
    humanReview: await findFirstFile(dir, ["去AI味质检.txt"]),
  };
  const imageDir = path.join(dir, "图片素材");
  const imageFiles = (await existsPath(imageDir))
    ? (await fs.readdir(imageDir, { withFileTypes: true }))
        .filter((item) => item.isFile())
        .map((item) => path.join(imageDir, item.name))
    : [];
  return {
    name: safe,
    path: dir,
    data,
    files,
    imageFiles,
    finalPost: await readText(files.finalPost),
    copyPost: await readText(files.copyPost),
    workflow: await readText(files.workflow),
    manual: await readText(files.manual),
    imageGuide: await readText(files.imageGuide),
    quality: await readText(files.quality),
    humanReview: await readText(files.humanReview),
  };
}

async function updatePackageMetadata(body = {}) {
  const safe = safeName(body.name);
  if (!safe) throw new Error("Package name is required");
  const dir = safeJoin(PATHS.drafts, safe);
  if (!dir || !(await existsPath(dir))) throw new Error("Package not found");

  const packageJson = await readPackageJson(dir);
  const file = packageJson.file || path.join(dir, "发布包数据.json");
  const data = packageJson.data && typeof packageJson.data === "object" ? packageJson.data : {};
  const now = new Date().toISOString();

  const publishStatus = String(body.publishStatus || "").trim();
  const publishedUrl = String(body.publishedUrl || "").trim();
  const reviewNotes = String(body.reviewNotes || "").trim();

  if (publishStatus) data.publishStatus = publishStatus;
  data.publishStatusUpdatedAt = now;
  data.publishedUrl = publishedUrl;
  data.reviewNotes = reviewNotes;
  if (publishStatus === "已发布" && !data.publishedAt) data.publishedAt = now;
  if (publishStatus !== "已发布" && body.clearPublishedAt) delete data.publishedAt;

  await writeJson(file, data);
  return getPackageDetail(safe);
}

async function tailFile(filePath, maxLines = 3000) {
  try {
    const stat = await fs.stat(filePath);
    const size = Math.min(stat.size, 2 * 1024 * 1024);
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
    await handle.close();
    return buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

async function dirSize(dir) {
  if (!(await existsPath(dir))) return 0;
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

async function getStatus() {
  const bridgeConfig = await readJson(PATHS.bridgeConfig, {});
  const notionConfig = await readJson(PATHS.notionConfig, {});
  const packages = await listDraftPackages();
  return {
    service: "小龙虾后台控制台",
    port: PORT,
    root: ROOT,
    dataDir: DATA_DIR,
    dataSizeMB: Math.round((await dirSize(DATA_DIR)) / 1024 / 1024),
    activeMode: bridgeConfig.active_mode || null,
    workflows: WORKFLOWS,
    xiaohongshu: notionConfig.xiaohongshu || {},
    imageGeneration: {
      enabled: Boolean(notionConfig.image_generation?.enabled),
      provider: notionConfig.image_generation?.provider || null,
      model: notionConfig.image_generation?.model || null,
      maxGeneratedImages: notionConfig.image_generation?.max_generated_images ?? null,
    },
    hermes: {
      enabled: Boolean(notionConfig.hermes?.enabled),
      mode: notionConfig.hermes?.mode || "research_only",
      provider: notionConfig.hermes?.provider || "command",
      command: notionConfig.hermes?.command || "hermes",
      fallbackOnError: notionConfig.hermes?.fallback_on_error !== false,
    },
    humanEditorRules: normalizeHumanEditorRulesForConfig(notionConfig.human_editor_rules || {}),
    customBusinessFlows: normalizeCustomBusinessFlowsForConfig(notionConfig.custom_business_flows || []),
    entryConfig: await getEntryConfig(),
    contentOptions: await getContentOptions(),
    knowledgeBase: await getKnowledgeBase(),
    notion: {
      intelConfigured: Boolean(notionConfig.notion?.database_id),
      contentConfigured: Boolean(notionConfig.content_publish?.database_id),
      xiaohongshuEnabled: Boolean(notionConfig.xiaohongshu?.enable_notion),
    },
    packages: {
      count: packages.length,
      latest: packages[0] || null,
      items: packages,
    },
    prefillStatus: await readJson(PATHS.prefillStatus, null),
  };
}

async function updateToggles(patch) {
  const config = await readJson(PATHS.notionConfig, {});
  config.xiaohongshu ||= {};
  config.image_generation ||= {};
  config.hermes ||= {};
  if (typeof patch.enableNotion === "boolean") config.xiaohongshu.enable_notion = patch.enableNotion;
  if (typeof patch.enablePrefill === "boolean") config.xiaohongshu.enable_prefill = patch.enablePrefill;
  if (typeof patch.enableImageGeneration === "boolean") config.image_generation.enabled = patch.enableImageGeneration;
  if (typeof patch.enableHermes === "boolean") config.hermes.enabled = patch.enableHermes;
  await writeJson(PATHS.notionConfig, config);
  return {
    xiaohongshu: config.xiaohongshu,
    hermes: config.hermes,
    imageGeneration: {
      enabled: Boolean(config.image_generation.enabled),
      provider: config.image_generation.provider || null,
      model: config.image_generation.model || null,
    },
  };
}

function normalizeHumanEditorRulesForConfig(value = {}) {
  const toLines = (input) => {
    if (Array.isArray(input)) return input.map((item) => String(item || "").trim()).filter(Boolean);
    return String(input || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  };
  const maxBodyChars = Number(value.maxBodyChars ?? value.max_body_chars);
  const minBodyChars = Number(value.minBodyChars ?? value.min_body_chars);
  return {
    enabled: value.enabled !== false,
    min_body_chars: Number.isFinite(minBodyChars) ? Math.max(100, Math.min(1500, Math.round(minBodyChars))) : 500,
    max_body_chars: Number.isFinite(maxBodyChars) ? Math.max(300, Math.min(2000, Math.round(maxBodyChars))) : 900,
    extra_rules: toLines(value.extraRules ?? value.extra_rules),
    banned_phrases: toLines(value.bannedPhrases ?? value.banned_phrases),
    required_details: toLines(value.requiredDetails ?? value.required_details),
  };
}

async function updateHumanEditorRules(patch) {
  const config = await readJson(PATHS.notionConfig, {});
  config.human_editor_rules = normalizeHumanEditorRulesForConfig(patch || {});
  await writeJson(PATHS.notionConfig, config);
  return { humanEditorRules: config.human_editor_rules };
}

function normalizeCustomBusinessFlowsForConfig(value = []) {
  const items = Array.isArray(value) ? value : [];
  const toLines = (input) => {
    if (Array.isArray(input)) return input.map((item) => String(item || "").trim()).filter(Boolean);
    return String(input || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  };
  return items
    .map((item, index) => {
      const id = String(item.id || `flow-${Date.now()}-${index}`).trim();
      const name = String(item.name || "").trim();
      return {
        id,
        name,
        enabled: item.enabled !== false,
        triggers: toLines(item.triggers),
        description: String(item.description || "").trim(),
        goal: String(item.goal || "").trim(),
        rules: toLines(item.rules),
        output_format: String(item.outputFormat ?? item.output_format ?? "").trim(),
        reply_prefix: String(item.replyPrefix ?? item.reply_prefix ?? "").trim(),
        created_at: item.created_at || new Date().toISOString(),
        updated_at: item.updated_at || item.created_at || new Date().toISOString(),
      };
    })
    .filter((item) => item.name && item.triggers.length);
}

async function saveCustomBusinessFlow(patch) {
  const config = await readJson(PATHS.notionConfig, {});
  const flows = normalizeCustomBusinessFlowsForConfig(config.custom_business_flows || []);
  const now = new Date().toISOString();
  const incoming = normalizeCustomBusinessFlowsForConfig([
    {
      ...patch,
      id: patch?.id || `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created_at: patch?.created_at || now,
      updated_at: now,
    },
  ])[0];
  if (!incoming) throw new Error("业务流名称和触发词不能为空");
  const index = flows.findIndex((item) => item.id === incoming.id);
  if (index >= 0) {
    incoming.created_at = flows[index].created_at || incoming.created_at;
    flows[index] = incoming;
  } else {
    flows.push(incoming);
  }
  config.custom_business_flows = flows;
  await writeJson(PATHS.notionConfig, config);
  return { customBusinessFlows: flows };
}

async function deleteCustomBusinessFlow(id) {
  const config = await readJson(PATHS.notionConfig, {});
  const flows = normalizeCustomBusinessFlowsForConfig(config.custom_business_flows || []).filter(
    (item) => item.id !== String(id || ""),
  );
  config.custom_business_flows = flows;
  await writeJson(PATHS.notionConfig, config);
  return { customBusinessFlows: flows };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/status") return sendJson(res, await getStatus());
  if (url.pathname === "/api/workflows") return sendJson(res, { items: WORKFLOWS });
  if (url.pathname === "/api/packages") return sendJson(res, { items: await listDraftPackages() });
  if (url.pathname === "/api/logs") return sendJson(res, { path: PATHS.bridgeLog, lines: await tailFile(PATHS.bridgeLog) });
  if (url.pathname === "/api/config") {
    return sendJson(res, {
      bridge: sanitizeConfig(await readJson(PATHS.bridgeConfig, {})),
      workflow: sanitizeConfig(await readJson(PATHS.notionConfig, {})),
      paths: PATHS,
    });
  }
  if (url.pathname === "/api/package") {
    const detail = await getPackageDetail(url.searchParams.get("name"));
    return detail ? sendJson(res, detail) : sendJson(res, { error: "Package not found" }, 404);
  }
  if (url.pathname === "/api/package/update" && req.method === "POST") {
    try {
      return sendJson(res, await updatePackageMetadata(await readBody(req)));
    } catch (error) {
      return sendJson(res, { error: error.message || String(error) }, 400);
    }
  }
  if (url.pathname === "/api/toggles" && req.method === "POST") {
    return sendJson(res, await updateToggles(await readBody(req)));
  }
  if (url.pathname === "/api/human-editor-rules" && req.method === "POST") {
    return sendJson(res, await updateHumanEditorRules(await readBody(req)));
  }
  if (url.pathname === "/api/business-flow" && req.method === "POST") {
    return sendJson(res, await saveCustomBusinessFlow(await readBody(req)));
  }
  if (url.pathname === "/api/business-flow/delete" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, await deleteCustomBusinessFlow(body.id));
  }
  if (url.pathname === "/api/entry-config" && req.method === "POST") {
    return sendJson(res, await updateEntryConfig(await readBody(req)));
  }
  if (url.pathname === "/api/content-task" && req.method === "POST") {
    return sendJson(res, await runConsoleContentTask(await readBody(req)));
  }
  if (url.pathname === "/api/content-task/preview" && req.method === "POST") {
    return sendJson(res, await previewConsoleContentTask(await readBody(req)));
  }
  if (url.pathname === "/api/viral-analysis" && req.method === "POST") {
    return sendJson(res, await runViralAnalysis(await readBody(req)));
  }
  if (url.pathname === "/api/xhs-parse" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, await parseXiaohongshuReference(body.sourceText || body.url || ""));
  }
  if (url.pathname === "/api/content-options" && req.method === "POST") {
    return sendJson(res, await updateContentOptions(await readBody(req)));
  }
  if (url.pathname === "/api/knowledge-base" && req.method === "POST") {
    return sendJson(res, await updateKnowledgeBase(await readBody(req)));
  }
  if (url.pathname === "/api/knowledge-base/delete" && req.method === "POST") {
    return sendJson(res, await deleteKnowledgeBaseItem(await readBody(req)));
  }
  return sendJson(res, { error: "Not found" }, 404);
}

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>小龙虾后台控制台</title>
  <style>
    :root {
      --bg: #0B1118;
      --sidebar: #101923;
      --panel: #151F2A;
      --panel-2: #1B2734;
      --line: #2A3747;
      --text: #F3F7FA;
      --text-muted: #AAB6C3;
      --text-soft: #6F7D8C;
      --brand: #FF4D3D;
      --primary: #4F7DFF;
      --success: #45C979;
      --warning: #FFB020;
      --danger: #FF5A5F;
      --ai: #8B5CF6;
      --ink: var(--text);
      --muted: var(--text-muted);
      --teal: var(--primary);
      --gold: var(--warning);
      --green: var(--success);
      --shadow: 0 18px 45px rgba(0, 0, 0, .28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      overflow-x: hidden;
      color: var(--text);
      font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 8% 5%, rgba(255, 77, 61, .18), transparent 28rem),
        radial-gradient(circle at 92% 12%, rgba(79, 125, 255, .18), transparent 26rem),
        linear-gradient(135deg, #0B1118, #0D1722 52%, #111B27);
    }
    .layout { display: grid; grid-template-columns: 252px minmax(0, 1fr); min-height: 100vh; max-width: 100vw; overflow-x: hidden; }
    aside {
      padding: 0;
      border-right: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(16,25,35,.96), rgba(11,17,24,.96)),
        var(--sidebar);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .brand {
      height: 78px;
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }
    .brand-mark {
      width: 38px;
      height: 38px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 35% 30%, rgba(255,255,255,.16), transparent 34%),
        linear-gradient(135deg, #ff2d3f, var(--brand));
      box-shadow: 0 10px 28px rgba(255,77,61,.20);
      font-size: 20px;
    }
    .logo { font-size: 16px; font-weight: 950; letter-spacing: -.06em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tagline { margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    nav { display: grid; gap: 8px; padding: 10px 14px; overflow-y: auto; flex: 1; align-content: start; }
    .nav-group { display: grid; gap: 3px; }
    .nav-group + .nav-group {
      border-top: 1px solid var(--line);
      padding-top: 9px;
    }
    .nav-title {
      color: var(--text-soft);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: .12em;
      text-transform: uppercase;
      padding: 10px 10px 2px;
    }
    .tab, .nav-soon {
      border: 0;
      border-radius: 10px;
      padding: 8px 11px;
      color: var(--muted);
      background: transparent;
      text-align: left;
      cursor: pointer;
      font-size: 13px;
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) auto;
      gap: 9px;
      align-items: center;
      width: 100%;
    }
    .tab span:nth-child(2), .nav-soon span:nth-child(2) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .nav-icon {
      width: 20px;
      height: 20px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      color: var(--text-muted);
      background: rgba(243,247,250,.08);
      font-size: 12px;
      font-weight: 900;
    }
    .tab.active {
      color: var(--text);
      background: linear-gradient(135deg, rgba(79,125,255,.92), rgba(72,66,180,.92));
      box-shadow: 0 12px 30px rgba(79,125,255,.20);
    }
    .tab.active .nav-icon {
      color: var(--text);
      background: rgba(255,255,255,.16);
    }
    .nav-soon {
      color: var(--text-soft);
      font-size: 12px;
      cursor: default;
      opacity: .76;
    }
    .soon-badge {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 5px;
      color: var(--text-soft);
      font-size: 9px;
      font-weight: 900;
      opacity: .72;
    }
    .sidebar-footer {
      border-top: 1px solid var(--line);
      padding: 10px 16px;
    }
    .collapse-menu {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text-muted);
      font-weight: 800;
      padding: 7px 10px;
      border-radius: 12px;
    }
    .content-shell { min-width: 0; }
    .topbar {
      height: 78px;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 14px;
      padding: 0 26px;
      border-bottom: 1px solid var(--line);
      background: rgba(11,17,24,.64);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .topbar-status {
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 9px 12px;
      background: rgba(21,31,42,.78);
      color: var(--text);
      font-weight: 850;
    }
    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--success);
      box-shadow: 0 0 0 4px rgba(69,201,121,.12);
    }
    .model-chip {
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 9px 13px;
      background: rgba(21,31,42,.78);
      font-weight: 900;
    }
    .model-dot {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: var(--ai);
      color: var(--text);
      font-size: 12px;
    }
    .topbar-icon {
      width: 36px;
      height: 36px;
      border: 0;
      border-radius: 12px;
      display: grid;
      place-items: center;
      color: var(--text-muted);
      background: transparent;
      font-size: 18px;
      cursor: pointer;
    }
    .topbar-avatar {
      width: 40px;
      height: 40px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #94A3B8, #CBD5E1);
      color: #0B1118;
      font-size: 18px;
      font-weight: 900;
    }
    main { padding: 18px 24px; min-width: 0; overflow-x: hidden; }
    .hero { display: none; }
    h1 { margin: 0; font-size: 30px; letter-spacing: -.07em; }
    h2 { margin: 0 0 10px; font-size: 18px; letter-spacing: -.03em; }
    h3 { margin: 0 0 6px; font-size: 14px; }
    .sub { color: var(--muted); line-height: 1.5; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .flow-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .workflow-detail-grid { display: grid; gap: 12px; margin-top: 12px; }
    .workflow-detail-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--panel-2);
      padding: 14px;
    }
    .workflow-detail-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      margin-bottom: 10px;
    }
    .workflow-detail-title { font-size: 18px; font-weight: 950; letter-spacing: -.03em; }
    .workflow-detail-role { color: var(--teal); font-size: 13px; font-weight: 900; margin-top: 3px; }
    .workflow-detail-body { display: grid; grid-template-columns: 1.1fr .9fr; gap: 12px; }
    .workflow-block {
      border-radius: 13px;
      background: rgba(27, 39, 52, .78);
      padding: 10px;
    }
    .workflow-block h3 { font-size: 13px; margin-bottom: 7px; }
    .workflow-list { margin: 0; padding-left: 18px; color: var(--text-muted); line-height: 1.55; font-size: 13px; }
    .workflow-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .workflow-tag { border-radius: 999px; padding: 4px 8px; background: rgba(79,125,255,.12); border: 1px solid rgba(79,125,255,.22); font-size: 12px; color: var(--text-muted); font-weight: 800; }
    .business-flow-builder { display: grid; grid-template-columns: minmax(0, .95fr) minmax(0, 1.05fr); gap: 12px; }
    .business-flow-list { display: grid; gap: 8px; }
    .business-flow-item {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel-2);
      padding: 10px;
      display: grid;
      gap: 7px;
    }
    .business-flow-title { display: flex; justify-content: space-between; gap: 8px; align-items: center; font-weight: 950; }
    .business-flow-meta { display: flex; flex-wrap: wrap; gap: 5px; }
    .field-help { color: var(--muted); font-size: 12px; line-height: 1.45; }
    .template-row { display: flex; flex-wrap: wrap; gap: 7px; margin: 8px 0 12px; }
    .mini-guide {
      border: 1px dashed var(--line);
      border-radius: 14px;
      padding: 10px;
      background: rgba(27, 39, 52, .72);
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 12px;
    }
    .production-dashboard { display: grid; gap: 12px; }
    .dashboard-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 16px;
      background:
        radial-gradient(circle at 18% 12%, rgba(217, 85, 47, .20), transparent 22rem),
        linear-gradient(135deg, rgba(21, 31, 42, .98), rgba(11, 17, 24, .96));
      color: var(--text);
    }
    .dashboard-hero h2 { color: var(--text); margin-bottom: 4px; font-size: 22px; }
    .dashboard-hero .sub { color: var(--text-muted); }
    .hero-status { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .hero-chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 10px;
      background: rgba(79,125,255,.12);
      color: var(--text);
      font-size: 13px;
      font-weight: 800;
    }
    .production-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .metric-card {
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
    }
    .metric-icon {
      width: 46px;
      height: 46px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      font-weight: 950;
      color: var(--text);
      background: linear-gradient(135deg, var(--primary), var(--ai));
    }
    .metric-card:nth-child(2) .metric-icon { background: linear-gradient(135deg, #238B57, var(--success)); }
    .metric-card:nth-child(3) .metric-icon { background: linear-gradient(135deg, #C36C12, var(--warning)); }
    .metric-card:nth-child(4) .metric-icon { background: linear-gradient(135deg, var(--ai), #B66CFF); }
    .dashboard-main-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); gap: 12px; align-items: start; }
    .dashboard-section-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    .dashboard-section-head h2 { margin: 0; }
    .hero-actions { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 2px; }
    .task-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 12px;
      background: var(--panel-2);
    }
    .task-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .task-title { font-size: 16px; font-weight: 950; line-height: 1.4; }
    .task-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .task-meta .pill { font-size: 11px; }
    .progress-bar {
      height: 8px;
      border-radius: 999px;
      background: #263648;
      overflow: hidden;
      margin-top: 12px;
    }
    .progress-fill {
      height: 100%;
      width: 78%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--primary), var(--ai));
    }
    .pipeline { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 14px 0 10px; }
    .pipeline-step { display: grid; gap: 5px; justify-items: center; color: var(--muted); font-size: 12px; }
    .pipeline-dot {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: #263648;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 950;
    }
    .pipeline-step.done .pipeline-dot { background: var(--primary); color: var(--text); }
    .pipeline-step.active .pipeline-dot { background: transparent; color: var(--primary); border: 3px solid var(--primary); }
    .reminder-list, .recent-output-list, .suggestion-list { display: grid; gap: 8px; }
    .reminder-item, .recent-output-item, .suggestion-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border-radius: 13px;
      border: 1px solid var(--line);
      background: var(--panel-2);
    }
    .reminder-item { grid-template-columns: 28px minmax(0, 1fr) auto; }
    .priority-dot {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 950;
      color: var(--text);
      background: rgba(79,125,255,.28);
    }
    .priority-dot.warning { background: rgba(255,176,32,.34); }
    .priority-dot.success { background: rgba(69,201,121,.28); }
    .suggestion-item { grid-template-columns: 30px minmax(0, 1fr); align-items: start; }
    .suggestion-index {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: rgba(139,92,246,.32);
      color: var(--text);
      font-size: 12px;
      font-weight: 950;
    }
    .recent-output-item { grid-template-columns: 42px minmax(0, 1fr) auto auto; }
    .output-logo {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      color: var(--text);
      background: linear-gradient(135deg, #ff2442, var(--brand));
      font-size: 12px;
      font-weight: 950;
    }
    .dashboard-stack { display: grid; gap: 12px; }
    .status-tag {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border-radius: 999px;
      padding: 3px 8px;
      background: rgba(255,176,32,.16);
      color: var(--warning);
      font-size: 11px;
      font-weight: 900;
    }
    .status-tag.done { background: rgba(69,201,121,.16); color: var(--success); }
    .status-tag.ai { background: rgba(139,92,246,.18); color: #CBB7FF; }
    .publish-center { display: grid; gap: 12px; }
    .publish-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
    }
    .publish-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .publish-stat {
      border: 1px solid var(--line);
      border-radius: 15px;
      padding: 12px;
      background: var(--panel-2);
    }
    .publish-stat strong { display: block; margin-top: 4px; font-size: 22px; letter-spacing: -.04em; }
    .publish-toolbar {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .publish-filter-group { display: flex; flex-wrap: wrap; gap: 7px; }
    .publish-filter-group .btn.active { border-color: var(--primary); background: rgba(79,125,255,.20); }
    .publish-table-wrap { overflow-x: auto; }
    .publish-title-cell { min-width: 300px; }
    .publish-title-cell strong { display: block; margin-bottom: 4px; }
    .publish-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .publish-detail-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 12px; align-items: start; }
    .publish-detail-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 12px;
      background: var(--panel-2);
    }
    .publish-meta-form {
      display: grid;
      gap: 10px;
      margin-bottom: 12px;
    }
    .publish-meta-form label {
      display: grid;
      gap: 6px;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 800;
    }
    .publish-meta-form select,
    .publish-meta-form input,
    .publish-meta-form textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 9px 10px;
      background: rgba(255,255,255,.045);
      color: var(--text);
      outline: none;
      font: inherit;
      resize: vertical;
    }
    .publish-meta-form textarea { min-height: 82px; }
    .publish-meta-line {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin: 8px 0;
    }
    .publish-copy-box { max-height: 520px; }
    .hub-page { display: grid; gap: 14px; }
    .hub-hero {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: center;
      background:
        radial-gradient(circle at 0 0, rgba(255,77,77,.16), transparent 34%),
        linear-gradient(135deg, rgba(79,125,255,.12), rgba(255,255,255,.03));
    }
    .hub-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .topic-card-grid,
    .knowledge-hub-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .topic-card,
    .knowledge-hub-card,
    .material-item {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 13px;
      background: rgba(255,255,255,.045);
    }
    .topic-card h3,
    .knowledge-hub-card h3,
    .material-item h3 { margin: 0 0 6px; font-size: 16px; }
    .topic-meta,
    .material-meta {
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
      margin: 9px 0;
    }
    .material-list { display: grid; gap: 10px; }
    .material-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }
    .knowledge-hub-card ul {
      margin: 8px 0 0;
      padding-left: 18px;
      color: var(--text-muted);
    }
    .knowledge-hub-card li { margin: 5px 0; }
    .viral-workspace {
      display: grid;
      grid-template-columns: minmax(440px, 1fr) minmax(280px, 360px);
      gap: 10px;
      align-items: start;
      min-width: 0;
    }
    .viral-result { display: grid; gap: 8px; min-width: 0; }
    .viral-section {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px;
      background: rgba(255,255,255,.045);
      min-width: 0;
    }
    .viral-section h3 { margin: 0 0 6px; font-size: 15px; }
    .viral-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .viral-list li {
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px;
      padding: 7px 8px;
      color: var(--text-muted);
      background: rgba(0,0,0,.12);
      overflow-wrap: anywhere;
    }
    .viral-angle-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 11px;
      background: rgba(79,125,255,.08);
      display: grid;
      gap: 7px;
    }
    .viral-angle-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .viral-score {
      min-width: 42px;
      height: 28px;
      border-radius: 999px;
      display: inline-grid;
      place-items: center;
      color: #fff;
      background: linear-gradient(135deg, var(--primary), var(--ai));
      font-weight: 900;
      font-size: 12px;
    }
    .viral-warning {
      border-color: rgba(255,176,32,.36);
      background:
        radial-gradient(circle at 0 0, rgba(255,176,32,.18), transparent 32%),
        rgba(255,176,32,.07);
    }
    .helper-example {
      margin-top: 6px;
      padding: 8px;
      border-radius: 10px;
      color: var(--text-muted);
      background: rgba(0,0,0,.16);
      border: 1px dashed rgba(255,255,255,.14);
      font-size: 12px;
      line-height: 1.5;
    }
    .parsed-reference {
      grid-column: 1 / -1;
      margin-top: 0;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px;
      background: rgba(0,0,0,.14);
      display: grid;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
    }
    .viral-reference-panel {
      background:
        radial-gradient(circle at 0 0, rgba(79,125,255,.12), transparent 24rem),
        rgba(11,17,24,.74);
    }
    .reference-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
      gap: 10px;
      align-items: start;
      min-width: 0;
    }
    .reference-main,
    .reference-side {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .reference-text-box {
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 11px;
      padding: 9px;
      background: rgba(0,0,0,.12);
      color: var(--text);
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      min-width: 0;
    }
    .reference-text-box a {
      color: var(--primary);
      overflow-wrap: anywhere;
      word-break: break-all;
    }
    .reference-desc {
      max-height: 300px;
      overflow: auto;
    }
    .reference-image-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 7px;
      min-width: 0;
    }
    .reference-image {
      position: relative;
      aspect-ratio: 1 / 1;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
    }
    .reference-image img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .reference-image span {
      position: absolute;
      left: 6px;
      top: 6px;
      border-radius: 999px;
      padding: 2px 6px;
      color: #fff;
      background: rgba(0,0,0,.55);
      font-size: 11px;
      font-weight: 800;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px;
      box-shadow: var(--shadow);
    }
    .metric { font-size: 22px; font-weight: 900; letter-spacing: -.04em; }
    .label { color: var(--muted); font-size: 12px; font-weight: 700; margin-bottom: 5px; }
    .section { margin-top: 12px; }
    .pill {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--text-muted);
      background: rgba(79,125,255,.10);
      font-size: 12px;
    }
    .btn {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 11px;
      background: var(--panel-2);
      color: var(--text);
      cursor: pointer;
      font-weight: 700;
    }
    .btn.primary { border-color: var(--primary); background: var(--primary); color: var(--text); }
    .btn.small { padding: 5px 8px; font-size: 12px; }
    .actions { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .field { display: grid; gap: 6px; }
    .field label { font-size: 13px; font-weight: 900; color: var(--ink); }
    .field input, .field textarea, .field select {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 8px 10px;
      background: var(--panel-2);
      color: var(--text);
      font: inherit;
      line-height: 1.55;
      outline: none;
    }
    .field textarea { min-height: 78px; resize: vertical; }
    .field.full { grid-column: 1 / -1; }
    #viral .hub-page { gap: 10px; }
    #viral .hub-hero { padding: 12px 14px; }
    #viral .hub-hero h2 { margin-bottom: 4px; }
    #viral .card { padding: 12px; }
    #viral .dashboard-section-head { margin-bottom: 8px; }
    .task-result {
      margin-top: 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: rgba(27,39,52,.72);
      white-space: pre-wrap;
      line-height: 1.6;
      color: var(--text-muted);
    }
    .workbench-shell { display: grid; gap: 14px; }
    .workbench-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(330px, auto);
      gap: 14px;
      align-items: center;
      padding: 16px 18px;
      background:
        radial-gradient(circle at 12% 15%, rgba(79,125,255,.20), transparent 22rem),
        linear-gradient(135deg, rgba(21,31,42,.96), rgba(11,17,24,.96));
    }
    .workbench-hero h2 { font-size: 24px; margin-bottom: 6px; }
    .workbench-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(110px, 1fr));
      gap: 8px;
      min-width: 360px;
    }
    .workbench-stat {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px;
      background: rgba(27,39,52,.72);
    }
    .workbench-stat strong { display: block; font-size: 20px; margin-top: 4px; }
    .task-board {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(340px, .65fr);
      gap: 12px;
      align-items: start;
    }
    .task-panel {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .task-board .task-panel:nth-child(1),
    .task-board .task-panel:nth-child(2) {
      grid-column: 1;
    }
    .task-panel-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
      margin-bottom: 2px;
    }
    .task-panel-head h3 { font-size: 16px; margin: 0; }
    .task-panel-kicker {
      color: var(--primary);
      font-size: 11px;
      font-weight: 950;
      letter-spacing: .12em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .task-panel-index {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: rgba(79,125,255,.18);
      color: var(--text);
      font-size: 12px;
      font-weight: 950;
    }
    .task-panel .field textarea { min-height: 78px; }
    .task-panel .field.full textarea { min-height: 96px; }
    .task-actions-card {
      grid-column: 2;
      grid-row: 1 / span 2;
      position: sticky;
      top: 92px;
      border-color: rgba(79,125,255,.34);
      background:
        radial-gradient(circle at 90% 8%, rgba(139,92,246,.18), transparent 18rem),
        var(--panel);
    }
    .task-primary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .task-primary-grid .field.full { grid-column: 1 / -1; }
    .task-checklist {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .task-check {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .task-check span:first-child {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: rgba(69,201,121,.14);
      color: var(--success);
      font-size: 11px;
      font-weight: 950;
    }
    .task-preview-box {
      display: grid;
      gap: 8px;
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px;
      background: rgba(11,17,24,.38);
    }
    .preview-group {
      display: grid;
      gap: 5px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--line);
    }
    .preview-group:last-child { border-bottom: 0; padding-bottom: 0; }
    .preview-title {
      color: var(--text);
      font-size: 12px;
      font-weight: 950;
    }
    .preview-item {
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .result-card {
      display: grid;
      gap: 10px;
    }
    .result-card h3 {
      margin: 0;
      font-size: 16px;
      line-height: 1.35;
    }
    .result-meta {
      display: grid;
      gap: 6px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .result-meta code {
      display: block;
      padding: 7px 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--text);
      background: rgba(11,17,24,.48);
      white-space: normal;
      word-break: break-all;
    }
    .result-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
    }
    .result-actions .btn { width: 100%; }
    .result-reply {
      max-height: 220px;
      overflow: auto;
      border-top: 1px solid var(--line);
      padding-top: 8px;
      color: var(--text-muted);
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.55;
    }
    .library-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(320px, .95fr);
      gap: 12px;
      align-items: start;
    }
    .collapsible-section summary {
      cursor: pointer;
      font-weight: 950;
      list-style: none;
    }
    .collapsible-section summary::-webkit-details-marker { display: none; }
    .knowledge-manager {
      display: grid;
      grid-template-columns: minmax(260px, .8fr) minmax(0, 1.2fr);
      gap: 12px;
    }
    .knowledge-list {
      display: grid;
      gap: 8px;
      max-height: 460px;
      overflow: auto;
    }
    .knowledge-item {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      background: rgba(27,39,52,.72);
    }
    .knowledge-item strong { display: block; margin-bottom: 4px; }
    .rule-list { display: grid; gap: 6px; }
    .rule-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; }
    .rule-item input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 11px;
      padding: 8px 10px;
      background: var(--panel-2);
      color: var(--text);
      font: inherit;
      outline: none;
    }
    .rule-item .btn { padding: 6px 9px; }
    .rule-toolbar { margin-top: 6px; }
    .save-state { margin-left: 10px; color: var(--muted); font-size: 13px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 13px; }
    td { font-size: 14px; line-height: 1.55; }
    pre {
      margin: 10px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 420px;
      overflow: auto;
      padding: 12px;
      border-radius: 14px;
      background: #070B10;
      color: var(--text-muted);
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 13px;
      line-height: 1.6;
    }
    .log-toolbar {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin: 14px 0 10px;
    }
    .log-filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .log-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      overflow: visible;
      padding-right: 0;
    }
    .log-entry {
      display: grid;
      grid-template-columns: 132px 68px minmax(0, 1fr);
      gap: 10px;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: 13px;
      background: var(--panel-2);
      box-shadow: 0 8px 22px rgba(67, 42, 24, .05);
      min-height: 88px;
    }
    .workflow-run-list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .workflow-run-card {
      border: 1px solid var(--line);
      border-radius: 15px;
      padding: 12px;
      background: var(--panel-2);
      box-shadow: 0 10px 28px rgba(67, 42, 24, .06);
      max-width: none;
    }
    .workflow-run-card.failed { border-color: rgba(255,90,95,.55); background: rgba(255,90,95,.10); }
    .workflow-run-card.running { border-color: rgba(255,176,32,.55); background: rgba(255,176,32,.10); }
    .workflow-run-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
      margin-bottom: 7px;
    }
    .workflow-run-title { font-size: 14px; font-weight: 900; line-height: 1.35; }
    .workflow-run-meta { color: var(--muted); font-size: 11px; line-height: 1.45; }
    .workflow-steps {
      display: grid;
      gap: 6px;
      margin-top: 8px;
    }
    .workflow-step {
      padding: 7px 8px;
      border-radius: 11px;
      background: rgba(27,39,52,.80);
    }
    .workflow-step.ai-step {
      border: 1px solid rgba(79,125,255,.25);
      background: linear-gradient(135deg, rgba(79,125,255,.14), rgba(27,39,52,.76));
    }
    .workflow-step.hermes-step {
      border-color: rgba(139,92,246,.38);
      background: linear-gradient(135deg, rgba(139,92,246,.16), rgba(27,39,52,.76));
    }
    .workflow-step.image-step {
      border-color: rgba(255,77,61,.38);
      background: linear-gradient(135deg, rgba(255,77,61,.13), rgba(27,39,52,.76));
    }
    .workflow-step.system-step {
      background: rgba(27,39,52,.70);
    }
    .workflow-step-title { font-weight: 800; font-size: 12px; }
    .workflow-step-desc { margin-top: 2px; color: var(--muted); font-size: 11px; line-height: 1.35; }
    .workflow-step-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 5px;
    }
    .step-chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 6px;
      background: rgba(243,247,250,.10);
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 900;
    }
    .step-chip.ai { color: var(--text); background: rgba(79,125,255,.32); }
    .step-chip.image { color: var(--text); background: rgba(255,77,61,.30); }
    .step-chip.hermes { color: var(--text); background: rgba(139,92,246,.32); }
    .step-chip.done { color: var(--text); background: rgba(69,201,121,.30); }
    .log-section-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-end;
      margin: 12px 0 8px;
    }
    .log-section-title h3 { margin: 0; }
    .live-log-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .live-log-list .log-entry { min-height: 0; }
    .log-entry.noisy { opacity: .62; }
    .log-time { color: var(--muted); font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; }
    .log-level {
      width: fit-content;
      height: fit-content;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .02em;
      background: rgba(111,125,140,.24);
    }
    .log-level.INFO { color: var(--text); background: rgba(69,201,121,.26); }
    .log-level.WARN { color: var(--text); background: rgba(255,176,32,.30); }
    .log-level.ERROR { color: var(--text); background: rgba(255,90,95,.30); }
    .log-level.DEBUG { color: var(--text); background: rgba(111,125,140,.32); }
    .log-message { font-weight: 800; }
    .log-explain {
      margin-top: 4px;
      color: var(--text-muted);
      line-height: 1.55;
    }
    .log-action {
      display: inline-flex;
      width: fit-content;
      margin-top: 8px;
      border-radius: 999px;
      padding: 4px 8px;
      background: rgba(79,125,255,.16);
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 800;
    }
    .log-detail {
      margin-top: 7px;
      color: var(--muted);
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
      overflow: auto;
    }
    .log-empty {
      padding: 16px;
      border: 1px dashed var(--line);
      border-radius: 14px;
      color: var(--muted);
      background: rgba(27,39,52,.68);
    }
    .logs-page {
      display: grid;
      gap: 10px;
    }
    .logs-command {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      padding: 14px;
      background:
        linear-gradient(135deg, rgba(21,31,42,.96), rgba(11,17,24,.96)),
        var(--ink);
      color: var(--text);
    }
    .logs-command h2 { margin-bottom: 6px; color: var(--text); }
    .logs-command .sub { color: var(--text-muted); }
    .logs-command .btn {
      background: rgba(79,125,255,.12);
      border-color: var(--line);
      color: var(--text);
    }
    .logs-command .btn.primary {
      background: var(--primary);
      color: var(--text);
      border-color: var(--primary);
    }
    .log-overview {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .log-overview-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 8px 10px;
      background: rgba(27,39,52,.78);
    }
    .log-overview-label {
      color: var(--text-soft);
      font-size: 12px;
      font-weight: 800;
    }
    .log-overview-value {
      margin-top: 2px;
      font-size: 17px;
      font-weight: 950;
      letter-spacing: -.04em;
    }
    .logs-workspace {
      display: grid;
      grid-template-columns: minmax(340px, .78fr) minmax(0, 1.35fr);
      gap: 10px;
      align-items: start;
    }
    .log-panel {
      padding: 0;
      overflow: hidden;
    }
    .log-panel-head {
      padding: 12px 14px 9px;
      border-bottom: 1px solid var(--line);
      background: rgba(27,39,52,.78);
    }
    .log-panel-head h3 {
      margin: 0;
      font-size: 15px;
      letter-spacing: -.03em;
    }
    .log-panel-body {
      padding: 10px;
    }
    .live-panel {
      position: sticky;
      top: 18px;
    }
    .live-log-list {
      grid-template-columns: 1fr;
    }
    .live-log-list .log-entry {
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 8px 10px;
      padding: 11px 12px;
    }
    .live-log-list .log-entry > div:nth-child(2) {
      grid-row: 1;
      grid-column: 2;
      justify-self: start;
    }
    .live-log-list .log-entry > div:nth-child(3) {
      grid-column: 1 / -1;
    }
    .workflow-history .workflow-run-card {
      max-width: none;
    }
    .entry-page {
      display: grid;
      gap: 12px;
    }
    .entry-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(320px, .72fr);
      gap: 12px;
      align-items: start;
    }
    .entry-card-list {
      display: grid;
      gap: 10px;
    }
    .entry-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 13px 14px;
      background: rgba(21,31,42,.72);
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      cursor: pointer;
      transition: border-color .18s ease, transform .18s ease, background .18s ease;
    }
    .entry-card:hover,
    .entry-card.active {
      border-color: rgba(79,125,255,.62);
      background: rgba(27,39,52,.92);
      transform: translateY(-1px);
    }
    .entry-type-icon {
      width: 38px;
      height: 38px;
      border-radius: 13px;
      display: grid;
      place-items: center;
      font-weight: 950;
      background: linear-gradient(135deg, rgba(79,125,255,.95), rgba(139,92,246,.9));
      color: var(--text);
      box-shadow: 0 12px 24px rgba(79,125,255,.16);
    }
    .entry-card-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 950;
      letter-spacing: -.03em;
    }
    .entry-card-desc {
      margin-top: 5px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .entry-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 9px;
    }
    .entry-tag {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 7px;
      color: var(--text-muted);
      font-size: 11px;
      background: rgba(243,247,250,.04);
    }
    .entry-editor {
      position: sticky;
      top: 92px;
    }
    .entry-editor textarea {
      min-height: 96px;
    }
    .entry-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .entry-metric {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px 12px;
      background: rgba(27,39,52,.72);
    }
    .entry-metric strong {
      display: block;
      margin-top: 4px;
      font-size: 22px;
      letter-spacing: -.04em;
    }
    .view { display: none; }
    .view.active { display: block; }
    .detail { display: none; margin-top: 16px; }
    .detail.active { display: block; }
    .ok { color: var(--success); font-weight: 800; }
    .warn { color: var(--warning); font-weight: 800; }
    .bad { color: var(--danger); font-weight: 800; }
    .muted { color: var(--muted); }
    .switch-row { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .switch-row strong { font-size: 14px; }
    @media (max-width: 1080px) {
      .layout { grid-template-columns: 1fr; }
      aside { position: static; }
      .grid, .flow-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .log-entry { grid-template-columns: 1fr; gap: 7px; min-height: 0; }
      .logs-command { grid-template-columns: 1fr; }
      .logs-workspace { grid-template-columns: 1fr; }
      .live-panel { position: static; }
      .task-board { grid-template-columns: 1fr; }
      .task-actions-card { position: static; }
      .task-board .task-panel:nth-child(1),
      .task-board .task-panel:nth-child(2),
      .task-actions-card {
        grid-column: auto;
        grid-row: auto;
      }
      .entry-layout { grid-template-columns: 1fr; }
      .entry-editor { position: static; }
      .library-grid { grid-template-columns: 1fr; }
      .workbench-hero { grid-template-columns: 1fr; }
      .workbench-stats { min-width: 0; }
      .topic-card-grid, .knowledge-hub-grid, .hub-stats { grid-template-columns: 1fr; }
      .material-item { grid-template-columns: 1fr; }
      .viral-workspace { grid-template-columns: 1fr; }
      .reference-layout { grid-template-columns: 1fr; }
      .reference-image-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      main { padding: 16px; }
      .grid, .flow-grid { grid-template-columns: 1fr; }
      .hero { flex-direction: column; }
      .task-primary-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .log-list { grid-template-columns: 1fr; }
      .workflow-run-list { grid-template-columns: 1fr; }
      .live-log-list { grid-template-columns: 1fr; }
      .log-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <div class="brand">
        <div class="brand-mark">虾</div>
        <div>
          <div class="logo">小龙虾内容生产控制台</div>
          <div class="tagline">内容生产 · 流程管理 · 智能发布</div>
        </div>
      </div>
      <nav>
        <div class="nav-group">
          <button class="tab active" data-view="dashboard"><span class="nav-icon">⌂</span><span>总览</span></button>
          <button class="tab" data-view="topics"><span class="nav-icon">◉</span><span>选题中心</span></button>
          <button class="tab" data-view="viral"><span class="nav-icon">火</span><span>爆款拆解</span></button>
          <button class="tab" data-view="materials"><span class="nav-icon">▣</span><span>素材/情报库</span></button>
          <button class="tab" data-view="knowledge"><span class="nav-icon">□</span><span>知识库</span></button>
          <button class="tab" data-view="contentTasks"><span class="nav-icon">✓</span><span>内容工作台</span></button>
          <button class="tab" data-view="packages"><span class="nav-icon">▤</span><span>内容资产</span></button>
          <button class="tab" data-view="reviews"><span class="nav-icon">↻</span><span>复盘分析</span></button>
        </div>
        <div class="nav-group">
          <button class="tab" data-view="workflows"><span class="nav-icon">⌘</span><span>流程编排</span></button>
          <button class="tab" data-view="entries"><span class="nav-icon">入</span><span>入口管理</span></button>
          <button class="nav-soon"><span class="nav-icon">◎</span><span>Skill 管理</span><span class="soon-badge">规划中</span></button>
          <button class="nav-soon"><span class="nav-icon">✚</span><span>插件管理</span><span class="soon-badge">规划中</span></button>
        </div>
        <div class="nav-group">
          <button class="nav-soon"><span class="nav-icon">AI</span><span>模型/API</span><span class="soon-badge">规划中</span></button>
          <button class="nav-soon"><span class="nav-icon">≡</span><span>任务队列</span><span class="soon-badge">规划中</span></button>
          <button class="tab" data-view="settings"><span class="nav-icon">⚙</span><span>开关配置</span></button>
          <button class="tab" data-view="logs"><span class="nav-icon">▥</span><span>运行日志</span></button>
        </div>
      </nav>
      <div class="sidebar-footer">
        <div class="collapse-menu"><span class="nav-icon">‹</span><span>收起菜单</span></div>
      </div>
    </aside>
    <div class="content-shell">
      <header class="topbar">
        <div class="topbar-status"><span class="status-dot"></span><span>在线</span></div>
        <div class="model-chip"><span class="model-dot">AI</span><span id="topbarModelState">GPT-5.4</span></div>
        <button class="topbar-icon" type="button" title="通知">⌁</button>
        <button class="topbar-icon" type="button" title="帮助">?</button>
        <div class="topbar-avatar">人</div>
      </header>
      <main>
      <div class="hero">
        <div>
          <h1>内容生产控制台</h1>
          <div class="sub">当前先做“看得清、控得住、可复盘”。后续再加知识库编辑、任务队列和网页发起任务。</div>
        </div>
        <button class="btn primary" onclick="refreshAll()">刷新状态</button>
      </div>

      <section id="dashboard" class="view active">
        <div class="grid">
          <div class="card"><div class="label">运行模式</div><div class="metric" id="activeMode">-</div></div>
          <div class="card"><div class="label">发布包</div><div class="metric" id="packageCount">-</div></div>
          <div class="card"><div class="label">数据目录</div><div class="metric" id="dataSize">-</div></div>
          <div class="card"><div class="label">Notion</div><div class="metric" id="notionState">-</div></div>
        </div>
        <div class="section card">
          <h2>关键状态</h2>
          <table><tbody id="statusTable"></tbody></table>
        </div>
      </section>

      <section id="topics" class="view">
        <div class="hub-page">
          <section class="card hub-hero">
            <div>
              <div class="task-panel-kicker">Topic Center</div>
              <h2>选题中心</h2>
              <p class="sub">把“最近生成过什么、知识库里有什么方向、哪些还没发布”汇总成候选选题。V1 先做选题池和一键带入内容工作台。</p>
            </div>
            <button class="btn primary" onclick="showView(&quot;contentTasks&quot;)">新建内容任务</button>
          </section>
          <div class="hub-stats">
            <div class="publish-stat"><div class="label">候选选题</div><strong id="topicCandidateCount">-</strong></div>
            <div class="publish-stat"><div class="label">待发布转化</div><strong id="topicPendingCount">-</strong></div>
            <div class="publish-stat"><div class="label">知识主题</div><strong id="topicKnowledgeCount">-</strong></div>
          </div>
          <section class="card">
            <div class="dashboard-section-head"><h2>推荐候选题</h2><span class="pill">从内容资产 + 知识库生成</span></div>
            <div id="topicCandidateList" class="topic-card-grid"></div>
          </section>
        </div>
      </section>

      <section id="viral" class="view">
        <div class="hub-page">
          <section class="card hub-hero">
            <div>
              <div class="task-panel-kicker">Viral Deconstruction</div>
              <h2>爆款拆解</h2>
              <p class="sub">先把对标笔记的原文和原图拿出来看清楚，再决定要不要进入拆解、迁移和内容生成。</p>
            </div>
            <button class="btn" onclick="showView(&quot;contentTasks&quot;)">去内容工作台</button>
          </section>
          <div class="viral-workspace">
            <section class="card">
              <div class="dashboard-section-head"><h2>第 1 步：解析原文原图</h2><span class="pill">先看素材，不做总结</span></div>
              <div class="form-grid">
                <div class="field full">
                  <label>小红书分享内容/链接/截图文字/图片描述</label>
                  <textarea id="viralSourceText" placeholder="例如：粘贴小红书分享文案、链接，或把截图里能看到的标题/正文/图片内容描述出来。"></textarea>
                  <div class="helper-example">这里不会让 AI 擅自概括。解析完成后只展示页面里能拿到的标题、正文片段/描述和原图；你确认素材正确后，再进入下一步。</div>
                  <div class="actions" style="margin-top:8px">
                    <button class="btn primary" id="viralParseButton" onclick="parseXhsReference()">解析对标图文</button>
                    <span class="sub" id="viralParseState"></span>
                  </div>
                </div>
                <div class="field">
                  <label>账号方向</label>
                  <input id="viralAccountDirection" placeholder="例如：AI 工具基础设施科普号 / 疗愈成长号" />
                </div>
                <div class="field">
                  <label>想迁移到的主题</label>
                  <input id="viralTargetTopic" placeholder="例如：Token 代理避坑 / 焦虑自救" />
                </div>
                <div class="field full">
                  <label>软广/产品植入</label>
                  <input id="viralProductMention" placeholder="例如：小龙虾 AI 助手，轻微提到即可；不需要就留空" />
                </div>
                <div class="actions field full">
                  <button class="btn" onclick="clearViralAnalysis()">清空</button>
                  <span id="viralState" class="save-state"></span>
                </div>
              </div>
            </section>
            <section class="card">
              <div class="dashboard-section-head"><h2>第 2 步：决定怎么用</h2><span class="pill">确认素材后再分析</span></div>
              <div id="viralResult" class="viral-result"><div class="log-empty">先在左侧解析对标图文。解析成功后，这里会出现“开始拆解/迁移”和“带入内容工作台”等操作。</div></div>
            </section>
            <div id="viralParsedReference" class="parsed-reference viral-reference-panel" style="display:none"></div>
          </div>
        </div>
      </section>

      <section id="materials" class="view">
        <div class="hub-page">
          <section class="card hub-hero">
            <div>
              <div class="task-panel-kicker">Material Library</div>
              <h2>素材/情报库</h2>
              <p class="sub">先把本地发布包、正文、配图提示词、质检记录当作可复用素材。后续再接 RSS、Notion 情报库和外部采集。</p>
            </div>
            <button class="btn" onclick="loadPackages()">刷新素材</button>
          </section>
          <div class="hub-stats">
            <div class="publish-stat"><div class="label">本地素材包</div><strong id="materialPackageCount">-</strong></div>
            <div class="publish-stat"><div class="label">含图片</div><strong id="materialImageCount">-</strong></div>
            <div class="publish-stat"><div class="label">可复用正文</div><strong id="materialTextCount">-</strong></div>
          </div>
          <section class="card">
            <div class="dashboard-section-head"><h2>最近素材</h2><span class="pill">本地发布包</span></div>
            <div id="materialList" class="material-list"></div>
          </section>
        </div>
      </section>

      <section id="knowledge" class="view">
        <div class="hub-page">
          <section class="card hub-hero">
            <div>
              <div class="task-panel-kicker">Knowledge Base</div>
              <h2>知识库</h2>
              <p class="sub">这里独立查看主题、知识点、风格样例和写作规则。编辑入口暂时仍放在内容工作台底部，避免同一套表单重复维护。</p>
            </div>
            <button class="btn primary" onclick="showView(&quot;contentTasks&quot;)">去编辑知识库</button>
          </section>
          <div class="hub-stats">
            <div class="publish-stat"><div class="label">主题</div><strong id="knowledgeHubTopics">-</strong></div>
            <div class="publish-stat"><div class="label">知识点</div><strong id="knowledgeHubPoints">-</strong></div>
            <div class="publish-stat"><div class="label">样例/规则</div><strong id="knowledgeHubRules">-</strong></div>
          </div>
          <section class="card">
            <div class="dashboard-section-head"><h2>知识库内容</h2><span class="pill">本地 JSON V1</span></div>
            <div id="knowledgeHubList" class="knowledge-hub-grid"></div>
          </section>
        </div>
      </section>

      <section id="reviews" class="view">
        <div class="hub-page">
          <section class="card hub-hero">
            <div>
              <div class="task-panel-kicker">Review Analytics</div>
              <h2>复盘分析</h2>
              <p class="sub">先用内容资产状态做轻量复盘：看有多少内容还卡在待发布、哪些已发布需要补链接和备注，后面再接真实平台数据。</p>
            </div>
            <button class="btn primary" onclick="showView(&quot;packages&quot;)">处理内容资产</button>
          </section>
          <div class="hub-stats">
            <div class="publish-stat"><div class="label">待发布</div><strong id="reviewPendingCount">-</strong></div>
            <div class="publish-stat"><div class="label">已发布/复盘</div><strong id="reviewDoneCount">-</strong></div>
            <div class="publish-stat"><div class="label">需补复盘</div><strong id="reviewNeedNotesCount">-</strong></div>
          </div>
          <section class="card">
            <div class="dashboard-section-head"><h2>复盘提醒</h2><span class="pill">基于发布状态</span></div>
            <div id="reviewSuggestionList" class="material-list"></div>
          </section>
        </div>
      </section>

      <section id="entries" class="view">
        <div class="entry-page">
          <section class="card hub-hero">
            <div>
              <div class="task-panel-kicker">Entry Management</div>
              <h2>入口管理</h2>
              <p class="sub">把微信、网页后台、定时任务、飞书/钉钉这些入口统一管理：谁负责接收任务、触发什么工作流、当前是否启用，一眼看清楚。</p>
            </div>
            <button class="btn primary" onclick="saveEntryConfig()">保存当前入口</button>
          </section>
          <div class="entry-metrics">
            <div class="entry-metric"><div class="label">入口总数</div><strong id="entryTotalCount">-</strong></div>
            <div class="entry-metric"><div class="label">已启用</div><strong id="entryEnabledCount">-</strong></div>
            <div class="entry-metric"><div class="label">待接入</div><strong id="entryPlannedCount">-</strong></div>
          </div>
          <div class="entry-layout">
            <section class="card">
              <div class="dashboard-section-head"><h2>入口列表</h2><span class="pill">点击左侧卡片编辑</span></div>
              <div id="entryList" class="entry-card-list"></div>
            </section>
            <section class="card entry-editor">
              <div class="dashboard-section-head"><h2 id="entryEditorTitle">入口配置</h2><span id="entrySaveState" class="save-state"></span></div>
              <input id="entrySelectedId" type="hidden" />
              <div class="switch-row">
                <div><strong>是否启用</strong><div class="sub">关闭后，这个入口只保留配置，不建议继续作为触发入口。</div></div>
                <button class="btn small" id="entryEnabledToggle" onclick="toggleSelectedEntry()">-</button>
              </div>
              <div class="field full">
                <label>触发词 / 入口地址（一行一个）</label>
                <textarea id="entryTriggers" placeholder="例如：早报&#10;小红书 token代理&#10;http://localhost:3101/"></textarea>
              </div>
              <div class="field full">
                <label>绑定工作流（一行一个）</label>
                <textarea id="entryWorkflows" placeholder="例如：热点情报&#10;小红书发布包&#10;爆款拆解"></textarea>
              </div>
              <div class="field full">
                <label>备注 / 使用边界</label>
                <textarea id="entryNotes" placeholder="这个入口适合做什么，不适合做什么。"></textarea>
              </div>
              <div class="actions">
                <button class="btn primary" onclick="saveEntryConfig()">保存入口配置</button>
                <button class="btn" onclick="renderEntryManagement(statusCache?.entryConfig || {})">放弃修改</button>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section id="workflows" class="view">
        <div class="flow-grid" id="workflowCards"></div>
        <div class="section card">
          <h2>推荐主线</h2>
          <p class="sub">发现选题 → 加工内容 → 沉淀资产 → 辅助发布。自动发布不是核心，质量和可复盘才是核心。</p>
        </div>
        <div class="section card">
          <h2>详细业务链路</h2>
          <p class="sub">这里按“入口判断、执行步骤、AI 调用、产出、失败降级”拆开，方便你判断一条微信指令到底会走哪条流程。</p>
          <div id="workflowDetailCards" class="workflow-detail-grid"></div>
        </div>
        <div class="section card">
          <h2>业务流生成器</h2>
          <p class="sub">这里可以直接把一个想法配置成微信可触发的业务流。V1 先支持“触发词 → 调用当前模型 → 按规则输出结果”，后面再逐步挂 Notion、发布包、网页任务等动作。</p>
          <div class="mini-guide">
            最简单的理解：触发词决定“小龙虾听到哪句话会进这条流程”；业务目标决定“这条流程要完成什么”；执行规则决定“不能乱写、要按什么标准写”；输出格式决定“最后回微信长什么样”。
          </div>
          <div class="template-row">
            <button class="btn small" onclick="applyBusinessFlowTemplate('tokenTopics')">套用：Token 代理选题</button>
            <button class="btn small" onclick="applyBusinessFlowTemplate('humanRewrite')">套用：去 AI 味改写</button>
            <button class="btn small" onclick="applyBusinessFlowTemplate('dailyOpportunities')">套用：内容机会筛选</button>
          </div>
          <div class="business-flow-builder">
            <div class="form-grid">
              <input id="businessFlowId" type="hidden" />
              <div class="field">
                <label>业务流名称</label>
                <input id="businessFlowName" placeholder="例如：Token 代理选题顾问" />
                <div class="field-help">写给自己看的名字，越具体越好。建议格式：领域 + 要完成的事。</div>
              </div>
              <div class="field">
                <label>回复前缀</label>
                <input id="businessFlowReplyPrefix" placeholder="例如：我按这条业务流整理好了：" />
                <div class="field-help">可不填。填了以后，小龙虾每次回复前会先加这句话。</div>
              </div>
              <div class="field full">
                <label>触发词</label>
                <div id="businessFlowTriggersList" class="rule-list"></div>
                <div class="rule-toolbar"><button class="btn small" onclick="addHumanRuleItem('businessFlowTriggersList')">新增触发词</button></div>
                <div class="field-help">你在微信里发这些话，就会进入这条业务流。建议 2-4 条，例如“小红书 token代理”“token代理选题”。</div>
              </div>
              <div class="field full">
                <label>业务目标</label>
                <textarea id="businessFlowGoal" placeholder="这条业务流最终要帮你完成什么？例如：每天从一个模糊方向里拆出 5 个适合小红书的选题，并说明软广切入点。"></textarea>
                <div class="field-help">用一句话说清楚最终结果，不要写太虚。比如“帮我生成 5 个可发小红书的选题”，比“帮我做内容”更好。</div>
              </div>
              <div class="field full">
                <label>执行规则</label>
                <div id="businessFlowRulesList" class="rule-list"></div>
                <div class="rule-toolbar"><button class="btn small" onclick="addHumanRuleItem('businessFlowRulesList')">新增规则</button></div>
                <div class="field-help">这里写边界和偏好。比如“不要写成百科”“必须有真实使用场景”“广告只能软性出现”。</div>
              </div>
              <div class="field full">
                <label>输出格式</label>
                <textarea id="businessFlowOutputFormat" placeholder="例如：1. 先给结论；2. 给 3 个可执行选题；3. 每个选题包含标题、用户痛点、内容角度、广告切入。"></textarea>
                <div class="field-help">这里决定微信回复结构。建议写成固定栏目，方便每次结果稳定。</div>
              </div>
              <div class="actions field full">
                <button class="btn primary" onclick="saveBusinessFlow()">生成/保存业务流</button>
                <button class="btn" onclick="resetBusinessFlowForm()">清空</button>
                <span id="businessFlowSaveState" class="save-state"></span>
              </div>
            </div>
            <div>
              <h3>已配置业务流</h3>
              <div id="businessFlowList" class="business-flow-list"></div>
            </div>
          </div>
        </div>
      </section>

      <section id="contentTasks" class="view">
        <div class="workbench-shell">
          <div class="card workbench-hero">
            <div>
              <h2>内容工作台</h2>
              <p class="sub">把一个想法配置成可生成、可沉淀、可复盘的内容任务。微信负责快，后台负责准。</p>
            </div>
            <div class="workbench-stats">
              <div class="workbench-stat"><div class="label">本地主题</div><strong id="workbenchTopicCount">-</strong></div>
              <div class="workbench-stat"><div class="label">知识点</div><strong id="workbenchKnowledgeCount">-</strong></div>
              <div class="workbench-stat"><div class="label">风格/规则</div><strong id="workbenchRuleCount">-</strong></div>
            </div>
          </div>

          <div class="task-board">
            <div class="card task-panel">
              <div class="task-panel-head">
                <div><div class="task-panel-kicker">Content Brief</div><h3>任务基础</h3><div class="sub">先说清楚要做什么、给谁看。</div></div>
                <div class="task-panel-index">1</div>
              </div>
              <div class="task-primary-grid">
            <div class="field">
              <label>内容主题</label>
              <input id="contentTaskTopic" placeholder="例如：小龙虾后台为什么需要可视化配置" />
              <div class="field-help">必填。可以写一个具体选题，也可以写一个模糊方向。</div>
            </div>
            <div class="field">
              <label>平台</label>
              <select id="contentTaskPlatform">
                <option value="小红书">小红书</option>
              </select>
            </div>
            <div class="field">
              <label>内容类型</label>
              <select id="contentTaskType">
                <option value="图文发布包">图文发布包</option>
                <option value="经验分享">经验分享</option>
                <option value="避坑科普">避坑科普</option>
                <option value="产品复盘">产品复盘</option>
              </select>
            </div>
            <div class="field">
              <label>软广强度</label>
              <select id="contentTaskAdLevel">
                <option value="低：只在合适位置软性提到">低：软性提到</option>
                <option value="中：明确带出产品价值但不硬推">中：明确带出价值</option>
                <option value="无：不加入广告">无广告</option>
              </select>
            </div>
            <div class="field">
              <label>内容目标</label>
              <input id="contentTaskGoal" placeholder="例如：让用户理解为什么后台比聊天入口更适合复杂任务" />
            </div>
            <div class="field">
              <label>目标受众</label>
              <input id="contentTaskAudience" placeholder="例如：想做 AI 助手/自动化产品的个人开发者" />
            </div>
            <div class="field">
              <label>字数范围</label>
              <input id="contentTaskWordRange" placeholder="例如：600-900 字" />
            </div>
              </div>
            </div>

            <div class="card task-panel">
              <div class="task-panel-head">
                <div><div class="task-panel-kicker">Context & Style</div><h3>知识与风格</h3><div class="sub">决定内容吃什么知识、像什么表达。</div></div>
                <div class="task-panel-index">2</div>
              </div>
              <div class="task-primary-grid">
            <div class="field">
              <label>表达风格</label>
              <input id="contentTaskStyle" placeholder="例如：真实复盘、少术语、有一点吐槽感" />
            </div>
            <div class="field">
              <label>知识库范围</label>
              <select id="contentTaskKnowledgeScope">
                <option value="暂不使用知识库">暂不使用知识库</option>
                <option value="AI 工具基础设施知识库">AI 工具基础设施</option>
                <option value="疗愈知识库">疗愈知识库</option>
                <option value="使用全部可用知识库">全部可用知识库</option>
              </select>
              <div class="field-help">V1 先写入生成要求；后续接真实知识库检索。</div>
            </div>
            <div class="field">
              <label>素材来源</label>
              <select id="contentTaskMaterialSource">
                <option value="手动素材优先">手动素材优先</option>
                <option value="情报库优先">情报库优先</option>
                <option value="知识库优先">知识库优先</option>
                <option value="手动素材 + 情报库 + 知识库">混合使用</option>
              </select>
            </div>
            <div class="field">
              <label>风格参考</label>
              <select id="contentTaskStyleReferenceType">
                <option value="不使用风格参考">不使用</option>
                <option value="参考我的历史内容">我的历史内容</option>
                <option value="参考风格样例库">风格样例库</option>
                <option value="参考某个账号/作者的结构特征">某账号/作者结构</option>
                <option value="参考手动粘贴样例">手动粘贴样例</option>
              </select>
            </div>
            <div class="field">
              <label>参考强度</label>
              <select id="contentTaskImitationStrength">
                <option value="轻：只参考选题角度和结构，不模仿语句">轻：只参考结构</option>
                <option value="中：参考节奏、开头方式和表达密度">中：参考节奏</option>
                <option value="强：高度贴近表达习惯，但不能复刻原句或冒充本人">强：贴近但不复刻</option>
              </select>
            </div>
            <div class="field">
              <label>AI 味控制</label>
              <select id="contentTaskAiFlavorControl">
                <option value="强：删编号、打碎结构、加入真实犹豫和具体细节">强：真人化优先</option>
                <option value="中：保持清晰但避免模板腔">中：平衡清晰和自然</option>
                <option value="轻：只做基础自然化">轻：基础自然化</option>
              </select>
            </div>
            <div class="field">
              <label>产出模式</label>
              <select id="contentTaskOutputMode">
                <option value="生成完整发布包，但不自动发布">完整发布包</option>
                <option value="先生成选题方案，不写正文">只做选题方案</option>
                <option value="生成正文和配图提示词，不预填发布页">正文 + 配图提示词</option>
              </select>
            </div>
            <div class="field">
              <label>产品/广告植入</label>
              <input id="contentTaskProductMention" placeholder="例如：小龙虾微信 AI 助手，软性带出后台配置价值" />
            </div>
            <div class="field full">
              <label>风格样例/参考说明</label>
              <textarea id="contentTaskStyleReference" placeholder="可粘贴某篇爆款、你的历史内容，或描述某类账号的结构特征。要求系统学习结构和节奏，不复刻原句。"></textarea>
            </div>
            <div class="field full">
              <label>补充素材</label>
              <textarea id="contentTaskMaterial" placeholder="可以粘贴截图说明、产品背景、真实经历、想植入的信息。没有也可以不填。"></textarea>
            </div>
              </div>
            </div>

            <div class="card task-panel task-actions-card">
              <div class="task-panel-head">
                <div><div class="task-panel-kicker">Run</div><h3>生成与结果</h3><div class="sub">执行任务，并查看本次生成状态。</div></div>
                <div class="task-panel-index">3</div>
              </div>
            <div class="field full">
              <label>额外要求</label>
              <textarea id="contentTaskRequirements" placeholder="例如：不要写成教程；不要出现夸张承诺；配图提示词要真实，适合用后台截图和微信截图。"></textarea>
            </div>
            <div class="actions">
              <button class="btn" onclick="previewContentTask()">预览使用知识</button>
              <button class="btn primary" id="contentTaskSubmit" onclick="submitContentTask()">开始生成发布包</button>
              <button class="btn" onclick="resetContentTaskForm()">清空</button>
            </div>
            <span id="contentTaskState" class="save-state"></span>
            <div id="contentTaskPreview" class="task-preview-box" style="display:none"></div>
            <div class="task-checklist">
              <div class="task-check"><span>✓</span><div>生成结果会保存到本地内容资产。</div></div>
              <div class="task-check"><span>✓</span><div>Notion 写入失败不会阻塞本地发布包。</div></div>
              <div class="task-check"><span>✓</span><div>当前默认不自动发布，先保证内容质量。</div></div>
            </div>
            <div id="contentTaskResult" class="task-result" style="display:none"></div>
            </div>
          </div>

          <div class="library-grid">
        <div class="card">
          <h2>本地知识库 V1</h2>
          <p class="sub">先把知识沉淀在本地，内容任务会按“知识库范围”自动取用相关知识点、风格样例和写作规则。</p>
          <div class="knowledge-manager">
            <div class="form-grid" style="grid-template-columns:1fr">
              <div class="field">
                <label>新增类型</label>
                <input id="knowledgeEditId" type="hidden" />
                <select id="knowledgeNewType" onchange="renderKnowledgeNewForm()">
                  <option value="topic">主题</option>
                  <option value="knowledgePoint">知识点</option>
                  <option value="styleSample">风格样例</option>
                  <option value="writingRule">写作规则</option>
                </select>
              </div>
              <div class="field" id="knowledgeTopicSelectField" style="display:none">
                <label>所属主题</label>
                <select id="knowledgeNewTopicId"></select>
              </div>
              <div class="field">
                <label id="knowledgeNewNameLabel">名称</label>
                <input id="knowledgeNewName" placeholder="例如：AI 工具基础设施" />
              </div>
              <div class="field">
                <label id="knowledgeNewContentLabel">内容</label>
                <textarea id="knowledgeNewContent" placeholder="写清楚这条知识、样例或规则。"></textarea>
              </div>
              <div class="actions">
                <button class="btn primary" onclick="saveKnowledgeItem()">保存到知识库</button>
                <span id="knowledgeSaveState" class="save-state"></span>
              </div>
            </div>
            <div>
              <div class="actions" style="margin-bottom:8px">
                <button class="btn small active" data-knowledge-filter="all" onclick="setKnowledgeFilter('all')">全部</button>
                <button class="btn small" data-knowledge-filter="topics" onclick="setKnowledgeFilter('topics')">主题</button>
                <button class="btn small" data-knowledge-filter="knowledgePoints" onclick="setKnowledgeFilter('knowledgePoints')">知识点</button>
                <button class="btn small" data-knowledge-filter="styleSamples" onclick="setKnowledgeFilter('styleSamples')">风格样例</button>
                <button class="btn small" data-knowledge-filter="writingRules" onclick="setKnowledgeFilter('writingRules')">写作规则</button>
              </div>
              <div id="knowledgeList" class="knowledge-list"></div>
            </div>
          </div>
        </div>
        <details class="card collapsible-section">
          <summary>任务选项库</summary>
          <h2>任务选项库</h2>
          <p class="sub">这里维护内容工作台里的下拉选项。后续接真实知识库时，这些选项会变成可绑定的数据源。</p>
          <div class="form-grid">
            <div class="field">
              <label>知识库范围（一行一个）</label>
              <textarea id="contentOptionKnowledgeScopes"></textarea>
            </div>
            <div class="field">
              <label>素材来源（一行一个）</label>
              <textarea id="contentOptionMaterialSources"></textarea>
            </div>
            <div class="field">
              <label>风格参考类型（一行一个）</label>
              <textarea id="contentOptionStyleReferenceTypes"></textarea>
            </div>
            <div class="field">
              <label>参考强度（一行一个）</label>
              <textarea id="contentOptionImitationStrengths"></textarea>
            </div>
            <div class="field">
              <label>AI 味控制（一行一个）</label>
              <textarea id="contentOptionAiFlavorControls"></textarea>
            </div>
            <div class="field">
              <label>产出模式（一行一个）</label>
              <textarea id="contentOptionOutputModes"></textarea>
            </div>
            <div class="actions field full">
              <button class="btn primary" onclick="saveContentOptions()">保存任务选项</button>
              <span id="contentOptionsSaveState" class="save-state"></span>
            </div>
          </div>
        </details>
          </div>
        </div>
      </section>

      <section id="packages" class="view">
        <div class="publish-center">
          <section class="card publish-hero">
            <div>
              <h2>内容资产</h2>
              <div class="sub">这里把发布包、待发布内容、已发布作品放在同一个资产池里，用状态筛选来管理。</div>
            </div>
            <div class="actions">
              <button class="btn primary" onclick="showView(&quot;contentTasks&quot;)">新建内容任务</button>
              <button class="btn" onclick="loadPackages()">刷新</button>
            </div>
          </section>
          <section class="publish-stats">
            <div class="publish-stat"><div class="label">全部内容</div><strong id="publishStatTotal">-</strong></div>
            <div class="publish-stat"><div class="label">待发布</div><strong id="publishStatPending">-</strong></div>
            <div class="publish-stat"><div class="label">已发布</div><strong id="publishStatPublished">-</strong></div>
            <div class="publish-stat"><div class="label">含图片素材</div><strong id="publishStatImages">-</strong></div>
          </section>
          <section class="card">
            <div class="publish-toolbar">
              <div class="publish-filter-group">
                <button class="btn small active" data-package-filter="all" onclick="setPackageFilter('all')">全部</button>
                <button class="btn small" data-package-filter="pending" onclick="setPackageFilter('pending')">待发布</button>
                <button class="btn small" data-package-filter="published" onclick="setPackageFilter('published')">已发布</button>
                <button class="btn small" data-package-filter="withImages" onclick="setPackageFilter('withImages')">有图片</button>
              </div>
              <div class="sub" id="publishFilterHint">显示全部发布包</div>
            </div>
            <div class="publish-table-wrap">
              <table>
                <thead><tr><th>内容</th><th>平台</th><th>状态</th><th>素材</th><th>更新时间</th><th>操作</th></tr></thead>
                <tbody id="packagesTable"></tbody>
              </table>
            </div>
          </section>
          <div id="packageDetail" class="detail"></div>
        </div>
      </section>

      <section id="settings" class="view">
        <div class="card">
          <h2>安全开关</h2>
          <div class="switch-row">
            <div><strong>Notion 内容库写入</strong><div class="sub">打开后内容包会自动写入内容发布库。</div></div>
            <button class="btn" id="toggleNotion" onclick="toggleSetting('enableNotion')">-</button>
          </div>
          <div class="switch-row">
            <div><strong>小红书自动预填</strong><div class="sub">当前建议关闭，等内容质量稳定后再开启。</div></div>
            <button class="btn" id="togglePrefill" onclick="toggleSetting('enablePrefill')">-</button>
          </div>
          <div class="switch-row">
            <div><strong>Hermes 研究增强</strong><div class="sub">打开后，内容生成前先生成研究卡片；失败会自动降级，不阻塞主流程。</div></div>
            <button class="btn" id="toggleHermes" onclick="toggleSetting('enableHermes')">-</button>
          </div>
          <div class="switch-row">
            <div><strong>自动生图</strong><div class="sub">当前关闭，只保留高质量生图提示词。</div></div>
            <button class="btn" id="toggleImage" onclick="toggleSetting('enableImageGeneration')">-</button>
          </div>
          <div class="section">
            <h2>去 AI 味规则</h2>
            <p class="sub">这里配置小红书发布包的真人化质检规则。系统默认硬规则仍会保留，这里写的是你的追加要求。</p>
            <div class="form-grid">
              <div class="field">
                <label>正文最少字数</label>
                <input id="humanMinChars" type="number" min="100" max="1500" step="50" />
              </div>
              <div class="field">
                <label>正文最多字数</label>
                <input id="humanMaxChars" type="number" min="300" max="2000" step="50" />
              </div>
              <div class="field full">
                <label>追加规则（一行一条）</label>
                <div id="humanExtraRulesList" class="rule-list"></div>
                <div class="rule-toolbar"><button class="btn small" onclick="addHumanRuleItem('humanExtraRulesList')">新增规则</button></div>
              </div>
              <div class="field">
                <label>额外禁用词（一行一个）</label>
                <div id="humanBannedPhrasesList" class="rule-list"></div>
                <div class="rule-toolbar"><button class="btn small" onclick="addHumanRuleItem('humanBannedPhrasesList')">新增禁用词</button></div>
              </div>
              <div class="field">
                <label>必须尽量包含的细节（一行一个）</label>
                <div id="humanRequiredDetailsList" class="rule-list"></div>
                <div class="rule-toolbar"><button class="btn small" onclick="addHumanRuleItem('humanRequiredDetailsList')">新增细节</button></div>
              </div>
            </div>
            <div class="actions" style="margin-top:14px">
              <button class="btn primary" onclick="saveHumanEditorRules()">保存规则</button>
              <span id="humanRulesSaveState" class="save-state"></span>
            </div>
          </div>
        </div>
        <div class="section card">
          <h2>脱敏配置</h2>
          <pre id="configJson">加载中...</pre>
        </div>
      </section>

      <section id="logs" class="view">
        <div class="card">
          <h2>运行日志</h2>
          <div class="sub" id="logPath"></div>
          <div class="log-toolbar">
            <div class="log-filters">
              <button class="btn small primary" id="logFilterWorkflow" onclick="setLogFilter('workflow')">按工作流</button>
              <button class="btn small" id="logFilterAll" onclick="setLogFilter('all')">全部</button>
              <button class="btn small" id="logFilterImportant" onclick="setLogFilter('important')">只看重要</button>
              <button class="btn small" id="logFilterErrors" onclick="setLogFilter('errors')">错误/警告</button>
            </div>
            <button class="btn small" onclick="loadLogs()">刷新日志</button>
          </div>
          <div id="logSummary" class="sub"></div>
          <div id="workflowLogPanel">
            <div class="log-section-title">
              <div>
                <h3>前面工作流日志</h3>
                <div class="sub">一张卡代表一次微信任务，适合复盘完整链路。</div>
              </div>
            </div>
            <div id="workflowRunsList" class="workflow-run-list"><div class="log-empty">加载中...</div></div>
            <div class="log-section-title">
              <div>
                <h3>当前运行日志</h3>
                <div class="sub">最近的服务状态、警告和新步骤，适合看现场有没有卡住。</div>
              </div>
            </div>
            <div id="liveLogsList" class="live-log-list"><div class="log-empty">加载中...</div></div>
          </div>
          <div id="logsList" class="log-list" style="display:none"><div class="log-empty">加载中...</div></div>
        </div>
      </section>
      </main>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    let statusCache = null;
    let logCache = [];
    let logFilter = "workflow";
    let packageCache = [];
    let packageFilter = "all";
    let knowledgeCache = null;
    let knowledgeFilter = "all";
    let selectedEntryId = "wechat";

    function upgradeDashboardLayout() {
      const dashboard = $("dashboard");
      if (!dashboard || dashboard.dataset.layoutReady === "1") return;
      dashboard.dataset.layoutReady = "1";
      dashboard.innerHTML = [
        '<div class="production-dashboard">',
        '<section class="card dashboard-hero">',
        '<div>',
        '<h2>小龙虾内容生产控制台</h2>',
        '<div class="sub">这里是内容生产主驾驶舱：看今天产能、推进当前任务、处理待办和复盘最近产出。</div>',
        '</div>',
        '<div class="hero-status">',
        '<span class="hero-chip" id="dashboardOnlineState">在线</span>',
        '<span class="hero-chip" id="activeMode">-</span>',
        '<span class="hero-chip" id="dashboardModelState">模型 -</span>',
        '<span class="hero-chip" id="notionState">-</span>',
        '</div>',
        '<div class="hero-actions"><button class="btn primary" onclick="showView(&quot;packages&quot;)">处理发布包</button><button class="btn" onclick="showView(&quot;workflows&quot;)">配置流程</button><button class="btn" onclick="showView(&quot;contentTasks&quot;)">新建内容任务</button></div>',
        '</section>',
        '<section class="production-metrics">',
        '<div class="card metric-card"><div class="metric-icon">情</div><div><div class="label">新情报</div><div class="metric" id="metricIntel">-</div><div class="sub" id="metricIntelHint">素材输入</div></div></div>',
        '<div class="card metric-card"><div class="metric-icon">题</div><div><div class="label">候选选题</div><div class="metric" id="metricTopics">-</div><div class="sub">可继续加工</div></div></div>',
        '<div class="card metric-card"><div class="metric-icon">生</div><div><div class="label">生成中</div><div class="metric" id="metricRunning">-</div><div class="sub">当前任务</div></div></div>',
        '<div class="card metric-card"><div class="metric-icon">发</div><div><div class="label">待发布</div><div class="metric" id="metricPending">-</div><div class="sub">发布包队列</div></div></div>',
        '</section>',
        '<div class="dashboard-main-grid">',
        '<div class="dashboard-stack">',
        '<section class="card"><div class="dashboard-section-head"><h2>当前任务</h2><span class="pill">生产流水线</span></div><div id="currentTaskPanel"></div></section>',
        '<section class="card"><div class="dashboard-section-head"><h2>最近产出</h2><button class="btn small" onclick="showView(&quot;packages&quot;)">查看全部</button></div><div id="recentOutputs" class="recent-output-list"></div></section>',
        '</div>',
        '<div class="dashboard-stack">',
        '<section class="card"><div class="dashboard-section-head"><h2>待办提醒</h2><span class="pill">按优先级</span></div><div id="todoReminders" class="reminder-list"></div></section>',
        '<section class="card"><div class="dashboard-section-head"><h2>生产建议（AI）</h2><span class="pill">自动判断</span></div><div id="productionSuggestions" class="suggestion-list"></div></section>',
        '<section class="card"><div class="dashboard-section-head"><h2>系统状态</h2><span class="pill">底座</span></div><table><tbody id="statusTable"></tbody></table></section>',
        '</div>',
        '</div>',
        '</div>',
      ].join("");
    }

    function statusText(value) {
      return String(value || "").trim();
    }

    function isPendingPublish(item) {
      if (!item) return false;
      const state = statusText(item.publishStatus);
      return /待发布|待手工|已生成|质检|审核/.test(state);
    }

    function isPublishedPackage(item) {
      return /已发布|已复盘/.test(String(item?.publishStatus || ""));
    }

    function packageStatusClass(item) {
      if (isPublishedPackage(item)) return "done";
      if (/AI|Hermes|质检/.test(String(item?.publishStatus || ""))) return "ai";
      return "";
    }

    function renderProductionDashboard(status) {
      const packages = Array.isArray(status?.packages?.items) ? status.packages.items : [];
      const latest = status?.packages?.latest;
      const pendingPackages = packages.filter(isPendingPublish);
      $("dashboardModelState").textContent = "模型 " + (status?.imageGeneration?.model || status?.activeMode || "-");
      $("metricIntel").textContent = status?.notion?.intelConfigured ? "已接入" : "未接入";
      $("metricIntelHint").textContent = status?.notion?.intelConfigured ? "情报库可用" : "需要配置情报库";
      $("metricTopics").textContent = status?.customBusinessFlows?.length || 0;
      $("metricRunning").textContent = latest ? 1 : 0;
      $("metricPending").textContent = pendingPackages.length || 0;

      const taskTitle = latest?.title || "暂无正在推进的内容任务";
      const taskState = latest?.publishStatus || "等待新任务";
      const taskProgress = isPendingPublish(latest) ? 78 : 100;
      $("currentTaskPanel").innerHTML = latest ? [
        '<div class="task-card">',
        '<div class="task-head">',
        '<div><div class="task-title">' + escapeHtml(taskTitle) + '</div><div class="sub">发布状态：' + escapeHtml(taskState) + ' · Notion：' + escapeHtml(latest.notionStatus || "-") + '</div></div>',
        '<span class="pill">' + escapeHtml(taskState) + '</span>',
        '</div>',
        '<div class="task-meta"><span class="pill">平台：小红书</span><span class="pill">图片：' + String(latest.imageCount || 0) + ' 张</span><span class="pill">更新：' + escapeHtml(fmtDate(latest.updatedAt)) + '</span></div>',
        '<div class="progress-bar"><div class="progress-fill" style="width:' + taskProgress + '%"></div></div>',
        '<div class="pipeline">',
        '<div class="pipeline-step done"><div class="pipeline-dot">✓</div><div>选题</div></div>',
        '<div class="pipeline-step done"><div class="pipeline-dot">✓</div><div>研究</div></div>',
        '<div class="pipeline-step done"><div class="pipeline-dot">✓</div><div>草稿</div></div>',
        '<div class="pipeline-step done"><div class="pipeline-dot">✓</div><div>去AI味</div></div>',
        '<div class="pipeline-step active"><div class="pipeline-dot">5</div><div>发布包</div></div>',
        '<div class="pipeline-step"><div class="pipeline-dot">6</div><div>发布</div></div>',
        '</div>',
        '<div class="actions"><button class="btn primary" onclick="showView(&quot;packages&quot;)">继续处理</button><button class="btn" onclick="showPackage(encodeURIComponent(' + JSON.stringify(latest.name) + ')); showView(&quot;packages&quot;)">查看详情</button><button class="btn" onclick="showView(&quot;logs&quot;)">查看日志</button></div>',
        '</div>',
      ].join("") : '<div class="log-empty">现在没有正在推进的内容。可以去「业务流程」配置流程，或后续在「新建内容任务」里直接发起。</div>';

      const recent = packages.slice(0, 4);
      $("recentOutputs").innerHTML = recent.length ? recent.map(function(item) {
        const done = /已发布|已复盘/.test(String(item.publishStatus || ""));
        return [
          '<div class="recent-output-item">',
          '<div class="output-logo">小红书</div>',
          '<div><strong>' + escapeHtml(item.title || item.name) + '</strong><div class="sub">' + escapeHtml(fmtDate(item.updatedAt)) + ' · 图片 ' + String(item.imageCount || 0) + ' 张</div></div>',
          '<div class="status-tag ' + (done ? 'done' : '') + '">' + escapeHtml(item.publishStatus || "-") + '</div>',
          '<button class="btn small" onclick="showPackage(\'' + encodeURIComponent(item.name) + '\'); showView(&quot;packages&quot;)">查看</button>',
          '</div>',
        ].join("");
      }).join("") : '<div class="log-empty">暂无最近产出。</div>';

      const reminders = [
        { icon: "发", level: pendingPackages.length ? "warning" : "success", title: "待发布内容", desc: pendingPackages.length ? "有 " + pendingPackages.length + " 个发布包建议处理" : "暂无待发布积压", action: "去处理", view: "packages" },
        { icon: "流", level: (status.customBusinessFlows || []).length ? "success" : "warning", title: "业务流配置", desc: (status.customBusinessFlows || []).length ? "已配置 " + status.customBusinessFlows.length + " 条自定义业务流" : "还没有自定义业务流，可以先从模板开始", action: "去配置", view: "workflows" },
        { icon: "库", level: status.notion.xiaohongshuEnabled ? "success" : "warning", title: "Notion 写入", desc: status.notion.xiaohongshuEnabled ? "内容库写入已开启" : "当前关闭，微信回复不会显示 Notion 字样", action: "查看", view: "settings" },
      ];
      $("todoReminders").innerHTML = reminders.map(function(item) {
        return '<div class="reminder-item"><div class="priority-dot ' + escapeHtml(item.level) + '">' + escapeHtml(item.icon) + '</div><div><strong>' + escapeHtml(item.title) + '</strong><div class="sub">' + escapeHtml(item.desc) + '</div></div><button class="btn small" onclick="showView(\'' + item.view + '\')">' + escapeHtml(item.action) + '</button></div>';
      }).join("");

      const suggestions = [
        pendingPackages.length ? "优先处理待发布内容，避免生成完的发布包沉底。" : "今天发布队列比较轻，可以先补充选题或知识库。",
        status.hermes.enabled ? "Hermes 内容脑已开启，适合继续提高研究和质检质量。" : "建议开启 Hermes，用于研究、判断、质检和改写。",
        status.imageGeneration.enabled ? "自动生图已开启，注意检查图片和主题是否匹配。" : "当前不自动生图，建议继续保留详细配图提示词。",
      ];
      $("productionSuggestions").innerHTML = suggestions.map(function(text, index) {
        return '<div class="suggestion-item"><div class="suggestion-index">' + (index + 1) + '</div><div><strong>' + escapeHtml(text) + '</strong></div></div>';
      }).join("");
    }

    function upgradeLogsLayout() {
      const logsView = $("logs");
      if (!logsView || logsView.dataset.layoutReady === "1") return;
      logsView.dataset.layoutReady = "1";
      logsView.innerHTML = [
        '<div class="logs-page">',
        '<div class="card logs-command">',
        '<div>',
        '<h2>运行日志工作台</h2>',
        '<div class="sub">先看当前现场，再复盘历史工作流；需要排查时再切到全部明细。</div>',
        '<div class="sub" id="logPath"></div>',
        '<div id="logOverview" class="log-overview">',
        '<div class="log-overview-card"><div class="log-overview-label">日志行数</div><div class="log-overview-value">-</div></div>',
        '<div class="log-overview-card"><div class="log-overview-label">工作流</div><div class="log-overview-value">-</div></div>',
        '<div class="log-overview-card"><div class="log-overview-label">AI 调用</div><div class="log-overview-value">-</div></div>',
        '<div class="log-overview-card"><div class="log-overview-label">异常</div><div class="log-overview-value">-</div></div>',
        '</div>',
        '</div>',
        '<div class="log-filters">',
        '<button class="btn small primary" id="logFilterWorkflow" onclick="setLogFilter(&quot;workflow&quot;)">工作台</button>',
        '<button class="btn small" id="logFilterAll" onclick="setLogFilter(&quot;all&quot;)">全部明细</button>',
        '<button class="btn small" id="logFilterImportant" onclick="setLogFilter(&quot;important&quot;)">只看重要</button>',
        '<button class="btn small" id="logFilterErrors" onclick="setLogFilter(&quot;errors&quot;)">错误/警告</button>',
        '<button class="btn small" onclick="loadLogs()">刷新</button>',
        '</div>',
        '</div>',
        '<div id="logSummary" class="sub"></div>',
        '<div id="workflowLogPanel">',
        '<div class="logs-workspace">',
        '<section class="card log-panel live-panel">',
        '<div class="log-panel-head"><h3>当前运行现场</h3><div class="sub">看服务是否在线、有没有卡住、最近一步走到哪里。</div></div>',
        '<div class="log-panel-body"><div id="liveLogsList" class="live-log-list"><div class="log-empty">加载中...</div></div></div>',
        '</section>',
        '<section class="card log-panel workflow-history">',
        '<div class="log-panel-head"><h3>前面工作流复盘</h3><div class="sub">一张卡代表一次微信任务，按时间从近到远排列。</div></div>',
        '<div class="log-panel-body"><div id="workflowRunsList" class="workflow-run-list"><div class="log-empty">加载中...</div></div></div>',
        '</section>',
        '</div>',
        '</div>',
        '<div class="card log-panel" id="logsDetailPanel" style="display:none">',
        '<div class="log-panel-head"><h3>日志明细</h3><div class="sub">用于排查问题，按当前筛选显示原始日志解释。</div></div>',
        '<div class="log-panel-body"><div id="logsList" class="log-list"><div class="log-empty">加载中...</div></div></div>',
        '</div>',
        '</div>',
      ].join("");
    }

    upgradeLogsLayout();
    upgradeDashboardLayout();

    function showView(view) {
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
      document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === view));
    }

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => showView(button.dataset.view));
    });

    async function api(url, options) {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function fmtDate(value) {
      return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
    }

    function summarizeExtra(extra) {
      if (!extra || typeof extra !== "object") return "";
      const parts = [];
      if (extra.workflow) parts.push("流程：" + extra.workflow);
      if (extra.step !== undefined && extra.totalSteps !== undefined) parts.push("第 " + extra.step + "/" + extra.totalSteps + " 次");
      if (extra.purpose) parts.push("用途：" + extra.purpose);
      if (extra.model) parts.push("模型：" + extra.model);
      if (extra.durationMs !== undefined) parts.push("耗时：" + Math.round(Number(extra.durationMs) / 1000) + " 秒");
      if (extra.text) parts.push("用户说：" + extra.text);
      if (extra.reply) parts.push("回复：" + String(extra.reply).slice(0, 80));
      if (extra.msgCount !== undefined) parts.push("消息数：" + extra.msgCount);
      if (extra.selectedCount !== undefined) parts.push("选中：" + extra.selectedCount + " 条");
      if (extra.writtenCount !== undefined) parts.push("写入：" + extra.writtenCount + " 条");
      if (extra.duplicateCount !== undefined) parts.push("重复：" + extra.duplicateCount + " 条");
      if (extra.packageDir) parts.push("素材包：" + extra.packageDir);
      if (extra.error) parts.push("错误：" + String(extra.error).slice(0, 120));
      return parts.join("；");
    }

    function explainLog(message, level, extra) {
      const summary = summarizeExtra(extra);
      const map = {
        "Bridge starting": ["小龙虾服务启动", "微信桥接程序开始运行，后面会持续监听微信消息。", "正常状态"],
        "Workflow run started": ["工作流开始", summary || "一次用户请求开始处理，后续步骤会归到同一张工作流卡片里。", "正常状态"],
        "Workflow run completed": ["工作流结束", summary || "这次用户请求已经处理结束。", "正常状态"],
        "AI API call": ["正在调用 AI", summary || "系统开始请求模型接口。用途、模型和第几步可以在详情里查看。", "计入 AI 调用次数"],
        "AI API call completed": ["AI 调用完成", summary || "模型接口已经返回结果，系统会继续进入下一步。", "正常状态"],
        "AI image call": ["正在调用生图模型", summary || "系统开始请求图片生成接口。", "计入 AI 调用次数"],
        "AI image call completed": ["生图调用完成", summary || "图片生成接口已经返回并保存到本地。", "正常状态"],
        "Poll result": ["正在检查微信新消息", summary || "这是后台心跳日志，不代表出错。msgCount 为 0 说明暂时没有新消息。", "一般不用管"],
        "Received message": ["收到一条微信消息", summary || "微信接口返回了新消息，下一步会解析文字内容。", "正常状态"],
        "Inbound text": ["识别到用户输入", summary || "小龙虾已经读到用户发来的文字，准备判断走哪个业务流程。", "正常状态"],
        "Replied": ["已回复微信", summary || "小龙虾已经把结果发回微信。", "正常状态"],
        "AI intel workflow completed": ["情报流程完成", summary || "已完成抓取、筛选和写入。", "正常状态"],
        "Xiaohongshu publish package completed": ["小红书发布包生成完成", summary || "正文、质检、配图提示词和本地素材包已经生成。", "正常状态"],
        "Xiaohongshu prefill launch direct": ["准备打开小红书发布页", summary || "系统尝试启动浏览器预填小红书发布页。", "如果没弹浏览器再看详情"],
        "Xiaohongshu prefill launch after confirm": ["确认后启动小红书预填", summary || "收到确认后，开始打开发布页。", "如果卡住再看详情"],
        "Xiaohongshu publish status updated": ["发布状态已写回", summary || "内容状态已经同步更新。", "正常状态"],
        "Hermes OpenClaw agent research failed; using fallback": ["Hermes 研究失败，已降级", summary || "研究增强没有成功，但主流程没有中断，系统用了备用研究卡片。", "可先忽略，频繁出现再处理"],
        "Hermes LLM research failed; using fallback": ["Hermes 研究失败，已降级", summary || "研究增强没有成功，但主流程没有中断。", "可先忽略，频繁出现再处理"],
        "Hermes command research failed; using fallback": ["Hermes 命令不可用，已降级", summary || "本机 Hermes 命令没有跑通，但内容生成会继续。", "需要增强质量时再修"],
        "Xiaohongshu image generation failed": ["生图失败", summary || "图片生成接口失败，发布包会保留配图建议和提示词。", "需要检查生图 API"],
        "Xiaohongshu Notion write failed": ["写入 Notion 失败", summary || "内容本地已保存，但同步到 Notion 没成功。", "检查 Notion 配置或字段"],
        "Handle message failure": ["处理微信消息失败", summary || "收到消息后处理流程报错。", "需要查看详情"],
        "Loop failure": ["监听循环异常", summary || "微信监听循环报错，通常会自动继续。", "如果连续出现需要处理"],
        "Fatal startup failure": ["服务启动失败", summary || "小龙虾启动时失败。", "需要立即处理"],
        "getUpdates returned error": ["微信拉取消息失败", summary || "微信接口返回错误。", "如果连续出现需要处理"],
        "Skip message without context_token": ["跳过无法回复的消息", summary || "这条消息缺少微信上下文，系统不知道该回到哪里。", "通常不用管"],
      };
      const fallback = level === "ERROR"
        ? ["运行错误", summary || "这条日志表示某个步骤失败，需要展开详情看错误原因。", "需要处理"]
        : level === "WARN"
          ? ["运行警告", summary || "这条日志表示某个步骤不稳定，但通常已经降级继续。", "建议关注"]
          : [message || "运行记录", summary || "普通运行日志。", "一般不用管"];
      const picked = map[message] || fallback;
      return { title: picked[0], explanation: picked[1], action: picked[2] };
    }

    function onOff(value) {
      return value ? '<span class="ok">开启</span>' : '<span class="warn">关闭</span>';
    }

    function setTextIfExists(id, value) {
      const el = $(id);
      if (el) el.textContent = value;
    }

    function setHtmlIfExists(id, value) {
      const el = $(id);
      if (el) el.innerHTML = value;
    }

    async function loadStatus() {
      const status = await api("/api/status");
      statusCache = status;
      if ($("topbarModelState")) $("topbarModelState").textContent = "GPT-5.4";
      setTextIfExists("activeMode", status.activeMode || "-");
      setTextIfExists("packageCount", status.packages.count || 0);
      setTextIfExists("dataSize", String(status.dataSizeMB || 0) + " MB");
      setHtmlIfExists("notionState", status.notion.xiaohongshuEnabled ? '<span class="ok">开启</span>' : '<span class="warn">关闭</span>');
      setHtmlIfExists("statusTable", [
        ["程序目录", status.root],
        ["运行数据目录", status.dataDir],
        ["Notion 内容库", status.notion.xiaohongshuEnabled ? "开启" : "关闭"],
        ["小红书预填", status.xiaohongshu.enable_prefill ? "开启" : "关闭"],
        ["Hermes 研究增强", status.hermes.enabled ? "开启" : "关闭"],
        ["自动生图", status.imageGeneration.enabled ? "开启" : "关闭"],
        ["生图模型", status.imageGeneration.model || "-"],
        ["最新发布包", status.packages.latest?.title || "暂无"],
      ].map(function(row) {
        return "<tr><th>" + escapeHtml(row[0]) + "</th><td>" + escapeHtml(row[1]) + "</td></tr>";
      }).join(""));
      renderToggles(status);
      renderHumanEditorRules(status.humanEditorRules || {});
      renderContentOptions(status.contentOptions || {});
      renderKnowledgeBase(status.knowledgeBase || {});
      renderWorkflows(status.workflows);
      renderBusinessFlows(status.customBusinessFlows || []);
      renderEntryManagement(status.entryConfig || {});
      renderProductionDashboard(status);
    }

    function renderToggles(status) {
      setToggle("toggleNotion", status.notion.xiaohongshuEnabled);
      setToggle("togglePrefill", Boolean(status.xiaohongshu.enable_prefill));
      setToggle("toggleHermes", Boolean(status.hermes.enabled));
      setToggle("toggleImage", Boolean(status.imageGeneration.enabled));
    }

    function entryIcon(type) {
      const map = { wechat: "微", web: "网", schedule: "时", feishu: "飞", dingtalk: "钉", custom: "入" };
      return map[type] || "入";
    }

    function entryStatusLabel(entry) {
      if (!entry.enabled) return '<span class="status-tag">已关闭</span>';
      if (entry.status === "planned") return '<span class="status-tag">待接入</span>';
      return '<span class="status-tag done">已启用</span>';
    }

    function renderEntryManagement(config = {}) {
      const entries = Array.isArray(config.entries) ? config.entries : [];
      if (!$("entryList")) return;
      if (!entries.some(function(entry) { return entry.id === selectedEntryId; })) selectedEntryId = entries[0]?.id || "";
      $("entryTotalCount").textContent = entries.length;
      $("entryEnabledCount").textContent = entries.filter(function(entry) { return entry.enabled; }).length;
      $("entryPlannedCount").textContent = entries.filter(function(entry) { return entry.status === "planned" || !entry.enabled; }).length;
      $("entryList").innerHTML = entries.length ? entries.map(function(entry) {
        const triggers = (entry.triggers || []).slice(0, 4).map(function(item) {
          return '<span class="entry-tag">' + escapeHtml(item) + '</span>';
        }).join("");
        const workflows = (entry.workflows || []).slice(0, 3).map(function(item) {
          return '<span class="entry-tag">' + escapeHtml(item) + '</span>';
        }).join("");
        return [
          '<div class="entry-card ' + (entry.id === selectedEntryId ? 'active' : '') + '" onclick="selectEntryConfig(\'' + escapeHtml(entry.id) + '\')">',
          '<div class="entry-type-icon">' + escapeHtml(entryIcon(entry.type)) + '</div>',
          '<div>',
          '<div class="entry-card-title">' + escapeHtml(entry.name) + entryStatusLabel(entry) + '</div>',
          '<div class="entry-card-desc">' + escapeHtml(entry.description || "") + '</div>',
          '<div class="entry-tags">' + triggers + workflows + '</div>',
          '</div>',
          '<button class="btn small" onclick="event.stopPropagation(); selectEntryConfig(\'' + escapeHtml(entry.id) + '\')">编辑</button>',
          '</div>',
        ].join("");
      }).join("") : '<div class="log-empty">还没有入口配置。</div>';
      fillEntryEditor(entries.find(function(entry) { return entry.id === selectedEntryId; }) || entries[0]);
    }

    function fillEntryEditor(entry) {
      if (!entry || !$("entrySelectedId")) return;
      selectedEntryId = entry.id;
      $("entrySelectedId").value = entry.id;
      $("entryEditorTitle").textContent = entry.name + "配置";
      $("entryEnabledToggle").textContent = entry.enabled ? "已启用" : "已关闭";
      $("entryEnabledToggle").classList.toggle("primary", Boolean(entry.enabled));
      $("entryTriggers").value = (entry.triggers || []).join("\n");
      $("entryWorkflows").value = (entry.workflows || []).join("\n");
      $("entryNotes").value = entry.notes || "";
    }

    function selectEntryConfig(id) {
      selectedEntryId = id;
      const entry = (statusCache?.entryConfig?.entries || []).find(function(item) { return item.id === id; });
      fillEntryEditor(entry);
      renderEntryManagement(statusCache?.entryConfig || {});
    }

    function toggleSelectedEntry() {
      const button = $("entryEnabledToggle");
      if (!button) return;
      const next = button.textContent !== "已启用";
      button.textContent = next ? "已启用" : "已关闭";
      button.classList.toggle("primary", next);
    }

    async function saveEntryConfig() {
      const id = $("entrySelectedId")?.value || selectedEntryId;
      if (!id) return;
      $("entrySaveState").textContent = "保存中...";
      const payload = {
        id,
        enabled: $("entryEnabledToggle")?.textContent === "已启用",
        triggers: normalizeRuleItems($("entryTriggers")?.value || ""),
        workflows: normalizeRuleItems($("entryWorkflows")?.value || ""),
        notes: $("entryNotes")?.value || "",
      };
      const result = await api("/api/entry-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (statusCache) statusCache.entryConfig = result.entryConfig;
      $("entrySaveState").textContent = "已保存";
      renderEntryManagement(result.entryConfig || {});
    }

    function setValue(id, value) {
      const el = $(id);
      if (el) el.value = value == null ? "" : String(value);
    }

    function normalizeRuleItems(value) {
      if (Array.isArray(value)) return value.map(function(item) { return String(item || "").trim(); }).filter(Boolean);
      return String(value || "").split(/\r?\n/).map(function(item) { return item.trim(); }).filter(Boolean);
    }

    function renderRuleList(id, items, placeholder) {
      const list = $(id);
      if (!list) return;
      const values = normalizeRuleItems(items);
      if (!values.length) values.push("");
      list.innerHTML = values.map(function(value) {
        return [
          '<div class="rule-item">',
          '<input value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(placeholder || "输入一条规则") + '" />',
          '<button class="btn small" onclick="removeHumanRuleItem(this)">删除</button>',
          '</div>',
        ].join("");
      }).join("");
    }

    function addHumanRuleItem(id) {
      const list = $(id);
      if (!list) return;
      list.insertAdjacentHTML("beforeend", [
        '<div class="rule-item">',
        '<input value="" placeholder="输入一条规则" />',
        '<button class="btn small" onclick="removeHumanRuleItem(this)">删除</button>',
        '</div>',
      ].join(""));
    }

    function removeHumanRuleItem(button) {
      const item = button.closest(".rule-item");
      const list = item?.parentElement;
      if (item) item.remove();
      if (list && !list.querySelector(".rule-item")) addHumanRuleItem(list.id);
    }

    function collectRuleList(id) {
      const list = $(id);
      if (!list) return [];
      return Array.from(list.querySelectorAll("input"))
        .map(function(input) { return input.value.trim(); })
        .filter(Boolean);
    }

    function renderHumanEditorRules(rules) {
      setValue("humanMinChars", rules.min_body_chars || 500);
      setValue("humanMaxChars", rules.max_body_chars || 900);
      renderRuleList("humanExtraRulesList", rules.extra_rules, "例如：必须写成真实排障经历");
      renderRuleList("humanBannedPhrasesList", rules.banned_phrases, "例如：效率神器");
      renderRuleList("humanRequiredDetailsList", rules.required_details, "例如：具体报错或卡点");
    }

    function setToggle(id, enabled) {
      const button = $(id);
      button.innerHTML = enabled ? "已开启" : "已关闭";
      button.classList.toggle("primary", enabled);
    }

    function optionLabel(value) {
      const text = String(value || "");
      const match = text.match(/^([^：:]{1,8})[：:](.+)$/);
      return match ? match[1] + "：" + match[2].trim().slice(0, 18) : text;
    }

    function fillSelectOptions(id, values, selectedValue) {
      const select = $(id);
      if (!select) return;
      const items = Array.isArray(values) && values.length ? values : [];
      select.innerHTML = items.map(function(value) {
        return '<option value="' + escapeHtml(value) + '">' + escapeHtml(optionLabel(value)) + '</option>';
      }).join("");
      if (selectedValue && items.includes(selectedValue)) select.value = selectedValue;
    }

    function renderContentOptions(options = {}) {
      fillSelectOptions("contentTaskKnowledgeScope", options.knowledgeScopes, $("contentTaskKnowledgeScope")?.value);
      fillSelectOptions("contentTaskMaterialSource", options.materialSources, $("contentTaskMaterialSource")?.value);
      fillSelectOptions("contentTaskStyleReferenceType", options.styleReferenceTypes, $("contentTaskStyleReferenceType")?.value);
      fillSelectOptions("contentTaskImitationStrength", options.imitationStrengths, $("contentTaskImitationStrength")?.value);
      fillSelectOptions("contentTaskAiFlavorControl", options.aiFlavorControls, $("contentTaskAiFlavorControl")?.value);
      fillSelectOptions("contentTaskOutputMode", options.outputModes, $("contentTaskOutputMode")?.value);
      const mapping = {
        contentOptionKnowledgeScopes: options.knowledgeScopes,
        contentOptionMaterialSources: options.materialSources,
        contentOptionStyleReferenceTypes: options.styleReferenceTypes,
        contentOptionImitationStrengths: options.imitationStrengths,
        contentOptionAiFlavorControls: options.aiFlavorControls,
        contentOptionOutputModes: options.outputModes,
      };
      Object.entries(mapping).forEach(function(entry) {
        const id = entry[0];
        const values = entry[1] || [];
        if ($(id)) $(id).value = values.join("\n");
      });
    }

    function renderKnowledgeNewForm() {
      const type = $("knowledgeNewType")?.value || "topic";
      $("knowledgeTopicSelectField").style.display = type === "knowledgePoint" ? "" : "none";
      $("knowledgeNewNameLabel").textContent = type === "topic" ? "主题名称" : type === "knowledgePoint" ? "知识点标题" : type === "styleSample" ? "样例名称" : "规则名称";
      $("knowledgeNewContentLabel").textContent = type === "topic" ? "主题说明" : type === "knowledgePoint" ? "知识内容" : type === "styleSample" ? "风格样例/结构说明" : "写作规则内容";
    }

    function renderKnowledgeTopicOptions(base = knowledgeCache) {
      const select = $("knowledgeNewTopicId");
      if (!select || !base) return;
      select.innerHTML = (base.topics || []).map(function(topic) {
        return '<option value="' + escapeHtml(topic.id) + '">' + escapeHtml(topic.name) + '</option>';
      }).join("");
    }

    function renderKnowledgeBase(base = {}) {
      knowledgeCache = base;
      setTextIfExists("workbenchTopicCount", (base.topics || []).length);
      setTextIfExists("workbenchKnowledgeCount", (base.knowledgePoints || []).length);
      setTextIfExists("workbenchRuleCount", ((base.styleSamples || []).length + (base.writingRules || []).length));
      renderTopicCenter();
      renderKnowledgeHub();
      renderKnowledgeTopicOptions(base);
      renderKnowledgeNewForm();
      const topicById = new Map((base.topics || []).map(function(topic) { return [topic.id, topic.name]; }));
      const groups = [
        ["topics", "主题", base.topics || []],
        ["knowledgePoints", "知识点", base.knowledgePoints || []],
        ["styleSamples", "风格样例", base.styleSamples || []],
        ["writingRules", "写作规则", base.writingRules || []],
      ];
      document.querySelectorAll("[data-knowledge-filter]").forEach(function(button) {
        button.classList.toggle("active", button.dataset.knowledgeFilter === knowledgeFilter);
      });
      const html = groups
        .filter(function(group) { return knowledgeFilter === "all" || knowledgeFilter === group[0]; })
        .flatMap(function(group) {
          const type = group[0];
          const label = group[1];
          const apiType = type === "topics" ? "topic" : type === "knowledgePoints" ? "knowledgePoint" : type === "styleSamples" ? "styleSample" : "writingRule";
          return group[2].map(function(item) {
            const title = item.name || item.title || "-";
            const detail = item.description || item.content || "";
            const topic = item.topicId ? " · " + (topicById.get(item.topicId) || item.topicId) : "";
            return [
              '<div class="knowledge-item">',
              '<strong>' + escapeHtml(label + " · " + title) + '</strong>',
              '<div class="sub">' + escapeHtml((item.enabled === false ? "已停用 · " : "") + detail + topic) + '</div>',
              '<div class="actions" style="margin-top:8px">',
              '<button class="btn small" onclick="editKnowledgeItem(' + JSON.stringify(apiType) + ',' + JSON.stringify(item.id) + ')">编辑</button>',
              '<button class="btn small" onclick="toggleKnowledgeItem(' + JSON.stringify(apiType) + ',' + JSON.stringify(item.id) + ')">' + (item.enabled === false ? "启用" : "停用") + '</button>',
              '<button class="btn small" onclick="deleteKnowledgeItem(' + JSON.stringify(apiType) + ',' + JSON.stringify(item.id) + ')">删除</button>',
              '</div>',
              '</div>',
            ].join("");
          });
        }).join("");
      $("knowledgeList").innerHTML = html || '<div class="log-empty">暂无知识库内容。</div>';
    }

    function setKnowledgeFilter(filter) {
      knowledgeFilter = filter;
      renderKnowledgeBase(knowledgeCache || {});
    }

    function knowledgeCollectionName(type) {
      return type === "topic" ? "topics" : type === "knowledgePoint" ? "knowledgePoints" : type === "styleSample" ? "styleSamples" : "writingRules";
    }

    function findKnowledgeItem(type, id) {
      const collection = knowledgeCache?.[knowledgeCollectionName(type)] || [];
      return collection.find(function(item) { return item.id === id; });
    }

    function editKnowledgeItem(type, id) {
      const item = findKnowledgeItem(type, id);
      if (!item) return;
      $("knowledgeEditId").value = id;
      $("knowledgeNewType").value = type;
      renderKnowledgeNewForm();
      if (type === "knowledgePoint" && $("knowledgeNewTopicId")) $("knowledgeNewTopicId").value = item.topicId || "";
      $("knowledgeNewName").value = item.name || item.title || "";
      $("knowledgeNewContent").value = item.description || item.content || "";
      $("knowledgeSaveState").textContent = "正在编辑，保存后覆盖原条目。";
    }

    async function toggleKnowledgeItem(type, id) {
      const item = findKnowledgeItem(type, id);
      if (!item) return;
      const payload = {
        type,
        id,
        topicId: item.topicId || "",
        name: item.name || item.title || "",
        title: item.title || item.name || "",
        description: item.description || item.content || "",
        content: item.content || item.description || "",
        enabled: item.enabled === false,
      };
      const result = await api("/api/knowledge-base", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      renderKnowledgeBase(result.knowledgeBase || {});
    }

    async function deleteKnowledgeItem(type, id) {
      if (!confirm("确定删除这条知识库内容吗？如果删除主题，主题下的知识点也会一起删除。")) return;
      const result = await api("/api/knowledge-base/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, id }),
      });
      renderKnowledgeBase(result.knowledgeBase || {});
    }

    function renderWorkflows(workflows) {
      $("workflowCards").innerHTML = workflows.map(function(item) {
        return [
          '<div class="card">',
          '<span class="pill">' + escapeHtml(item.status) + '</span>',
          '<h2 style="margin-top:12px">' + escapeHtml(item.name) + '</h2>',
          '<p class="sub">' + escapeHtml(item.slogan) + '</p>',
          '<h3>入口</h3>',
          '<p>' + escapeHtml(item.trigger) + '</p>',
          '<h3>产出</h3>',
          '<p>' + escapeHtml(item.output) + '</p>',
          '</div>',
        ].join("");
      }).join("");
      renderWorkflowDetails();
    }

    function renderList(items) {
      return '<ol class="workflow-list">' + (items || []).map(function(item) {
        return '<li>' + escapeHtml(item) + '</li>';
      }).join("") + '</ol>';
    }

    function renderTags(items) {
      return '<div class="workflow-tags">' + (items || []).map(function(item) {
        return '<span class="workflow-tag">' + escapeHtml(item) + '</span>';
      }).join("") + '</div>';
    }

    function renderWorkflowDetails() {
      const details = ${JSON.stringify(WORKFLOW_DETAILS)};
      $("workflowDetailCards").innerHTML = details.map(function(item) {
        return [
          '<article class="workflow-detail-card">',
          '<div class="workflow-detail-head">',
          '<div><div class="workflow-detail-title">' + escapeHtml(item.name) + '</div><div class="workflow-detail-role">' + escapeHtml(item.role) + '</div></div>',
          '<span class="pill">' + escapeHtml(item.id) + '</span>',
          '</div>',
          '<div class="workflow-detail-body">',
          '<div class="workflow-block"><h3>执行步骤</h3>' + renderList(item.steps) + '</div>',
          '<div class="workflow-block"><h3>入口示例</h3>' + renderTags(item.examples) + '<h3 style="margin-top:10px">触发判断</h3><p class="sub">' + escapeHtml(item.decision) + '</p><h3>AI 调用</h3>' + renderList(item.aiCalls) + '<h3>产出物</h3>' + renderTags(item.outputs) + '<h3 style="margin-top:10px">失败降级</h3><p class="sub">' + escapeHtml(item.fallback) + '</p></div>',
          '</div>',
          '</article>',
        ].join("");
      }).join("");
    }

    function setPackageFilter(filter) {
      packageFilter = filter;
      document.querySelectorAll("[data-package-filter]").forEach(function(button) {
        button.classList.toggle("active", button.dataset.packageFilter === filter);
      });
      renderPackagesTable();
    }

    function filteredPackages() {
      if (packageFilter === "pending") return packageCache.filter(isPendingPublish);
      if (packageFilter === "published") return packageCache.filter(isPublishedPackage);
      if (packageFilter === "withImages") return packageCache.filter(function(item) { return Number(item.imageCount || 0) > 0; });
      return packageCache;
    }

    function renderPackageStats() {
      const total = packageCache.length;
      const pending = packageCache.filter(isPendingPublish).length;
      const published = packageCache.filter(isPublishedPackage).length;
      const withImages = packageCache.filter(function(item) { return Number(item.imageCount || 0) > 0; }).length;
      if ($("publishStatTotal")) $("publishStatTotal").textContent = total;
      if ($("publishStatPending")) $("publishStatPending").textContent = pending;
      if ($("publishStatPublished")) $("publishStatPublished").textContent = published;
      if ($("publishStatImages")) $("publishStatImages").textContent = withImages;
    }

    function renderPackagesTable() {
      const items = filteredPackages();
      const hintMap = {
        all: "显示全部内容资产",
        pending: "只看待发布/待审核/已生成内容",
        published: "只看已发布或已复盘内容",
        withImages: "只看包含图片素材的内容",
      };
      if ($("publishFilterHint")) $("publishFilterHint").textContent = hintMap[packageFilter] || hintMap.all;
      if (!items.length) {
        $("packagesTable").innerHTML = '<tr><td colspan="6" class="muted">当前筛选下暂无内容资产</td></tr>';
        return;
      }
      $("packagesTable").innerHTML = items.map(function(item) {
        return [
          "<tr>",
          '<td class="publish-title-cell"><strong>' + escapeHtml(item.title || item.name) + '</strong><div class="muted">' + escapeHtml(item.name) + "</div></td>",
          '<td><span class="pill">小红书</span></td>',
          '<td><span class="status-tag ' + packageStatusClass(item) + '">' + escapeHtml(item.publishStatus || "-") + '</span><div class="muted">Notion: ' + escapeHtml(item.notionStatus || "-") + "</div></td>",
          "<td>图片 " + String(item.imageCount || 0) + " 张</td>",
          "<td>" + fmtDate(item.updatedAt) + "</td>",
          '<td><div class="publish-actions"><button class="btn small primary" onclick="showPackage(\'' + encodeURIComponent(item.name) + '\')">查看</button><button class="btn small" onclick="showPackage(\'' + encodeURIComponent(item.name) + '\')">复制/发布</button></div></td>',
          "</tr>",
        ].join("");
      }).join("");
    }

    function seedContentTaskFromTopic(topic, material) {
      setValue("contentTaskTopic", topic || "");
      if (material) setValue("contentTaskMaterial", material);
      showView("contentTasks");
      const input = $("contentTaskTopic");
      if (input) input.focus();
    }

    function listHtml(items) {
      const values = Array.isArray(items) ? items.filter(Boolean) : [];
      return values.length
        ? '<ul class="viral-list">' + values.map(function(item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") + '</ul>'
        : '<div class="sub">暂无</div>';
    }

    function renderParsedReference(parsed) {
      const box = $("viralParsedReference");
      if (!box) return;
      if (!parsed) {
        box.style.display = "none";
        box.innerHTML = "";
        return;
      }
      box.style.display = "";
      if (!parsed.ok) {
        box.innerHTML = '<div class="viral-section viral-warning"><h3>没有解析到原文原图</h3><div class="sub">' + escapeHtml(parsed.error || "没有解析到内容") + '</div><div class="helper-example">可以改用手工补充：标题、正文、图片描述、评论区信息。补充后仍然可以进入拆解，但准确度会取决于你补充的信息完整度。</div></div>';
        return;
      }
      const images = Array.isArray(parsed.images) ? parsed.images : [];
      box.innerHTML = [
        '<div class="dashboard-section-head"><div><h2>解析到的原素材</h2><div class="sub">下面是页面里直接提取到的内容，不是 AI 总结。</div></div><div class="topic-meta"><span class="pill">原图 ' + images.length + ' 张</span><span class="pill">候选 ' + escapeHtml(parsed.rawImageCount || images.length) + ' 张</span><span class="pill">' + escapeHtml(parsed.parseSource || "html") + '</span></div></div>',
        '<div class="reference-layout">',
        '<div class="reference-main">',
        '<div class="reference-text-box"><div class="label">原文标题</div><strong>' + escapeHtml(parsed.title || "未提取到标题") + '</strong></div>',
        parsed.description ? '<div class="reference-text-box reference-desc"><div class="label">页面提取到的正文</div>' + escapeHtml(parsed.description) + '</div>' : '<div class="reference-text-box reference-desc"><div class="label">页面提取到的正文</div><span class="sub">暂时没有提取到正文，建议手工补充展开全文后的内容。</span></div>',
        '<div class="reference-text-box"><div class="label">来源链接</div><a href="' + escapeHtml(parsed.finalUrl || parsed.sourceUrl || "#") + '" target="_blank" rel="noreferrer">' + escapeHtml(parsed.finalUrl || parsed.sourceUrl || "无") + '</a></div>',
        '</div>',
        '<div class="reference-side">',
        images.length ? '<div class="reference-image-grid">' + images.slice(0, 12).map(function(url, index) {
          return '<a class="reference-image" href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer"><img src="' + escapeHtml(url) + '" loading="lazy" referrerpolicy="no-referrer"><span>' + (index + 1) + '</span></a>';
        }).join("") + '</div>' : '<div class="sub">没有提取到原图。</div>',
        '<div class="actions"><button class="btn small primary" onclick="focusViralNextStep()">素材没问题，下一步</button><button class="btn small" onclick="saveParsedReferenceToKnowledge()">保存到知识库</button>' + (images.length ? '<button class="btn small" onclick="copyTextToClipboard(' + JSON.stringify(images.join("\\n")) + ', &quot;viralParseState&quot;)">复制图片链接</button>' : '') + '</div>',
        '</div>',
        '</div>',
      ].join("");
    }

    function renderViralNextStep(parsed) {
      const target = $("viralResult");
      if (!target) return;
      if (!parsed) {
        target.innerHTML = [
          '<section class="viral-section">',
          '<h3>先做素材确认</h3>',
          '<ul class="viral-list">',
          '<li>1. 粘贴小红书分享文案或链接。</li>',
          '<li>2. 点击“解析对标图文”，先看原文和原图是否正确。</li>',
          '<li>3. 确认后再进入爆款拆解、灵感迁移或内容工作台。</li>',
          '</ul>',
          '</section>',
        ].join("");
        return;
      }
      if (!parsed.ok) {
        target.innerHTML = [
          '<section class="viral-section viral-warning">',
          '<h3>解析没成功，先别拆解</h3>',
          '<div class="sub">现在还没拿到可确认的原文原图。建议补充标题、展开全文、图片描述或截图文字，再继续。</div>',
          '<div class="actions" style="margin-top:10px"><button class="btn" onclick="submitViralAnalysis()">我已手工补充，继续拆解</button></div>',
          '</section>',
        ].join("");
        return;
      }
      const images = Array.isArray(parsed.images) ? parsed.images : [];
      target.innerHTML = [
        '<section class="viral-section">',
        '<h3>原素材已就绪</h3>',
        '<div class="sub">已拿到标题' + (parsed.description ? '、正文片段' : '') + '和 ' + images.length + ' 张原图。请先人工看一眼：图是不是这篇笔记的图，标题是不是你要对标的内容。</div>',
        '<div class="actions" style="margin-top:10px">',
        '<button class="btn primary" id="viralAnalyzeButton" onclick="submitViralAnalysis()">开始拆解/迁移</button>',
        '<button class="btn" onclick="sendParsedReferenceToWorkbench()">不拆解，直接带入内容工作台</button>',
        '<button class="btn" onclick="copyTextToClipboard(' + JSON.stringify([parsed.title, parsed.description].filter(Boolean).join("\\n\\n")) + ', &quot;viralState&quot;)">复制原文文字</button>',
        '</div>',
        '</section>',
        '<section class="viral-section"><h3>拆解前可选补充</h3><div class="sub">为了拆得更准，可以补充：展开全文后的完整正文、评论区高赞评论、你希望迁移到的账号方向、想植入的产品。没有也可以继续。</div></section>',
      ].join("");
    }

    function focusViralNextStep() {
      renderViralNextStep(window.__lastParsedReference);
      $("viralResult")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function sendParsedReferenceToWorkbench() {
      const parsed = window.__lastParsedReference;
      if (!parsed?.ok) return;
      const images = Array.isArray(parsed.images) ? parsed.images : [];
      setValue("contentTaskTopic", parsed.title || "");
      setValue("contentTaskMaterial", [
        parsed.title ? "对标标题：" + parsed.title : "",
        parsed.description ? "页面提取正文片段/描述：\\n" + parsed.description : "",
        parsed.finalUrl || parsed.sourceUrl ? "来源链接：" + (parsed.finalUrl || parsed.sourceUrl) : "",
        images.length ? "原图链接：\\n" + images.slice(0, 10).join("\\n") : "",
      ].filter(Boolean).join("\\n\\n"));
      showView("contentTasks");
    }

    async function parseXhsReference() {
      $("viralParseState").textContent = "正在解析链接...";
      $("viralParseButton").disabled = true;
      try {
        const parsed = await api("/api/xhs-parse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceText: $("viralSourceText")?.value || "" }),
        });
        window.__lastParsedReference = parsed;
        $("viralParseState").textContent = parsed.ok ? "解析完成，原图 " + (parsed.images?.length || 0) + " 张。" : "解析失败。";
        renderParsedReference(parsed);
        renderViralNextStep(parsed);
      } catch (error) {
        window.__lastParsedReference = null;
        $("viralParseState").textContent = "解析失败。";
        const failed = { ok: false, error: error.message || String(error) };
        renderParsedReference(failed);
        renderViralNextStep(failed);
      } finally {
        $("viralParseButton").disabled = false;
      }
    }

    function renderViralAnalysisResult(payload) {
      const result = payload?.result || {};
      const logic = result.viral_logic || {};
      const image = result.image_strategy || {};
      const brief = result.draft_brief || {};
      const angles = Array.isArray(result.migration_angles) ? result.migration_angles : [];
      if (payload?.parsedReference) {
        window.__lastParsedReference = payload.parsedReference;
        renderParsedReference(payload.parsedReference);
      }
      $("viralResult").innerHTML = [
        result.mode === "needs_more_info" ? '<section class="viral-section viral-warning"><h3>需要补充素材</h3><div class="sub">当前只拿到了链接/分享参数，Web 端无法稳定解析小红书正文和图片。请补充标题、正文、截图或图片描述后再拆解。</div><div class="helper-example">推荐补充格式：标题：...<br>正文：...<br>封面图：...<br>正文图：...<br>高赞评论：...</div></section>' : '',
        '<section class="viral-section"><h3>AI 拆解摘要</h3><div class="sub">' + escapeHtml(result.reference_summary || "暂无拆解摘要") + '</div><div class="topic-meta"><span class="pill">耗时 ' + Math.round(Number(payload.durationMs || 0) / 1000) + ' 秒</span><span class="pill">迁移方向 ' + angles.length + ' 个</span></div></section>',
        '<section class="viral-section"><h3>可确认信息</h3>' + listHtml(result.available_signals) + '<h3 style="margin-top:10px">缺失信息</h3>' + listHtml(result.missing_info) + '</section>',
        '<section class="viral-section"><h3>爆款逻辑</h3><div class="material-list">' +
          ['hook', 'pain_or_desire', 'emotion', 'structure', 'why_it_works'].map(function(key) {
            const label = { hook: "开头钩子", pain_or_desire: "痛点/欲望", emotion: "情绪", structure: "结构", why_it_works: "为什么有效" }[key];
            return '<div class="preview-item"><strong>' + label + '</strong><br>' + escapeHtml(logic[key] || "暂无") + '</div>';
          }).join("") + '</div></section>',
        '<section class="viral-section"><h3>图片策略</h3><div class="sub">封面作用：' + escapeHtml(image.cover_role || "暂无") + '</div><div class="sub">视觉风格：' + escapeHtml(image.visual_style || "暂无") + '</div><h3 style="margin-top:10px">新图方向</h3>' + listHtml(image.new_image_directions) + '</section>',
        '<section class="viral-section"><h3>迁移方向</h3><div class="material-list">' + angles.map(function(item) {
          return '<article class="viral-angle-card"><div class="viral-angle-head"><strong>' + escapeHtml(item.title || "未命名方向") + '</strong><span class="viral-score">' + escapeHtml(item.fit_score ?? "-") + '</span></div><div class="sub">' + escapeHtml(item.angle || "") + '</div><div class="sub">风险：' + escapeHtml(item.risk || "需人工判断") + '</div><div class="sub">理由：' + escapeHtml(item.why || "") + '</div></article>';
        }).join("") + '</div></section>',
        '<section class="viral-section"><h3>推荐继续做</h3><div class="sub"><strong>' + escapeHtml(result.recommended_direction?.title || brief.topic || "未给出") + '</strong></div><div class="sub">' + escapeHtml(result.recommended_direction?.reason || "") + '</div><div class="actions" style="margin-top:10px"><button class="btn primary" onclick="sendViralBriefToWorkbench()">带入内容工作台</button><button class="btn" onclick="copyTextToClipboard(' + JSON.stringify(JSON.stringify(result, null, 2)) + ', &quot;viralState&quot;)">复制 JSON</button></div></section>',
        '<section class="viral-section"><h3>安全提醒</h3>' + listHtml(result.safety_notes) + '</section>',
      ].join("");
      window.__lastViralBrief = brief;
    }

    function sendViralBriefToWorkbench() {
      const brief = window.__lastViralBrief || {};
      setValue("contentTaskTopic", brief.topic || "");
      setValue("contentTaskGoal", brief.goal || "");
      setValue("contentTaskAudience", brief.audience || "");
      setValue("contentTaskStyle", brief.style || "");
      setValue("contentTaskMaterial", brief.material || "");
      setValue("contentTaskRequirements", [
        window.__lastParsedReference?.title ? "参考标题：" + window.__lastParsedReference.title : "",
        window.__lastParsedReference?.images?.length ? "参考原图链接：\n" + window.__lastParsedReference.images.slice(0, 10).join("\n") : "",
        brief.image_prompt_brief ? "配图方向：" + brief.image_prompt_brief : "",
        "这篇内容来自爆款拆解结果，但必须换主题、换表达、换素材，不能复刻原文原图。",
      ].filter(Boolean).join("\\n"));
      showView("contentTasks");
    }

    async function saveParsedReferenceToKnowledge() {
      const parsed = window.__lastParsedReference;
      if (!parsed?.ok) {
        setTextIfExists("viralState", "没有可保存的解析素材。");
        return;
      }
      const images = Array.isArray(parsed.images) ? parsed.images : [];
      const content = [
        "类型：爆款解析样例",
        parsed.title ? "原文标题：" + parsed.title : "",
        parsed.description ? "原文正文：\\n" + parsed.description : "",
        parsed.finalUrl || parsed.sourceUrl ? "来源链接：" + (parsed.finalUrl || parsed.sourceUrl) : "",
        images.length ? "原图链接：\\n" + images.join("\\n") : "",
        "使用建议：只学习选题、结构、表达节奏和图片组织方式，不直接搬运原文原图。",
      ].filter(Boolean).join("\\n\\n");
      setTextIfExists("viralState", "正在保存到知识库...");
      try {
        const result = await api("/api/knowledge-base", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "styleSample",
            name: "爆款样例｜" + (parsed.title || "未命名样例"),
            content,
            enabled: true,
          }),
        });
        knowledgeCache = result.knowledgeBase || knowledgeCache;
        renderKnowledgeBase(knowledgeCache || {});
        renderKnowledgeHub();
        setTextIfExists("viralState", "已保存到知识库：风格样例。");
      } catch (error) {
        setTextIfExists("viralState", "保存失败：" + (error.message || String(error)));
      }
    }

    async function submitViralAnalysis() {
      $("viralState").textContent = "正在拆解参考内容...";
      const analyzeButton = $("viralAnalyzeButton");
      if (analyzeButton) analyzeButton.disabled = true;
      try {
        const result = await api("/api/viral-analysis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceText: $("viralSourceText")?.value || "",
            accountDirection: $("viralAccountDirection")?.value || "",
            targetTopic: $("viralTargetTopic")?.value || "",
            productMention: $("viralProductMention")?.value || "",
            parsedReference: window.__lastParsedReference || null,
          }),
        });
        $("viralState").textContent = "拆解完成。";
        renderViralAnalysisResult(result);
        await loadLogs();
      } catch (error) {
        $("viralState").textContent = "拆解失败。";
        $("viralResult").innerHTML = '<div class="preview-item">错误：' + escapeHtml(error.message || String(error)) + '</div>';
      } finally {
        const latestAnalyzeButton = $("viralAnalyzeButton");
        if (latestAnalyzeButton) latestAnalyzeButton.disabled = false;
      }
    }

    function clearViralAnalysis() {
      ["viralSourceText", "viralAccountDirection", "viralTargetTopic", "viralProductMention"].forEach(function(id) { setValue(id, ""); });
      $("viralState").textContent = "";
      $("viralParseState").textContent = "";
      renderParsedReference(null);
      renderViralNextStep(null);
      window.__lastViralBrief = null;
      window.__lastParsedReference = null;
    }

    function getKnowledgeTopicNames() {
      return (knowledgeCache?.topics || []).map(function(topic) { return topic.name; }).filter(Boolean);
    }

    function renderTopicCenter() {
      const pending = packageCache.filter(isPendingPublish);
      const knowledgeTopics = getKnowledgeTopicNames();
      const generated = packageCache.slice(0, 6).map(function(item) {
        return {
          title: item.title || item.name,
          source: "内容资产",
          desc: "来自已有发布包，可继续改写、复盘或做系列选题。",
          status: item.publishStatus || "本地已保存",
          material: "参考已有发布包：" + item.name,
        };
      });
      const fromKnowledge = knowledgeTopics.slice(0, 6).map(function(name) {
        return {
          title: name + "：做一篇更具体的小红书笔记",
          source: "知识库",
          desc: "来自本地知识库主题，适合继续补充真实经历和案例。",
          status: "候选",
          material: "围绕知识库主题「" + name + "」展开，优先结合真实使用场景。",
        };
      });
      const candidates = [...generated, ...fromKnowledge].slice(0, 10);
      setTextIfExists("topicCandidateCount", candidates.length);
      setTextIfExists("topicPendingCount", pending.length);
      setTextIfExists("topicKnowledgeCount", knowledgeTopics.length);
      if (!$("topicCandidateList")) return;
      $("topicCandidateList").innerHTML = candidates.length ? candidates.map(function(item) {
        return [
          '<article class="topic-card">',
          '<h3>' + escapeHtml(item.title) + '</h3>',
          '<div class="sub">' + escapeHtml(item.desc) + '</div>',
          '<div class="topic-meta"><span class="pill">' + escapeHtml(item.source) + '</span><span class="status-tag">' + escapeHtml(item.status) + '</span></div>',
          '<div class="actions"><button class="btn small primary" onclick="seedContentTaskFromTopic(' + JSON.stringify(item.title) + ', ' + JSON.stringify(item.material) + ')">做成发布包</button></div>',
          '</article>',
        ].join("");
      }).join("") : '<div class="log-empty">还没有可用候选题。先生成一篇内容，或在知识库里添加主题。</div>';
    }

    function renderMaterialLibrary() {
      const withImages = packageCache.filter(function(item) { return Number(item.imageCount || 0) > 0; });
      setTextIfExists("materialPackageCount", packageCache.length);
      setTextIfExists("materialImageCount", withImages.length);
      setTextIfExists("materialTextCount", packageCache.length);
      if (!$("materialList")) return;
      $("materialList").innerHTML = packageCache.slice(0, 12).map(function(item) {
        return [
          '<article class="material-item">',
          '<div>',
          '<h3>' + escapeHtml(item.title || item.name) + '</h3>',
          '<div class="sub">' + escapeHtml(item.path || "") + '</div>',
          '<div class="material-meta"><span class="pill">' + escapeHtml(item.publishStatus || "本地素材") + '</span><span class="pill">图片 ' + String(item.imageCount || 0) + ' 张</span><span class="pill">' + escapeHtml(fmtDate(item.updatedAt)) + '</span></div>',
          '</div>',
          '<div class="actions"><button class="btn small" onclick="showPackage(' + JSON.stringify(encodeURIComponent(item.name)) + '); showView(&quot;packages&quot;)">查看素材</button><button class="btn small primary" onclick="seedContentTaskFromTopic(' + JSON.stringify(item.title || item.name) + ', ' + JSON.stringify("复用本地素材包：" + item.name) + ')">再加工</button></div>',
          '</article>',
        ].join("");
      }).join("") || '<div class="log-empty">暂无本地素材包。</div>';
    }

    function renderReviewAnalytics() {
      const pending = packageCache.filter(isPendingPublish);
      const done = packageCache.filter(isPublishedPackage);
      const needNotes = done.filter(function(item) {
        return !item.publishedUrl && !item.reviewNotes;
      });
      setTextIfExists("reviewPendingCount", pending.length);
      setTextIfExists("reviewDoneCount", done.length);
      setTextIfExists("reviewNeedNotesCount", needNotes.length);
      if (!$("reviewSuggestionList")) return;
      const suggestions = [
        pending.length ? {
          title: "优先处理待发布内容",
          desc: "还有 " + pending.length + " 个内容资产处于已生成/待审核/待发布状态，建议先发布或标记放弃。",
          action: "去处理",
          view: "packages",
        } : {
          title: "待发布队列比较干净",
          desc: "当前没有明显积压，可以开始补充新选题或沉淀知识库。",
          action: "去选题",
          view: "topics",
        },
        needNotes.length ? {
          title: "已发布内容缺少复盘记录",
          desc: needNotes.length + " 篇内容建议补充发布链接、表现数据和下次优化点。",
          action: "补复盘",
          view: "packages",
        } : {
          title: "已发布内容复盘状态正常",
          desc: "后续接平台数据后，这里会展示浏览、点赞、收藏和转化趋势。",
          action: "看资产",
          view: "packages",
        },
        {
          title: "建议每周做一次选题复盘",
          desc: "把发布效果好的标题、开头、配图方向沉淀到知识库，下一次生成会更稳定。",
          action: "看知识库",
          view: "knowledge",
        },
      ];
      $("reviewSuggestionList").innerHTML = suggestions.map(function(item) {
        return [
          '<article class="material-item">',
          '<div><h3>' + escapeHtml(item.title) + '</h3><div class="sub">' + escapeHtml(item.desc) + '</div></div>',
          '<button class="btn small primary" onclick="showView(' + JSON.stringify(item.view) + ')">' + escapeHtml(item.action) + '</button>',
          '</article>',
        ].join("");
      }).join("");
    }

    function renderKnowledgeHub() {
      const base = knowledgeCache || {};
      const topics = base.topics || [];
      const points = base.knowledgePoints || [];
      const styles = base.styleSamples || [];
      const rules = base.writingRules || [];
      setTextIfExists("knowledgeHubTopics", topics.length);
      setTextIfExists("knowledgeHubPoints", points.length);
      setTextIfExists("knowledgeHubRules", styles.length + rules.length);
      if (!$("knowledgeHubList")) return;
      const groups = [
        ["主题", topics, function(item) { return item.name + (item.description ? "：" + item.description : ""); }],
        ["知识点", points, function(item) { return item.title + (item.content ? "：" + item.content : ""); }],
        ["风格样例", styles, function(item) { return item.name + (item.content ? "：" + item.content : ""); }],
        ["写作规则", rules, function(item) { return item.name + (item.content ? "：" + item.content : ""); }],
      ];
      $("knowledgeHubList").innerHTML = groups.map(function(group) {
        const items = group[1].slice(0, 8);
        return [
          '<article class="knowledge-hub-card">',
          '<h3>' + escapeHtml(group[0]) + '</h3>',
          items.length ? '<ul>' + items.map(function(item) { return '<li>' + escapeHtml(group[2](item)) + '</li>'; }).join("") + '</ul>' : '<div class="sub">暂无内容</div>',
          '</article>',
        ].join("");
      }).join("");
    }

    function resetBusinessFlowForm() {
      setValue("businessFlowId", "");
      setValue("businessFlowName", "");
      setValue("businessFlowReplyPrefix", "");
      setValue("businessFlowGoal", "");
      setValue("businessFlowOutputFormat", "");
      renderRuleList("businessFlowTriggersList", [], "例如：小红书 token代理");
      renderRuleList("businessFlowRulesList", [], "例如：先判断用户真实意图，再给可执行建议");
      const state = $("businessFlowSaveState");
      if (state) state.textContent = "";
    }

    const businessFlowTemplates = {
      tokenTopics: {
        name: "Token 代理选题顾问",
        triggers: ["小红书 token代理", "token代理选题", "今天token代理写什么"],
        goal: "围绕 AI 工具基础设施、API 调用、Token 代理、模型中转等方向，生成适合小红书发布的选题，并给出软性广告切入点。",
        rules: [
          "不要把 Token 代理解释成自动化助手，它本质是 API 调用/模型访问/额度与稳定性的基础设施服务。",
          "内容必须面向真实用户问题，例如模型不可用、接口报错、余额消耗、调用不稳定、不同模型切换麻烦。",
          "广告只能软性出现，作为“可选解决方案”或“我现在的处理方式”，不能强推。",
          "每个选题都要有具体使用场景，避免空泛讲概念。",
        ],
        outputFormat: "请输出 5 个小红书选题。每个选题包含：标题、适合人群、用户痛点、正文角度、软广切入点、配图建议。最后给出今天最推荐做的 1 个。",
        replyPrefix: "我按 Token 代理内容方向整理好了：",
      },
      humanRewrite: {
        name: "小红书去 AI 味改写",
        triggers: ["帮我去AI味", "小红书改自然", "这篇改真人一点"],
        goal: "把用户发来的草稿改成更像真实小红书笔记的表达，降低 AI 味，提高真实经历感和可发布性。",
        rules: [
          "删掉过于工整的编号和总结腔，除非用户明确要求保留清单。",
          "开头优先使用具体场景，不要用“最近很多人都在讨论”。",
          "加入一点真实犹豫、误判或修正过程，但不要编造硬事实。",
          "语气要像个人笔记，不像教程、新闻稿或百科。",
          "保留用户原意，不要为了口语化改丢核心信息。",
        ],
        outputFormat: "请输出：1. 修改后的正文；2. 3 个标题备选；3. 改动说明，说明主要去掉了哪些 AI 味；4. 如果还有风险，列出需要人工确认的点。",
        replyPrefix: "我先帮你改成更自然的一版：",
      },
      dailyOpportunities: {
        name: "每日内容机会筛选",
        triggers: ["今天适合写什么", "今天有哪些内容机会", "帮我找选题"],
        goal: "根据用户给出的方向或已有素材，筛选今天最值得做的内容机会，并判断哪些适合继续做成发布包。",
        rules: [
          "优先选择普通人能看懂、能产生共鸣、能引出经验分享的选题。",
          "不要只追热点，要说明为什么这个选题适合当前账号。",
          "每个机会都要判断：能不能写成故事、能不能带观点、能不能软性带产品。",
          "如果素材不足，要明确告诉用户还缺什么信息。",
        ],
        outputFormat: "请输出：今日推荐方向、5 个内容机会、每个机会的价值判断、适合的平台表达、小红书标题草案、是否建议继续做发布包。",
        replyPrefix: "我帮你筛了一轮今天的内容机会：",
      },
    };

    function applyBusinessFlowTemplate(key) {
      const template = businessFlowTemplates[key];
      if (!template) return;
      setValue("businessFlowId", "");
      setValue("businessFlowName", template.name);
      setValue("businessFlowReplyPrefix", template.replyPrefix);
      setValue("businessFlowGoal", template.goal);
      setValue("businessFlowOutputFormat", template.outputFormat);
      renderRuleList("businessFlowTriggersList", template.triggers, "例如：小红书 token代理");
      renderRuleList("businessFlowRulesList", template.rules, "例如：先判断用户真实意图，再给可执行建议");
      $("businessFlowSaveState").textContent = "已套用模板，你可以微调后保存。";
    }

    function renderBusinessFlows(flows) {
      renderRuleList("businessFlowTriggersList", collectRuleList("businessFlowTriggersList"), "例如：小红书 token代理");
      renderRuleList("businessFlowRulesList", collectRuleList("businessFlowRulesList"), "例如：先判断用户真实意图，再给可执行建议");
      const list = $("businessFlowList");
      if (!list) return;
      if (!flows.length) {
        list.innerHTML = '<div class="sub">还没有自定义业务流。左侧填好后点“生成/保存业务流”，微信里就可以用触发词调用。</div>';
        return;
      }
      list.innerHTML = flows.map(function(flow) {
        return [
          '<div class="business-flow-item">',
          '<div class="business-flow-title"><span>' + escapeHtml(flow.name) + '</span><span class="pill">' + (flow.enabled ? "启用" : "停用") + '</span></div>',
          '<div class="business-flow-meta">' + renderTags(flow.triggers || []) + '</div>',
          flow.goal ? '<div class="sub">' + escapeHtml(flow.goal) + '</div>' : '',
          '<div class="actions">',
          '<button class="btn small" onclick="editBusinessFlow(\'' + escapeHtml(flow.id) + '\')">编辑</button>',
          '<button class="btn small" onclick="deleteBusinessFlow(\'' + escapeHtml(flow.id) + '\')">删除</button>',
          '</div>',
          '</div>',
        ].join("");
      }).join("");
    }

    function editBusinessFlow(id) {
      const flow = (statusCache?.customBusinessFlows || []).find(function(item) { return item.id === id; });
      if (!flow) return;
      setValue("businessFlowId", flow.id);
      setValue("businessFlowName", flow.name);
      setValue("businessFlowReplyPrefix", flow.reply_prefix || "");
      setValue("businessFlowGoal", flow.goal || flow.description || "");
      setValue("businessFlowOutputFormat", flow.output_format || "");
      renderRuleList("businessFlowTriggersList", flow.triggers, "例如：小红书 token代理");
      renderRuleList("businessFlowRulesList", flow.rules, "例如：先判断用户真实意图，再给可执行建议");
      $("businessFlowSaveState").textContent = "正在编辑：" + flow.name;
    }

    async function loadPackages() {
      const data = await api("/api/packages");
      packageCache = data.items || [];
      renderPackageStats();
      renderPackagesTable();
      renderTopicCenter();
      renderMaterialLibrary();
      renderReviewAnalytics();
    }

    function renderStatusOptions(current) {
      const statuses = ["已生成", "待审核", "待发布", "已发布", "已复盘", "已放弃"];
      const value = current || "已生成";
      return statuses.map(function(status) {
        return '<option value="' + escapeHtml(status) + '"' + (status === value ? " selected" : "") + ">" + escapeHtml(status) + "</option>";
      }).join("");
    }

    async function showPackage(name) {
      const detail = await api("/api/package?name=" + name);
      const data = detail.data || {};
      const title = (data.draft && data.draft.title) || detail.name;
      const bodyText = detail.copyPost || detail.finalPost || "";
      const encodedName = encodeURIComponent(detail.name);
      $("packageDetail").classList.add("active");
      $("packageDetail").innerHTML = [
        '<div class="card">',
        '<div class="dashboard-section-head">',
        '<div><h2>' + escapeHtml(title) + '</h2><div class="sub">' + escapeHtml(detail.path) + '</div><div class="publish-meta-line"><span class="status-tag ' + (data.publishStatus === "已发布" ? "done" : "") + '">' + escapeHtml(data.publishStatus || "已生成") + '</span><span class="pill">图片 ' + String((detail.imageFiles || []).length) + ' 张</span></div></div>',
        '<button class="btn small" onclick="$(\'packageDetail\').classList.remove(\'active\')">收起</button>',
        '</div>',
        '<div class="publish-detail-grid">',
        '<section class="publish-detail-card">',
        '<h3>复制发布版</h3>',
        '<div class="actions"><button class="btn small primary" onclick="copyTextToClipboard(' + JSON.stringify(bodyText) + ', &quot;packageActionState&quot;)">复制正文</button><button class="btn small" onclick="copyTextToClipboard(' + JSON.stringify(detail.path) + ', &quot;packageActionState&quot;)">复制本地路径</button><button class="btn small" onclick="copyTextToClipboard(' + JSON.stringify(detail.name) + ', &quot;packageActionState&quot;)">复制发布包名</button><span class="sub" id="packageActionState"></span></div>',
        '<pre class="publish-copy-box">' + escapeHtml(bodyText || "未找到正文") + '</pre>',
        '</section>',
        '<section class="publish-detail-card">',
        '<h3>发布流转</h3>',
        '<div class="publish-meta-form">',
        '<label>当前状态<select id="packagePublishStatus">' + renderStatusOptions(data.publishStatus) + '</select></label>',
        '<label>发布链接<input id="packagePublishedUrl" value="' + escapeHtml(data.publishedUrl || "") + '" placeholder="发布后粘贴小红书/公众号等链接"></label>',
        '<label>复盘备注<textarea id="packageReviewNotes" placeholder="记录发布时间、标题调整、平台反馈、下一步优化">' + escapeHtml(data.reviewNotes || "") + '</textarea></label>',
        '</div>',
        '<div class="actions"><button class="btn primary" onclick="savePackageMeta(' + JSON.stringify(encodedName) + ')">保存状态</button><button class="btn" onclick="showView(&quot;logs&quot;)">查看日志</button><span class="sub" id="packageSaveState"></span></div>',
        '<h3>本地图片素材</h3><pre>' + escapeHtml((detail.imageFiles || []).join("\\n") || "暂无本地图片文件") + '</pre>',
        '<h3>质检</h3><pre>' + escapeHtml([detail.humanReview, detail.quality].filter(Boolean).join("\\n\\n") || "暂无质检文件") + '</pre>',
        '<h3>配图提示词</h3><pre>' + escapeHtml(detail.imageGuide || "未找到图片说明") + '</pre>',
        '<h3>生成与重写流程</h3><pre>' + escapeHtml(detail.workflow || "未找到流程文档") + '</pre>',
        '</section>',
        '</div>',
        '</div>',
      ].join("");
      $("packageDetail").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function savePackageMeta(encodedName) {
      const state = $("packageSaveState");
      if (state) state.textContent = "保存中...";
      try {
        const result = await api("/api/package/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: decodeURIComponent(encodedName),
            publishStatus: $("packagePublishStatus")?.value || "已生成",
            publishedUrl: $("packagePublishedUrl")?.value || "",
            reviewNotes: $("packageReviewNotes")?.value || "",
          }),
        });
        if (state) state.textContent = "已保存。";
        await loadPackages();
        showPackage(encodeURIComponent(result.name || decodeURIComponent(encodedName)));
      } catch (error) {
        if (state) state.textContent = "保存失败：" + (error.message || String(error));
      }
    }

    async function loadConfig() {
      $("configJson").textContent = JSON.stringify(await api("/api/config"), null, 2);
    }

    function parseLogLine(line) {
      const match = String(line || "").match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+([^\{]*)(?:\s+(\{.*\}))?$/);
      if (!match) {
        return { time: "", level: "RAW", message: String(line || ""), detail: "", extra: null, noisy: false, raw: line };
      }
      let detail = match[4] || "";
      let extra = null;
      if (detail) {
        try {
          extra = JSON.parse(detail);
          detail = JSON.stringify(extra, null, 2);
        } catch {
          // Keep original detail when the log suffix is not strict JSON.
        }
      }
      const message = match[3].trim();
      const explained = explainLog(message, match[2].trim(), extra);
      return {
        time: fmtDate(match[1]),
        level: match[2].trim(),
        message,
        displayMessage: explained.title,
        explanation: explained.explanation,
        action: explained.action,
        detail,
        extra,
        noisy: message === "Poll result" || message === "Sync completed",
        raw: line,
      };
    }

    function setLogFilter(filter) {
      logFilter = filter;
      ["Workflow", "All", "Important", "Errors"].forEach(function(name) {
        const id = "logFilter" + name;
        if ($(id)) $(id).classList.toggle("primary", filter.toLowerCase() === name.toLowerCase());
      });
      renderLogs();
    }

    function filteredLogs() {
      if (logFilter === "errors") return logCache.filter((item) => item.level === "ERROR" || item.level === "WARN");
      if (logFilter === "important") return logCache.filter((item) => !item.noisy || item.level === "ERROR" || item.level === "WARN");
      return logCache;
    }

    function buildWorkflowRuns() {
      const runs = new Map();
      const ordered = [];
      let legacyRun = null;

      function ensureRun(id, item) {
        if (!runs.has(id)) {
          const run = {
            id,
            startedAt: item.time,
            userText: item.extra?.userText || item.extra?.text || item.message,
            status: "running",
            durationMs: null,
            items: [],
          };
          runs.set(id, run);
          ordered.push(run);
        }
        return runs.get(id);
      }

      logCache.forEach(function(item, index) {
        const explicitId = item.extra?.workflowRunId;
        if (explicitId) {
          const run = ensureRun(explicitId, item);
          run.items.push(item);
          if (item.extra?.userText) run.userText = item.extra.userText;
          if (item.message === "Workflow run completed") {
            run.status = item.extra?.status || (item.level === "ERROR" ? "failed" : "completed");
            run.durationMs = item.extra?.durationMs ?? run.durationMs;
          }
          if (item.level === "ERROR") run.status = "failed";
          return;
        }

        if (item.message === "Inbound text") {
          legacyRun = ensureRun("legacy-" + index, item);
          legacyRun.userText = item.extra?.text || item.extra?.userText || "旧日志工作流";
          legacyRun.items.push(item);
          return;
        }
        if (legacyRun && !item.noisy) {
          legacyRun.items.push(item);
          if (item.message === "Replied") {
            legacyRun.status = "completed";
            legacyRun = null;
          } else if (item.level === "ERROR") {
            legacyRun.status = "failed";
            legacyRun = null;
          }
        }
      });

      return ordered.reverse();
    }

    function renderWorkflowRuns() {
      const runs = buildWorkflowRuns();
      if (!runs.length) {
        $("workflowRunsList").innerHTML = '<div class="log-empty">最近日志里还没有完整工作流。等你在微信里发一次任务，这里会按每次请求聚合展示。</div>';
        return;
      }
      $("workflowRunsList").innerHTML = runs.slice(0, 12).map(function(run) {
        const aiCallStats = countAiCalls(run.items);
        const warnings = run.items.filter((item) => item.level === "WARN").length;
        const errors = run.items.filter((item) => item.level === "ERROR").length;
        const statusLabel = run.status === "failed" ? "失败" : run.status === "completed" ? "完成" : "运行中";
        const aiCallHint = aiCallStats.mode === "legacy-unknown"
          ? '<div class="workflow-run-meta">这条是旧日志，只能看到用过模型，但没有逐次调用记录；新任务会精确统计。</div>'
          : aiCallStats.mode === "legacy-unknown-with-image"
            ? '<div class="workflow-run-meta">这条是旧日志，能看到执行过生图，但没有逐次调用记录；新任务会把每张图单独计入。</div>'
          : '';
        const steps = buildWorkflowStepCards(run);
        return [
          '<div class="workflow-run-card ' + escapeHtml(run.status) + '">',
          '<div class="workflow-run-head">',
          '<div>',
          '<div class="workflow-run-title">' + escapeHtml(run.userText || "一次工作流") + '</div>',
          '<div class="workflow-run-meta">' + escapeHtml(run.startedAt || "-") + ' · AI 调用 ' + escapeHtml(formatAiCallCount(aiCallStats)) + ' · 警告 ' + warnings + ' · 错误 ' + errors + (run.durationMs ? ' · 耗时 ' + Math.round(run.durationMs / 1000) + ' 秒' : '') + '</div>',
          aiCallHint,
          '</div>',
          '<span class="log-action">' + statusLabel + '</span>',
          '</div>',
          '<div class="workflow-steps">' + (steps || '<div class="workflow-step-desc">暂无步骤详情</div>') + '</div>',
          '</div>',
        ].join("");
      }).join("");
    }

    function getAiStepName(purpose) {
      const text = String(purpose || "");
      const name = text.split("：")[0].split(":")[0].trim();
      return name || "AI 步骤";
    }

    function renderStepChips(chips) {
      return '<div class="workflow-step-meta">' + chips.map(function(chip) {
        return '<span class="step-chip ' + escapeHtml(chip.kind || "") + '">' + escapeHtml(chip.text) + '</span>';
      }).join("") + '</div>';
    }

    function buildWorkflowStepCards(run) {
      const items = run.items.filter((item) => !item.noisy && item.message !== "Workflow run started");
        const aiStarts = items.filter((item) => item.message === "AI API call" || item.message === "AI image call");
        if (aiStarts.length) {
          const completedByKey = new Map();
          items
          .filter((item) => item.message === "AI API call completed" || item.message === "AI image call completed")
          .forEach(function(item) {
            const extra = item.extra || {};
            completedByKey.set(String(extra.step || "") + "|" + String(extra.purpose || ""), item);
          });
        const aiCards = aiStarts.map(function(item) {
          const extra = item.extra || {};
          const done = completedByKey.get(String(extra.step || "") + "|" + String(extra.purpose || ""));
          const doneExtra = done?.extra || {};
          const isHermes = /Hermes|研究增强/.test(String(extra.purpose || ""));
          const isImage = item.message === "AI image call" || /生图|图片/.test(String(extra.purpose || ""));
          const stepLabel = extra.step && extra.totalSteps ? "第 " + extra.step + "/" + extra.totalSteps + " 步" : "AI 调用";
          const chips = [
            { kind: isImage ? "image" : "ai", text: isImage ? "生图" : "AI" },
            { kind: "", text: stepLabel },
            { kind: "", text: extra.model || doneExtra.model || "模型未知" },
          ];
          if (isHermes) chips.splice(1, 0, { kind: "hermes", text: "Hermes" });
          if (doneExtra.durationMs !== undefined) chips.push({ kind: "done", text: Math.round(Number(doneExtra.durationMs) / 1000) + " 秒" });
          const purpose = String(extra.purpose || "");
          return [
            '<div class="workflow-step ai-step ' + (isHermes ? "hermes-step" : "") + (isImage ? " image-step" : "") + '">',
            renderStepChips(chips),
            '<div class="workflow-step-title">' + escapeHtml(getAiStepName(purpose)) + '</div>',
            '<div class="workflow-step-desc">' + escapeHtml(purpose || "这一步调用模型处理内容。") + '</div>',
            '</div>',
          ].join("");
        });
        const tailCards = items
          .filter((item) => !["AI API call", "AI API call completed", "AI image call", "AI image call completed", "Inbound text"].includes(item.message))
          .slice(-4)
          .map(function(item) {
            return [
              '<div class="workflow-step system-step">',
              renderStepChips([{ kind: item.level === "WARN" || item.level === "ERROR" ? "" : "done", text: item.level || "INFO" }]),
              '<div class="workflow-step-title">' + escapeHtml(item.displayMessage || item.message) + '</div>',
              item.explanation ? '<div class="workflow-step-desc">' + escapeHtml(item.explanation) + '</div>' : '',
              '</div>',
            ].join("");
          });
        return aiCards.concat(tailCards).join("");
      }

      return items
        .slice(-10)
        .map(function(item) {
          return [
            '<div class="workflow-step system-step">',
            '<div class="workflow-step-title">' + escapeHtml(item.displayMessage || item.message) + '</div>',
            item.explanation ? '<div class="workflow-step-desc">' + escapeHtml(item.explanation) + '</div>' : '',
            '</div>',
          ].join("");
        })
        .join("");
    }

    function renderLiveLogs() {
      const liveItems = logCache
        .filter((item) => !item.noisy || item.level === "WARN" || item.level === "ERROR" || item.message === "Bridge starting")
        .slice(-8)
        .reverse();
      if (!liveItems.length) {
        $("liveLogsList").innerHTML = '<div class="log-empty">暂无当前运行日志</div>';
        return;
      }
      $("liveLogsList").innerHTML = liveItems.map(function(item) {
        return [
          '<div class="log-entry ' + (item.noisy ? 'noisy' : '') + '">',
          '<div class="log-time">' + escapeHtml(item.time || "-") + '</div>',
          '<div><span class="log-level ' + escapeHtml(item.level) + '">' + escapeHtml(item.level) + '</span></div>',
          '<div>',
          '<div class="log-message">' + escapeHtml(item.displayMessage || item.message || item.raw || "-") + '</div>',
          item.explanation ? '<div class="log-explain">' + escapeHtml(item.explanation) + '</div>' : '',
          item.action ? '<div class="log-action">' + escapeHtml(item.action) + '</div>' : '',
          item.detail ? '<details class="log-detail"><summary>查看详情</summary>' + escapeHtml(item.detail) + '</details>' : '',
          '</div>',
          '</div>',
        ].join("");
      }).join("");
    }

    function hasAiModelMarker(item) {
      if (!item || item.message === "AI API call" || item.message === "AI API call completed") return false;
      const extra = item.extra || {};
      return Boolean(extra.model || extra.provider || extra.step || extra.purpose);
    }

    function countAiCalls(items) {
      const explicit = items.filter((item) => item.message === "AI API call" || item.message === "AI image call").length;
      if (explicit > 0) return { count: explicit, mode: "exact" };
      const inferred = items.filter(hasAiModelMarker).length;
      const legacyImages = items.some((item) => item.extra?.imageStatus === "generated" || item.extra?.imageStatus === "failed");
      if (legacyImages) return { count: inferred, mode: "legacy-unknown-with-image" };
      return { count: inferred, mode: inferred > 0 ? "legacy-unknown" : "none" };
    }

    function formatAiCallCount(stats) {
      if (!stats || stats.mode === "none") return "0 次";
      if (stats.mode === "legacy-unknown-with-image") return "旧日志未记录次数（含生图）";
      if (stats.mode === "legacy-unknown") return "旧日志未记录次数";
      return stats.count + " 次";
    }

    function renderLogOverview(counts) {
      const overview = $("logOverview");
      if (!overview) return;
      const runs = buildWorkflowRuns();
      const aiCallStats = countAiCalls(logCache);
      const issues = (counts.WARN || 0) + (counts.ERROR || 0);
      const aiCallOverviewLabel = aiCallStats.mode === "legacy-unknown" ? "AI 调用" : "AI 调用";
      overview.innerHTML = [
        '<div class="log-overview-card"><div class="log-overview-label">日志行数</div><div class="log-overview-value">' + logCache.length + '</div></div>',
        '<div class="log-overview-card"><div class="log-overview-label">工作流</div><div class="log-overview-value">' + runs.length + '</div></div>',
        '<div class="log-overview-card"><div class="log-overview-label">' + aiCallOverviewLabel + '</div><div class="log-overview-value">' + escapeHtml(formatAiCallCount(aiCallStats)) + '</div></div>',
        '<div class="log-overview-card"><div class="log-overview-label">异常</div><div class="log-overview-value">' + issues + '</div></div>',
      ].join("");
    }

    function renderLogs() {
      const items = filteredLogs().slice(-500);
      const counts = logCache.reduce(function(acc, item) {
        acc[item.level] = (acc[item.level] || 0) + 1;
        return acc;
      }, {});
      $("logSummary").textContent = "最近 " + logCache.length + " 行日志 · INFO " + (counts.INFO || 0) + " · WARN " + (counts.WARN || 0) + " · ERROR " + (counts.ERROR || 0);
      renderLogOverview(counts);
      if (logFilter === "workflow") {
        $("workflowLogPanel").style.display = "";
        $("logsDetailPanel").style.display = "none";
        renderWorkflowRuns();
        renderLiveLogs();
        return;
      }
      $("workflowLogPanel").style.display = "none";
      $("logsDetailPanel").style.display = "";
      $("logsList").className = "log-list";
      if (!items.length) {
        $("logsList").innerHTML = '<div class="log-empty">当前筛选下暂无日志</div>';
        return;
      }
      $("logsList").innerHTML = items.map(function(item) {
        return [
          '<div class="log-entry ' + (item.noisy ? 'noisy' : '') + '">',
          '<div class="log-time">' + escapeHtml(item.time || "-") + '</div>',
          '<div><span class="log-level ' + escapeHtml(item.level) + '">' + escapeHtml(item.level) + '</span></div>',
          '<div>',
          '<div class="log-message">' + escapeHtml(item.displayMessage || item.message || item.raw || "-") + '</div>',
          item.explanation ? '<div class="log-explain">' + escapeHtml(item.explanation) + '</div>' : '',
          item.action ? '<div class="log-action">' + escapeHtml(item.action) + '</div>' : '',
          item.detail ? '<details class="log-detail"><summary>查看详情</summary>' + escapeHtml(item.detail) + '</details>' : '',
          '</div>',
          '</div>',
        ].join("");
      }).join("");
    }

    async function loadLogs() {
      const data = await api("/api/logs");
      $("logPath").textContent = data.path || "";
      logCache = (data.lines || []).map(parseLogLine);
      renderLogs();
    }

    async function toggleSetting(key) {
      const current = {
        enableNotion: Boolean(statusCache?.notion?.xiaohongshuEnabled),
        enablePrefill: Boolean(statusCache?.xiaohongshu?.enable_prefill),
        enableHermes: Boolean(statusCache?.hermes?.enabled),
        enableImageGeneration: Boolean(statusCache?.imageGeneration?.enabled),
      };
      const patch = { [key]: !current[key] };
      await api("/api/toggles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      await refreshAll();
    }

    function readContentTaskForm() {
      return {
        topic: $("contentTaskTopic").value.trim(),
        platform: $("contentTaskPlatform").value,
        contentType: $("contentTaskType").value,
        adLevel: $("contentTaskAdLevel").value,
        goal: $("contentTaskGoal").value.trim(),
        audience: $("contentTaskAudience").value.trim(),
        style: $("contentTaskStyle").value.trim(),
        knowledgeScope: $("contentTaskKnowledgeScope").value,
        materialSource: $("contentTaskMaterialSource").value,
        styleReferenceType: $("contentTaskStyleReferenceType").value,
        imitationStrength: $("contentTaskImitationStrength").value,
        aiFlavorControl: $("contentTaskAiFlavorControl").value,
        outputMode: $("contentTaskOutputMode").value,
        productMention: $("contentTaskProductMention").value.trim(),
        styleReference: $("contentTaskStyleReference").value.trim(),
        wordRange: $("contentTaskWordRange").value.trim(),
        material: $("contentTaskMaterial").value.trim(),
        requirements: $("contentTaskRequirements").value.trim(),
      };
    }

    function resetContentTaskForm() {
      ["contentTaskTopic", "contentTaskGoal", "contentTaskAudience", "contentTaskStyle", "contentTaskWordRange", "contentTaskProductMention", "contentTaskStyleReference", "contentTaskMaterial", "contentTaskRequirements"].forEach(function(id) {
        if ($(id)) $(id).value = "";
      });
      $("contentTaskState").textContent = "";
      $("contentTaskPreview").style.display = "none";
      $("contentTaskPreview").innerHTML = "";
      $("contentTaskResult").style.display = "none";
      $("contentTaskResult").textContent = "";
    }

    function renderPreviewGroup(title, items, getText) {
      const rows = (items || []).map(function(item, index) {
        return '<div class="preview-item">' + escapeHtml((index + 1) + ". " + getText(item)) + '</div>';
      }).join("");
      return '<div class="preview-group"><div class="preview-title">' + escapeHtml(title) + '</div>' + (rows || '<div class="preview-item">未命中</div>') + '</div>';
    }

    async function previewContentTask() {
      const payload = readContentTaskForm();
      $("contentTaskPreview").style.display = "";
      $("contentTaskPreview").innerHTML = '<div class="preview-item">正在预览本次会使用的知识...</div>';
      try {
        const result = await api("/api/content-task/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const selected = result.selectedKnowledge || {};
        $("contentTaskPreview").innerHTML = [
          '<div class="preview-group"><div class="preview-title">任务范围</div><div class="preview-item">主题：' + escapeHtml(result.topic || "未填写") + '</div><div class="preview-item">知识库：' + escapeHtml(result.knowledgeScope || "未选择") + '</div></div>',
          renderPreviewGroup("主题", selected.topics, function(item) { return (item.name || "-") + (item.description ? "：" + item.description : ""); }),
          renderPreviewGroup("知识点", selected.knowledgePoints, function(item) { return (item.title || "-") + (item.content ? "：" + item.content : ""); }),
          renderPreviewGroup("风格样例", selected.styleSamples, function(item) { return (item.name || "-") + (item.content ? "：" + item.content : ""); }),
          renderPreviewGroup("写作规则", selected.writingRules, function(item) { return (item.name || "-") + (item.content ? "：" + item.content : ""); }),
        ].join("");
      } catch (error) {
        $("contentTaskPreview").innerHTML = '<div class="preview-item">预览失败：' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    async function copyTextToClipboard(text, stateId) {
      try {
        await navigator.clipboard.writeText(text || "");
        if (stateId && $(stateId)) $(stateId).textContent = "已复制。";
      } catch {
        if (stateId && $(stateId)) $(stateId).textContent = "复制失败，请手动复制。";
      }
    }

    function renderContentTaskResult(result) {
      const packageName = result.packageName || "";
      const packageDir = result.packageDir || "";
      $("contentTaskResult").style.display = "";
      $("contentTaskResult").innerHTML = [
        '<div class="result-card">',
        '<div><span class="pill">生成完成</span></div>',
        '<h3>' + escapeHtml(result.title || "未命名内容") + '</h3>',
        '<div class="result-meta">',
        '<div>发布包：' + escapeHtml(packageName || "-") + '</div>',
        '<div>耗时：' + escapeHtml(Math.round((result.durationMs || 0) / 1000) + " 秒") + '</div>',
        '<div>本地路径：<code>' + escapeHtml(packageDir || "-") + '</code></div>',
        '</div>',
        '<div class="result-actions">',
        '<button class="btn primary" onclick="showView(&quot;packages&quot;); ' + (packageName ? 'showPackage(' + JSON.stringify(encodeURIComponent(packageName)) + ')' : '') + '">查看内容资产</button>',
        '<button class="btn" onclick="copyTextToClipboard(' + JSON.stringify(packageDir) + ', &quot;contentTaskState&quot;)">复制本地路径</button>',
        '<button class="btn" onclick="copyTextToClipboard(' + JSON.stringify(packageName) + ', &quot;contentTaskState&quot;)">复制发布包名</button>',
        '<button class="btn" onclick="showView(&quot;logs&quot;)">查看运行日志</button>',
        '</div>',
        '<div class="result-reply">' + escapeHtml(result.replyText || "") + '</div>',
        '</div>',
      ].join("");
    }

    function readOptionTextarea(id) {
      return String($(id)?.value || "")
        .split(/\r?\n/)
        .map(function(item) { return item.trim(); })
        .filter(Boolean);
    }

    async function saveContentOptions() {
      $("contentOptionsSaveState").textContent = "保存中...";
      const result = await api("/api/content-options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          knowledgeScopes: readOptionTextarea("contentOptionKnowledgeScopes"),
          materialSources: readOptionTextarea("contentOptionMaterialSources"),
          styleReferenceTypes: readOptionTextarea("contentOptionStyleReferenceTypes"),
          imitationStrengths: readOptionTextarea("contentOptionImitationStrengths"),
          aiFlavorControls: readOptionTextarea("contentOptionAiFlavorControls"),
          outputModes: readOptionTextarea("contentOptionOutputModes"),
        }),
      });
      renderContentOptions(result.contentOptions || {});
      $("contentOptionsSaveState").textContent = "已保存，内容工作台下拉选项已更新。";
    }

    async function saveKnowledgeItem() {
      const type = $("knowledgeNewType").value;
      const id = $("knowledgeEditId").value.trim();
      const name = $("knowledgeNewName").value.trim();
      const content = $("knowledgeNewContent").value.trim();
      if (!name || !content) {
        $("knowledgeSaveState").textContent = "请先填写名称和内容。";
        return;
      }
      $("knowledgeSaveState").textContent = "保存中...";
      const result = await api("/api/knowledge-base", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          id,
          topicId: $("knowledgeNewTopicId")?.value || "",
          name,
          title: name,
          description: content,
          content,
          enabled: true,
        }),
      });
      $("knowledgeEditId").value = "";
      $("knowledgeNewName").value = "";
      $("knowledgeNewContent").value = "";
      renderKnowledgeBase(result.knowledgeBase || {});
      $("knowledgeSaveState").textContent = "已保存，下一次内容生成可使用。";
    }

    async function submitContentTask() {
      const payload = readContentTaskForm();
      if (!payload.topic) {
        $("contentTaskState").textContent = "请先填写内容主题。";
        return;
      }
      $("contentTaskSubmit").disabled = true;
      $("contentTaskState").textContent = "生成中，通常需要 1-3 分钟...";
      $("contentTaskResult").style.display = "";
      $("contentTaskResult").innerHTML = '<div class="preview-item">任务已提交：正在调用内容生成流程。完成后这里会显示发布包操作卡。</div>';
      try {
        const result = await api("/api/content-task", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        $("contentTaskState").textContent = "已生成发布包。";
        renderContentTaskResult(result);
        await refreshAll();
      } catch (error) {
        $("contentTaskState").textContent = "生成失败。";
        $("contentTaskResult").innerHTML = '<div class="preview-item">错误：' + escapeHtml(error.message || String(error)) + '</div>';
      } finally {
        $("contentTaskSubmit").disabled = false;
      }
    }

    async function saveHumanEditorRules() {
      $("humanRulesSaveState").textContent = "保存中...";
      await api("/api/human-editor-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          minBodyChars: Number($("humanMinChars").value || 500),
          maxBodyChars: Number($("humanMaxChars").value || 900),
          extraRules: collectRuleList("humanExtraRulesList"),
          bannedPhrases: collectRuleList("humanBannedPhrasesList"),
          requiredDetails: collectRuleList("humanRequiredDetailsList"),
        }),
      });
      $("humanRulesSaveState").textContent = "已保存，下一次内容生成生效。";
      await refreshAll();
    }

    async function saveBusinessFlow() {
      $("businessFlowSaveState").textContent = "保存中...";
      const payload = {
        id: $("businessFlowId").value.trim(),
        name: $("businessFlowName").value.trim(),
        enabled: true,
        triggers: collectRuleList("businessFlowTriggersList"),
        goal: $("businessFlowGoal").value.trim(),
        rules: collectRuleList("businessFlowRulesList"),
        outputFormat: $("businessFlowOutputFormat").value.trim(),
        replyPrefix: $("businessFlowReplyPrefix").value.trim(),
      };
      if (!payload.name || !payload.triggers.length) {
        $("businessFlowSaveState").textContent = "请先填写名称和至少一个触发词。";
        return;
      }
      await api("/api/business-flow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      $("businessFlowSaveState").textContent = "已生成可用业务流，微信里发送触发词即可调用。";
      await refreshAll();
    }

    async function deleteBusinessFlow(id) {
      if (!confirm("确定删除这条业务流吗？")) return;
      await api("/api/business-flow/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: id }),
      });
      resetBusinessFlowForm();
      await refreshAll();
    }

    async function refreshAll() {
      await Promise.all([loadStatus(), loadPackages(), loadConfig(), loadLogs()]);
    }

    refreshAll().catch((error) => {
      document.body.insertAdjacentHTML("beforeend", "<pre>" + escapeHtml(error.stack || error.message) + "</pre>");
    });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") return sendHtml(res, PAGE);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message, stack: error.stack }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`小龙虾后台控制台已启动：http://localhost:${PORT}`);
  console.log(`运行数据目录：${DATA_DIR}`);
});
