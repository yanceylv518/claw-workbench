import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NOTION_CONFIG_PATH = path.join(ROOT, "notion-ai-intel.config.json");
const BRIDGE_CONFIG_PATH = path.join(ROOT, "wechat-bridge.config.json");
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || "", ".openclaw");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

const SECRET_PLACEHOLDER = "__KEEP_SECRET__";
const NOTION_VERSION = "2022-06-28";
const VALIDATION_TIMEOUT_MS = 12000;
const WORKFLOW_SKILL_DEFAULTS = {
  requirement: {
    name: "需求结构化",
    description: "把输入主题整理成目标人群、内容目标、约束和缺失信息。",
    enabled: true,
    profile: "standard",
    timeoutSeconds: 60,
    fallbackOnError: true,
    notes: "",
    focusOptions: ["优先发现缺失信息", "明确目标人群", "保留业务约束"],
    selectedFocuses: ["优先发现缺失信息", "明确目标人群"],
    outputRequirement: "输出主题、人群、内容目标、约束、缺失信息和风险提示。",
  },
  strategy: {
    name: "策略判断",
    description: "判断内容应该走经验分享、教程、避坑、案例还是热点解读。",
    enabled: true,
    profile: "standard",
    timeoutSeconds: 60,
    fallbackOnError: true,
    notes: "",
    focusOptions: ["降低营销感", "强化平台适配", "降低 AI 味", "强化收藏价值"],
    selectedFocuses: ["降低营销感", "强化平台适配"],
    outputRequirement: "输出内容类型、标题方向、正文结构、图片策略、必须使用和必须避免的点。",
  },
  plan: {
    name: "内容方案",
    description: "把策略变成可执行的正文大纲、场景设计和图片规划。",
    enabled: true,
    profile: "standard",
    timeoutSeconds: 60,
    fallbackOnError: true,
    notes: "",
    focusOptions: ["更重视真实场景", "强化图片可执行性", "强化结构完整性", "减少空泛表达"],
    selectedFocuses: ["更重视真实场景", "强化图片可执行性"],
    outputRequirement: "输出内容角度、开头方式、正文大纲、场景设计、图片计划和人工确认项。",
  },
  deliveryGate: {
    name: "交付门槛",
    description: "判断发布包是否可交付、是否需要复核，以及必须修改项。",
    enabled: false,
    profile: "strict",
    timeoutSeconds: 60,
    fallbackOnError: true,
    notes: "",
    focusOptions: ["检查硬广风险", "检查图片正文匹配", "检查是否可交付", "优先列出必须修改项"],
    selectedFocuses: ["检查硬广风险", "检查是否可交付"],
    outputRequirement: "输出可交付判断、评分、必须修改、可选优化、风险提示和运营备注。",
  },
};

function normalizeImageMaxCount(value, generateBodyImages = false) {
  const minimum = generateBodyImages ? 2 : 1;
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : minimum;
  return Math.max(minimum, Math.min(safeValue, 9));
}

function inferAspectRatioFromSize(size) {
  const match = String(size || "").trim().match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return "";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "";
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function secretMeta(value) {
  return {
    configured: Boolean(value),
    masked: maskSecret(value),
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export class SettingsValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "SettingsValidationError";
    this.status = 400;
    this.details = details;
  }
}

function maybeUpdateSecret(target, key, value) {
  const text = normalizeString(value);
  if (!text || text === SECRET_PLACEHOLDER) return;
  target[key] = text;
}

function clampNumber(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(next, max));
}

function normalizeWorkflowSkills(rawSkills = {}) {
  const normalized = {};
  for (const [id, defaults] of Object.entries(WORKFLOW_SKILL_DEFAULTS)) {
    const raw = rawSkills?.[id] || {};
    const optional = id === "deliveryGate";
    normalized[id] = {
      name: defaults.name,
      description: defaults.description,
      enabled: optional ? raw.enabled === true : true,
      profile: normalizeString(raw.profile) || defaults.profile,
      timeoutSeconds: clampNumber(raw.timeout_seconds ?? raw.timeoutSeconds, defaults.timeoutSeconds, 30, 180),
      fallbackOnError: raw.fallback_on_error ?? raw.fallbackOnError ?? defaults.fallbackOnError,
      notes: normalizeString(raw.notes),
      focusOptions: Array.isArray(defaults.focusOptions) ? defaults.focusOptions : [],
      selectedFocuses: Array.isArray(raw.selected_focuses)
        ? raw.selected_focuses.map(normalizeString).filter(Boolean)
        : Array.isArray(raw.selectedFocuses)
          ? raw.selectedFocuses.map(normalizeString).filter(Boolean)
          : defaults.selectedFocuses,
      outputRequirement: normalizeString(raw.output_requirement ?? raw.outputRequirement) || defaults.outputRequirement,
    };
  }
  return normalized;
}

function providerOptions(openclawConfig) {
  const providers = openclawConfig?.models?.providers || {};
  return Object.entries(providers).map(([id, provider]) => ({
    id,
    baseUrl: provider?.baseUrl || "",
    apiKey: secretMeta(provider?.apiKey),
    auth: provider?.auth || "",
    api: provider?.api || "",
    models: Array.isArray(provider?.models) ? provider.models.map((item) => ({
      id: item?.id || "",
      name: item?.name || item?.id || "",
    })) : [],
  }));
}

function isSecretConfigured(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (value && typeof value === "object") return Boolean(value.configured);
  return false;
}

function ensureUrl(value, label) {
  const raw = normalizeString(value);
  if (!raw) throw new Error(`${label} 不能为空`);
  try {
    return new URL(raw.endsWith("/") ? raw : `${raw}/`);
  } catch {
    throw new Error(`${label} 不是有效 URL`);
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = VALIDATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function validateNotionDatabase({ label, token, databaseId }) {
  const safeToken = normalizeString(token);
  const safeDatabaseId = normalizeString(databaseId);
  if (!safeToken) throw new Error(`${label} Token 不能为空`);
  if (!safeDatabaseId) throw new Error(`${label} Database ID 不能为空`);
  const response = await fetchWithTimeout(`https://api.notion.com/v1/databases/${encodeURIComponent(safeDatabaseId)}`, {
    headers: {
      authorization: `Bearer ${safeToken}`,
      "notion-version": NOTION_VERSION,
    },
  });
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new Error(`${label} 验证失败：${response.status} ${response.statusText}${text ? `，${text.slice(0, 120)}` : ""}`);
}

function buildModelsUrl(baseUrl) {
  const url = ensureUrl(baseUrl, "Base URL");
  const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (pathname.endsWith("/models/")) return url.toString();
  url.pathname = `${pathname}models`;
  return url.toString();
}

async function validateOpenAiCompatibleApi({ label, baseUrl, apiKey, model }) {
  const safeApiKey = normalizeString(apiKey);
  const safeModel = normalizeString(model);
  if (!safeApiKey) throw new Error(`${label} API Key 不能为空`);
  if (!safeModel) throw new Error(`${label}模型不能为空`);
  const response = await fetchWithTimeout(buildModelsUrl(baseUrl), {
    headers: {
      authorization: `Bearer ${safeApiKey}`,
      "api-key": safeApiKey,
      "content-type": "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${label} API 验证失败：${response.status} ${response.statusText}${text ? `，${text.slice(0, 120)}` : ""}`);
  }
}

async function validateSettingsBeforeSave({ input, notionConfig, bridgeConfig, openclawConfig }) {
  const checks = [];

  if (input.modelProvider) {
    const providerId = normalizeString(input.modelProvider.providerId);
    if (providerId) {
      const provider = openclawConfig.models?.providers?.[providerId] || {};
      const activeModeName = bridgeConfig.active_mode || "";
      const activeMode = bridgeConfig.modes?.[activeModeName] || {};
      checks.push(validateOpenAiCompatibleApi({
        label: "模型",
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: activeMode.model || input.modelProvider.model,
      }));
    }
  }

  if (input.notionIntel && notionConfig.enabled) {
    checks.push(validateNotionDatabase({
      label: "Notion 情报库",
      token: notionConfig.notion?.token,
      databaseId: notionConfig.notion?.database_id,
    }));
  }

  if (input.notionContent && notionConfig.xiaohongshu?.enable_notion) {
    checks.push(validateNotionDatabase({
      label: "Notion 发布包",
      token: notionConfig.content_publish?.token,
      databaseId: notionConfig.content_publish?.database_id,
    }));
  }

  if (input.imageGeneration && notionConfig.image_generation?.enabled) {
    checks.push(validateOpenAiCompatibleApi({
      label: "图片",
      baseUrl: notionConfig.image_generation?.base_url,
      apiKey: notionConfig.image_generation?.api_key,
      model: notionConfig.image_generation?.model,
    }));
  }

  if (input.assistantApi && notionConfig.assistant_api?.enabled) {
    checks.push(validateOpenAiCompatibleApi({
      label: "小助手",
      baseUrl: notionConfig.assistant_api?.base_url,
      apiKey: notionConfig.assistant_api?.api_key,
      model: notionConfig.assistant_api?.model,
    }));
  }

  const results = await Promise.allSettled(checks);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));
  if (errors.length) {
    throw new SettingsValidationError(`配置验证未通过：${errors.join("；")}`, errors);
  }
}

export async function getSettingsConfig() {
  const notionConfig = await readJson(NOTION_CONFIG_PATH, {});
  const bridgeConfig = await readJson(BRIDGE_CONFIG_PATH, {});
  const openclawConfig = await readJson(OPENCLAW_CONFIG_PATH, {});
  const activeModeName = bridgeConfig.active_mode || "";
  const activeMode = bridgeConfig.modes?.[activeModeName] || {};
  const providerId = activeMode.provider_id || Object.keys(openclawConfig?.models?.providers || {})[0] || "";
  const provider = openclawConfig?.models?.providers?.[providerId] || {};
  const fallbackModel = Array.isArray(provider.models) ? provider.models[0]?.id || "" : "";

  return {
    paths: {
      notionConfig: NOTION_CONFIG_PATH,
      bridgeConfig: BRIDGE_CONFIG_PATH,
      openclawConfig: OPENCLAW_CONFIG_PATH,
    },
    localApi: {
      host: "127.0.0.1",
      port: Number(process.env.XIAOLONGXIA_LOCAL_API_PORT || 3200),
      baseUrl: `http://127.0.0.1:${Number(process.env.XIAOLONGXIA_LOCAL_API_PORT || 3200)}`,
      dataDir: process.env.XIAOLONGXIA_DATA_DIR || path.join(ROOT, "data", "runtime"),
    },
    bridge: {
      activeMode: activeModeName,
      modeType: activeMode.type || "",
      providerId,
      model: activeMode.model || fallbackModel,
      label: activeMode.label || "",
    },
    wechatAssistant: {
      defaultCity: bridgeConfig.assistant?.default_city || "",
      weatherEnabled: bridgeConfig.assistant?.weather_enabled !== false,
    },
    modelProvider: {
      providerId,
      baseUrl: provider.baseUrl || "",
      apiKey: secretMeta(provider.apiKey),
      auth: provider.auth || "api-key",
      api: provider.api || "openai-completions",
      model: activeMode.model || fallbackModel,
      providers: providerOptions(openclawConfig),
    },
    notionIntel: {
      enabled: Boolean(notionConfig.enabled),
      token: secretMeta(notionConfig.notion?.token),
      databaseId: notionConfig.notion?.database_id || "",
    },
    notionContent: {
      token: secretMeta(notionConfig.content_publish?.token),
      databaseId: notionConfig.content_publish?.database_id || "",
      xiaohongshuEnableNotion: Boolean(notionConfig.xiaohongshu?.enable_notion),
    },
    hermes: {
      enabled: Boolean(notionConfig.hermes?.enabled),
      mode: notionConfig.hermes?.mode || "research",
      provider: notionConfig.hermes?.provider || "llm",
      command: notionConfig.hermes?.command || "hermes",
      wslDistro: notionConfig.hermes?.wsl_distro || "Ubuntu",
      workerUrl: notionConfig.hermes?.worker_url || "http://127.0.0.1:3307",
      timeoutSeconds: Number(notionConfig.hermes?.timeout_seconds || 60),
      fallbackOnError: notionConfig.hermes?.fallback_on_error !== false,
    },
    workflow: {
      modelTimeoutSeconds: clampNumber(notionConfig.workflow?.model_timeout_seconds, 180, 30, 600),
      skillProfile: notionConfig.workflow?.skill_profile || "standard",
      skillNotes: notionConfig.workflow?.skill_notes || "",
      enableSkillFallback: notionConfig.workflow?.enable_skill_fallback !== false,
      skills: normalizeWorkflowSkills(notionConfig.workflow?.skills),
    },
    imageGeneration: {
      enabled: Boolean(notionConfig.image_generation?.enabled),
      provider: notionConfig.image_generation?.provider || "openai",
      apiKey: secretMeta(notionConfig.image_generation?.api_key),
      baseUrl: notionConfig.image_generation?.base_url || "",
      model: notionConfig.image_generation?.model || "",
      size: notionConfig.image_generation?.size || "1024x1024",
      quality: notionConfig.image_generation?.quality || "high",
      generateBodyImages: Boolean(notionConfig.image_generation?.generate_body_images),
      maxGeneratedImages: normalizeImageMaxCount(
        notionConfig.image_generation?.max_generated_images,
        Boolean(notionConfig.image_generation?.generate_body_images),
      ),
    },
    assistantApi: {
      enabled: Boolean(notionConfig.assistant_api?.enabled),
      providerId: notionConfig.assistant_api?.provider_id || "",
      apiKey: secretMeta(notionConfig.assistant_api?.api_key),
      baseUrl: notionConfig.assistant_api?.base_url || "",
      model: notionConfig.assistant_api?.model || "",
    },
  };
}

export async function updateSettingsConfig(input = {}) {
  const notionConfig = await readJson(NOTION_CONFIG_PATH, {});
  const bridgeConfig = await readJson(BRIDGE_CONFIG_PATH, {});
  const openclawConfig = await readJson(OPENCLAW_CONFIG_PATH, {});

  notionConfig.notion ||= {};
  notionConfig.content_publish ||= {};
  notionConfig.xiaohongshu ||= {};
  notionConfig.hermes ||= {};
  notionConfig.workflow ||= {};
  notionConfig.image_generation ||= {};
  notionConfig.assistant_api ||= {};
  bridgeConfig.modes ||= {};
  openclawConfig.models ||= {};
  openclawConfig.models.providers ||= {};

  if (input.bridge) {
    const providerId = normalizeString(input.bridge.providerId);
    const model = normalizeString(input.bridge.model);
    const label = normalizeString(input.bridge.label);
    const activeMode = normalizeString(input.bridge.activeMode) || bridgeConfig.active_mode || "third-party-api";
    bridgeConfig.active_mode = activeMode;
    bridgeConfig.modes[activeMode] ||= { type: "provider" };
    bridgeConfig.modes[activeMode].type = normalizeString(input.bridge.modeType) || "provider";
    if (providerId) bridgeConfig.modes[activeMode].provider_id = providerId;
    if (model) bridgeConfig.modes[activeMode].model = model;
    if (label) bridgeConfig.modes[activeMode].label = label;
  }

  if (input.wechatAssistant) {
    bridgeConfig.assistant ||= {};
    bridgeConfig.assistant.default_city = normalizeString(input.wechatAssistant.defaultCity);
    if (typeof input.wechatAssistant.weatherEnabled === "boolean") {
      bridgeConfig.assistant.weather_enabled = input.wechatAssistant.weatherEnabled;
    }
  }

  if (input.modelProvider) {
    const providerId = normalizeString(input.modelProvider.providerId);
    if (providerId) {
      openclawConfig.models.providers[providerId] ||= {};
      const provider = openclawConfig.models.providers[providerId];
      provider.baseUrl = normalizeString(input.modelProvider.baseUrl) || provider.baseUrl || "";
      provider.auth = normalizeString(input.modelProvider.auth) || provider.auth || "api-key";
      provider.api = normalizeString(input.modelProvider.api) || provider.api || "openai-completions";
      maybeUpdateSecret(provider, "apiKey", input.modelProvider.apiKey);
      const model = normalizeString(input.modelProvider.model);
      if (model) {
        const exists = Array.isArray(provider.models) && provider.models.some((item) => item?.id === model);
        provider.models = Array.isArray(provider.models) ? provider.models : [];
        if (!exists) provider.models.push({ id: model, name: model });
      }
      const activeMode = bridgeConfig.active_mode || "third-party-api";
      bridgeConfig.active_mode = activeMode;
      bridgeConfig.modes[activeMode] ||= {};
      bridgeConfig.modes[activeMode].type = "provider";
      bridgeConfig.modes[activeMode].provider_id = providerId;
      if (model) bridgeConfig.modes[activeMode].model = model;
      bridgeConfig.modes[activeMode].label = bridgeConfig.modes[activeMode].label || providerId;
    }
  }

  if (input.notionIntel) {
    if (typeof input.notionIntel.enabled === "boolean") notionConfig.enabled = input.notionIntel.enabled;
    notionConfig.notion.database_id = normalizeString(input.notionIntel.databaseId) || notionConfig.notion.database_id || "";
    maybeUpdateSecret(notionConfig.notion, "token", input.notionIntel.token);
  }

  if (input.notionContent) {
    notionConfig.content_publish.database_id = normalizeString(input.notionContent.databaseId) || notionConfig.content_publish.database_id || "";
    maybeUpdateSecret(notionConfig.content_publish, "token", input.notionContent.token);
    if (typeof input.notionContent.xiaohongshuEnableNotion === "boolean") {
      notionConfig.xiaohongshu.enable_notion = input.notionContent.xiaohongshuEnableNotion;
    }
    notionConfig.xiaohongshu.sync_notion_during_workflow = false;
  }

  if (input.hermes) {
    if (typeof input.hermes.enabled === "boolean") notionConfig.hermes.enabled = input.hermes.enabled;
    notionConfig.hermes.mode = normalizeString(input.hermes.mode) || notionConfig.hermes.mode || "research";
    notionConfig.hermes.provider = normalizeString(input.hermes.provider) || notionConfig.hermes.provider || "llm";
    notionConfig.hermes.command = normalizeString(input.hermes.command) || notionConfig.hermes.command || "hermes";
    notionConfig.hermes.wsl_distro = normalizeString(input.hermes.wslDistro) || notionConfig.hermes.wsl_distro || "Ubuntu";
    notionConfig.hermes.worker_url = normalizeString(input.hermes.workerUrl) || notionConfig.hermes.worker_url || "http://127.0.0.1:3307";
    notionConfig.hermes.timeout_seconds = Number(input.hermes.timeoutSeconds || notionConfig.hermes.timeout_seconds || 60);
    if (typeof input.hermes.fallbackOnError === "boolean") notionConfig.hermes.fallback_on_error = input.hermes.fallbackOnError;
  }

  if (input.workflow) {
    notionConfig.workflow.model_timeout_seconds = clampNumber(input.workflow.modelTimeoutSeconds, notionConfig.workflow.model_timeout_seconds || 180, 30, 600);
    notionConfig.workflow.skill_profile = normalizeString(input.workflow.skillProfile) || notionConfig.workflow.skill_profile || "standard";
    notionConfig.workflow.skill_notes = normalizeString(input.workflow.skillNotes);
    if (typeof input.workflow.enableSkillFallback === "boolean") {
      notionConfig.workflow.enable_skill_fallback = input.workflow.enableSkillFallback;
    }
    if (input.workflow.skills && typeof input.workflow.skills === "object") {
      notionConfig.workflow.skills ||= {};
      for (const [id, defaults] of Object.entries(WORKFLOW_SKILL_DEFAULTS)) {
        const raw = input.workflow.skills[id];
        if (!raw || typeof raw !== "object") continue;
        const optional = id === "deliveryGate";
        notionConfig.workflow.skills[id] ||= {};
        const target = notionConfig.workflow.skills[id];
        target.enabled = optional && typeof raw.enabled === "boolean" ? raw.enabled : true;
        target.profile = normalizeString(raw.profile) || target.profile || defaults.profile;
        target.timeout_seconds = clampNumber(raw.timeoutSeconds, target.timeout_seconds || defaults.timeoutSeconds, 30, 180);
        if (typeof raw.fallbackOnError === "boolean") target.fallback_on_error = raw.fallbackOnError;
        target.notes = normalizeString(raw.notes);
        if (Array.isArray(raw.selectedFocuses)) {
          const allowed = new Set(defaults.focusOptions || []);
          target.selected_focuses = raw.selectedFocuses.map(normalizeString).filter((item) => item && allowed.has(item));
        }
        target.output_requirement = normalizeString(raw.outputRequirement) || target.output_requirement || defaults.outputRequirement;
      }
    }
  }

  if (input.imageGeneration) {
    if (typeof input.imageGeneration.enabled === "boolean") notionConfig.image_generation.enabled = input.imageGeneration.enabled;
    notionConfig.image_generation.provider = normalizeString(input.imageGeneration.provider) || notionConfig.image_generation.provider || "openai";
    notionConfig.image_generation.base_url = normalizeString(input.imageGeneration.baseUrl) || notionConfig.image_generation.base_url || "";
    notionConfig.image_generation.model = normalizeString(input.imageGeneration.model) || notionConfig.image_generation.model || "";
    const imageSize = normalizeString(input.imageGeneration.size) || notionConfig.image_generation.size || "1024x1024";
    notionConfig.image_generation.size = imageSize;
    notionConfig.image_generation.image_size = imageSize;
    notionConfig.image_generation.aspect_ratio = inferAspectRatioFromSize(imageSize) || notionConfig.image_generation.aspect_ratio || "1:1";
    notionConfig.image_generation.quality = normalizeString(input.imageGeneration.quality) || notionConfig.image_generation.quality || "high";
    if (typeof input.imageGeneration.generateBodyImages === "boolean") {
      notionConfig.image_generation.generate_body_images = input.imageGeneration.generateBodyImages;
    }
    notionConfig.image_generation.max_generated_images = normalizeImageMaxCount(
      input.imageGeneration.maxGeneratedImages,
      Boolean(notionConfig.image_generation.generate_body_images),
    );
    maybeUpdateSecret(notionConfig.image_generation, "api_key", input.imageGeneration.apiKey);
  }

  if (input.assistantApi) {
    if (typeof input.assistantApi.enabled === "boolean") notionConfig.assistant_api.enabled = input.assistantApi.enabled;
    notionConfig.assistant_api.provider_id = normalizeString(input.assistantApi.providerId) || notionConfig.assistant_api.provider_id || "";
    notionConfig.assistant_api.base_url = normalizeString(input.assistantApi.baseUrl) || notionConfig.assistant_api.base_url || "";
    notionConfig.assistant_api.model = normalizeString(input.assistantApi.model) || notionConfig.assistant_api.model || "";
    maybeUpdateSecret(notionConfig.assistant_api, "api_key", input.assistantApi.apiKey);
  }

  await validateSettingsBeforeSave({ input, notionConfig, bridgeConfig, openclawConfig });

  await writeJson(NOTION_CONFIG_PATH, notionConfig);
  await writeJson(BRIDGE_CONFIG_PATH, bridgeConfig);
  await writeJson(OPENCLAW_CONFIG_PATH, openclawConfig);

  return getSettingsConfig();
}
