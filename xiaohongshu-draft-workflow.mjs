import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { maybeRunAiIntelWorkflow } from "./notion-ai-intel-workflow.mjs";
import { runOpenClawAgent, buildWechatSessionId } from "./openclaw-agent-client.mjs";

const DEFAULT_TIMEOUT_MS = 180000;
const DATA_DIR = process.env.XIAOLONGXIA_DATA_DIR || path.join(process.cwd(), ".wechat-direct-bridge");
const DRAFT_DIR = path.join(DATA_DIR, "xiaohongshu-drafts");
const IMAGE_DIR = path.join(DATA_DIR, "xiaohongshu-images");
const NOTION_VERSION = "2026-03-11";
const NOTION_TIMEOUT_MS = 20000;
const NOTION_RETRY_COUNT = 2;
const execFileAsync = promisify(execFile);

function execFileWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: options.windowsHide,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const timeout = Number(options.timeout) > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          const error = new Error(`Command timed out after ${options.timeout}ms: ${command} ${args.join(" ")}`);
          error.stdout = Buffer.concat(stdoutChunks).toString("utf8");
          error.stderr = Buffer.concat(stderrChunks).toString("utf8");
          reject(error);
        }, options.timeout)
      : null;

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      error.stdout = Buffer.concat(stdoutChunks).toString("utf8");
      error.stderr = Buffer.concat(stderrChunks).toString("utf8");
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed: ${command} ${args.join(" ")}${signal ? ` (${signal})` : ""}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin?.end(input || "", "utf8");
  });
}

function buildWslHermesPythonBridge() {
  return [
    "import os, sys",
    "command = sys.argv[1]",
    "query = sys.stdin.read()",
    'args = [command, "chat", "-Q", "--ignore-rules", "--source", "tool", "--max-turns", "3", "-q", query]',
    "try:",
    "    os.execvp(command, args)",
    "except FileNotFoundError:",
    '    fallback = os.path.expanduser("~/.local/bin/" + command)',
    "    os.execv(fallback, args)",
  ].join("\n");
}

const DIRECT_PATTERNS = [
  /小红书\s*(草稿|待发布|发布稿|笔记|文案|发布包)/i,
  /(做成|整理成|改成).*(小红书)/i,
  /帮我做\s*小红书/i,
  /生成.*小红书/i,
];

function truncate(text, max = 1800) {
  const normalized = String(text || "").trim();
  if (!normalized) return "这次小红书发布包还没整理出来，你再发一次我继续做。";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureTrailingSlash(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function normalizeImageMaxCount(value, generateBodyImages = false) {
  const minimum = generateBodyImages ? 2 : 1;
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : minimum;
  return Math.max(minimum, Math.min(safeValue, 9));
}

function normalizeUsageTokens(usage = {}) {
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  let promptTokens = Number(
    usage.prompt_tokens ??
      usage.promptTokens ??
      usage.input_tokens ??
      usage.inputTokens ??
      usage.input_text_tokens ??
      0,
  );
  let completionTokens = Number(
    usage.completion_tokens ??
      usage.completionTokens ??
      usage.output_tokens ??
      usage.outputTokens ??
      usage.output_image_tokens ??
      0,
  );
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? 0);
  promptTokens = Number.isFinite(promptTokens) ? Math.max(0, Math.round(promptTokens)) : 0;
  completionTokens = Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : 0;
  if (Number.isFinite(totalTokens) && totalTokens > promptTokens + completionTokens) {
    completionTokens += Math.round(totalTokens - promptTokens - completionTokens);
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function normalizeNotionId(value) {
  const raw = String(value || "").trim().replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(raw)) return String(value || "").trim();
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

const notionDataSourceIdCache = new Map();

async function getNotionDataSourceId(databaseId, token) {
  const normalizedDatabaseId = normalizeNotionId(databaseId);
  const cacheKey = `${normalizedDatabaseId}:${String(token || "").slice(-8)}`;
  if (notionDataSourceIdCache.has(cacheKey)) {
    return notionDataSourceIdCache.get(cacheKey);
  }

  const database = await notionFetchJson(
    `https://api.notion.com/v1/databases/${normalizedDatabaseId}`,
    token,
    undefined,
    "GET",
  );

  const dataSourceId =
    database?.data_sources?.[0]?.id ||
    database?.data_sources?.[0]?.data_source_id ||
    normalizedDatabaseId;

  const normalizedDataSourceId = normalizeNotionId(dataSourceId);
  notionDataSourceIdCache.set(cacheKey, normalizedDataSourceId);
  return normalizedDataSourceId;
}

function safeSlug(text) {
  return String(text || "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "xiaohongshu-package";
}

function safeFileName(text, fallback = "小红书发布包", maxLength = 60) {
  const cleaned = String(text || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .replace(/[. ]+$/g, "");
  return cleaned || fallback;
}

function normalizeList(value, limit = 8) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim().replace(/^\d+[.)、\s]+/, ""))
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function normalizeSections(value) {
  return Array.isArray(value)
    ? value
        .map((item) => ({
          heading: String(item?.heading || "").trim(),
          content: String(item?.content || "").trim(),
        }))
        .filter((item) => item.heading && item.content)
        .slice(0, 5)
    : [];
}

function normalizeImagePlan(value, limit = 6) {
  return Array.isArray(value)
    ? value
        .map((item) => ({
          position: String(item?.position || "").trim(),
          image_type: String(item?.image_type || "").trim(),
          purpose: String(item?.purpose || "").trim(),
          visual_focus: String(item?.visual_focus || "").trim(),
          prompt: String(item?.prompt || "").trim(),
        }))
        .filter((item) => item.position && item.prompt)
        .slice(0, limit)
    : [];
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function buildIntelRequest(userText) {
  const normalized = String(userText || "").trim();
  if (/行业|赛道|趋势|市场|品牌|企业/i.test(normalized)) {
    return "帮我找今天值得关注的行业情报3条";
  }
  if (/自媒体|内容|选题|文案|短视频|小红书|抖音/i.test(normalized)) {
    return "帮我找今天适合自媒体的AI信息3条";
  }
  return "帮我找今天AI最有用的3条信息";
}

function inferTopicLabel(userText) {
  const normalized = String(userText || "").trim();
  if (/行业|赛道|趋势|市场|品牌|企业/i.test(normalized)) return "行业观察";
  if (/自媒体|内容|选题|文案|短视频|小红书|抖音/i.test(normalized)) return "内容运营";
  return "AI热点";
}

function classifyXiaohongshuDraftIntent(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return { mode: "none", normalizedText: "", reason: "empty" };
  if (DIRECT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { mode: "direct", normalizedText: normalized, reason: "direct_pattern" };
  }
  return { mode: "none", normalizedText: normalized, reason: "low_confidence" };
}

function loadNotionConfig(baseDir) {
  const configPath = path.join(baseDir, "notion-ai-intel.config.json");
  const config = readJson(configPath, {});
  const token = process.env.NOTION_TOKEN || config?.notion?.token || "";

  return {
    xiaohongshu: {
      enableNotion:
        process.env.XIAOHONGSHU_ENABLE_NOTION
          ? String(process.env.XIAOHONGSHU_ENABLE_NOTION).toLowerCase() !== "false"
          : config?.xiaohongshu?.enable_notion === true,
      syncNotionDuringWorkflow: false,
    },
    aiIntel: {
      token,
      databaseId: process.env.NOTION_DATABASE_ID || config?.notion?.database_id || "",
      propertyMap: {
        title: config?.notion?.property_map?.title || "标题",
        summary: config?.notion?.property_map?.summary || "总结",
        usage: config?.notion?.property_map?.usage || "用途",
        link: config?.notion?.property_map?.link || "链接",
        date: config?.notion?.property_map?.date || "日期",
        category: config?.notion?.property_map?.category || "分类",
      },
    },
    contentPublish: {
      token: process.env.NOTION_CONTENT_PUBLISH_TOKEN || config?.content_publish?.token || token,
      databaseId: process.env.NOTION_CONTENT_PUBLISH_DATABASE_ID || config?.content_publish?.database_id || "",
      propertyMap: {
        title: config?.content_publish?.property_map?.title || "标题",
        contentType: config?.content_publish?.property_map?.content_type || "内容类型",
        publishStatus: config?.content_publish?.property_map?.publish_status || "发布状态",
        sourceIntel: config?.content_publish?.property_map?.source_intel || "来源情报",
        summary: config?.content_publish?.property_map?.summary || "摘要",
        finalPost: config?.content_publish?.property_map?.final_post || "最终成稿",
        platform: config?.content_publish?.property_map?.platform || "目标平台",
        publishDate: config?.content_publish?.property_map?.publish_date || "发布日期",
        publishUrl: config?.content_publish?.property_map?.publish_url || "发布链接",
      },
    },
    imageGeneration: {
      enabled:
        process.env.XIAOLONGXIA_IMAGE_ENABLED
          ? String(process.env.XIAOLONGXIA_IMAGE_ENABLED).toLowerCase() === "true"
          : config?.image_generation?.enabled === true,
      autoGenerateInWorkflow:
        process.env.XIAOHONGSHU_AUTO_GENERATE_IMAGES_IN_WORKFLOW
          ? String(process.env.XIAOHONGSHU_AUTO_GENERATE_IMAGES_IN_WORKFLOW).toLowerCase() === "true"
          : config?.image_generation?.auto_generate_in_workflow !== false,
      provider: String(config?.image_generation?.provider || "openai").trim(),
      apiKey:
        process.env.OPENAI_IMAGE_API_KEY ||
        process.env.OPENAI_API_KEY ||
        config?.image_generation?.api_key ||
        "",
      baseUrl: ensureTrailingSlash(
        String(
          process.env.OPENAI_IMAGE_API_BASE ||
            process.env.OPENAI_API_BASE ||
            config?.image_generation?.base_url ||
            "https://api.openai.com/v1",
        ),
      ),
      model: String(config?.image_generation?.model || "gpt-image-1").trim(),
      size: String(config?.image_generation?.size || "1024x1536").trim(),
      quality: String(config?.image_generation?.quality || "medium").trim(),
      generateBodyImages: config?.image_generation?.generate_body_images === true,
      maxGeneratedImages: normalizeImageMaxCount(
        config?.image_generation?.max_generated_images,
        config?.image_generation?.generate_body_images === true,
      ),
      n: Math.max(1, Math.min(Number(config?.image_generation?.n || 1), 4)),
      aspectRatio: String(config?.image_generation?.aspect_ratio || "16:9").trim(),
      imageSize: String(config?.image_generation?.image_size || "2K").trim(),
    },
    hermes: {
      enabled:
        process.env.XIAOLONGXIA_HERMES_ENABLED
          ? String(process.env.XIAOLONGXIA_HERMES_ENABLED).toLowerCase() !== "false"
          : config?.hermes?.enabled === true,
      mode: String(config?.hermes?.mode || "research_only").trim(),
      provider: String(config?.hermes?.provider || "command").trim(),
      command: String(config?.hermes?.command || "hermes").trim(),
      wsl_distro: String(config?.hermes?.wsl_distro || "Ubuntu").trim(),
      worker_url: String(config?.hermes?.worker_url || "http://127.0.0.1:3307").trim(),
      timeout_seconds: Math.max(10, Math.min(Number(config?.hermes?.timeout_seconds || 60), 300)),
      fallback_on_error: config?.hermes?.fallback_on_error !== false,
    },
  };
}

function notionDbIsConfigured(config) {
  return Boolean(String(config?.token || "").trim() && String(config?.databaseId || "").trim());
}

function imageGenerationIsConfigured(config) {
  return Boolean(
    config?.enabled &&
      ["openai", "openai-chat-image"].includes(String(config?.provider || "").trim().toLowerCase()) &&
      String(config?.apiKey || "").trim(),
  );
}

async function notionFetchJson(url, token, body, method = "POST") {
  let lastError = null;
  for (let attempt = 0; attempt <= NOTION_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Notion request failed: ${res.status} ${text}`);
      return text ? JSON.parse(text) : {};
    } catch (error) {
      lastError = error;
      if (attempt >= NOTION_RETRY_COUNT) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Unknown Notion request failure");
}

function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

async function uploadImageToNotion(filePath, token) {
  const filename = path.basename(filePath);
  const contentType = guessMimeType(filePath);
  const createRes = await notionFetchJson(
    "https://api.notion.com/v1/file_uploads",
    token,
    {},
    "POST",
  );

  const uploadId = createRes?.id;
  if (!uploadId) {
    throw new Error(`Notion file upload init failed for ${filename}`);
  }
  const uploadUrl = `https://api.notion.com/v1/file_uploads/${uploadId}/send`;

  const form = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  form.set("file", new Blob([fileBuffer], { type: contentType }), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
  try {
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
      body: form,
      signal: controller.signal,
    });
    const text = await uploadRes.text();
    if (!uploadRes.ok) {
      throw new Error(`Notion file send failed: ${uploadRes.status} ${text}`);
    }
    const uploaded = text ? JSON.parse(text) : {};
    if (uploaded?.status && uploaded.status !== "uploaded") {
      throw new Error(`Notion file upload incomplete for ${filename}: ${uploaded.status}`);
    }
    return {
      id: uploadId,
      filename,
      contentType,
      filePath,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadGeneratedImagesToNotion(imageResult, token, logger) {
  const files = Array.isArray(imageResult?.files) ? imageResult.files : [];
  const uploadedByPath = new Map();
  for (const item of files) {
    const filePath = String(item?.path || "").trim();
    if (!filePath || !fs.existsSync(filePath)) continue;
    try {
      const uploaded = await uploadImageToNotion(filePath, token);
      uploadedByPath.set(filePath, uploaded);
    } catch (error) {
      logger?.("WARN", "Failed to upload generated image to Notion", {
        filePath,
        error: String(error),
      });
    }
  }
  return uploadedByPath;
}

async function resolveRelationPropertyId(databaseId, token, targetDatabaseId) {
  const dataSourceId = await getNotionDataSourceId(databaseId, token);
  const schema = await notionFetchJson(`https://api.notion.com/v1/data_sources/${dataSourceId}`, token, null, "GET");

  const entry = Object.values(schema?.properties || {}).find(
    (property) =>
      property?.type === "relation" &&
      String(property?.relation?.database_id || "").replace(/-/g, "") === String(targetDatabaseId || "").replace(/-/g, ""),
  );

  return entry?.id || null;
}

function paragraphBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: String(text || "").slice(0, 2000) } }],
    },
  };
}

function headingBlock(text, level = 2) {
  const key = level === 3 ? "heading_3" : "heading_2";
  return {
    object: "block",
    type: key,
    [key]: {
      rich_text: [{ type: "text", text: { content: String(text || "").slice(0, 2000) } }],
    },
  };
}

function bulletedBlock(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: String(text || "").slice(0, 2000) } }],
    },
  };
}

function imageUploadBlock(uploadInfo, caption = "") {
  if (!uploadInfo?.id) return null;
  const block = {
    object: "block",
    type: "image",
    image: {
      type: "file_upload",
      file_upload: {
        id: uploadInfo.id,
      },
    },
  };
  const normalizedCaption = String(caption || "").trim();
  if (normalizedCaption) {
    block.image.caption = [{ type: "text", text: { content: normalizedCaption.slice(0, 2000) } }];
  }
  return block;
}

function buildDraftPrompt(userText, topicLabel, intelItems) {
  return [
    "You are building a complete Xiaohongshu publish package for a Chinese creator.",
    "Return strict JSON only.",
    'Schema: {"title":"string","subtitle":"string","hook":"string","cover_text":"string","cover_style":"string","visual_direction":"string","cover_image_prompt":"string","supporting_image_prompts":["string"],"post_text":"string","body_sections":[{"heading":"string","content":"string"}],"hashtags":["string"],"image_shot_list":["string"],"publish_checklist":["string"],"comment_seed":"string","pin_comment":"string","materials_summary":["string"]}',
    "Rules:",
    "- Write concise Chinese suitable for Xiaohongshu.",
    "- The final style should feel like an actually publishable Xiaohongshu note.",
    "- title should be strong but not clickbait.",
    "- subtitle should be one short angle summary.",
    "- post_text is the final publish-ready body text. It must be easy to copy directly into Xiaohongshu.",
    "- post_text should use short paragraphs, natural line breaks, and a creator tone.",
    "- Do not overuse emoji. Use 0 to 3 simple emojis max if truly useful.",
    "- body_sections should reflect the structure behind post_text.",
    "- hashtags should be 5 to 8 useful tags without # symbol.",
    "- cover_text should be short and eye-catching.",
    "- cover_style should say what kind of cover image this post should use.",
    "- visual_direction should describe the overall visual language in one short Chinese sentence.",
    "- cover_image_prompt should be a detailed Chinese image-generation prompt for the cover image.",
    "- supporting_image_prompts should contain 2 to 3 detailed Chinese prompts for supporting body visuals or cards.",
    "- image_shot_list should list what screenshots, diagrams, or visuals to prepare.",
    "- publish_checklist should list what to double-check before posting.",
    "- comment_seed should be the first comment suggestion.",
    "- pin_comment should be the suggested pinned comment.",
    "- materials_summary should summarize the raw source angles this post is built from.",
    `Topic label: ${topicLabel}`,
    `Original user request: ${userText}`,
    `Reference intel items: ${JSON.stringify(intelItems)}`,
  ].join("\n");
}

function buildHermesResearchPrompt(userText, topicLabel, intelItems) {
  return [
    "你是小龙虾内容流程里的研究员，不直接写小红书正文。",
    "请只输出一个严格 JSON 对象，不要 Markdown，不要代码块，不要解释，不要前后缀。",
    "输出必须以 { 开头，以 } 结尾。",
    "所有字段必须使用双引号，数组元素必须是字符串。",
    'Schema: {"recommended_angle":"string","real_materials":["string"],"reference_structure":["string"],"opening_style":"string","image_direction":"string","avoid":["string"],"sample_pattern_notes":["string"]}',
    "研究目标：为后续小红书发布包提供真实素材、爆款结构参考和避坑点。",
    "要求：",
    "- 优先使用用户真实项目素材，不要凭空编造平台数据。",
    "- 参考结构只总结写法，不照搬任何原文。",
    "- 如果主题是小龙虾，记住它是用户自己的微信 AI 助手，不是泛泛的机器人。",
    "- 输出要帮助正文更像真实折腾记录，而不是完整科普稿。",
    `Topic label: ${topicLabel}`,
    `Original user request: ${userText}`,
    `Available intel/source items: ${JSON.stringify(intelItems).slice(0, 12000)}`,
  ].join("\n");
}

export function normalizeHermesResearch(value, fallback = null) {
  const source = value && typeof value === "object" ? value : {};
  return {
    status: source.status || fallback?.status || "available",
    provider: source.provider || fallback?.provider || "hermes",
    recommended_angle: String(source.recommended_angle || fallback?.recommended_angle || "").trim(),
    real_materials: normalizeList(source.real_materials || fallback?.real_materials, 8),
    reference_structure: normalizeList(source.reference_structure || fallback?.reference_structure, 8),
    opening_style: String(source.opening_style || fallback?.opening_style || "").trim(),
    image_direction: String(source.image_direction || fallback?.image_direction || "").trim(),
    avoid: normalizeList(source.avoid || fallback?.avoid, 8),
    sample_pattern_notes: normalizeList(source.sample_pattern_notes || fallback?.sample_pattern_notes, 8),
    warning: source.warning || fallback?.warning || null,
  };
}

function validateHermesResearchShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hermes research output is not an object");
  }
  const required = ["recommended_angle", "real_materials", "reference_structure", "opening_style", "image_direction", "avoid", "sample_pattern_notes"];
  const missing = required.filter((key) => !(key in value));
  if (missing.length) {
    throw new Error(`Hermes research JSON missing fields: ${missing.join(", ")}`);
  }
  for (const key of ["real_materials", "reference_structure", "avoid", "sample_pattern_notes"]) {
    if (!Array.isArray(value[key])) {
      throw new Error(`Hermes research field must be array: ${key}`);
    }
  }
  return value;
}

function extractJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty JSON output");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error(`No JSON object found in output: ${raw.slice(0, 300)}`);
  }
}

export function buildFallbackHermesResearch(userText, topicLabel, intelItems) {
  const isLobster = /小龙虾|后台|微信.?AI|AI助手|控制台/i.test(`${userText} ${topicLabel}`);
  if (isLobster) {
    return normalizeHermesResearch({
      status: "fallback",
      provider: "local-heuristic",
      recommended_angle: "需求越加越多后，微信入口开始混乱，所以小龙虾需要一个后台把情报、内容、管理三条线收束起来。",
      real_materials: [
        "小龙虾是用户自己的微信 AI 助手。",
        "功能从 AI 情报扩展到 Notion、小红书发布包、财经分析、配图提示词、开关配置。",
        "现在已有 localhost:3100 后台，包含总览、业务流程、发布包、开关配置、运行日志。",
        "当前已关闭自动生图和小红书预填，先保留发布包和配图提示词。",
      ],
      reference_structure: [
        "从一个具体尴尬场景开头：自己也要想这条微信命令会不会触发某条流程。",
        "写功能是怎么一点点加上去的，而不是直接讲后台的好处。",
        "中段点出：聊天框适合发起任务，不适合管理系统。",
        "结尾保留半成品感：先不急着加功能，先把后台和流程理清楚。",
      ],
      opening_style: "昨天/这两天才发现，小龙虾不是功能不够，是被我自己越做越乱了。",
      image_direction: "优先用真实微信聊天截图和后台截图作为参考，做成聊天入口混乱 vs 后台清晰收束的对比。",
      avoid: [
        "不要写成 AI 助手后台是什么。",
        "不要写成产品宣传稿。",
        "不要写得过于完整、像课程总结。",
        "不要生成无关机器人、AI 大脑或科幻大屏。",
      ],
      sample_pattern_notes: [
        "适合用“我把工具做复杂了，才发现需要重构”的个人项目复盘结构。",
        "适合保留一点不完美和折腾感，不要每段都像结论。",
      ],
    });
  }
  return normalizeHermesResearch({
    status: "fallback",
    provider: "local-heuristic",
    recommended_angle: "从一个具体使用场景或踩坑开始，写清楚问题、转折和当前不完美但能用的解决方案。",
    real_materials: intelItems.slice(0, 3).map((item) => item.title || item.summary || "").filter(Boolean),
    reference_structure: [
      "具体场景开头",
      "说明最初误判",
      "给出实际处理过程",
      "保留边界和未解决问题",
    ],
    avoid: ["不要写成百科科普", "不要过度总结", "不要用太多泛话题"],
  });
}

export async function maybeRunHermesResearch({ hermesConfig, llm, userText, topicLabel, intelItems, modelTimeoutMs, logger }) {
  if (!hermesConfig?.enabled) {
    return normalizeHermesResearch({
      status: "disabled",
      provider: "none",
      warning: "Hermes research disabled",
    });
  }
  const prompt = buildHermesResearchPrompt(userText, topicLabel, intelItems);
  const fallback = buildFallbackHermesResearch(userText, topicLabel, intelItems);

  if (hermesConfig.provider === "hermes-worker") {
    const workerUrl = String(hermesConfig.worker_url || "http://127.0.0.1:3307").replace(/\/+$/, "");
    const startedAt = Date.now();
    try {
      logger?.("INFO", "Hermes Worker research started", {
        workflow: "小红书发布包",
        step: 2,
        totalSteps: 6,
        purpose: "Hermes Worker 研究增强：分析参考结构、知识补充和爆款角度",
        endpoint: `${workerUrl}/api/hermes/research`,
      });
      const response = await fetch(`${workerUrl}/api/hermes/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userText,
          topicLabel,
          intelItems,
          command: hermesConfig.command || "hermes",
          wslDistro: hermesConfig.wsl_distro || "Ubuntu",
          timeoutMs: Math.min(modelTimeoutMs, (hermesConfig.timeout_seconds || 180) * 1000),
          maxTurns: 3,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `${response.status} ${response.statusText}`);
      }
      logger?.("INFO", "Hermes Worker research completed", {
        workflow: "小红书发布包",
        step: 2,
        totalSteps: 6,
        purpose: "Hermes Worker 研究增强：分析参考结构、知识补充和爆款角度",
        durationMs: Date.now() - startedAt,
      });
      return normalizeHermesResearch({
        ...data.research,
        status: data.status === "completed" ? "completed" : "fallback",
        provider: "hermes-worker",
        warning: data.status === "completed" ? "" : `hermes_worker_${data.status || "fallback"}:${data.error || ""}`,
      }, fallback);
    } catch (error) {
      logger?.("WARN", "Hermes Worker research failed; using fallback", { workerUrl, error: String(error) });
      return normalizeHermesResearch({
        ...fallback,
        status: "fallback",
        warning: `hermes_worker_failed:${String(error)}`,
      });
    }
  }

  if (hermesConfig.provider === "llm") {
    try {
      const result = await callModelJson(llm, prompt, Math.min(modelTimeoutMs, (hermesConfig.timeout_seconds || 60) * 1000), {
        logger,
        workflow: "小红书发布包",
        step: 2,
        totalSteps: 6,
        purpose: "Hermes 研究增强：分析参考结构、知识补充和爆款角度",
      });
      return normalizeHermesResearch({ ...validateHermesResearchShape(result), status: "completed", provider: "llm-research" }, fallback);
    } catch (error) {
      logger?.("WARN", "Hermes LLM research failed; using fallback", { error: String(error) });
      return normalizeHermesResearch({
        ...fallback,
        status: "fallback",
        warning: `llm_research_failed:${String(error)}`,
      });
    }
  }

  if (hermesConfig.provider === "openclaw-agent") {
    try {
      const startedAt = Date.now();
      const sessionId = buildWechatSessionId("hermes-research", `${userText}-${Date.now()}-${crypto.randomUUID()}`);
      logger?.("INFO", "AI API call", {
        workflow: "小红书发布包",
        step: 2,
        totalSteps: 6,
        purpose: "Hermes 研究增强：分析参考结构、知识补充和爆款角度",
        mode: "openclaw-agent",
        providerId: "openclaw-agent",
        model: "agent",
        endpoint: "openclaw-agent",
        sessionId,
      });
      const result = await runOpenClawAgent({
        sessionId,
        message: prompt,
        timeoutSeconds: Math.max(20, Math.min(Number(hermesConfig.timeout_seconds || 60), 300)),
        thinking: "medium",
      });
      let parsed;
      try {
        parsed = validateHermesResearchShape(extractJsonFromText(result.text));
      } catch (parseError) {
        throw new Error(`${String(parseError)}; agent_output=${String(result.text || "").slice(0, 500)}`);
      }
      logger?.("INFO", "AI API call completed", {
        workflow: "小红书发布包",
        step: 2,
        totalSteps: 6,
        purpose: "Hermes 研究增强：分析参考结构、知识补充和爆款角度",
        model: "agent",
        durationMs: Date.now() - startedAt,
      });
      return normalizeHermesResearch({ ...parsed, status: "completed", provider: "openclaw-agent" }, fallback);
    } catch (error) {
      logger?.("WARN", "Hermes OpenClaw agent research failed; using fallback", { error: String(error) });
      return normalizeHermesResearch({
        ...fallback,
        status: "fallback",
        warning: `openclaw_agent_research_failed:${String(error)}`,
      });
    }
  }

  if (hermesConfig.provider === "wsl-hermes-agent") {
    const distro = String(hermesConfig.wsl_distro || hermesConfig.wslDistro || "Ubuntu").trim() || "Ubuntu";
    const command = String(hermesConfig.command || "hermes").trim() || "hermes";
    const safeCommand = /^[\w./-]+$/.test(command) ? command : "hermes";
    try {
      const startedAt = Date.now();
      logger?.("INFO", "AI API call", {
        workflow: "灏忕孩涔﹀彂甯冨寘",
        step: 2,
        totalSteps: 6,
        purpose: "Hermes 鐮旂┒澧炲己锛氬垎鏋愬弬鑰冪粨鏋勩€佺煡璇嗚ˉ鍏呭拰鐖嗘瑙掑害",
        mode: "wsl-hermes-agent",
        providerId: "wsl-hermes-agent",
        model: "hermes-agent",
        endpoint: `wsl:${distro}`,
      });
      const result = await execFileWithInput(
        "wsl",
        ["-d", distro, "python3", "-c", buildWslHermesPythonBridge(), safeCommand],
        prompt,
        {
          timeout: Math.min(modelTimeoutMs, (hermesConfig.timeout_seconds || 60) * 1000),
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const stdout = result.stdout;
      let parsed;
      try {
        parsed = validateHermesResearchShape(extractJsonFromText(stdout));
      } catch (parseError) {
        throw new Error(`${String(parseError)}; hermes_stdout=${String(stdout || "").slice(0, 500)}; hermes_stderr=${String(result.stderr || "").slice(0, 500)}`);
      }
      logger?.("INFO", "AI API call completed", {
        workflow: "灏忕孩涔﹀彂甯冨寘",
        step: 2,
        totalSteps: 6,
        purpose: "Hermes 鐮旂┒澧炲己锛氬垎鏋愬弬鑰冪粨鏋勩€佺煡璇嗚ˉ鍏呭拰鐖嗘瑙掑害",
        model: "hermes-agent",
        durationMs: Date.now() - startedAt,
      });
      return normalizeHermesResearch({ ...parsed, status: "completed", provider: "wsl-hermes-agent" }, fallback);
    } catch (error) {
      logger?.("WARN", "WSL Hermes Agent research failed; using fallback", { distro, command: safeCommand, error: String(error) });
      return normalizeHermesResearch({
        ...fallback,
        status: "fallback",
        warning: `wsl_hermes_agent_failed:${String(error)}`,
      });
    }
  }

  const command = String(hermesConfig.command || "hermes").trim();
  if (!command) return fallback;
  try {
    const { stdout } = await execFileAsync(
      command,
      ["chat", "-Q", "--source", "tool", "--max-turns", "1", "-q", prompt],
      {
        timeout: Math.min(modelTimeoutMs, (hermesConfig.timeout_seconds || 60) * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const parsed = extractJsonFromText(stdout);
    return normalizeHermesResearch({ ...parsed, status: "completed", provider: "hermes-command" }, fallback);
  } catch (error) {
    logger?.("WARN", "Hermes command research failed; using fallback", { command, error: String(error) });
    return normalizeHermesResearch({
      ...fallback,
      status: "fallback",
      warning: `hermes_command_failed:${String(error)}`,
    });
  }
}

async function runWslHermesAgentJson({ hermesConfig, prompt, modelTimeoutMs, loggerMeta = {}, logger }) {
  const distro = String(hermesConfig?.wsl_distro || hermesConfig?.wslDistro || "Ubuntu").trim() || "Ubuntu";
  const command = String(hermesConfig?.command || "hermes").trim() || "hermes";
  const safeCommand = /^[\w./-]+$/.test(command) ? command : "hermes";
  const startedAt = Date.now();
  logger?.("INFO", "Hermes Agent started", {
    ...loggerMeta,
    executor: "wsl-hermes-agent",
    wslDistro: distro,
    command: safeCommand,
  });
  logger?.("INFO", "AI API call", {
    ...loggerMeta,
    mode: "wsl-hermes-agent",
    providerId: "wsl-hermes-agent",
    model: "hermes-agent",
    endpoint: `wsl:${distro}`,
  });
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileWithInput(
      "wsl",
      ["-d", distro, "python3", "-c", buildWslHermesPythonBridge(), safeCommand],
      prompt,
      {
        timeout: Math.min(modelTimeoutMs, (hermesConfig?.timeout_seconds || 120) * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const output = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`.trim();
    const hasSessionOnly = /session_id:/i.test(output) && !/[{[]/.test(output);
    const hint = hasSessionOnly
      ? "Hermes Agent 已启动但没有返回正文，通常是 Hermes 模型认证或默认 Provider 未配置完成。请在 WSL 里运行 hermes model 或 hermes status 检查认证。"
      : "Hermes Agent 命令执行失败。请在 WSL 里运行 hermes status 查看模型与认证状态。";
    throw new Error(`${hint} 原始输出：${output.slice(0, 800) || String(error)}`);
  }
  logger?.("INFO", "Hermes Agent completed", {
    ...loggerMeta,
    executor: "wsl-hermes-agent",
    wslDistro: distro,
    command: safeCommand,
    durationMs: Date.now() - startedAt,
    outputChars: String(stdout || "").length,
    stderrChars: String(stderr || "").length,
  });
  logger?.("INFO", "AI API call completed", {
    ...loggerMeta,
    model: "hermes-agent",
    durationMs: Date.now() - startedAt,
  });
  try {
    return extractJsonFromText(stdout);
  } catch (error) {
    throw new Error(`${String(error)}; hermes_stdout=${String(stdout || "").slice(0, 500)}; hermes_stderr=${String(stderr || "").slice(0, 500)}`);
  }
}

function buildHermesResearchForPrompt(hermesResearch) {
  if (!hermesResearch || hermesResearch.status === "disabled") return "Hermes research: disabled.";
  return [
    "Hermes / research card for this draft:",
    JSON.stringify({
      status: hermesResearch.status,
      recommended_angle: hermesResearch.recommended_angle,
      real_materials: hermesResearch.real_materials,
      reference_structure: hermesResearch.reference_structure,
      opening_style: hermesResearch.opening_style,
      image_direction: hermesResearch.image_direction,
      avoid: hermesResearch.avoid,
      sample_pattern_notes: hermesResearch.sample_pattern_notes,
    }),
    "Use this research card as guidance. Do not mention Hermes in the final post.",
  ].join("\n");
}

function buildHermesResearchText(hermesResearch) {
  if (!hermesResearch) return "";
  const lines = [
    `状态：${hermesResearch.status || "-"}`,
    `来源：${hermesResearch.provider || "-"}`,
    hermesResearch.warning ? `提示：${hermesResearch.warning}` : "",
    "",
    "推荐角度：",
    hermesResearch.recommended_angle || "-",
    "",
    "真实素材：",
    ...normalizeList(hermesResearch.real_materials, 10).map((item) => `- ${item}`),
    "",
    "参考结构：",
    ...normalizeList(hermesResearch.reference_structure, 10).map((item) => `- ${item}`),
    "",
    "开头方式：",
    hermesResearch.opening_style || "-",
    "",
    "配图方向：",
    hermesResearch.image_direction || "-",
    "",
    "避坑：",
    ...normalizeList(hermesResearch.avoid, 10).map((item) => `- ${item}`),
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function buildWorkflowSkillContextForPrompt(workflowSkills = null) {
  if (!workflowSkills) return "Workflow skill context: not available.";
  return [
    "Workflow skill context. Use it as binding business direction:",
    JSON.stringify({
      requirement: workflowSkills.requirement || null,
      strategy: workflowSkills.strategy || null,
      contentPlan: workflowSkills.contentPlan || null,
    }),
  ].join("\n");
}

function buildDraftPromptV2(userText, topicLabel, intelItems, imageMode, hermesResearch = null, workflowSkills = null) {
  const direction = extractXiaohongshuDirection(userText);
  const theme = extractXiaohongshuTheme(userText);
  const businessRules = buildBusinessSpecificDraftRules(userText, topicLabel);
  return [
    "You are building a complete Xiaohongshu publish package for a Chinese creator.",
    "Return strict JSON only.",
    'Schema: {"title":"string","subtitle":"string","hook":"string","cover_text":"string","cover_style":"string","visual_direction":"string","cover_image_prompt":"string","supporting_image_prompts":["string"],"image_plan":[{"position":"string","image_type":"string","purpose":"string","visual_focus":"string","prompt":"string"}],"post_text":"string","body_sections":[{"heading":"string","content":"string"}],"hashtags":["string"],"image_shot_list":["string"],"publish_checklist":["string"],"comment_seed":"string","pin_comment":"string","materials_summary":["string"]}',
    "Rules:",
    "- Write concise Chinese suitable for Xiaohongshu.",
    "- The final style should feel like an actually publishable Xiaohongshu note.",
    "- title should be strong but not clickbait.",
    "- subtitle should be one short angle summary.",
    "- post_text is the final publish-ready body text. It must be easy to copy directly into Xiaohongshu.",
    "- post_text should use short paragraphs, natural line breaks, and a creator tone.",
    "- Do not overuse emoji. Use 0 to 3 simple emojis max if truly useful.",
    "- body_sections should reflect the structure behind post_text.",
    "- hashtags should be 5 to 8 useful tags without # symbol.",
    "- cover_text should be short and eye-catching.",
    "- cover_style should say what kind of cover image this post should use.",
    "- visual_direction should describe the overall visual language in one short Chinese sentence.",
    "- cover_image_prompt should be a detailed Chinese image-generation prompt for the cover image.",
    "- supporting_image_prompts should contain 2 to 3 detailed Chinese prompts for supporting body visuals or cards.",
    "- image_plan should list the actual recommended images in publish order. position examples: 封面图, 正文图1, 正文图2, 结尾图.",
    "- Each image_plan item must explain what image should go there, why, what visual focus it needs, and include a precise prompt.",
    "- image_shot_list should list what screenshots, diagrams, or visuals to prepare.",
    "- publish_checklist should list what to double-check before posting.",
    "- comment_seed should be the first comment suggestion.",
    "- pin_comment should be the suggested pinned comment.",
    "- materials_summary should summarize the raw source angles this post is built from.",
    businessRules,
    theme ? `Preferred theme: ${theme}` : "Preferred theme: auto",
    direction ? `Preferred content direction: ${direction}` : "Preferred content direction: auto",
    `Image mode: ${imageMode}`,
    `Topic label: ${topicLabel}`,
    `Original user request: ${userText}`,
    buildWorkflowSkillContextForPrompt(workflowSkills),
    buildHermesResearchForPrompt(hermesResearch),
    `Reference intel items: ${JSON.stringify(intelItems)}`,
  ].join("\n");
}

function isAiToolInfrastructureRequest(userText, topicLabel = "") {
  const text = `${userText || ""} ${topicLabel || ""}`;
  return /(token代理|token\s*代理|api代理|接口代理|中转接口|api中转|base\s*url|apikey|api key|模型接口|接口报错|429|401|timeout|超时|dify|cursor|coze|AI工具基础设施)/i.test(text);
}

function buildBusinessSpecificDraftRules(userText, topicLabel = "") {
  if (!isAiToolInfrastructureRequest(userText, topicLabel)) return "";
  return [
    "Business-specific hard rules for AI工具基础设施科普号:",
    "- Token代理 in this account means API token/API key relay, model API proxy, base_url forwarding, or stable API access layer.",
    "- Token代理 is NOT an AI Agent, NOT a task automation assistant, NOT a workflow scheduler, NOT a team collaboration bot.",
    "- Never say Token代理 can itself complete data processing, automate reports, schedule work, or collaborate across devices.",
    "- Correct explanation: it helps applications send model requests through a relay/proxy endpoint, so tools can connect more smoothly when the official endpoint is hard to access or when a unified base_url is needed.",
    "- Emphasize boundaries: it only solves the calling path / endpoint / stability / compatibility layer; model capability still depends on the chosen model; business automation depends on the application itself.",
    "- Must include beginner-friendly concepts: API Key/Token, Base URL, model name, request forwarding, timeout/401/429 troubleshooting.",
    "- Soft ad should be phrased as practical option: if you just want to run a tool first, a stable relay endpoint can be used for testing. No hard selling.",
    "- Avoid unsupported model claims such as GPT-5.5 unless present in reliable source items and necessary.",
  ].join("\n");
}

function validateDraftAgainstBusinessRules(draft, userText, topicLabel = "") {
  const issues = [];
  let aiFlavor = 0;
  let humanTrace = 0;
  const hardIssues = issues;
  const specificFixes = [];
  const text = `${draft?.title || ""}\n${draft?.subtitle || ""}\n${draft?.post_text || ""}\n${normalizeSections(draft?.body_sections).map((item) => `${item.heading}\n${item.content}`).join("\n")}`;
  if (text.length > 1200) {
    aiFlavor += 10;
    humanTrace -= 8;
    hardIssues.push("文案过长，像报告而不像小红书笔记。");
    specificFixes.push("压缩到500-900字，保留一个具体场景、一个核心观点和一个清单。");
  }

  if (/(是什么|为什么|怎么做|总结|What is|Why|How to|Conclusion)/i.test(text) && !/(我|朋友|客户|同事|昨天|刚才|后来|卡住|报错|配置)/.test(text)) {
    aiFlavor += 12;
    humanTrace -= 12;
    hardIssues.push("结构过于教科书，缺少真实使用场景。");
    specificFixes.push("把“是什么/为什么/怎么做/总结”改成一次实际使用或排障经历。");
  }

  if (text.length > 1200) {
    aiFlavor += 10;
    humanTrace -= 8;
    hardIssues.push("文案过长，像报告而不像小红书笔记。");
    specificFixes.push("压缩到500-900字，保留一个具体场景、一个核心观点和一个清单。");
  }

  if (/(是什么|为什么|怎么做|总结|What is|Why|How to|Conclusion)/i.test(text) && !/(我|朋友|客户|同事|昨天|刚才|后来|卡住|报错|配置)/.test(text)) {
    aiFlavor += 12;
    humanTrace -= 12;
    hardIssues.push("结构过于教科书，缺少真实使用场景。");
    specificFixes.push("把“是什么/为什么/怎么做/总结”改成一次实际使用或排障经历。");
  }

  if (isAiToolInfrastructureRequest(userText, topicLabel)) {
    const wrongAgentClaims = [
      /Token代理.*(助手|完成复杂|数据处理|自动化任务|团队协作|定期生成报表|调度日常工作|连接各种设备|解放双手)/i,
      /(像一个助手|工作流调度|多设备协同|自动化处理).*Token代理/i,
      /把繁琐的工作交给.*代理/i,
    ];
    if (wrongAgentClaims.some((pattern) => pattern.test(text))) {
      issues.push("Token代理被错误写成了AI Agent/自动化助手，需要改成API调用中转/接口代理。");
    }
    if (!/(Base URL|base_url|API Key|Token|接口|中转|转发|调用|请求|timeout|401|429)/i.test(text)) {
      issues.push("AI工具基础设施内容缺少 API Key / Base URL / 请求转发 / 报错排查等关键概念。");
    }
  }
  return issues;
}

function repairAiToolInfrastructureDraft(draft, userText, topicLabel = "") {
  const issues = validateDraftAgainstBusinessRules(draft, userText, topicLabel);
  if (!issues.length) return { draft, repaired: false, issues: [] };
  if (!isAiToolInfrastructureRequest(userText, topicLabel)) return { draft, repaired: false, issues };

  const next = {
    ...draft,
    title: /token代理/i.test(String(userText || ""))
      ? "Token代理到底解决什么问题？"
      : (draft?.title || "AI工具接口为什么总是连不上？"),
    subtitle: "不是AI助手，而是API调用中转层",
    hook: "很多人把 Token 代理理解错了：它不是帮你干活的 Agent。",
    cover_text: "Token代理不是AI助手",
    cover_style: draft?.cover_style || "干净科技风，适合科普账号",
    visual_direction: draft?.visual_direction || "清晰、克制、偏工具科普的视觉风格",
    post_text: [
      "很多人第一次听到“Token代理”，会以为它是一个能帮你自动干活的 AI 助手。",
      "",
      "其实不是。",
      "",
      "在 AI 工具接入里，Token 代理更准确地说，是一层 API 调用中转。",
      "",
      "你可以把它理解成：",
      "你的工具先请求一个统一的 Base URL，再由这个中转服务把请求转发到对应模型接口。",
      "",
      "它主要解决的是这些问题：",
      "1. 工具里需要填写 Base URL，但你不知道该填哪里",
      "2. 官方接口访问不稳定，经常 timeout",
      "3. 想把多个模型接口统一到一个调用入口",
      "4. 本地工具、Dify、Cursor、Coze 这类应用需要更容易跑通",
      "",
      "但要注意：",
      "Token 代理本身不会替你写报告、处理数据、做团队协作。",
      "真正完成任务的是你的应用和模型，代理只负责把调用链路接顺。",
      "",
      "所以新手先记住一句话：",
      "Token 代理解决的是“怎么稳定调用模型”，不是“模型能帮你做什么”。",
      "",
      "如果你只是想先把 AI 工具跑通，可以先用稳定的中转接口测试。等流程稳定后，再考虑成本、模型选择和并发限制。",
    ].join("\n"),
    body_sections: [
      {
        heading: "Token代理不是AI助手",
        content: "它不是负责自动完成任务的 Agent，而是模型 API 调用链路中的中转层。",
      },
      {
        heading: "它真正解决什么",
        content: "它主要解决 Base URL 配置、接口转发、访问稳定性、模型入口统一等问题。",
      },
      {
        heading: "新手怎么理解",
        content: "应用负责业务流程，模型负责生成结果，Token代理负责让请求更顺利地到达模型服务。",
      },
    ],
    hashtags: ["AI工具", "Token代理", "API接口", "BaseURL", "Dify", "Cursor", "AI自动化", "新手教程"],
    image_shot_list: ["API请求链路示意图", "Base URL配置示意图", "常见报错排查卡片"],
    publish_checklist: [
      "确认没有把Token代理写成AI Agent",
      "确认解释清楚Base URL和API Key",
      "确认软广只作为跑通工具的可选方案",
      "确认没有承诺百分百稳定或无限使用",
    ],
    materials_summary: [
      "Token代理是API调用中转层",
      "适合解释Base URL、接口转发和调用稳定性",
      "不能把它描述为自动化助手",
    ],
  };
  return { draft: next, repaired: true, issues };
}

export async function runDraftGenerationSkill({
  llm,
  userText,
  topicLabel,
  intelItems,
  hermesResearch,
  requirement,
  strategy,
  contentPlan,
  imageMode = "auto",
  modelTimeoutMs,
  logger,
}) {
  const generatedDraft = await callModelJson(
    llm,
    buildDraftPromptV2(userText, topicLabel, intelItems, imageMode, hermesResearch, {
      requirement,
      strategy,
      contentPlan,
    }),
    modelTimeoutMs,
    {
      logger,
      workflow: "小红书发布包",
      step: 4,
      totalSteps: 6,
      purpose: "生成小红书发布包初稿：标题、正文、标签、配图提示词和发布清单",
    },
  );
  const repairResult = repairAiToolInfrastructureDraft(generatedDraft, userText, topicLabel);
  return {
    draft: repairResult.draft,
    repairResult,
  };
}

export async function runQualityCheckSkill({
  llm,
  userText,
  topicLabel,
  requirement,
  strategy,
  contentPlan,
  draft,
  selectedIntelItems,
  scoredOpportunities,
  repairResult = { repaired: false, issues: [] },
  humanEditorRules = {},
  modelTimeoutMs,
  skillConfig,
  logger,
}) {
  const humanEditorReview = await runHumanEditorReview({
    llm,
    userText,
    topicLabel,
    draft,
    humanEditorRules,
    modelTimeoutMs,
    logger,
  });
  const humanRewriteResult = applyHumanEditorRewrite(draft, humanEditorReview);
  let reviewedDraft = humanRewriteResult.draft;
  humanEditorReview.rewrite_applied = humanRewriteResult.applied;

  const nextRepairResult = {
    repaired: Boolean(repairResult?.repaired),
    issues: Array.isArray(repairResult?.issues) ? [...repairResult.issues] : [],
  };
  if (humanRewriteResult.applied) {
    const secondRepairResult = repairAiToolInfrastructureDraft(reviewedDraft, userText, topicLabel);
    reviewedDraft = secondRepairResult.draft;
    if (secondRepairResult.repaired) {
      nextRepairResult.repaired = true;
      nextRepairResult.issues = [...nextRepairResult.issues, ...secondRepairResult.issues];
    }
  }

  const qualityReview = await reviewDraftQuality({
    llm,
    userText,
    topicLabel,
    draft: reviewedDraft,
    scoredOpportunities,
    modelTimeoutMs,
    logger,
  });
  const deliveryGate = skillConfig?.enabled === false
    ? fallbackDeliveryGateFromReviews({ qualityReview, humanEditorReview, strategy, contentPlan })
    : await runDeliveryGateSkill({
        llm,
        userText,
        topicLabel,
        requirement,
        strategy,
        contentPlan,
        draft: reviewedDraft,
        selectedIntelItems,
        humanEditorReview,
        qualityReview,
        modelTimeoutMs,
        skillConfig,
        logger,
      });

  return {
    draft: reviewedDraft,
    repairResult: nextRepairResult,
    humanEditorReview,
    qualityReview,
    deliveryGate,
  };
}


const HUMAN_EDITOR_BANNED_PHRASES = [
  "基础科普",
  "一文搞懂",
  "快速了解",
  "很多小伙伴问我",
  "今天一起来看看",
  "总的来说",
  "赶快收藏",
  "评论区聊聊",
  "效率神器",
  "解放双手",
  "不容错过",
  "轻松提升效率",
];

const HUMAN_EDITOR_STRICT_RULES = [
  "Humanization hard gates:",
  "- Treat a draft as failed if it sounds like an encyclopedia, product brochure, generic assistant answer, or symmetric essay.",
  "- A publishable rewrite must have at least one concrete scene: who was using what tool, what went wrong, what screen/field/error appeared, and what changed after checking it.",
  "- A publishable rewrite must include at least one human trace: misjudgment, hesitation, small detour, manual check, or a sentence that sounds like actual usage experience.",
  "- A publishable rewrite must include at least two operational details: API Key, Base URL, model name, /v1 path, Authorization header, response_format, 401, 429, timeout, model not found, Notion, WeChat bot, Dify, Cursor, Coze, or Xiaohongshu creator page.",
  "- Do not write 'what is / why / how / summary' as a neat textbook structure unless the user explicitly asks for a tutorial.",
  "- Prefer imperfect but readable human rhythm: short paragraph, one observation, one concrete example, one checklist, one boundary.",
  "- Soft ads can only appear as an optional next step, never as the conclusion or the main promise.",
  "- If there is no real enough material, rewrite by narrowing the topic instead of padding with generic benefits.",
  "- Keep Xiaohongshu body concise: usually 500-900 Chinese characters. Avoid long report-like output.",
  "- The rewritten_body must be the final publishable post, not notes about what should be rewritten.",
];

function normalizeHumanEditorRulesConfig(config = {}) {
  const source = config?.human_editor_rules || config?.humanEditorRules || {};
  return {
    enabled: source.enabled !== false,
    extraRules: normalizeList(source.extra_rules || source.extraRules, 30),
    bannedPhrases: normalizeList(source.banned_phrases || source.bannedPhrases, 50),
    requiredDetails: normalizeList(source.required_details || source.requiredDetails, 30),
    maxBodyChars: Number.isFinite(Number(source.max_body_chars || source.maxBodyChars))
      ? Math.max(300, Math.min(2000, Number(source.max_body_chars || source.maxBodyChars)))
      : 900,
    minBodyChars: Number.isFinite(Number(source.min_body_chars || source.minBodyChars))
      ? Math.max(100, Math.min(1500, Number(source.min_body_chars || source.minBodyChars)))
      : 500,
  };
}

function buildHumanEditorCustomRulesText(rulesConfig = {}) {
  const rules = normalizeHumanEditorRulesConfig({ human_editor_rules: rulesConfig });
  if (!rules.enabled) return "";
  const lines = [
    "User-configured human editor rules:",
    `- Target Xiaohongshu body length: ${rules.minBodyChars}-${rules.maxBodyChars} Chinese characters unless the user asks otherwise.`,
  ];
  if (rules.bannedPhrases.length) lines.push(`- Extra banned phrases: ${rules.bannedPhrases.join(" / ")}`);
  if (rules.requiredDetails.length) lines.push(`- Must try to include these detail types: ${rules.requiredDetails.join(" / ")}`);
  rules.extraRules.forEach((item) => lines.push(`- ${item}`));
  return lines.join("\n");
}

function buildHumanEditorPrompt(userText, topicLabel, draft, rulesConfig = {}) {
  const aiInfraRules = isAiToolInfrastructureRequest(userText, topicLabel)
    ? [
        "AI tool infrastructure hard rules:",
        "- Token代理 means API token/API key relay, model API proxy, Base URL forwarding layer, or stable model-calling access layer.",
        "- It can help with unified Base URL, request forwarding, easier testing for Dify/Cursor/Coze/Chatbox/bots, and troubleshooting timeout/401/429/model mismatch.",
        "- It does NOT process data, write reports, schedule tasks, collaborate with teams, control devices, provide model intelligence, or replace an AI Agent.",
        "- Include this boundary naturally: Token代理解决的是“怎么把请求稳定发到模型接口”，不是“模型能帮你做什么”。",
        "- Preferred shape: concrete scene -> misjudgment -> discovery -> explanation -> checklist -> soft ad -> boundary.",
      ].join("\n")
    : "";

  return [
    "You are the xiaohongshu-human-editor skill embedded in an automated content workflow.",
    "Return strict JSON only. No markdown fences.",
    'Schema: {"ai_flavor_score":number,"human_trace_score":number,"rewrite_needed":boolean,"hard_issues":["string"],"specific_fixes":["string"],"rewrite_direction":"string","rewritten_title":"string","rewritten_body":"string","soft_ad_note":"string"}',
    "Your job: review and rewrite Xiaohongshu/Rednote Chinese content to reduce AI-generated flavor and improve human-like experience writing, platform fit, factual accuracy, and soft-ad naturalness.",
    "Score rules:",
    "- ai_flavor_score: 0 means no AI flavor, 100 means very AI-like.",
    "- human_trace_score: 0 means no lived detail, 100 means strong human experience.",
    "- rewrite_needed=true if ai_flavor_score > 35, human_trace_score < 80, or any hard issue exists.",
    "Check these dimensions:",
    "- scene_specificity: concrete tool/person/problem/time/context.",
    "- human_trace: personal misjudgment, trial, hesitation, lived detail.",
    "- detail_density: fields, errors, buttons, settings, examples, constraints.",
    "- structure_naturalness: avoid perfectly symmetrical textbook sections.",
    "- language_naturalness: avoid generic marketing and assistant-like wording.",
    "- soft_ad_naturalness: ad appears as an optional practical path.",
    "- platform_fit: useful, save-worthy, comment-worthy for Xiaohongshu.",
    `Avoid phrases: ${HUMAN_EDITOR_BANNED_PHRASES.join(" / ")}`,
    HUMAN_EDITOR_STRICT_RULES.join("\n"),
    buildHumanEditorCustomRulesText(rulesConfig),
    "Rewrite rules:",
    "- If rewriting, use one of these shapes: troubleshooting note, practical setup note, saveable checklist with context, or personal experience note.",
    "- Include at least three human elements: specific tool, specific problem, misjudgment, diagnostic action, concrete field, boundary reminder, non-sales soft ad.",
    "- Keep rewritten_body publish-ready. Do not explain your rewrite in the body.",
    "- Do not use hard-sell language such as 找我购买、全网最低、百分百稳定、不限量、官方接口、保证可用.",
    aiInfraRules,
    `Topic label: ${topicLabel}`,
    `Original user request: ${userText}`,
    `Draft: ${JSON.stringify(draft)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function heuristicHumanEditorReview(draft, userText, topicLabel = "") {
  const text = `${draft?.title || ""}\n${draft?.subtitle || ""}\n${draft?.post_text || ""}`;
  const hardIssues = [];
  const specificFixes = [];
  let aiFlavor = 18;
  let humanTrace = 82;

  const bannedHits = HUMAN_EDITOR_BANNED_PHRASES.filter((phrase) => text.includes(phrase));
  if (bannedHits.length) {
    aiFlavor += bannedHits.length * 8;
    humanTrace -= bannedHits.length * 5;
    hardIssues.push(`出现模板化表达：${bannedHits.join("、")}`);
    specificFixes.push("删除模板化开头和营销式结尾，改成具体排障或使用场景。");
  }

  if (!/(Dify|Cursor|Coze|Chatbox|微信|机器人|小红书|Base URL|API Key|model|\/v1|timeout|401|429|报错|超时)/i.test(text)) {
    aiFlavor += 18;
    humanTrace -= 20;
    hardIssues.push("缺少具体工具、报错或配置字段。");
    specificFixes.push("补入具体工具和配置项，例如 Dify、Base URL、API Key、model、timeout。");
  }

  if (!/(我一开始|刚开始|后来发现|排了一圈|试了|卡了|最后发现|先看|再看)/.test(text)) {
    aiFlavor += 14;
    humanTrace -= 16;
    hardIssues.push("缺少真人排查过程或认知转折。");
    specificFixes.push("加入“我一开始以为…后来发现…”的排查过程。");
  }

  if (isAiToolInfrastructureRequest(userText, topicLabel)) {
    const infraIssues = validateDraftAgainstBusinessRules(draft, userText, topicLabel);
    if (infraIssues.length) {
      aiFlavor += 20;
      humanTrace -= 12;
      hardIssues.push(...infraIssues);
      specificFixes.push("按 Token 代理=API调用中转/Base URL转发层重写，明确它不是 AI Agent。");
    }
  }

  aiFlavor = Math.max(0, Math.min(100, aiFlavor));
  humanTrace = Math.max(0, Math.min(100, humanTrace));

  return {
    status: "fallback",
    ai_flavor_score: aiFlavor,
    human_trace_score: humanTrace,
    rewrite_needed: aiFlavor > 35 || humanTrace < 80 || hardIssues.length > 0,
    hard_issues: hardIssues,
    specific_fixes: specificFixes,
    rewrite_direction: hardIssues.length ? "改成真实排障笔记，补具体工具、报错、配置字段和边界提醒。" : "保持当前方向。",
    rewritten_title: "",
    rewritten_body: "",
    soft_ad_note: "软广只作为跑通工具的可选路径，不做承诺。",
  };
}

function normalizeHumanEditorReview(result, fallback) {
  const hardIssues = normalizeList(result?.hard_issues, 10);
  const specificFixes = normalizeList(result?.specific_fixes, 10);
  return {
    status: "reviewed",
    ai_flavor_score: Number.isFinite(Number(result?.ai_flavor_score))
      ? Math.max(0, Math.min(100, Number(result.ai_flavor_score)))
      : fallback.ai_flavor_score,
    human_trace_score: Number.isFinite(Number(result?.human_trace_score))
      ? Math.max(0, Math.min(100, Number(result.human_trace_score)))
      : fallback.human_trace_score,
    rewrite_needed:
      typeof result?.rewrite_needed === "boolean"
        ? result.rewrite_needed
        : fallback.rewrite_needed,
    hard_issues: hardIssues.length ? hardIssues : fallback.hard_issues,
    specific_fixes: specificFixes.length ? specificFixes : fallback.specific_fixes,
    rewrite_direction: String(result?.rewrite_direction || fallback.rewrite_direction || "").trim(),
    rewritten_title: String(result?.rewritten_title || "").trim(),
    rewritten_body: String(result?.rewritten_body || "").trim(),
    soft_ad_note: String(result?.soft_ad_note || fallback.soft_ad_note || "").trim(),
  };
}

function sectionsFromPostText(postText) {
  const paragraphs = String(postText || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = [];
  for (let i = 0; i < paragraphs.length && chunks.length < 3; i += 2) {
    chunks.push(paragraphs.slice(i, i + 2).join("\n"));
  }
  return chunks.map((content, index) => ({
    heading: index === 0 ? "真实场景" : index === 1 ? "排查过程" : "经验提醒",
    content,
  }));
}

function applyHumanEditorRewrite(draft, review) {
  const shouldApply =
    review?.rewrite_needed &&
    String(review?.rewritten_body || "").trim().length >= 80;
  if (!shouldApply) return { draft, applied: false };

  const rewrittenTitle = String(review?.rewritten_title || "").trim();
  const rewrittenBody = String(review?.rewritten_body || "").trim();
  const next = {
    ...draft,
    title: rewrittenTitle || draft?.title || "小红书发布包",
    post_text: rewrittenBody,
    body_sections: sectionsFromPostText(rewrittenBody),
    publish_checklist: [
      ...normalizeList(draft?.publish_checklist, 6),
      "确认内容不像百科说明，包含具体场景和排查过程",
      "确认软广只是可选方案，没有过度承诺",
    ].slice(0, 8),
  };
  return { draft: next, applied: true };
}

async function runHumanEditorReview({ llm, userText, topicLabel, draft, humanEditorRules, modelTimeoutMs, logger }) {
  const fallback = heuristicHumanEditorReview(draft, userText, topicLabel);
  try {
    const result = await callModelJson(
      llm,
      buildHumanEditorPrompt(userText, topicLabel, draft, humanEditorRules),
      Math.min(modelTimeoutMs, 90000),
      {
        logger,
        workflow: "小红书发布包",
        step: 5,
        totalSteps: 6,
        purpose: "去 AI 味质检：判断内容是否像真人经验，并给出必要重写建议",
      },
    );
    return normalizeHumanEditorReview(result, fallback);
  } catch (error) {
    logger?.("WARN", "Xiaohongshu human editor review failed; fallback used", { error: String(error) });
    return fallback;
  }
}

function buildOpportunityScoringPrompt(userText, topicLabel, intelItems) {
  return [
    "You are a Xiaohongshu content strategy editor.",
    "Return strict JSON only.",
    'Schema: {"items":[{"index":number,"title":"string","pain_score":number,"save_value_score":number,"soft_ad_score":number,"practical_score":number,"series_score":number,"total_score":number,"recommended_angle":"string","reason":"string"}],"recommended_indexes":[number],"summary":"string"}',
    "Scoring rules:",
    "- pain_score: whether the topic hits a real beginner/user pain point, 0-20.",
    "- save_value_score: whether readers would save the post as a checklist/tutorial, 0-20.",
    "- soft_ad_score: whether token proxy / stable API relay can be mentioned naturally, 0-20.",
    "- practical_score: whether the post can give concrete steps or examples, 0-20.",
    "- series_score: whether it can become part of a repeatable content series, 0-20.",
    "- total_score must be the sum of the five scores.",
    "- recommended_indexes should contain 1 to 3 best item indexes, sorted by priority.",
    "- Keep reasons concise Chinese.",
    "Account positioning:",
    "- AI 工具基础设施科普号.",
    "- Explain API, Token, Base URL, model selection, API proxy, relay stability, troubleshooting, cost control.",
    "- Soft ad must feel like practical experience, not hard selling.",
    `Topic label: ${topicLabel}`,
    `Original user request: ${userText}`,
    `Candidate items: ${JSON.stringify(intelItems.map((item, index) => ({
      index,
      title: item?.title || "",
      summary: item?.summary || "",
      usage: item?.usage || "",
      category: item?.category || "",
      link: item?.link || "",
    })))}`,
  ].join("\n");
}

function buildDraftQualityPrompt(userText, topicLabel, draft, scoredOpportunities) {
  return [
    "You are a Xiaohongshu publishing QA editor for an AI infrastructure education account.",
    "Return strict JSON only.",
    'Schema: {"score":number,"passed":boolean,"title_check":"string","content_check":"string","soft_ad_check":"string","risk_check":"string","publish_readiness":"string","issues":["string"],"suggestions":["string"]}',
    "Review dimensions:",
    "- Title should be concrete, problem-driven, and not clickbait.",
    "- Opening should contain a real beginner pain point.",
    "- Content should explain one problem clearly and provide actionable steps.",
    "- Soft ad should be natural: mention stable relay/proxy only as a practical option, not as a sales pitch.",
    "- Avoid unsafe promises such as guaranteed stability, unlimited usage, cheapest, official, or bypassing platform rules.",
    "- Score from 0 to 100. passed=true only when score >= 75 and no serious risk.",
    `Topic label: ${topicLabel}`,
    `Original user request: ${userText}`,
    `Selected opportunity context: ${JSON.stringify(scoredOpportunities || null)}`,
    `Draft: ${JSON.stringify(draft)}`,
  ].join("\n");
}

function buildHermesContentBrainPrompt(userText, topicLabel, intelItems, imageMode, rulesConfig = {}) {
  return [
    "你是小龙虾内容系统里的 Hermes 内容脑。",
    "OpenClaw 只负责流程编排、保存文件、写 Notion 和回复微信；你负责研究、判断、质检、改写和生成最终文案。",
    "Return strict JSON only. No markdown fences. Do not explain outside JSON.",
    "Your output must be one complete JSON object.",
    'Schema: {"research_card":{"recommended_angle":"string","real_materials":["string"],"reference_structure":["string"],"opening_style":"string","image_direction":"string","avoid":["string"],"sample_pattern_notes":["string"]},"opportunity_score":{"items":[{"index":number,"title":"string","pain_score":number,"save_value_score":number,"soft_ad_score":number,"practical_score":number,"series_score":number,"total_score":number,"recommended_angle":"string","reason":"string"}],"recommended_indexes":[number],"summary":"string"},"draft":{"title":"string","subtitle":"string","hook":"string","cover_text":"string","cover_style":"string","visual_direction":"string","cover_image_prompt":"string","supporting_image_prompts":["string"],"image_plan":[{"position":"string","image_type":"string","purpose":"string","visual_focus":"string","prompt":"string"}],"post_text":"string","body_sections":[{"heading":"string","content":"string"}],"hashtags":["string"],"image_shot_list":["string"],"publish_checklist":["string"],"comment_seed":"string","pin_comment":"string","materials_summary":["string"]},"human_editor_review":{"ai_flavor_score":number,"human_trace_score":number,"rewrite_needed":boolean,"rewrite_applied":boolean,"hard_issues":["string"],"specific_fixes":["string"],"rewrite_direction":"string","rewritten_title":"string","rewritten_body":"string","soft_ad_note":"string"},"quality_review":{"score":number,"passed":boolean,"title_check":"string","content_check":"string","soft_ad_check":"string","risk_check":"string","publish_readiness":"string","issues":["string"],"suggestions":["string"]}}',
    "Content rules:",
    "- Generate the final publish-ready draft directly, not a generic first draft.",
    "- The final draft must already include human-like details, specific scenes, non-textbook structure, and natural soft ad if relevant.",
    "- If the topic is AI tool infrastructure/token proxy, do not confuse token proxy with an AI agent. It is API key/token relay, Base URL forwarding, or model API proxy.",
    "- Avoid hard-sell claims: 官方接口、保证稳定、不限量、全网最低、百分百.",
    "- Image prompts must be specific and usable, but do not generate images.",
    "- Keep Chinese Xiaohongshu tone natural; avoid '一文搞懂/效率神器/解放双手/轻松提升'.",
    HUMAN_EDITOR_STRICT_RULES.join("\n"),
    buildHumanEditorCustomRulesText(rulesConfig),
    `Topic label: ${topicLabel}`,
    `Original user request: ${userText}`,
    `Image mode: ${imageMode}`,
    `Source items: ${JSON.stringify(intelItems).slice(0, 16000)}`,
  ].join("\n");
}

function validateHermesContentBrainShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hermes content brain output is not an object");
  }
  const draft = value.draft;
  if (!draft || typeof draft !== "object") throw new Error("Hermes content brain missing draft");
  if (!String(draft.title || "").trim()) throw new Error("Hermes content brain draft missing title");
  if (!String(draft.post_text || "").trim()) throw new Error("Hermes content brain draft missing post_text");
  if (!value.quality_review || typeof value.quality_review !== "object") {
    throw new Error("Hermes content brain missing quality_review");
  }
  return value;
}

function normalizeHermesContentBrainResult(result, { userText, topicLabel, intelItems }) {
  const source = validateHermesContentBrainShape(result);
  const rawOpportunity = source.opportunity_score || {};
  const opportunityItems = Array.isArray(rawOpportunity.items)
    ? rawOpportunity.items
        .map((item) => ({
          index: Number.isFinite(Number(item?.index)) ? Number(item.index) : -1,
          title: String(item?.title || "").trim(),
          pain_score: Number(item?.pain_score || 0),
          save_value_score: Number(item?.save_value_score || 0),
          soft_ad_score: Number(item?.soft_ad_score || 0),
          practical_score: Number(item?.practical_score || 0),
          series_score: Number(item?.series_score || 0),
          total_score: Number(item?.total_score || 0),
          recommended_angle: String(item?.recommended_angle || "").trim(),
          reason: String(item?.reason || "").trim(),
        }))
        .filter((item) => item.index >= 0 && item.index < intelItems.length)
        .sort((a, b) => b.total_score - a.total_score)
    : [];
  const fallbackOpportunityItems = intelItems
    .map((item, index) => heuristicScoreOpportunity(item, index))
    .sort((a, b) => b.total_score - a.total_score);
  const opportunityScore = {
    status: "hermes-content-brain",
    items: opportunityItems.length ? opportunityItems : fallbackOpportunityItems,
    recommended_indexes: Array.isArray(rawOpportunity.recommended_indexes)
      ? rawOpportunity.recommended_indexes.map((value) => Number(value)).filter((value) => value >= 0 && value < intelItems.length).slice(0, 3)
      : (opportunityItems.length ? opportunityItems : fallbackOpportunityItems).slice(0, 3).map((item) => item.index),
    summary: String(rawOpportunity.summary || "Hermes 内容脑已完成选题判断。").trim(),
  };
  const draft = {
    ...source.draft,
    body_sections: normalizeSections(source.draft.body_sections).length
      ? normalizeSections(source.draft.body_sections)
      : sectionsFromPostText(source.draft.post_text),
    image_plan: normalizeImagePlan(source.draft.image_plan, 10),
    supporting_image_prompts: normalizeList(source.draft.supporting_image_prompts, 5),
    hashtags: normalizeList(source.draft.hashtags, 8),
    image_shot_list: normalizeList(source.draft.image_shot_list, 8),
    publish_checklist: normalizeList(source.draft.publish_checklist, 8),
    materials_summary: normalizeList(source.draft.materials_summary, 8),
  };
  const humanFallback = heuristicHumanEditorReview(draft, userText, topicLabel);
  const humanEditorReview = {
    ...normalizeHumanEditorReview(source.human_editor_review || {}, humanFallback),
    status: "hermes-content-brain",
    rewrite_applied: source.human_editor_review?.rewrite_applied !== false,
  };
  const quality = source.quality_review || {};
  const qualityReview = {
    status: "hermes-content-brain",
    score: Number.isFinite(Number(quality.score)) ? Number(quality.score) : 75,
    passed: typeof quality.passed === "boolean" ? quality.passed : Number(quality.score || 0) >= 75,
    title_check: String(quality.title_check || "").trim(),
    content_check: String(quality.content_check || "").trim(),
    soft_ad_check: String(quality.soft_ad_check || "").trim(),
    risk_check: String(quality.risk_check || "").trim(),
    publish_readiness: String(quality.publish_readiness || "").trim(),
    issues: normalizeList(quality.issues, 8),
    suggestions: normalizeList(quality.suggestions, 8),
  };
  return {
    status: "completed",
    provider: "hermes-content-brain",
    hermesResearch: normalizeHermesResearch({ ...(source.research_card || {}), status: "completed", provider: "hermes-content-brain" }),
    opportunityScore,
    selectedIntelItems: selectScoredIntelItems(intelItems, opportunityScore),
    draft,
    humanEditorReview,
    qualityReview,
  };
}

async function maybeRunHermesContentBrain({ hermesConfig, llm, userText, topicLabel, intelItems, imageMode, humanEditorRules, modelTimeoutMs, logger }) {
  if (!hermesConfig?.enabled || !["content_brain", "content-brain", "brain"].includes(String(hermesConfig.mode || "").trim())) {
    return { status: "disabled", reason: "mode_not_content_brain" };
  }
  try {
    const result = await callModelJson(
      llm,
      buildHermesContentBrainPrompt(userText, topicLabel, intelItems, imageMode, humanEditorRules),
      Math.min(modelTimeoutMs, (hermesConfig.timeout_seconds || 120) * 1000),
      {
        logger,
        workflow: "小红书发布包",
        step: 2,
        totalSteps: 3,
        purpose: "Hermes 内容脑：研究、判断、质检、改写并生成最终文案",
      },
    );
    return normalizeHermesContentBrainResult(result, { userText, topicLabel, intelItems });
  } catch (error) {
    logger?.("WARN", "Hermes content brain failed; stable workflow fallback used", { error: String(error) });
    return { status: "failed", error: String(error) };
  }
}

async function maybeRunHermesContentBrainV2({ hermesConfig, llm, userText, topicLabel, intelItems, imageMode, humanEditorRules, modelTimeoutMs, logger }) {
  if (!hermesConfig?.enabled || !["content_brain", "content-brain", "brain"].includes(String(hermesConfig.mode || "").trim())) {
    return { status: "disabled", reason: "mode_not_content_brain" };
  }
  const prompt = buildHermesContentBrainPrompt(userText, topicLabel, intelItems, imageMode, humanEditorRules);
  const callMeta = {
    workflow: "小红书发布包",
    step: 2,
    totalSteps: 3,
    purpose: "Hermes 内容脑：完成研究、策略、内容方案、初稿生成和自检",
  };
  try {
    const provider = String(hermesConfig.provider || "llm").trim();
    let result;
    if (provider === "wsl-hermes-agent") {
      result = await runWslHermesAgentJson({ hermesConfig, prompt, modelTimeoutMs, loggerMeta: callMeta, logger });
    } else if (provider === "openclaw-agent") {
      const startedAt = Date.now();
      const sessionId = buildWechatSessionId("hermes-content-brain", `${userText}-${Date.now()}-${crypto.randomUUID()}`);
      logger?.("INFO", "Hermes Agent started", {
        ...callMeta,
        executor: "openclaw-agent",
        sessionId,
      });
      logger?.("INFO", "AI API call", {
        ...callMeta,
        mode: "openclaw-agent",
        providerId: "openclaw-agent",
        model: "agent",
        endpoint: "openclaw-agent",
        sessionId,
      });
      const agentResult = await runOpenClawAgent({
        sessionId,
        message: prompt,
        timeoutSeconds: Math.max(30, Math.min(Number(hermesConfig.timeout_seconds || 120), 300)),
        thinking: "medium",
      });
      logger?.("INFO", "Hermes Agent completed", {
        ...callMeta,
        executor: "openclaw-agent",
        sessionId,
        durationMs: Date.now() - startedAt,
        outputChars: String(agentResult.text || "").length,
      });
      logger?.("INFO", "AI API call completed", {
        ...callMeta,
        model: "agent",
        durationMs: Date.now() - startedAt,
      });
      result = extractJsonFromText(agentResult.text);
    } else {
      logger?.("INFO", "Hermes Agent started", {
        ...callMeta,
        executor: "current-model-api",
      });
      result = await callModelJson(
        llm,
        prompt,
        Math.min(modelTimeoutMs, (hermesConfig.timeout_seconds || 120) * 1000),
        { logger, ...callMeta },
      );
      logger?.("INFO", "Hermes Agent completed", {
        ...callMeta,
        executor: "current-model-api",
      });
    }
    return normalizeHermesContentBrainResult(result, { userText, topicLabel, intelItems });
  } catch (error) {
    logger?.("WARN", "Hermes Agent fallback", {
      ...callMeta,
      executor: String(hermesConfig.provider || "llm").trim() || "llm",
      error: String(error),
      fallback: "stable-multi-step",
    });
    logger?.("WARN", "Hermes content brain failed; stable workflow fallback used", { error: String(error) });
    return { status: "failed", error: String(error) };
  }
}

function heuristicScoreOpportunity(item, index) {
  const text = `${item?.title || ""} ${item?.summary || ""} ${item?.usage || ""}`;
  const hasPain = /(失败|报错|超时|timeout|401|429|连不上|不稳定|配置|成本|避坑|新手|怎么|为什么|Base URL|API|Token|Key)/i.test(text);
  const hasPractical = /(步骤|教程|配置|方法|清单|排查|案例|工具|接入|Dify|Cursor|Coze|微信|机器人)/i.test(text);
  const hasSoftAdFit = /(API|Token|代理|中转|Base URL|模型|调用|接口|稳定|成本|自动化)/i.test(text);
  const painScore = hasPain ? 18 : 10;
  const saveValueScore = hasPractical ? 18 : 11;
  const softAdScore = hasSoftAdFit ? 18 : 8;
  const practicalScore = hasPractical || hasPain ? 17 : 10;
  const seriesScore = /(API|工具|模型|自动化|Dify|Cursor|Coze|报错|成本)/i.test(text) ? 16 : 10;
  return {
    index,
    title: String(item?.title || "").trim(),
    pain_score: painScore,
    save_value_score: saveValueScore,
    soft_ad_score: softAdScore,
    practical_score: practicalScore,
    series_score: seriesScore,
    total_score: painScore + saveValueScore + softAdScore + practicalScore + seriesScore,
    recommended_angle: hasPain ? "问题排查 / 新手避坑" : "经验分享 / 工具科普",
    reason: hasPain ? "有明确使用痛点，适合做成排查清单。" : "可作为科普素材，但需要补充具体场景。",
  };
}

export async function scoreContentOpportunities({ llm, userText, topicLabel, intelItems, modelTimeoutMs, logger }) {
  const fallbackItems = intelItems
    .map((item, index) => heuristicScoreOpportunity(item, index))
    .sort((a, b) => b.total_score - a.total_score);
  const fallback = {
    status: "fallback",
    items: fallbackItems,
    recommended_indexes: fallbackItems.slice(0, 3).map((item) => item.index),
    summary: "模型选题评分不可用，已使用本地规则排序。",
  };

  if (!Array.isArray(intelItems) || !intelItems.length) return fallback;

  try {
    const result = await callModelJson(
      llm,
      buildOpportunityScoringPrompt(userText, topicLabel, intelItems),
      Math.min(modelTimeoutMs, 90000),
      {
        logger,
        workflow: "小红书发布包",
        step: 3,
        totalSteps: 6,
        purpose: "内容机会评分：从情报素材里判断哪些最适合做成小红书",
      },
    );
    const items = Array.isArray(result?.items)
      ? result.items
          .map((item) => ({
            index: Number.isFinite(Number(item?.index)) ? Number(item.index) : -1,
            title: String(item?.title || "").trim(),
            pain_score: Number(item?.pain_score || 0),
            save_value_score: Number(item?.save_value_score || 0),
            soft_ad_score: Number(item?.soft_ad_score || 0),
            practical_score: Number(item?.practical_score || 0),
            series_score: Number(item?.series_score || 0),
            total_score: Number(item?.total_score || 0),
            recommended_angle: String(item?.recommended_angle || "").trim(),
            reason: String(item?.reason || "").trim(),
          }))
          .filter((item) => item.index >= 0 && item.index < intelItems.length)
          .sort((a, b) => b.total_score - a.total_score)
      : [];
    if (!items.length) return fallback;
    const recommendedIndexes = Array.isArray(result?.recommended_indexes)
      ? result.recommended_indexes.map((value) => Number(value)).filter((value) => value >= 0 && value < intelItems.length)
      : items.slice(0, 3).map((item) => item.index);
    return {
      status: "scored",
      items,
      recommended_indexes: [...new Set(recommendedIndexes)].slice(0, 3),
      summary: String(result?.summary || "已完成选题评分。").trim(),
    };
  } catch (error) {
    logger?.("WARN", "Xiaohongshu opportunity scoring failed; fallback used", { error: String(error) });
    return fallback;
  }
}

async function reviewDraftQuality({ llm, userText, topicLabel, draft, scoredOpportunities, modelTimeoutMs, logger }) {
  const text = `${draft?.title || ""}\n${draft?.post_text || ""}`;
  const issueList = [];
  if (String(draft?.title || "").length < 8) issueList.push("标题偏短，建议更具体。");
  if (!/(为什么|怎么|如何|报错|失败|超时|配置|避坑|新手|API|Token|Base URL|代理|中转)/i.test(text)) {
    issueList.push("问题场景不够明确，建议强化具体痛点。");
  }
  if (!/(步骤|方法|清单|排查|建议|注意|先|再|最后|1|2|3)/i.test(text)) {
    issueList.push("实操步骤不够明显，建议补成清单。");
  }
  if (/(保证|无限|最便宜|官方|永久免费|百分百|绕过)/i.test(text)) {
    issueList.push("存在容易被理解为过度承诺的表达。");
  }
  const fallbackScore = Math.max(60, 86 - issueList.length * 8);
  const fallback = {
    status: "fallback",
    score: fallbackScore,
    passed: fallbackScore >= 75,
    title_check: issueList.some((item) => item.includes("标题")) ? "标题需要更具体。" : "标题基本可用。",
    content_check: issueList.length ? "内容可发布，但仍有优化点。" : "内容结构基本完整。",
    soft_ad_check: "未发现明显硬广问题。",
    risk_check: issueList.some((item) => item.includes("过度承诺")) ? "需要删除过度承诺。" : "未发现明显风险表达。",
    publish_readiness: fallbackScore >= 75 ? "可发布" : "建议修改后发布",
    issues: issueList,
    suggestions: issueList.length ? issueList : ["保持具体场景、步骤清单和软性表达。"],
  };

  try {
    const result = await callModelJson(
      llm,
      buildDraftQualityPrompt(userText, topicLabel, draft, scoredOpportunities),
      Math.min(modelTimeoutMs, 90000),
      {
        logger,
        workflow: "小红书发布包",
        step: 6,
        totalSteps: 6,
        purpose: "发布前质量检查：检查标题、正文、软广自然度和风险",
      },
    );
    return {
      status: "reviewed",
      score: Number(result?.score || 0),
      passed: Boolean(result?.passed),
      title_check: String(result?.title_check || "").trim(),
      content_check: String(result?.content_check || "").trim(),
      soft_ad_check: String(result?.soft_ad_check || "").trim(),
      risk_check: String(result?.risk_check || "").trim(),
      publish_readiness: String(result?.publish_readiness || "").trim(),
      issues: normalizeList(result?.issues, 8),
      suggestions: normalizeList(result?.suggestions, 8),
    };
  } catch (error) {
    logger?.("WARN", "Xiaohongshu quality review failed; fallback used", { error: String(error) });
    return fallback;
  }
}

export function selectScoredIntelItems(intelItems, opportunityScore) {
  const indexes = Array.isArray(opportunityScore?.recommended_indexes)
    ? opportunityScore.recommended_indexes
    : [];
  const selected = indexes
    .map((index) => intelItems[index])
    .filter(Boolean);
  return selected.length ? selected : intelItems.slice(0, 3);
}

function buildOpportunityScoreText(opportunityScore, intelItems) {
  const lines = [
    "选题评分",
    "========",
    "",
    `状态：${opportunityScore?.status || "unknown"}`,
    `总结：${opportunityScore?.summary || ""}`,
    "",
  ];
  const items = Array.isArray(opportunityScore?.items) ? opportunityScore.items : [];
  items.forEach((item, rank) => {
    const source = intelItems[item.index] || {};
    lines.push(`${rank + 1}. ${item.title || source.title || `候选 ${item.index + 1}`}`);
    lines.push(`   总分：${item.total_score}/100`);
    lines.push(`   痛点：${item.pain_score} 收藏：${item.save_value_score} 软广自然度：${item.soft_ad_score} 实操：${item.practical_score} 系列：${item.series_score}`);
    if (item.recommended_angle) lines.push(`   推荐角度：${item.recommended_angle}`);
    if (item.reason) lines.push(`   原因：${item.reason}`);
    if (source.link) lines.push(`   来源：${source.link}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

function buildQualityReviewText(review) {
  const lines = [
    "内容质检",
    "========",
    "",
    `状态：${review?.status || "unknown"}`,
    `评分：${review?.score ?? "-"}/100`,
    `是否通过：${review?.passed ? "是" : "否"}`,
    `发布建议：${review?.publish_readiness || ""}`,
    "",
    "检查结果：",
    `- 标题：${review?.title_check || ""}`,
    `- 内容：${review?.content_check || ""}`,
    `- 软广：${review?.soft_ad_check || ""}`,
    `- 风险：${review?.risk_check || ""}`,
  ];
  const ruleValidation = review?.ruleValidation || null;
  if (ruleValidation) {
    lines.push("", "业务硬规则：");
    lines.push(`- 是否自动修正：${ruleValidation.repaired ? "是" : "否"}`);
    normalizeList(ruleValidation.issues, 8).forEach((item) => lines.push(`- ${item}`));
  }
  const issues = normalizeList(review?.issues, 8);
  if (issues.length) {
    lines.push("", "问题：");
    issues.forEach((item) => lines.push(`- ${item}`));
  }
  const suggestions = normalizeList(review?.suggestions, 8);
  if (suggestions.length) {
    lines.push("", "修改建议：");
    suggestions.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join("\n").trim();
}

function buildHumanEditorReviewText(review) {
  const lines = [
    "去AI味质检",
    "==========",
    "",
    `状态：${review?.status || "unknown"}`,
    `AI味评分：${review?.ai_flavor_score ?? "-"}/100（越低越好，基于重写前初稿）`,
    `真人感评分：${review?.human_trace_score ?? "-"}/100（越高越好，基于重写前初稿）`,
    `是否需要重写：${review?.rewrite_needed ? "是" : "否"}`,
    `是否已应用重写：${review?.rewrite_applied ? "是" : "否"}`,
  ];
  if (review?.rewrite_applied) {
    lines.push("说明：上面的分数是初稿质检分，不代表重写后最终稿分数。");
  }

  if (review?.rewrite_direction) {
    lines.push(`重写方向：${review.rewrite_direction}`);
  }
  if (review?.soft_ad_note) {
    lines.push(`软广备注：${review.soft_ad_note}`);
  }

  const hardIssues = normalizeList(review?.hard_issues, 10);
  if (hardIssues.length) {
    lines.push("", "硬问题：");
    hardIssues.forEach((item) => lines.push(`- ${item}`));
  }

  const fixes = normalizeList(review?.specific_fixes, 10);
  if (fixes.length) {
    lines.push("", "具体修改：");
    fixes.forEach((item) => lines.push(`- ${item}`));
  }

  if (review?.rewritten_title || review?.rewritten_body) {
    lines.push("", "重写结果：");
    if (review.rewritten_title) lines.push(`标题：${review.rewritten_title}`);
    if (review.rewritten_body) {
      lines.push("", review.rewritten_body);
    }
  }

  return lines.join("\n").trim();
}

function resolveImageMode(userText, imageConfig) {
  const normalized = String(userText || "").trim();
  if (/(\u4e0d\u751f\u56fe|\u4e0d\u8981\u751f\u56fe|\u4e0d\u7528\u51fa\u56fe|\u53ea\u8981\u63d0\u793a\u8bcd|\u53ea\u8981\u914d\u56fe\u5efa\u8bae)/u.test(normalized)) {
    return { mode: "suggest-only", shouldGenerate: false };
  }
  if (/(\u751f\u56fe|\u751f\u6210\u56fe\u7247|\u76f4\u63a5\u51fa\u56fe|\u5c01\u9762\u56fe\u4e5f\u751f\u6210|\u628a\u56fe\u4e5f\u751f\u6210)/u.test(normalized)) {
    return { mode: "generate-images", shouldGenerate: true };
  }
  return {
    mode: imageConfig?.enabled ? "generate-images" : "suggest-only",
    shouldGenerate: Boolean(imageConfig?.enabled),
  };
}

async function callModelJsonViaApi(llm, prompt, timeoutMs, meta = {}) {
  const startedAt = Date.now();
  const workflow = meta.workflow || "小红书发布包";
  const purpose = meta.purpose || "生成结构化内容";
  meta.logger?.("INFO", "AI API call", {
    workflow,
    step: meta.step || 1,
    totalSteps: meta.totalSteps || 1,
    purpose,
    mode: llm.mode,
    providerId: llm.providerId,
    model: llm.model,
    endpoint: "chat/completions",
  });
  const requestUrl = new URL("chat/completions", llm.baseUrl).toString();
  const bodyText = JSON.stringify({
    model: llm.model,
    messages: [
      { role: "system", content: "Return valid JSON only. No markdown fences. No commentary." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    stream: false,
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: bodyText,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Xiaohongshu package call failed: ${res.status} ${text}`);
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Xiaohongshu package returned empty content");
      const parsed = JSON.parse(content);
      const durationMs = Date.now() - startedAt;
      const usage = data?.usage || {};
      const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0;
      const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? 0) || 0;
      const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? Math.max(0, totalTokens - promptTokens)) || 0;
      meta.logger?.("INFO", "AI API call completed", {
        workflow,
        step: meta.step || 1,
        totalSteps: meta.totalSteps || 1,
        purpose,
        model: llm.model,
        durationMs,
        retryCount: attempt - 1,
        modelUsage: {
          provider: llm.providerId || llm.mode || "",
          model: llm.model,
          purpose,
          promptTokens,
          completionTokens,
          totalTokens: totalTokens || promptTokens + completionTokens,
          durationMs,
        },
      });
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        meta.logger?.("WARN", "AI API call retrying", {
          workflow,
          step: meta.step || 1,
          totalSteps: meta.totalSteps || 1,
          purpose,
          model: llm.model,
          attempt,
          durationMs: Date.now() - attemptStartedAt,
          error: String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const durationMs = Date.now() - startedAt;
  meta.logger?.("WARN", "AI API call failed", {
    workflow,
    step: meta.step || 1,
    totalSteps: meta.totalSteps || 1,
    purpose,
    model: llm.model,
    durationMs,
    retryCount: 1,
    error: String(lastError),
    modelUsage: {
      provider: llm.providerId || llm.mode || "",
      model: llm.model,
      purpose,
      status: "failed",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs,
      error: String(lastError),
    },
  });
  throw lastError;
}

async function callModelJson(llm, prompt, timeoutMs, meta = {}) {
  if (llm.mode === "openclaw-agent") {
    const startedAt = Date.now();
    const sessionId = buildWechatSessionId("wechat-xiaohongshu-package", `${Date.now()}-${crypto.randomUUID()}`);
    meta.logger?.("INFO", "AI API call", {
      workflow: meta.workflow || "小红书发布包",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "生成结构化内容",
      mode: llm.mode,
      providerId: llm.providerId,
      model: llm.model,
      endpoint: "openclaw-agent",
      sessionId,
    });
    const result = await runOpenClawAgent({
      message: [
        "你现在是小红书发布助手。",
        "请严格只输出 JSON，不要输出 markdown 代码块，不要解释。",
        prompt,
      ].join("\n\n"),
      sessionId,
      timeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      thinking: "minimal",
    });
    const parsed = JSON.parse(result.text);
    meta.logger?.("INFO", "AI API call completed", {
      workflow: meta.workflow || "小红书发布包",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "生成结构化内容",
      model: llm.model,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  }
  return callModelJsonViaApi(llm, prompt, timeoutMs, meta);
}

function buildImageFileName(kind, index = 0) {
  if (kind === "cover") return "cover.png";
  return `support-${index + 1}.png`;
}

function sortGeneratedImageFiles(files) {
  return Array.isArray(files)
    ? [...files].sort((left, right) => {
        const leftRank = left?.kind === "cover" ? 0 : 1;
        const rightRank = right?.kind === "cover" ? 0 : 1;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return String(left?.path || "").localeCompare(String(right?.path || ""));
      })
    : [];
}

function buildPublishSegments(draft, imageResult = null) {
  const sections = normalizeSections(draft?.body_sections);
  const imagePlan = normalizeImagePlan(draft?.image_plan, 10);
  const generatedFiles = sortGeneratedImageFiles(imageResult?.files);
  const coverFile = generatedFiles.find((item) => item?.kind === "cover") || null;
  const supportFiles = generatedFiles.filter((item) => item?.kind === "support");
  const supportPlans = imagePlan.filter((item) => !String(item?.position || "").includes("封面"));

  return {
    cover: {
      text: String(draft?.cover_text || "").trim(),
      style: String(draft?.cover_style || "").trim(),
      prompt: String(draft?.cover_image_prompt || "").trim(),
      file: coverFile,
    },
    sections: sections.map((section, index) => ({
      heading: section.heading,
      content: section.content,
      imagePlan: supportPlans[index] || null,
      imageFile: supportFiles[index] || null,
    })),
  };
}

function createDraftArtifactPaths(draft) {
  ensureDir(DRAFT_DIR);
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  const titleName = safeFileName(draft?.title || "小红书发布包", "小红书发布包", 48);
  const baseName = `${stamp}_${titleName}`;
  const packageDir = path.join(DRAFT_DIR, baseName);
  ensureDir(packageDir);
  return {
    baseName,
    packageDir,
    jsonPath: path.join(packageDir, "发布包数据.json"),
    mdPath: path.join(packageDir, "完整发布包.md"),
    titlePath: path.join(packageDir, "标题.txt"),
    bodyPath: path.join(packageDir, "正文.txt"),
    hashtagsPath: path.join(packageDir, "话题.txt"),
    coverTextPath: path.join(packageDir, "封面文案.txt"),
    copyAllPath: path.join(packageDir, "复制发布版.txt"),
    imageIndexPath: path.join(packageDir, "图片使用说明.txt"),
    finalPostPath: path.join(packageDir, "最终成稿.txt"),
    manualGuidePath: path.join(packageDir, "手工发布说明.txt"),
    workflowDocumentPath: path.join(packageDir, "生成与重写流程.md"),
    hermesResearchPath: path.join(packageDir, "Hermes研究卡片.txt"),
    opportunityScorePath: path.join(packageDir, "选题评分.txt"),
    humanEditorReviewPath: path.join(packageDir, "去AI味质检.txt"),
    qualityReviewPath: path.join(packageDir, "内容质检.txt"),
    imageDir: path.join(packageDir, "图片素材"),
  };
}

async function writeImageFromResponse(item, targetPath) {
  if (typeof item === "string" && item.startsWith("data:image/")) {
    const [, base64] = item.split(",", 2);
    if (!base64) throw new Error("Image data URI is missing base64 payload");
    fs.writeFileSync(targetPath, Buffer.from(base64, "base64"));
    return;
  }

  if (item?.b64_json) {
    fs.writeFileSync(targetPath, Buffer.from(item.b64_json, "base64"));
    return;
  }

  if (item?.image_base64) {
    fs.writeFileSync(targetPath, Buffer.from(item.image_base64, "base64"));
    return;
  }

  if (item?.image_url?.url) {
    const response = await fetch(item.image_url.url);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
    return;
  }

  if (item?.url) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
    return;
  }

  throw new Error("Image generation returned no image payload");
}

function collectImageCandidates(value, results = []) {
  if (!value) return results;
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      results.push(value);
      return results;
    }

    const markdownMatches = value.match(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g) || [];
    for (const match of markdownMatches) {
      const dataUriMatch = match.match(/\((data:image\/[^)]+)\)/);
      if (dataUriMatch?.[1]) results.push(dataUriMatch[1]);
    }

    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageCandidates(item, results);
    return results;
  }
  if (typeof value === "object") {
    if (value.b64_json || value.url || value.image_base64 || value?.image_url?.url) {
      results.push(value);
    }
    for (const nested of Object.values(value)) collectImageCandidates(nested, results);
  }
  return results;
}

async function generateImageWithOpenAI(prompt, imageConfig, targetPath) {
  return generateImageWithOpenAIFetch(prompt, imageConfig, targetPath);
}

async function generateImageWithOpenAIPowerShell(prompt, imageConfig, targetPath) {
  const requestBody = {
    model: imageConfig.model,
    prompt,
    size: imageConfig.size,
    quality: imageConfig.quality,
    response_format: imageConfig.responseFormat || "b64_json",
    output_format: "png",
  };

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$body = $env:IMG_REQUEST_BODY",
    "$target = $env:IMG_TARGET_PATH",
    "$resp = Invoke-RestMethod -Uri $env:IMG_API_URL -Method Post -Headers @{ Authorization = ('Bearer ' + $env:IMG_API_KEY); 'Content-Type' = 'application/json' } -Body $body -TimeoutSec 180",
    "if (-not $resp.data -or $resp.data.Count -eq 0) { throw 'Image generation returned empty data' }",
    "$item = $resp.data[0]",
    "if ($item.b64_json) { [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($item.b64_json)); exit 0 }",
    "if ($item.image_base64) { [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($item.image_base64)); exit 0 }",
    "if ($item.url) { Invoke-WebRequest -UseBasicParsing -Uri $item.url -OutFile $target -TimeoutSec 180; exit 0 }",
    "if ($item.image_url -and $item.image_url.url) { Invoke-WebRequest -UseBasicParsing -Uri $item.image_url.url -OutFile $target -TimeoutSec 180; exit 0 }",
    "throw 'Image generation returned no supported payload'",
  ].join("; ");

  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      IMG_API_URL: new URL("images/generations", imageConfig.baseUrl).toString(),
      IMG_API_KEY: imageConfig.apiKey,
      IMG_TARGET_PATH: targetPath,
      IMG_REQUEST_BODY: JSON.stringify(requestBody),
    },
  });
}

async function generateImageWithOpenAIFetch(prompt, imageConfig, targetPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const responseFormat = imageConfig.responseFormat || "b64_json";
    const response = await fetch(new URL("images/generations", imageConfig.baseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${imageConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: imageConfig.model,
        prompt,
        size: imageConfig.size,
        quality: imageConfig.quality,
        response_format: responseFormat,
        output_format: "png",
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Image generation failed: ${response.status} ${text}`);
    }

    const data = JSON.parse(text);
    const item = data?.data?.[0];
    await writeImageFromResponse(item, targetPath);
    return { usage: normalizeUsageTokens(data?.usage) };
  } finally {
    clearTimeout(timer);
  }
}

async function generateImageWithOpenAIChat(prompt, imageConfig, targetPath) {
  const systemInstruction =
    "You are an image generation endpoint. Return image output whenever possible. Do not answer with plain text only.";
  const userInstruction = [
    "请直接生成图片，不要只返回文字说明。",
    "If you can generate an image, include the image payload in the response.",
    String(prompt || "").trim(),
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("chat/completions", imageConfig.baseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${imageConfig.apiKey}`,
      },
        body: JSON.stringify({
          model: imageConfig.model,
          n: imageConfig.n || 1,
          messages: [
            {
              role: "system",
              content: systemInstruction,
            },
            {
              role: "user",
              content: userInstruction,
            },
          ],
          extra_body: {
            google: {
            image_config: {
              aspect_ratio: imageConfig.aspectRatio || "16:9",
              image_size: imageConfig.imageSize || "2K",
            },
          },
        },
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Chat image generation failed: ${response.status} ${text}`);
    }

    const data = JSON.parse(text);
    const candidates = collectImageCandidates(data);
    const firstCandidate = candidates[0];
    if (!firstCandidate) {
      throw new Error(`Chat image generation returned no image payload: ${text}`);
    }
    await writeImageFromResponse(firstCandidate, targetPath);
    return { usage: normalizeUsageTokens(data?.usage) };
  } finally {
    clearTimeout(timer);
  }
}

async function generateImageWithOpenAIChatRetry(prompt, imageConfig, targetPath) {
  const promptText = String(prompt || "").trim();
  const attempts = [
    promptText,
    [
      "必须直接返回图片，不要描述图片，不要解释，不要只给文字，只能给图片。",
      "Return image payload only.",
      promptText,
    ]
      .filter(Boolean)
      .join("\n"),
    [
      "最后再试一次：只能返回图片，不能返回纯文本。",
      "Generate exactly one image for this prompt and return image payload only.",
      promptText,
    ]
      .filter(Boolean)
      .join("\n"),
  ];

  let lastError = null;
  for (const attemptPrompt of attempts) {
    try {
      const result = await generateImageWithOpenAIChat(attemptPrompt, imageConfig, targetPath);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Chat image generation retry failed");
}

async function generateImage(prompt, imageConfig, targetPath) {
  const provider = String(imageConfig?.provider || "").trim().toLowerCase();
  if (provider === "openai-chat-image") {
    return generateImageWithOpenAIChatRetry(prompt, imageConfig, targetPath);
  }
  return generateImageWithOpenAI(prompt, imageConfig, targetPath);
}

function hardenImagePrompt(prompt, kind = "support") {
  const normalized = String(prompt || "")
    .trim()
    .replace(/Icon/gi, "抽象应用卡片")
    .replace(/logo/gi, "抽象品牌无关图形")
    .replace(/文字[‘'"][^’'"]+[’'"]?/g, "标题留白区域")
    .replace(/包含.*?文字/g, "包含标题留白区域")
    .replace(/标题文字/g, "标题留白区域");

  const composition =
    kind === "cover"
      ? "小红书封面构图，主体清晰，中央或上方预留干净标题留白区域，方便后期加字。"
      : "小红书正文配图构图，画面清晰，适合作为解释型插图。";

  return [
    normalized,
    composition,
    "画面要求：高质量、干净、现代、真实可用，不要生成任何可读文字。",
    "严禁：中文、英文、数字、问号、乱码、随机符号、品牌Logo、真实软件Logo、商标、UI文字、水印。",
    "如果需要表达流程，请使用无文字的抽象节点、线条、卡片和箭头，只用视觉关系表达，不要在图中写字。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function maybeGenerateDraftImages(draft, artifactPaths, imageConfig, logger) {
  const visualDirection = String(draft?.visual_direction || "").trim();
  const rawCoverPrompt = String(draft?.cover_image_prompt || "").trim();
  const rawSupportingPrompts = normalizeList(draft?.supporting_image_prompts, 3);
  const coverPrompt = rawCoverPrompt ? hardenImagePrompt(rawCoverPrompt, "cover") : "";
  const supportingPrompts = rawSupportingPrompts.map((prompt) => hardenImagePrompt(prompt, "support"));
  const prompts = {
    visualDirection,
    coverPrompt,
    supportingPrompts,
    rawCoverPrompt,
    rawSupportingPrompts,
  };

  if (!imageGenerationIsConfigured(imageConfig)) {
    return {
      status: "skipped",
      prompts,
      outputDir: null,
      files: [],
      error: null,
    };
  }

  const outputDir = artifactPaths.imageDir;
  ensureDir(outputDir);
  const files = [];
  const logImageCall = async ({ kind, prompt, targetPath, index = 0, total = 1 }) => {
    const startedAt = Date.now();
    const kindLabel = kind === "cover" ? "封面图" : `正文配图 ${index + 1}`;
    logger?.("INFO", "AI image call", {
      workflow: "小红书发布包",
      step: `7.${index + 1}`,
      totalSteps: 7,
      purpose: `生图：生成${kindLabel}`,
      mode: "image-generation",
      providerId: imageConfig.provider,
      model: imageConfig.model,
      endpoint: "images/generations",
      imageKind: kind,
      targetPath,
      promptPreview: String(prompt || "").slice(0, 160),
    });
    const imageResult = await generateImage(prompt, imageConfig, targetPath);
    const usage = normalizeUsageTokens(imageResult?.usage);
    logger?.("INFO", "AI image call completed", {
      workflow: "小红书发布包",
      step: `7.${index + 1}`,
      totalSteps: 7,
      purpose: `生图：生成${kindLabel}`,
      mode: "image-generation",
      providerId: imageConfig.provider,
      model: imageConfig.model,
      imageKind: kind,
      targetPath,
      durationMs: Date.now() - startedAt,
      imageUsage: usage,
    });
  };

  try {
    if (coverPrompt) {
      const coverPath = path.join(outputDir, buildImageFileName("cover"));
      await logImageCall({ kind: "cover", prompt: coverPrompt, targetPath: coverPath, index: 0 });
      files.push({ kind: "cover", path: coverPath, prompt: coverPrompt });
    }

    if (imageConfig.generateBodyImages) {
      const maxSupporting = Math.max(0, imageConfig.maxGeneratedImages - files.length);
      for (let index = 0; index < Math.min(maxSupporting, supportingPrompts.length); index += 1) {
        const prompt = supportingPrompts[index];
        const filePath = path.join(outputDir, buildImageFileName("support", index));
        await logImageCall({ kind: "support", prompt, targetPath: filePath, index: files.length });
        files.push({ kind: "support", path: filePath, prompt });
      }
    }

    logger?.("INFO", "Xiaohongshu images generated", {
      outputDir,
      fileCount: files.length,
      generatedBodyImages: imageConfig.generateBodyImages,
    });

    return {
      status: "generated",
      prompts,
      outputDir,
      files,
      error: null,
    };
  } catch (error) {
    logger?.("WARN", "Xiaohongshu image generation failed", {
      error: String(error),
      outputDir,
    });
    return {
      status: "failed",
      prompts,
      outputDir,
      files,
      error: String(error),
    };
  }
}

function buildMarkdownPackageV2(draft, sourceItems, imageResult = null) {
  const hashtags = normalizeList(draft.hashtags).map((tag) => `#${tag}`).join(" ");
  const sections = normalizeSections(draft.body_sections);
  const imageShotList = normalizeList(draft.image_shot_list, 8);
  const imagePlan = normalizeImagePlan(draft.image_plan, 6);
  const publishChecklist = normalizeList(draft.publish_checklist, 8);
  const materialsSummary = normalizeList(draft.materials_summary, 8);
  const publishSegments = buildPublishSegments(draft, imageResult);

  const lines = [
    `# ${draft.title || "小红书发布包"}`,
    "",
    `副标题：${draft.subtitle || ""}`,
    `封面文案：${draft.cover_text || ""}`,
    `封面风格：${draft.cover_style || ""}`,
    `视觉方向：${draft.visual_direction || ""}`,
    "",
    "最终发布正文：",
    draft.post_text || "",
  ];

  if (sections.length) {
    lines.push("", "正文结构拆解：");
    sections.forEach((section, index) => {
      lines.push(`${index + 1}. ${section.heading}`);
      lines.push(section.content);
    });
  }

  if (hashtags) {
    lines.push("", "推荐话题：", hashtags);
  }

  if (draft.comment_seed) {
    lines.push("", "首条评论建议：", draft.comment_seed);
  }

  if (draft.pin_comment) {
    lines.push("", "置顶评论建议：", draft.pin_comment);
  }

  if (imageShotList.length) {
    lines.push("", "配图拍摄/截图清单：");
    imageShotList.forEach((item) => lines.push(`- ${item}`));
  }

  if (imagePlan.length) {
    lines.push("", "配图建议（按发布顺序）：");
    imagePlan.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.position}`);
      if (item.image_type) lines.push(`   类型：${item.image_type}`);
      if (item.purpose) lines.push(`   作用：${item.purpose}`);
      if (item.visual_focus) lines.push(`   重点：${item.visual_focus}`);
      lines.push(`   提示词：${item.prompt}`);
    });
  }

  if (publishChecklist.length) {
    lines.push("", "发布检查清单：");
    publishChecklist.forEach((item) => lines.push(`- ${item}`));
  }

  if (draft.cover_image_prompt) {
    lines.push("", "封面图提示词：", draft.cover_image_prompt);
  }

  const supportingPrompts = normalizeList(draft.supporting_image_prompts, 5);
  if (supportingPrompts.length) {
    lines.push("", "正文配图提示词：");
    supportingPrompts.forEach((item) => lines.push(`- ${item}`));
  }

  if (imageResult?.files?.length) {
    lines.push("", "已生成图片：");
    imageResult.files.forEach((file) => lines.push(`- ${file.kind}: ${file.path}`));
  }

  if (materialsSummary.length) {
    lines.push("", "素材摘要：");
    materialsSummary.forEach((item) => lines.push(`- ${item}`));
  }

  if (Array.isArray(sourceItems) && sourceItems.length) {
    lines.push("", "参考素材：");
    sourceItems.forEach((item) => lines.push(`- ${item.title}${item.link ? ` | ${item.link}` : ""}`));
  }

  return lines.join("\n");
}

function buildManualPublishGuideV2(draft, savedPaths, imageResult = null) {
  const imageFiles = Array.isArray(imageResult?.files) ? imageResult.files : [];
  const lines = [
    "小红书发布包手工发布说明",
    "========================",
    "",
    `标题：${draft?.title || ""}`,
    `副标题：${draft?.subtitle || ""}`,
    "",
    "本地素材位置：",
    `- 发布包文件夹：${savedPaths.packageDir}`,
    `- 标题：${savedPaths.titlePath}`,
    `- 正文：${savedPaths.bodyPath}`,
    `- 话题：${savedPaths.hashtagsPath}`,
    `- 封面文案：${savedPaths.coverTextPath}`,
    `- 复制发布版：${savedPaths.copyAllPath}`,
    `- 最终成稿：${savedPaths.finalPostPath}`,
    `- 图片使用说明：${savedPaths.imageIndexPath}`,
    `- Markdown 版本：${savedPaths.mdPath}`,
    `- JSON 数据包：${savedPaths.jsonPath}`,
  ];

  if (imageFiles.length) {
    lines.push(`- 图片目录：${savedPaths.imageDir}`);
    imageFiles.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.kind} -> ${item.path}`);
    });
  } else {
    lines.push("- 图片目录：本次没有自动生成图片，请按提示词或配图建议手动配图");
  }

  lines.push(
    "",
    "最快手工发布步骤：",
    "1. 打开小红书创作服务平台的图文发布页。",
    "2. 上传“图片素材”文件夹里的图片，优先按“图片使用说明”里的顺序上传。",
    "3. 打开“标题.txt”，复制到标题框。",
    "4. 打开“正文.txt”，复制到正文框。",
    "5. 打开“话题.txt”，把话题补到正文末尾或发布页话题位置。",
    "6. 检查图片顺序、标题、正文和话题后，保存草稿或手动发布。",
    "",
    "如果只想最快复制一次：",
    "- 打开“复制发布版.txt”，里面已经合并了标题、正文和话题。",
  );

  if (draft?.cover_text) {
    lines.push("", `封面文案：${draft.cover_text}`);
  }

  return lines.join("\n");
}

function buildHashtagsText(draft) {
  return normalizeList(draft?.hashtags, 10)
    .map((tag) => {
      const normalized = String(tag || "").trim().replace(/^#+/, "");
      return normalized ? `#${normalized}` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function buildCopyAllText(draft) {
  const title = String(draft?.title || "").trim();
  const body = String(draft?.post_text || "").trim();
  const hashtags = buildHashtagsText(draft);
  return [
    title ? `标题：${title}` : "",
    "",
    body,
    "",
    hashtags ? `话题：${hashtags}` : "",
  ]
    .filter((part, index, array) => {
      if (part) return true;
      return array[index - 1] && array[index + 1];
    })
    .join("\n")
    .trim();
}

function buildImageIndexText(draft, imageResult = null) {
  const imageFiles = Array.isArray(imageResult?.files) ? imageResult.files : [];
  const imagePlan = normalizeImagePlan(draft?.image_plan, 10);
  const shotList = normalizeList(draft?.image_shot_list, 10);
  const lines = [
    "图片使用说明",
    "============",
    "",
  ];

  if (imageFiles.length) {
    lines.push("建议上传顺序：");
    imageFiles.forEach((file, index) => {
      const plan = imagePlan[index] || null;
      const label = file.kind === "cover" ? "封面图" : `正文配图 ${index}`;
      lines.push(`${index + 1}. ${label}`);
      lines.push(`   文件：${file.path}`);
      if (plan?.position) lines.push(`   位置：${plan.position}`);
      if (plan?.purpose) lines.push(`   作用：${plan.purpose}`);
      if (file.prompt) lines.push(`   提示词：${file.prompt}`);
    });
  } else {
    lines.push("本次没有自动生成图片。可以按下面的配图建议手动找图或生图。");
  }

  if (shotList.length) {
    lines.push("", "配图清单：");
    shotList.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }

  if (imagePlan.length) {
    lines.push("", "详细配图建议：");
    imagePlan.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.position}`);
      if (item.image_type) lines.push(`   类型：${item.image_type}`);
      if (item.purpose) lines.push(`   作用：${item.purpose}`);
      if (item.visual_focus) lines.push(`   视觉重点：${item.visual_focus}`);
      if (item.prompt) lines.push(`   生图提示词：${item.prompt}`);
    });
  }

  if (draft?.cover_image_prompt) {
    lines.push("", "封面图提示词：", draft.cover_image_prompt);
  }

  const supportingPrompts = normalizeList(draft?.supporting_image_prompts, 5);
  if (supportingPrompts.length) {
    lines.push("", "正文配图提示词：");
    supportingPrompts.forEach((prompt, index) => lines.push(`${index + 1}. ${prompt}`));
  }

  return lines.join("\n").trim();
}

function buildWechatReply(draft, saved, notion) {
  const hashtags = normalizeList(draft.hashtags, 5).map((tag) => `#${tag}`).join(" ");
  const imageShotList = normalizeList(draft.image_shot_list, 3);
  const postLines = String(draft.post_text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  const lines = [
    "小红书发布包已经帮你整理好了：",
    `标题：${draft.title || ""}`,
  ];
  if (draft.subtitle) lines.push(`副标题：${draft.subtitle}`);
  if (draft.cover_text) lines.push(`封面文案：${draft.cover_text}`);
  lines.push("最终发布正文：");
  lines.push(...postLines);
  if (hashtags) lines.push(`话题：${hashtags}`);
  if (imageShotList.length) {
    lines.push("配图清单：");
    imageShotList.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  lines.push(`已保存发布包：${saved.baseName}`);
  if (notion?.status === "written") {
    lines.push(`资料库：已写入${notion.target === "content_publish" ? "内容发布库" : "情报库"}`);
  } else if (notion?.status === "failed") {
    lines.push("资料库：写入失败，已保留本地素材包");
  }
  return truncate(lines.join("\n"));
}

function saveDraftFiles(draft, intelItems) {
  ensureDir(DRAFT_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${stamp}-${safeSlug(draft.title || "xiaohongshu-package")}`;
  const jsonPath = path.join(DRAFT_DIR, `${baseName}.json`);
  const mdPath = path.join(DRAFT_DIR, `${baseName}.md`);
  const payload = {
    generatedAt: new Date().toISOString(),
    packageType: "xiaohongshu-publish-package",
    draft,
    sourceItems: intelItems,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(mdPath, buildMarkdownPackage(draft, intelItems), "utf8");
  return {
    baseName,
    jsonPath,
    mdPath,
  };
}

async function findIntelSourceRelations(sourceItems, aiIntelConfig) {
  if (!notionDbIsConfigured(aiIntelConfig)) return [];
  const dataSourceId = await getNotionDataSourceId(aiIntelConfig.databaseId, aiIntelConfig.token);
  const relations = [];
  for (const item of sourceItems) {
    const link = String(item?.link || "").trim();
    const title = String(item?.title || "").trim();
    if (!link && !title) continue;

    let pageId = null;
    if (link) {
      const byLink = await notionFetchJson(
        `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
        aiIntelConfig.token,
        {
          page_size: 1,
          filter: {
            property: aiIntelConfig.propertyMap.link,
            url: { equals: link },
          },
        },
      );
      pageId = byLink?.results?.[0]?.id || null;
    }

    if (!pageId && title) {
      const byTitle = await notionFetchJson(
        `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
        aiIntelConfig.token,
        {
          page_size: 1,
          filter: {
            property: aiIntelConfig.propertyMap.title,
            title: { equals: title },
          },
        },
      );
      pageId = byTitle?.results?.[0]?.id || null;
    }

    if (pageId && !relations.some((entry) => entry.id === pageId)) {
      relations.push({ id: pageId });
    }
  }
  return relations.slice(0, 20);
}

function buildAiIntelFallbackPayload(draft, notionConfig) {
  const summary =
    String(draft.subtitle || "").trim() ||
    String(draft.hook || "").trim() ||
    String(draft.post_text || "").trim().slice(0, 120);

  return {
    parent: { database_id: normalizeNotionId(notionConfig.databaseId) },
    properties: {
      [notionConfig.propertyMap.title]: {
        title: [{ text: { content: String(draft.title || "小红书发布包").slice(0, 100) } }],
      },
      [notionConfig.propertyMap.summary]: {
        rich_text: [{ text: { content: summary.slice(0, 2000) } }],
      },
      [notionConfig.propertyMap.usage]: {
        rich_text: [{ text: { content: "小红书发布包" } }],
      },
      [notionConfig.propertyMap.link]: {
        url: null,
      },
      [notionConfig.propertyMap.date]: {
        date: { start: new Date().toISOString() },
      },
      [notionConfig.propertyMap.category]: {
        select: { name: "自媒体选题" },
      },
    },
  };
}

function buildContentPublishPayload(draft, contentConfig, sourceRelations) {
  const summary =
    String(draft.subtitle || "").trim() ||
    String(draft.hook || "").trim() ||
    String(draft.post_text || "").trim().slice(0, 120);

  const finalPostText = String(draft.post_text || "").trim();

  const properties = {
    [contentConfig.propertyMap.title]: {
      title: [{ text: { content: String(draft.title || "小红书发布包").slice(0, 100) } }],
    },
    [contentConfig.propertyMap.contentType]: {
      select: { name: "小红书发布包" },
    },
    [contentConfig.propertyMap.publishStatus]: {
      select: { name: "已生成" },
    },
    [contentConfig.propertyMap.summary]: {
      rich_text: [{ text: { content: summary.slice(0, 2000) } }],
    },
    [contentConfig.propertyMap.finalPost]: {
      rich_text: buildRichTextFragments(finalPostText, 2000, 25),
    },
    [contentConfig.propertyMap.platform]: {
      select: { name: "小红书" },
    },
    [contentConfig.propertyMap.publishDate]: {
      date: { start: new Date().toISOString() },
    },
    [contentConfig.propertyMap.publishUrl]: {
      url: null,
    },
  };

  if (sourceRelations.length) {
    properties[contentConfig.propertyMap.sourceIntel] = {
      relation: sourceRelations,
    };
  }

  return {
    parent: { database_id: normalizeNotionId(contentConfig.databaseId) },
    properties,
  };
}

function buildRichTextFragments(text, chunkSize = 2000, maxChunks = 25) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [{ text: { content: "" } }];
  }
  const chunks = [];
  for (let i = 0; i < normalized.length && chunks.length < maxChunks; i += chunkSize) {
    chunks.push({ text: { content: normalized.slice(i, i + chunkSize) } });
  }
  return chunks;
}

async function syncReverseIntelRelations(contentPageId, sourceRelations, aiIntelConfig, contentPublishConfig) {
  if (!contentPageId || !sourceRelations.length || !notionDbIsConfigured(aiIntelConfig)) return;
  const reversePropertyId = await resolveRelationPropertyId(
    aiIntelConfig.databaseId,
    aiIntelConfig.token,
    contentPublishConfig.databaseId,
  );
  if (!reversePropertyId) return;

  for (const relation of sourceRelations) {
    const sourcePageId = relation?.id;
    if (!sourcePageId) continue;

    const sourcePage = await notionFetchJson(
      `https://api.notion.com/v1/pages/${normalizeNotionId(sourcePageId)}`,
      aiIntelConfig.token,
      null,
      "GET",
    );

    const reverseProperty = Object.values(sourcePage?.properties || {}).find((property) => property?.id === reversePropertyId);
    const existingRelations = Array.isArray(reverseProperty?.relation) ? reverseProperty.relation : [];

    if (existingRelations.some((entry) => entry.id === contentPageId)) continue;

    const nextRelations = [...existingRelations, { id: contentPageId }].slice(0, 100);

    await notionFetchJson(
      `https://api.notion.com/v1/pages/${normalizeNotionId(sourcePageId)}`,
      aiIntelConfig.token,
      {
        properties: {
          [reversePropertyId]: {
            relation: nextRelations,
          },
        },
      },
      "PATCH",
    );
  }
}

function buildNotionBlocks(draft, sourceItems) {
  const blocks = [];
  if (draft.cover_text) blocks.push(headingBlock(`封面文案：${draft.cover_text}`));
  if (draft.subtitle) blocks.push(paragraphBlock(`副标题：${draft.subtitle}`));
  if (draft.post_text) {
    blocks.push(headingBlock("最终发布正文"));
    String(draft.post_text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => blocks.push(paragraphBlock(line)));
  }

  const imageShotList = normalizeList(draft.image_shot_list, 10);
  if (imageShotList.length) {
    blocks.push(headingBlock("配图清单"));
    imageShotList.forEach((item) => blocks.push(bulletedBlock(item)));
  }

  const publishChecklist = normalizeList(draft.publish_checklist, 10);
  if (publishChecklist.length) {
    blocks.push(headingBlock("发布检查清单"));
    publishChecklist.forEach((item) => blocks.push(bulletedBlock(item)));
  }

  const hashtags = normalizeList(draft.hashtags, 10);
  if (hashtags.length) {
    blocks.push(headingBlock("推荐话题"));
    blocks.push(paragraphBlock(hashtags.map((tag) => `#${tag}`).join(" ")));
  }

  if (draft.comment_seed) {
    blocks.push(headingBlock("首条评论建议"));
    blocks.push(paragraphBlock(draft.comment_seed));
  }

  if (draft.pin_comment) {
    blocks.push(headingBlock("置顶评论建议"));
    blocks.push(paragraphBlock(draft.pin_comment));
  }

  if (Array.isArray(sourceItems) && sourceItems.length) {
    blocks.push(headingBlock("参考素材"));
    sourceItems.forEach((item) => blocks.push(bulletedBlock(`${item.title}${item.link ? ` | ${item.link}` : ""}`)));
  }

  return blocks.slice(0, 100);
}

async function writePackageToNotion(draft, sourceItems, notionConfig) {
  const useContentPublish = notionDbIsConfigured(notionConfig.contentPublish);
  const targetConfig = useContentPublish ? notionConfig.contentPublish : notionConfig.aiIntel;
  const sourceRelations = useContentPublish
    ? await findIntelSourceRelations(sourceItems, notionConfig.aiIntel)
    : [];

  const payload = useContentPublish
    ? buildContentPublishPayload(draft, notionConfig.contentPublish, sourceRelations)
    : buildAiIntelFallbackPayload(draft, notionConfig.aiIntel);

  const page = await notionFetchJson("https://api.notion.com/v1/pages", targetConfig.token, payload);
  const pageId = page.id;
  const blocks = buildNotionBlocks(draft, sourceItems);
  if (pageId && blocks.length) {
    await notionFetchJson(
      `https://api.notion.com/v1/blocks/${normalizeNotionId(pageId)}/children`,
      targetConfig.token,
      { children: blocks },
      "PATCH",
    );
  }
  if (pageId && useContentPublish && sourceRelations.length) {
    await syncReverseIntelRelations(pageId, sourceRelations, notionConfig.aiIntel, notionConfig.contentPublish);
  }
  return {
    pageId: page.id || null,
    url: page.url || null,
    target: useContentPublish ? "content_publish" : "ai_intel",
    relationCount: sourceRelations.length,
  };
}

function buildMarkdownPackage(draft, sourceItems, imageResult = null) {
  const hashtags = normalizeList(draft.hashtags).map((tag) => `#${tag}`).join(" ");
  const sections = normalizeSections(draft.body_sections);
  const imageShotList = normalizeList(draft.image_shot_list, 8);
  const publishChecklist = normalizeList(draft.publish_checklist, 8);
  const materialsSummary = normalizeList(draft.materials_summary, 8);
  const supportingPrompts = normalizeList(draft.supporting_image_prompts, 5);

  const lines = [
    `# ${draft.title || "小红书发布包"}`,
    "",
    `副标题：${draft.subtitle || ""}`,
    `封面文案：${draft.cover_text || ""}`,
    `封面风格：${draft.cover_style || ""}`,
    `视觉方向：${draft.visual_direction || ""}`,
    "",
    "最终发布正文：",
    draft.post_text || "",
  ];

  if (sections.length) {
    lines.push("", "正文结构拆解：");
    sections.forEach((section, index) => {
      lines.push(`${index + 1}. ${section.heading}`);
      lines.push(section.content);
    });
  }

  if (hashtags) {
    lines.push("", "推荐话题：", hashtags);
  }

  if (draft.comment_seed) {
    lines.push("", "首条评论建议：", draft.comment_seed);
  }

  if (draft.pin_comment) {
    lines.push("", "置顶评论建议：", draft.pin_comment);
  }

  if (imageShotList.length) {
    lines.push("", "配图拍摄/截图清单：");
    imageShotList.forEach((item) => lines.push(`- ${item}`));
  }

  if (publishChecklist.length) {
    lines.push("", "发布检查清单：");
    publishChecklist.forEach((item) => lines.push(`- ${item}`));
  }

  if (draft.cover_image_prompt) {
    lines.push("", "封面图提示词：", draft.cover_image_prompt);
  }

  if (supportingPrompts.length) {
    lines.push("", "正文配图提示词：");
    supportingPrompts.forEach((item) => lines.push(`- ${item}`));
  }

  if (imageResult?.files?.length) {
    lines.push("", "已生成图片：");
    imageResult.files.forEach((file) => lines.push(`- ${file.kind}: ${file.path}`));
  } else if (imageResult?.status === "failed") {
    lines.push("", `图片生成状态：失败（${imageResult.error || "未知错误"}）`);
  } else if (imageResult?.status === "skipped") {
    lines.push("", "图片生成状态：未启用自动出图，已保留提示词");
  }

  if (publishSegments.cover.file || publishSegments.sections.some((item) => item.imageFile || item.imagePlan)) {
    lines.push("", "图文成稿（可直接参考排版）：", "");
    if (publishSegments.cover.file?.path) {
      lines.push("## 封面图");
      lines.push(`![封面图](${publishSegments.cover.file.path})`);
      if (publishSegments.cover.text) lines.push(`封面文案：${publishSegments.cover.text}`);
      if (publishSegments.cover.style) lines.push(`封面风格：${publishSegments.cover.style}`);
      if (publishSegments.cover.prompt) lines.push(`封面提示词：${publishSegments.cover.prompt}`);
      lines.push("");
    }

    publishSegments.sections.forEach((section, index) => {
      lines.push(`## ${section.heading || `正文段落 ${index + 1}`}`);
      if (section.imageFile?.path) {
        lines.push(`![正文配图${index + 1}](${section.imageFile.path})`);
      }
      if (section.imagePlan?.position) lines.push(`建议位置：${section.imagePlan.position}`);
      if (section.imagePlan?.image_type) lines.push(`图片类型：${section.imagePlan.image_type}`);
      if (section.imagePlan?.purpose) lines.push(`图片作用：${section.imagePlan.purpose}`);
      if (section.imagePlan?.visual_focus) lines.push(`视觉重点：${section.imagePlan.visual_focus}`);
      if (section.imagePlan?.prompt) lines.push(`图片提示词：${section.imagePlan.prompt}`);
      lines.push(section.content);
      lines.push("");
    });
  }

  if (materialsSummary.length) {
    lines.push("", "素材摘要：");
    materialsSummary.forEach((item) => lines.push(`- ${item}`));
  }

  if (Array.isArray(sourceItems) && sourceItems.length) {
    lines.push("", "参考素材：");
    sourceItems.forEach((item) => lines.push(`- ${item.title}${item.link ? ` | ${item.link}` : ""}`));
  }

  return lines.join("\n");
}

function buildWechatReplyV2Verbose(draft, saved, notion, imageResult = null) {
  const hashtags = normalizeList(draft.hashtags, 5).map((tag) => `#${tag}`).join(" ");
  const imageShotList = normalizeList(draft.image_shot_list, 3);
  const supportingPrompts = normalizeList(draft.supporting_image_prompts, 2);
  const imagePlan = normalizeImagePlan(draft.image_plan, 3);
  const postLines = String(draft.post_text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  const lines = [
    "小红书发布包已经帮你整理好了。",
    `标题：${draft.title || ""}`,
  ];
  if (draft.subtitle) lines.push(`副标题：${draft.subtitle}`);
  if (draft.cover_text) lines.push(`封面文案：${draft.cover_text}`);
  if (draft.visual_direction) lines.push(`视觉方向：${draft.visual_direction}`);
  lines.push("最终发布正文：");
  lines.push(...postLines);
  if (hashtags) lines.push(`话题：${hashtags}`);
  if (imageShotList.length) {
    lines.push("配图清单：");
    imageShotList.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  if (imagePlan.length) {
    lines.push("配图建议：");
    imagePlan.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.position}｜${item.image_type || "图片"}｜${truncate(item.prompt, 80)}`);
    });
  }
  if (draft.cover_image_prompt) {
    lines.push(`封面图提示词：${truncate(draft.cover_image_prompt, 160)}`);
  }
  if (supportingPrompts.length) {
    lines.push("正文配图提示词：");
    supportingPrompts.forEach((item, index) => lines.push(`${index + 1}. ${truncate(item, 120)}`));
  }
  lines.push(`已保存发布包：${saved.baseName}`);
  if (saved?.packageDir) {
    lines.push(`本地素材包：${saved.packageDir}`);
  }
  if (saved?.finalPostPath) {
    lines.push(`最终成稿文件：${saved.finalPostPath}`);
  }
  if (imageResult?.status === "generated" && imageResult.files.length) {
    lines.push(`图片生成：已生成 ${imageResult.files.length} 张`);
    lines.push(`图片目录：${imageResult.outputDir}`);
  } else if (imageResult?.status === "failed") {
    lines.push(`图片生成：失败（${imageResult.error || "未知错误"}）`);
  } else {
    lines.push("图片生成：未启用自动出图，已保留提示词");
  }
  if (notion?.status === "written") {
    lines.push(`资料库：已写入${notion.target === "content_publish" ? "内容发布库" : "情报库"}`);
  } else if (notion?.status === "failed") {
    lines.push("资料库：写入失败，已保留本地素材包");
  }
  lines.push("如未自动打开并保存小红书草稿，可直接按本地素材包手工发布。");
  return truncate(lines.join("\n"));
}
function buildWechatReplyV2(draft, saved, notion, imageResult = null, businessFlow = null) {
  const imageLine =
    imageResult?.status === "generated" && imageResult.files?.length
      ? `配图：已生成 ${imageResult.files.length} 张`
      : imageResult?.status === "failed"
        ? "配图：生成失败，已保留配图建议"
        : "配图：已保留配图建议";
  const review = businessFlow?.qualityReview || null;
  const humanReview = businessFlow?.humanEditorReview || null;
  const reviewLine = review
    ? `质检：${review.score ?? "-"}分，${review.passed ? "可发布" : "建议再改"}`
    : "质检：未执行";
  const humanLine = humanReview
    ? humanReview.rewrite_applied
      ? `去AI味：初稿真人感${humanReview.human_trace_score ?? "-"}分，AI味${humanReview.ai_flavor_score ?? "-"}分，已重写；最终稿未复评`
      : `去AI味：真人感${humanReview.human_trace_score ?? "-"}分，AI味${humanReview.ai_flavor_score ?? "-"}分`
    : "去AI味：未执行";

  const lines = [
    "小红书发布包已整理好。",
    `标题：${draft.title || "未命名"}`,
    imageLine,
    humanLine,
    reviewLine,
  ];

  if (saved?.packageDir) {
    lines.push(`素材包：${saved.packageDir}`);
  }

  if (notion?.status === "written") {
    lines.push(`资料库：已写入${notion.target === "content_publish" ? "内容发布库" : "情报库"}`);
  } else if (notion?.status === "failed") {
    lines.push("资料库：写入失败，已保留本地素材包");
  }

  lines.push("自动生图和小红书预填已暂时关闭；本次重点保留完整发布文档、配图提示词和本地素材包。");
  return truncate(lines.join("\n"), 700);
}

function inferRequirementWorkflow(userText, topicLabel, draft) {
  const normalized = String(userText || "").trim();
  return {
    rawInput: normalized,
    topic: String(draft?.subtitle || draft?.title || topicLabel || "").trim(),
    platform: "小红书",
    contentGoal: /引流|成交|咨询|转化|获客/u.test(normalized) ? "业务转化" : "内容种草与经验分享",
    audience: /新手|小白/u.test(normalized) ? "新手用户" : "对该主题有实际需求的用户",
    productOrService: /产品|服务|工具|课程|系统|后台/u.test(normalized) ? "包含业务/产品信息" : "未明确植入",
    constraints: ["避免硬广和夸大承诺", "避免明显 AI 口吻", "保留可人工检查和二次编辑的空间"],
    missingFields: [
      !/人群|用户|客户|新手|小白/u.test(normalized) ? "目标人群" : "",
      !/目的|引流|成交|种草|转化|获客/u.test(normalized) ? "内容目标" : "",
      !/不能|避免|不要|禁止/u.test(normalized) ? "禁写要求" : "",
    ].filter(Boolean),
  };
}

function buildRequirementStructuringPrompt(userText, topicLabel) {
  return [
    "你是小龙虾内容工作流里的「需求结构化 Skill」。",
    "你的职责不是写正文，而是把用户的原始需求整理成后续内容生成可以稳定使用的业务字段。",
    "只输出严格 JSON，不要 Markdown，不要解释。",
    'Schema: {"topic":"string","platform":"string","contentGoal":"string","audience":"string","productOrService":"string","tone":"string","constraints":["string"],"missingFields":["string"],"riskNotes":["string"],"confidence":number,"summary":"string"}',
    "字段要求：",
    "- topic: 这次内容真正要讲的主题，不要只写“小红书”。",
    "- contentGoal: 内容目标，例如种草、教育、引流、经验分享、避坑、转化。",
    "- audience: 尽量具体的人群，如果输入缺失就合理推断并在 missingFields 标注。",
    "- productOrService: 有明确产品/服务就写清楚，没有就写“未明确”。",
    "- constraints: 必须包含用户明说的限制，也可以补充平台表达限制。",
    "- missingFields: 只列真正影响生成质量的缺失项，不要机械列太多。",
    "- confidence: 0-100。",
    `Topic label: ${topicLabel}`,
    `Original request: ${userText}`,
  ].join("\n");
}

function normalizeRequirementSkill(result, fallback) {
  const source = result && typeof result === "object" ? result : {};
  const confidence = Number(source.confidence);
  return {
    ...fallback,
    status: source.status || "completed",
    provider: source.provider || "llm-skill",
    rawInput: fallback.rawInput,
    topic: String(source.topic || fallback.topic || "").trim(),
    platform: String(source.platform || fallback.platform || "小红书").trim(),
    contentGoal: String(source.contentGoal || fallback.contentGoal || "").trim(),
    audience: String(source.audience || fallback.audience || "").trim(),
    productOrService: String(source.productOrService || fallback.productOrService || "").trim(),
    tone: String(source.tone || fallback.tone || "").trim(),
    constraints: normalizeList(source.constraints || fallback.constraints, 8),
    missingFields: normalizeList(source.missingFields || fallback.missingFields, 8),
    riskNotes: normalizeList(source.riskNotes || fallback.riskNotes, 8),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : fallback.confidence ?? 65,
    summary: String(source.summary || fallback.summary || "").trim(),
  };
}

function normalizeWorkflowSkillConfig(skillConfig = {}, globalTimeoutMs) {
  const timeoutSeconds = Number(skillConfig.timeoutSeconds);
  return {
    name: String(skillConfig.name || ""),
    enabled: skillConfig.enabled !== false,
    profile: String(skillConfig.profile || "standard"),
    notes: String(skillConfig.notes || "").trim(),
    selectedFocuses: Array.isArray(skillConfig.selectedFocuses)
      ? skillConfig.selectedFocuses.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    outputRequirement: String(skillConfig.outputRequirement || "").trim(),
    timeoutMs: Math.min(
      Number.isFinite(globalTimeoutMs) ? globalTimeoutMs : DEFAULT_TIMEOUT_MS,
      Math.max(30000, Math.min(Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : 60000, 180000)),
    ),
    fallbackOnError: skillConfig.fallbackOnError !== false,
  };
}

function applySkillPromptConfig(prompt, skillConfig = {}) {
  const config = normalizeWorkflowSkillConfig(skillConfig, DEFAULT_TIMEOUT_MS);
  const profileText = config.profile === "strict"
    ? "Skill 配置档：严格复核。优先保证真实感、结构完整、风险表达和可交付性。"
    : config.profile === "fast"
      ? "Skill 配置档：快速生成。保持输出完整，但减少不必要的展开。"
      : "";
  const additions = [
    profileText,
    config.selectedFocuses.length ? `关注重点：${config.selectedFocuses.join("、")}` : "",
    config.notes ? `关注重点：${config.notes}` : "",
    config.outputRequirement ? `输出要求：${config.outputRequirement}` : "",
  ].filter(Boolean);
  if (!additions.length) return prompt;
  return `${prompt}\n\n额外 Skill 配置：\n${additions.join("\n")}`;
}

export async function runRequirementStructuringSkill({ llm, userText, topicLabel, modelTimeoutMs, skillConfig, logger }) {
  const fallback = {
    ...inferRequirementWorkflow(userText, topicLabel, null),
    status: "fallback",
    provider: "local-heuristic",
    confidence: 62,
    riskNotes: [],
    summary: "已使用本地规则完成需求结构化。",
  };
  const config = normalizeWorkflowSkillConfig(skillConfig, modelTimeoutMs);
  if (!config.enabled) {
    return { ...fallback, status: "disabled", warning: "requirement_skill_disabled" };
  }
  try {
    const result = await callModelJson(
      llm,
      applySkillPromptConfig(buildRequirementStructuringPrompt(userText, topicLabel), config),
      config.timeoutMs,
      {
        logger,
        workflow: "小红书发布包",
        step: 2,
        totalSteps: 7,
        purpose: "需求结构化 Skill：提取主题、人群、目标、约束和缺失信息",
      },
    );
    return normalizeRequirementSkill(result, fallback);
  } catch (error) {
    logger?.("WARN", "Requirement structuring skill failed; fallback used", { error: String(error) });
    if (!config.fallbackOnError) throw error;
    return {
      ...fallback,
      warning: `requirement_skill_failed:${String(error)}`,
    };
  }
}

function inferContentStrategyWorkflow(userText, draft, businessFlow) {
  const normalized = `${userText || ""}\n${draft?.title || ""}\n${draft?.post_text || ""}`;
  let type = "经验分享";
  if (/避坑|踩坑|不要|误区|失败/u.test(normalized)) type = "避坑提醒";
  else if (/教程|步骤|流程|怎么|如何/u.test(normalized)) type = "流程教程";
  else if (/对比|测评|区别|选择/u.test(normalized)) type = "对比测评";
  else if (/热点|趋势|行业|观察/u.test(normalized)) type = "热点解读";
  else if (/清单|合集|盘点/u.test(normalized)) type = "清单合集";
  const riskNotes = [
    ...(businessFlow?.ruleValidation?.issues || []),
    ...(businessFlow?.qualityReview?.issues || []),
  ].map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6);
  return {
    type,
    reason: `根据输入关键词、标题和正文结构，当前更适合用「${type}」方式表达。`,
    structure: Array.isArray(draft?.body_sections) && draft.body_sections.length
      ? draft.body_sections.map((section) => String(section?.heading || "").trim()).filter(Boolean)
      : ["开场场景", "核心问题", "解决方法", "经验提醒"],
    imageStrategy: String(draft?.visual_direction || draft?.cover_style || "").trim(),
    riskNotes,
  };
}

function buildContentStrategyPrompt({ userText, topicLabel, requirement, intelItems, hermesResearch, draft = null }) {
  return [
    "你是小龙虾内容工作流里的「内容策略判断 Skill」。",
    "你的职责不是写完整正文，而是为小红书发布包选择最合适的内容策略。",
    "只输出严格 JSON，不要 Markdown，不要解释。",
    'Schema: {"type":"string","reason":"string","titleDirection":"string","structure":["string"],"openingStyle":"string","imageStrategy":"string","sellingPointMethod":"string","riskNotes":["string"],"mustUse":["string"],"mustAvoid":["string"],"confidence":number}',
    "可选 type 示例：经验分享、避坑提醒、问题解决、流程教程、热点解读、对比测评、清单合集、真实案例。",
    "判断标准：小红书平台适配、用户真实感、收藏价值、业务表达克制、图片可执行性。",
    `Topic label: ${topicLabel}`,
    `Requirement: ${JSON.stringify(requirement)}`,
    `Reference intel items: ${JSON.stringify((intelItems || []).slice(0, 5))}`,
    `Hermes research: ${JSON.stringify(hermesResearch || null)}`,
    draft ? `Existing draft for correction: ${JSON.stringify({ title: draft.title, subtitle: draft.subtitle, hook: draft.hook, sections: draft.body_sections })}` : "Existing draft: not generated yet",
    `Original request: ${userText}`,
  ].join("\n");
}

function normalizeStrategySkill(result, fallback) {
  const source = result && typeof result === "object" ? result : {};
  const confidence = Number(source.confidence);
  return {
    ...fallback,
    status: source.status || "completed",
    provider: source.provider || "llm-skill",
    type: String(source.type || fallback.type || "经验分享").trim(),
    reason: String(source.reason || fallback.reason || "").trim(),
    titleDirection: String(source.titleDirection || fallback.titleDirection || "").trim(),
    structure: normalizeList(source.structure || fallback.structure, 8),
    openingStyle: String(source.openingStyle || fallback.openingStyle || "").trim(),
    imageStrategy: String(source.imageStrategy || fallback.imageStrategy || "").trim(),
    sellingPointMethod: String(source.sellingPointMethod || fallback.sellingPointMethod || "").trim(),
    riskNotes: normalizeList(source.riskNotes || fallback.riskNotes, 8),
    mustUse: normalizeList(source.mustUse || fallback.mustUse, 8),
    mustAvoid: normalizeList(source.mustAvoid || fallback.mustAvoid, 8),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : fallback.confidence ?? 65,
  };
}

export async function runContentStrategySkill({ llm, userText, topicLabel, requirement, intelItems, hermesResearch, draft = null, businessFlow = null, modelTimeoutMs, skillConfig, logger }) {
  const fallback = {
    ...inferContentStrategyWorkflow(userText, draft, businessFlow),
    status: "fallback",
    provider: "local-heuristic",
    titleDirection: "",
    openingStyle: "",
    sellingPointMethod: "自然融入，不做硬广。",
    mustUse: [],
    mustAvoid: [],
    confidence: 62,
  };
  const config = normalizeWorkflowSkillConfig(skillConfig, modelTimeoutMs);
  if (!config.enabled) {
    return { ...fallback, status: "disabled", warning: "strategy_skill_disabled" };
  }
  try {
    const result = await callModelJson(
      llm,
      applySkillPromptConfig(buildContentStrategyPrompt({ userText, topicLabel, requirement, intelItems, hermesResearch, draft }), config),
      config.timeoutMs,
      {
        logger,
        workflow: "小红书发布包",
        step: 3,
        totalSteps: 7,
        purpose: "内容策略判断 Skill：选择内容类型、结构、图片策略和风险约束",
      },
    );
    return normalizeStrategySkill(result, fallback);
  } catch (error) {
    logger?.("WARN", "Content strategy skill failed; fallback used", { error: String(error) });
    if (!config.fallbackOnError) throw error;
    return {
      ...fallback,
      warning: `strategy_skill_failed:${String(error)}`,
    };
  }
}

function buildContentPlanWorkflow(draft) {
  const imagePlan = Array.isArray(draft?.image_plan) ? draft.image_plan : [];
  return {
    angle: String(draft?.subtitle || draft?.hook || "").trim(),
    opening: String(draft?.hook || "").trim(),
    bodyStructure: Array.isArray(draft?.body_sections)
      ? draft.body_sections.map((section) => ({
          title: String(section?.heading || "").trim(),
          summary: String(section?.content || "").trim().slice(0, 90),
        })).filter((section) => section.title || section.summary)
      : [],
    coverDirection: String(draft?.cover_text || draft?.cover_style || "").trim(),
    imagePlan: imagePlan.map((item, index) => ({
      label: String(item?.position || (index === 0 ? "封面图" : `正文图 ${index}`)).trim(),
      purpose: String(item?.purpose || "").trim(),
      prompt: String(item?.prompt || "").trim(),
    })).filter((item) => item.label || item.prompt),
  };
}

function buildContentPlanPrompt({ userText, topicLabel, requirement, strategy, intelItems, hermesResearch }) {
  return [
    "你是小龙虾内容工作流里的「内容方案 Skill」。",
    "你的职责不是写完整正文，而是在发布包生成前设计清晰、可执行的内容方案。",
    "只输出严格 JSON，不要 Markdown，不要解释。",
    'Schema: {"angle":"string","titleDirections":["string"],"opening":"string","bodyOutline":[{"title":"string","purpose":"string","keyPoints":["string"]}],"sceneDesign":"string","sellingPointPlacement":"string","imagePlan":[{"label":"string","purpose":"string","visualFocus":"string","promptDirection":"string"}],"hashtagDirection":["string"],"riskNotes":["string"],"confirmRequired":["string"],"confidence":number}',
    "方案要求：",
    "- angle 要明确这篇内容的独特切入点。",
    "- bodyOutline 是正文大纲，不要写完整正文。",
    "- sceneDesign 要让内容像真实经验，而不是空泛总结。",
    "- sellingPointPlacement 要说明业务/产品如何自然出现，如果没有产品就写“无需植入”。",
    "- imagePlan 要和小红书图文发布包匹配，至少包含封面图和正文图方向。",
    "- confirmRequired 只列需要人工确认的关键问题。",
    `Topic label: ${topicLabel}`,
    `Requirement: ${JSON.stringify(requirement)}`,
    `Strategy: ${JSON.stringify(strategy)}`,
    `Reference intel items: ${JSON.stringify((intelItems || []).slice(0, 5))}`,
    `Hermes research: ${JSON.stringify(hermesResearch || null)}`,
    `Original request: ${userText}`,
  ].join("\n");
}

function normalizeContentPlanSkill(result, fallback) {
  const source = result && typeof result === "object" ? result : {};
  const confidence = Number(source.confidence);
  const bodyOutline = Array.isArray(source.bodyOutline)
    ? source.bodyOutline.map((item) => ({
        title: String(item?.title || "").trim(),
        purpose: String(item?.purpose || "").trim(),
        keyPoints: normalizeList(item?.keyPoints, 6),
      })).filter((item) => item.title || item.purpose || item.keyPoints.length)
    : fallback.bodyOutline || [];
  const imagePlan = Array.isArray(source.imagePlan)
    ? source.imagePlan.map((item) => ({
        label: String(item?.label || "").trim(),
        purpose: String(item?.purpose || "").trim(),
        visualFocus: String(item?.visualFocus || "").trim(),
        promptDirection: String(item?.promptDirection || "").trim(),
      })).filter((item) => item.label || item.purpose || item.promptDirection)
    : fallback.imagePlan || [];
  return {
    ...fallback,
    status: source.status || "completed",
    provider: source.provider || "llm-skill",
    angle: String(source.angle || fallback.angle || "").trim(),
    titleDirections: normalizeList(source.titleDirections || fallback.titleDirections, 6),
    opening: String(source.opening || fallback.opening || "").trim(),
    bodyOutline,
    sceneDesign: String(source.sceneDesign || fallback.sceneDesign || "").trim(),
    sellingPointPlacement: String(source.sellingPointPlacement || fallback.sellingPointPlacement || "").trim(),
    imagePlan,
    hashtagDirection: normalizeList(source.hashtagDirection || fallback.hashtagDirection, 8),
    riskNotes: normalizeList(source.riskNotes || fallback.riskNotes, 8),
    confirmRequired: normalizeList(source.confirmRequired || fallback.confirmRequired, 8),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : fallback.confidence ?? 65,
  };
}

function fallbackContentPlanFromStrategy(requirement, strategy, intelItems) {
  const structure = normalizeList(strategy?.structure, 6);
  return {
    status: "fallback",
    provider: "local-heuristic",
    angle: String(strategy?.titleDirection || requirement?.topic || "").trim(),
    titleDirections: [strategy?.titleDirection, `${strategy?.type || "经验分享"}：${requirement?.topic || "当前主题"}`].filter(Boolean),
    opening: String(strategy?.openingStyle || "从一个具体使用场景切入。").trim(),
    bodyOutline: (structure.length ? structure : ["真实场景", "核心问题", "解决方法", "经验提醒"]).map((title) => ({
      title,
      purpose: "承接内容策略，形成可写作段落。",
      keyPoints: [],
    })),
    sceneDesign: "使用一个用户真实遇到的问题作为开场，避免空泛总结。",
    sellingPointPlacement: strategy?.sellingPointMethod || "自然融入，不做硬广。",
    imagePlan: [
      { label: "封面图", purpose: "承接标题和点击理由", visualFocus: strategy?.imageStrategy || "", promptDirection: strategy?.imageStrategy || "清晰、有主题感的小红书封面" },
      { label: "正文图1", purpose: "解释核心问题或步骤", visualFocus: "信息清晰", promptDirection: "流程卡片或场景图" },
    ],
    hashtagDirection: [],
    riskNotes: normalizeList(strategy?.riskNotes, 8),
    confirmRequired: normalizeList(requirement?.missingFields, 8),
    confidence: 62,
    sourceTitles: (intelItems || []).map((item) => item?.title).filter(Boolean).slice(0, 3),
  };
}

export async function runContentPlanSkill({ llm, userText, topicLabel, requirement, strategy, intelItems, hermesResearch, modelTimeoutMs, skillConfig, logger }) {
  const fallback = fallbackContentPlanFromStrategy(requirement, strategy, intelItems);
  const config = normalizeWorkflowSkillConfig(skillConfig, modelTimeoutMs);
  if (!config.enabled) {
    return { ...fallback, status: "disabled", warning: "content_plan_skill_disabled" };
  }
  try {
    const result = await callModelJson(
      llm,
      applySkillPromptConfig(buildContentPlanPrompt({ userText, topicLabel, requirement, strategy, intelItems, hermesResearch }), config),
      config.timeoutMs,
      {
        logger,
        workflow: "小红书发布包",
        step: 4,
        totalSteps: 7,
        purpose: "内容方案 Skill：设计角度、正文大纲、场景、图片规划和人工确认项",
      },
    );
    return normalizeContentPlanSkill(result, fallback);
  } catch (error) {
    logger?.("WARN", "Content plan skill failed; fallback used", { error: String(error) });
    if (!config.fallbackOnError) throw error;
    return {
      ...fallback,
      warning: `content_plan_skill_failed:${String(error)}`,
    };
  }
}

function buildDeliveryGatePrompt({ userText, topicLabel, requirement, strategy, contentPlan, draft, selectedIntelItems, humanEditorReview, qualityReview }) {
  const draftSnapshot = {
    title: draft?.title || "",
    subtitle: draft?.subtitle || "",
    coverText: draft?.cover_text || "",
    hook: draft?.hook || "",
    postText: draft?.post_text || "",
    bodySections: Array.isArray(draft?.body_sections) ? draft.body_sections : [],
    visualDirection: draft?.visual_direction || draft?.cover_style || "",
    imageShotList: normalizeList(draft?.image_shot_list, 12),
    imagePlan: Array.isArray(draft?.image_plan) ? draft.image_plan : [],
    hashtags: normalizeList(draft?.hashtags, 12),
    publishChecklist: normalizeList(draft?.publish_checklist, 12),
  };
  return [
    "你是小龙虾内容工作流里的「交付门禁 Skill」。",
    "你的职责不是继续改写正文，而是在发布包保存前做交付判断：是否可交付、是否必须人工复核、哪些问题必须修。",
    "只输出严格 JSON，不要 Markdown，不要解释。",
    'Schema: {"decision":"ready|review|blocked","deliverable":boolean,"reviewRequired":boolean,"score":number,"summary":"string","humanLike":number,"platformFit":number,"structureComplete":number,"imageMatch":number,"marketingRestraint":number,"riskExpression":number,"mustFix":["string"],"optionalFix":["string"],"riskNotes":["string"],"operatorNotes":["string"],"confidence":number}',
    "判断要求：",
    "- ready 表示可进入人工发布或交付给运营；review 表示内容基本可用但需要人工复核；blocked 表示存在明显缺失或风险，不建议交付。",
    "- score 和各维度分数使用 0-100。",
    "- mustFix 只放真正影响交付的问题，最多 5 条。",
    "- optionalFix 放可以优化但不阻断交付的问题，最多 5 条。",
    "- riskNotes 关注事实、营销夸张、平台敏感表达、图片正文不匹配、素材缺失。",
    "- operatorNotes 写给本地后台使用者，说明下一步怎么处理。",
    `Topic label: ${topicLabel}`,
    `Requirement skill: ${JSON.stringify(requirement || null)}`,
    `Strategy skill: ${JSON.stringify(strategy || null)}`,
    `Content plan skill: ${JSON.stringify(contentPlan || null)}`,
    `Final draft: ${JSON.stringify(draftSnapshot)}`,
    `Human editor review: ${JSON.stringify(humanEditorReview || null)}`,
    `Quality review: ${JSON.stringify(qualityReview || null)}`,
    `Selected intel: ${JSON.stringify((selectedIntelItems || []).slice(0, 5).map((item) => ({
      title: item?.title || "",
      summary: item?.summary || item?.description || "",
      url: item?.url || item?.sourceUrl || "",
    })))}`,
    `Original request: ${userText}`,
  ].join("\n");
}

function fallbackDeliveryGateFromReviews({ qualityReview, humanEditorReview, strategy, contentPlan }) {
  const qualityScore = Number(qualityReview?.score);
  const humanTraceScore = Number(humanEditorReview?.human_trace_score);
  const aiFlavorScore = Number(humanEditorReview?.ai_flavor_score);
  const riskNotes = normalizeList([
    ...(qualityReview?.issues || []),
    ...(strategy?.riskNotes || []),
    ...(contentPlan?.riskNotes || []),
  ], 8);
  const mustFix = normalizeList([
    ...(qualityReview?.passed === false ? (qualityReview?.issues || []) : []),
    ...(contentPlan?.confirmRequired || []),
  ], 5);
  const score = Number.isFinite(qualityScore)
    ? qualityScore
    : Math.round([
        Number.isFinite(humanTraceScore) ? humanTraceScore : 70,
        Number.isFinite(aiFlavorScore) ? 100 - aiFlavorScore : 70,
      ].reduce((sum, item) => sum + item, 0) / 2);
  const reviewRequired = qualityReview?.passed === false || mustFix.length > 0 || score < 75;
  const decision = score < 60 || mustFix.length >= 3 ? "blocked" : reviewRequired ? "review" : "ready";
  return {
    status: "fallback",
    provider: "local-heuristic",
    decision,
    deliverable: decision !== "blocked",
    reviewRequired,
    passed: decision === "ready",
    score,
    summary: decision === "ready" ? "内容已通过基础门禁，可进入交付。" : decision === "review" ? "内容基本可用，但建议人工复核后交付。" : "内容存在关键问题，暂不建议交付。",
    humanLike: Number.isFinite(humanTraceScore) ? humanTraceScore : null,
    platformFit: score,
    structureComplete: score,
    imageMatch: contentPlan?.imagePlan?.length ? 78 : 62,
    marketingRestraint: Number.isFinite(aiFlavorScore) ? Math.max(0, 100 - aiFlavorScore) : 70,
    riskExpression: riskNotes.length ? Math.max(45, 85 - riskNotes.length * 8) : 85,
    humanTraceScore: Number.isFinite(humanTraceScore) ? humanTraceScore : null,
    aiFlavorScore: Number.isFinite(aiFlavorScore) ? aiFlavorScore : null,
    mustFix,
    optionalFix: normalizeList(qualityReview?.suggestions || qualityReview?.improvements || [], 5),
    riskNotes,
    operatorNotes: reviewRequired ? ["先处理必须修改项，再查看发布包详情确认正文和配图提示词。"] : ["可查看发布包详情，按正文和图片结构进入人工发布。"],
    issues: riskNotes,
    confidence: 62,
  };
}

function normalizeDeliveryGateSkill(result, fallback) {
  const source = result && typeof result === "object" ? result : {};
  const numberOrFallback = (value, fallbackValue = null) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : fallbackValue;
  };
  const decisionRaw = String(source.decision || fallback.decision || "review").trim().toLowerCase();
  const decision = ["ready", "review", "blocked"].includes(decisionRaw) ? decisionRaw : "review";
  const mustFix = normalizeList(source.mustFix || fallback.mustFix, 5);
  const riskNotes = normalizeList(source.riskNotes || fallback.riskNotes || source.issues || fallback.issues, 8);
  const reviewRequired = typeof source.reviewRequired === "boolean"
    ? source.reviewRequired
    : decision !== "ready" || mustFix.length > 0;
  const deliverable = typeof source.deliverable === "boolean"
    ? source.deliverable
    : decision !== "blocked";
  return {
    ...fallback,
    status: source.status || "completed",
    provider: source.provider || "llm-skill",
    decision,
    deliverable,
    reviewRequired,
    passed: decision === "ready" && deliverable && !reviewRequired,
    score: numberOrFallback(source.score, fallback.score),
    summary: String(source.summary || fallback.summary || "").trim(),
    humanLike: numberOrFallback(source.humanLike, fallback.humanLike),
    platformFit: numberOrFallback(source.platformFit, fallback.platformFit),
    structureComplete: numberOrFallback(source.structureComplete, fallback.structureComplete),
    imageMatch: numberOrFallback(source.imageMatch, fallback.imageMatch),
    marketingRestraint: numberOrFallback(source.marketingRestraint, fallback.marketingRestraint),
    riskExpression: numberOrFallback(source.riskExpression, fallback.riskExpression),
    humanTraceScore: numberOrFallback(source.humanTraceScore, fallback.humanTraceScore),
    aiFlavorScore: numberOrFallback(source.aiFlavorScore, fallback.aiFlavorScore),
    mustFix,
    optionalFix: normalizeList(source.optionalFix || fallback.optionalFix, 5),
    riskNotes,
    operatorNotes: normalizeList(source.operatorNotes || fallback.operatorNotes, 5),
    issues: riskNotes,
    confidence: numberOrFallback(source.confidence, fallback.confidence ?? 65),
  };
}

async function runDeliveryGateSkill({ llm, userText, topicLabel, requirement, strategy, contentPlan, draft, selectedIntelItems, humanEditorReview, qualityReview, modelTimeoutMs, skillConfig, logger }) {
  const fallback = fallbackDeliveryGateFromReviews({ qualityReview, humanEditorReview, strategy, contentPlan });
  const config = normalizeWorkflowSkillConfig(skillConfig, modelTimeoutMs);
  if (!config.enabled) {
    return { ...fallback, status: "disabled", warning: "delivery_gate_skill_disabled" };
  }
  try {
    const result = await callModelJson(
      llm,
      applySkillPromptConfig(buildDeliveryGatePrompt({ userText, topicLabel, requirement, strategy, contentPlan, draft, selectedIntelItems, humanEditorReview, qualityReview }), config),
      config.timeoutMs,
      {
        logger,
        workflow: "小红书发布包",
        step: 6,
        totalSteps: 7,
        purpose: "交付门禁 Skill：判断发布包是否可交付、是否需要人工复核以及必须修改项。",
      },
    );
    return normalizeDeliveryGateSkill(result, fallback);
  } catch (error) {
    logger?.("WARN", "Delivery gate skill failed; fallback used", { error: String(error) });
    if (!config.fallbackOnError) throw error;
    return {
      ...fallback,
      warning: `delivery_gate_skill_failed:${String(error)}`,
    };
  }
}

function normalizePlanForWorkflow(planSkill, draft) {
  if (!planSkill) return buildContentPlanWorkflow(draft);
  return {
    ...buildContentPlanWorkflow(draft),
    ...planSkill,
  };
}

function buildPublishPackageWorkflow({ userText, topicLabel, draft, selectedIntelItems, businessFlow, requirementSkill = null, strategySkill = null, contentPlanSkill = null, deliveryGateSkill = null }) {
  const requirement = requirementSkill || inferRequirementWorkflow(userText, topicLabel, draft);
  const strategy = strategySkill || inferContentStrategyWorkflow(userText, draft, businessFlow);
  const contentPlan = normalizePlanForWorkflow(contentPlanSkill, draft);
  const qualityGate = deliveryGateSkill || fallbackDeliveryGateFromReviews({
    qualityReview: businessFlow?.qualityReview,
    humanEditorReview: businessFlow?.humanEditorReview,
    strategy,
    contentPlan,
  });
  return {
    version: "publish-package-workflow-v1",
    name: "小红书发布包生成",
    requirement,
    strategy,
    knowledgeContext: {
      sourceCount: Array.isArray(selectedIntelItems) ? selectedIntelItems.length : 0,
      sourceTitles: (Array.isArray(selectedIntelItems) ? selectedIntelItems : [])
        .map((item) => String(item?.title || "").trim())
        .filter(Boolean)
        .slice(0, 5),
    },
    contentPlan,
    qualityGate,
    finalArtifact: {
      title: String(draft?.title || "").trim(),
      coverText: String(draft?.cover_text || "").trim(),
      imageCount: contentPlan.imagePlan.length,
      hashtagCount: Array.isArray(draft?.hashtags) ? draft.hashtags.length : 0,
    },
  };
}

function saveDraftFilesV2(draft, intelItems, imageResult = null, artifactPaths = null, businessFlow = null, workflow = null) {
  const paths = artifactPaths || createDraftArtifactPaths(draft);
  const publishSegments = buildPublishSegments(draft, imageResult);
  const payload = {
    generatedAt: new Date().toISOString(),
    packageType: "xiaohongshu-publish-package",
    draft,
    sourceItems: intelItems,
    businessFlow,
    workflow,
    images: imageResult,
    publishSegments,
  };
  fs.writeFileSync(paths.jsonPath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(paths.mdPath, buildMarkdownPackageV2(draft, intelItems, imageResult), "utf8");
  fs.writeFileSync(paths.titlePath, String(draft?.title || "").trim(), "utf8");
  fs.writeFileSync(paths.bodyPath, String(draft?.post_text || "").trim(), "utf8");
  fs.writeFileSync(paths.hashtagsPath, buildHashtagsText(draft), "utf8");
  fs.writeFileSync(paths.coverTextPath, String(draft?.cover_text || "").trim(), "utf8");
  fs.writeFileSync(paths.copyAllPath, buildCopyAllText(draft), "utf8");
  fs.writeFileSync(paths.imageIndexPath, buildImageIndexText(draft, imageResult), "utf8");
  fs.writeFileSync(paths.finalPostPath, String(draft?.post_text || "").trim(), "utf8");
  fs.writeFileSync(paths.manualGuidePath, buildManualPublishGuideV2(draft, paths, imageResult), "utf8");
  fs.writeFileSync(paths.workflowDocumentPath, buildWorkflowDocumentMarkdown(draft, intelItems, imageResult, businessFlow), "utf8");
  if (businessFlow?.hermesResearch) {
    fs.writeFileSync(paths.hermesResearchPath, buildHermesResearchText(businessFlow.hermesResearch), "utf8");
  }
  if (businessFlow?.opportunityScore) {
    fs.writeFileSync(paths.opportunityScorePath, buildOpportunityScoreText(businessFlow.opportunityScore, intelItems), "utf8");
  }
  if (businessFlow?.humanEditorReview) {
    fs.writeFileSync(paths.humanEditorReviewPath, buildHumanEditorReviewText(businessFlow.humanEditorReview), "utf8");
  }
  if (businessFlow?.qualityReview) {
    fs.writeFileSync(paths.qualityReviewPath, buildQualityReviewText(businessFlow.qualityReview), "utf8");
  }
  return {
    baseName: paths.baseName,
    packageDir: paths.packageDir,
    jsonPath: paths.jsonPath,
    mdPath: paths.mdPath,
    titlePath: paths.titlePath,
    bodyPath: paths.bodyPath,
    hashtagsPath: paths.hashtagsPath,
    coverTextPath: paths.coverTextPath,
    copyAllPath: paths.copyAllPath,
    imageIndexPath: paths.imageIndexPath,
    finalPostPath: paths.finalPostPath,
    manualGuidePath: paths.manualGuidePath,
    workflowDocumentPath: paths.workflowDocumentPath,
    hermesResearchPath: paths.hermesResearchPath,
    opportunityScorePath: paths.opportunityScorePath,
    humanEditorReviewPath: paths.humanEditorReviewPath,
    qualityReviewPath: paths.qualityReviewPath,
    imageDir: paths.imageDir,
  };
}

function patchSavedPackageJson(jsonPath, patch) {
  if (!jsonPath || !fs.existsSync(jsonPath)) return false;
  const current = readJson(jsonPath, null);
  if (!current || typeof current !== "object") return false;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(next, null, 2), "utf8");
  return true;
}

function buildWorkflowDocumentMarkdown(draft, intelItems, imageResult = null, businessFlow = null) {
  const lines = [
    `# 生成与重写流程：${draft?.title || "小红书发布包"}`,
    "",
    "## 最终发布正文",
    String(draft?.post_text || "").trim() || "未生成正文",
    "",
    "## 配图与生图提示词",
    imageResult?.status === "generated"
      ? `图片状态：已生成 ${imageResult.files?.length || 0} 张`
      : imageResult?.status === "failed"
        ? `图片状态：生成失败，已保留提示词。错误：${imageResult.error || "未知"}`
        : "图片状态：未生图，仅保留配图建议和提示词",
    "",
  ];
  if (draft?.cover_image_prompt) {
    lines.push("### 封面图提示词", String(draft.cover_image_prompt).trim(), "");
  }
  normalizeImagePlan(draft?.image_plan, 10).forEach((item, index) => {
    lines.push(
      `### 配图 ${index + 1}`,
      item.position ? `位置：${item.position}` : "",
      item.purpose ? `作用：${item.purpose}` : "",
      item.visual_focus ? `视觉重点：${item.visual_focus}` : "",
      item.prompt ? `提示词：${item.prompt}` : "",
      "",
    );
  });
  if (businessFlow?.opportunityScore) {
    if (businessFlow?.hermesResearch) {
      lines.push("## Hermes 研究卡片", buildHermesResearchText(businessFlow.hermesResearch), "");
    }
    lines.push("## 选题评分", buildOpportunityScoreText(businessFlow.opportunityScore, intelItems), "");
  }
  if (businessFlow?.businessRuleRepair?.applied) {
    lines.push("## 业务硬规则修正");
    normalizeList(businessFlow.businessRuleRepair.fixes, 12).forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  if (businessFlow?.humanEditorReview) {
    lines.push("## 去 AI 味质检与重写", buildHumanEditorReviewText(businessFlow.humanEditorReview), "");
  }
  if (businessFlow?.qualityReview) {
    lines.push("## 内容质检", buildQualityReviewText(businessFlow.qualityReview), "");
  }
  return lines.filter((line) => line !== null && line !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");
}

function buildBusinessFlowNotionBlocks(businessFlow) {
  if (!businessFlow || typeof businessFlow !== "object") return [];
  const blocks = [headingBlock("生成与重写流程")];
  const hermesResearch = businessFlow.hermesResearch || null;
  const opportunity = businessFlow.opportunityScore || null;
  const humanReview = businessFlow.humanEditorReview || null;
  const qualityReview = businessFlow.qualityReview || null;
  if (hermesResearch && hermesResearch.status !== "disabled") {
    blocks.push(headingBlock("0. Hermes 研究卡片", 3));
    if (hermesResearch.recommended_angle) blocks.push(bulletedBlock(`推荐角度：${hermesResearch.recommended_angle}`));
    normalizeList(hermesResearch.real_materials, 6).forEach((item) => blocks.push(bulletedBlock(`真实素材：${item}`)));
    normalizeList(hermesResearch.reference_structure, 6).forEach((item) => blocks.push(bulletedBlock(`参考结构：${item}`)));
    normalizeList(hermesResearch.avoid, 6).forEach((item) => blocks.push(bulletedBlock(`避坑：${item}`)));
  }
  if (opportunity) {
    blocks.push(headingBlock("1. 选题判断", 3));
    if (opportunity.summary) blocks.push(paragraphBlock(String(opportunity.summary)));
    if (opportunity.selected_reason) blocks.push(bulletedBlock(`选中原因：${opportunity.selected_reason}`));
    if (opportunity.content_angle) blocks.push(bulletedBlock(`内容角度：${opportunity.content_angle}`));
  }
  if (businessFlow.businessRuleRepair?.applied) {
    blocks.push(headingBlock("2. 业务硬规则修正", 3));
    normalizeList(businessFlow.businessRuleRepair.fixes, 8).forEach((item) => {
      blocks.push(bulletedBlock(item));
    });
  }
  if (humanReview) {
    blocks.push(headingBlock("3. 去 AI 味质检与重写", 3));
    blocks.push(
      bulletedBlock(
        `真人感：${humanReview.human_trace_score ?? "-"} / AI味：${humanReview.ai_flavor_score ?? "-"} / 是否重写：${humanReview.rewrite_applied ? "是" : "否"}`,
      ),
    );
    if (humanReview.verdict) blocks.push(bulletedBlock(`结论：${humanReview.verdict}`));
    normalizeList(humanReview.ai_flavor_signals, 8).forEach((item) => blocks.push(bulletedBlock(`AI味问题：${item}`)));
    normalizeList(humanReview.rewrite_actions, 8).forEach((item) => blocks.push(bulletedBlock(`重写动作：${item}`)));
  }
  if (qualityReview) {
    blocks.push(headingBlock("4. 发布质检", 3));
    blocks.push(
      bulletedBlock(
        `综合分：${qualityReview.score ?? "-"} / 可发布：${qualityReview.passed ? "是" : "否"}`,
      ),
    );
    if (qualityReview.publish_readiness) blocks.push(bulletedBlock(`发布判断：${qualityReview.publish_readiness}`));
    normalizeList(qualityReview.issues, 8).forEach((item) => blocks.push(bulletedBlock(`待优化：${item}`)));
  }
  return blocks;
}

function buildNotionBlocksV2(draft, sourceItems, imageResult = null, uploadedImages = new Map(), businessFlow = null) {
  const blocks = [];
  const publishSegments = buildPublishSegments(draft, imageResult);
  if (draft.cover_text) blocks.push(headingBlock(`封面文案：${draft.cover_text}`));
  if (draft.subtitle) blocks.push(paragraphBlock(`副标题：${draft.subtitle}`));
  if (draft.visual_direction) {
    blocks.push(headingBlock("视觉方向"));
    blocks.push(paragraphBlock(draft.visual_direction));
  }
  if (draft.post_text) {
    blocks.push(headingBlock("最终发布正文"));
    String(draft.post_text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => blocks.push(paragraphBlock(line)));
  }

  blocks.push(...buildBusinessFlowNotionBlocks(businessFlow));

  const imageShotList = normalizeList(draft.image_shot_list, 10);
  const imagePlan = normalizeImagePlan(draft.image_plan, 10);
  if (imageShotList.length) {
    blocks.push(headingBlock("配图清单"));
    imageShotList.forEach((item) => blocks.push(bulletedBlock(item)));
  }

  if (imagePlan.length) {
    blocks.push(headingBlock("配图建议（按发布顺序）"));
    imagePlan.forEach((item) => {
      const parts = [
        item.position ? `位置：${item.position}` : "",
        item.image_type ? `类型：${item.image_type}` : "",
        item.purpose ? `作用：${item.purpose}` : "",
        item.visual_focus ? `重点：${item.visual_focus}` : "",
        item.prompt ? `提示词：${item.prompt}` : "",
      ].filter(Boolean);
      blocks.push(bulletedBlock(parts.join("；")));
    });
  }

  if (draft.cover_image_prompt) {
    blocks.push(headingBlock("封面图提示词"));
    blocks.push(paragraphBlock(draft.cover_image_prompt));
  }

  const supportingPrompts = normalizeList(draft.supporting_image_prompts, 10);
  if (supportingPrompts.length) {
    blocks.push(headingBlock("正文配图提示词"));
    supportingPrompts.forEach((item) => blocks.push(bulletedBlock(item)));
  }

  if (imageResult?.files?.length) {
    blocks.push(headingBlock("已生成图片"));
    imageResult.files.forEach((item) => {
      const uploadInfo = uploadedImages.get(item.path);
      blocks.push(
        bulletedBlock(
          `${item.kind}: ${item.path}${uploadInfo?.id ? ` | Notion上传ID: ${uploadInfo.id}` : ""}`,
        ),
      );
    });
  } else if (imageResult?.status === "failed") {
    blocks.push(headingBlock("图片生成状态"));
    blocks.push(paragraphBlock(`生成失败：${imageResult.error || "未知错误"}`));
  }

  if (publishSegments.cover.file || publishSegments.sections.some((item) => item.imageFile || item.imagePlan)) {
    blocks.push(headingBlock("图文排版版"));

    if (publishSegments.cover.file?.path || publishSegments.cover.prompt) {
      blocks.push(headingBlock("封面图（已生成）", 3));
      const coverUpload = publishSegments.cover.file?.path
        ? uploadedImages.get(publishSegments.cover.file.path)
        : null;
      const coverImageBlock = imageUploadBlock(
        coverUpload,
        publishSegments.cover.text || "封面图",
      );
      if (coverImageBlock) blocks.push(coverImageBlock);
      if (publishSegments.cover.file?.path) {
        blocks.push(paragraphBlock(`文件路径：${publishSegments.cover.file.path}`));
      }
      if (publishSegments.cover.text) {
        blocks.push(paragraphBlock(`封面文案：${publishSegments.cover.text}`));
      }
      if (publishSegments.cover.style) {
        blocks.push(paragraphBlock(`封面风格：${publishSegments.cover.style}`));
      }
      if (publishSegments.cover.prompt) {
        blocks.push(paragraphBlock(`封面提示词：${publishSegments.cover.prompt}`));
      }
    }

    publishSegments.sections.forEach((section, index) => {
      blocks.push(headingBlock(section.heading || `正文段落 ${index + 1}`, 3));
      const supportUpload = section.imageFile?.path ? uploadedImages.get(section.imageFile.path) : null;
      const supportImageBlock = imageUploadBlock(
        supportUpload,
        section.imagePlan?.purpose || section.heading || `正文配图 ${index + 1}`,
      );
      if (supportImageBlock) blocks.push(supportImageBlock);
      if (section.imageFile?.path) {
        blocks.push(paragraphBlock(`正文配图 ${index + 1} 文件：${section.imageFile.path}`));
      }
      if (section.imagePlan?.position) {
        blocks.push(paragraphBlock(`建议插入位置：${section.imagePlan.position}`));
      }
      if (section.imagePlan?.image_type) {
        blocks.push(paragraphBlock(`图片类型：${section.imagePlan.image_type}`));
      }
      if (section.imagePlan?.purpose) {
        blocks.push(paragraphBlock(`图片作用：${section.imagePlan.purpose}`));
      }
      if (section.imagePlan?.visual_focus) {
        blocks.push(paragraphBlock(`视觉重点：${section.imagePlan.visual_focus}`));
      }
      if (section.imagePlan?.prompt) {
        blocks.push(paragraphBlock(`图片提示词：${section.imagePlan.prompt}`));
      }
      blocks.push(paragraphBlock(section.content));
    });
  }

  const publishChecklist = normalizeList(draft.publish_checklist, 10);
  if (publishChecklist.length) {
    blocks.push(headingBlock("发布检查清单"));
    publishChecklist.forEach((item) => blocks.push(bulletedBlock(item)));
  }

  const hashtags = normalizeList(draft.hashtags, 10);
  if (hashtags.length) {
    blocks.push(headingBlock("推荐话题"));
    blocks.push(paragraphBlock(hashtags.map((tag) => `#${tag}`).join(" ")));
  }

  if (draft.comment_seed) {
    blocks.push(headingBlock("首条评论建议"));
    blocks.push(paragraphBlock(draft.comment_seed));
  }

  if (draft.pin_comment) {
    blocks.push(headingBlock("置顶评论建议"));
    blocks.push(paragraphBlock(draft.pin_comment));
  }

  if (Array.isArray(sourceItems) && sourceItems.length) {
    blocks.push(headingBlock("参考素材"));
    sourceItems.forEach((item) => blocks.push(bulletedBlock(`${item.title}${item.link ? ` | ${item.link}` : ""}`)));
  }

  return blocks.slice(0, 100);
}

async function writePackageToNotionV2(draft, sourceItems, notionConfig, imageResult = null, businessFlow = null, logger = null) {
  const useContentPublish = notionDbIsConfigured(notionConfig.contentPublish);
  const targetConfig = useContentPublish ? notionConfig.contentPublish : notionConfig.aiIntel;
  let relationWarning = null;
  let sourceRelations = [];
  if (useContentPublish) {
    try {
      sourceRelations = await findIntelSourceRelations(sourceItems, notionConfig.aiIntel);
    } catch (error) {
      relationWarning = `source_relation_failed:${String(error)}`;
      logger?.("WARN", "Notion source relation lookup failed; continue without relation", {
        error: String(error),
      });
    }
  }

  const payload = useContentPublish
    ? buildContentPublishPayload(draft, notionConfig.contentPublish, sourceRelations)
    : buildAiIntelFallbackPayload(draft, notionConfig.aiIntel);

  const page = await notionFetchJson("https://api.notion.com/v1/pages", targetConfig.token, payload);
  const pageId = page.id;
  let uploadedImages = new Map();
  if (pageId) {
    try {
      uploadedImages = await uploadGeneratedImagesToNotion(imageResult, targetConfig.token);
    } catch (error) {
      throw new Error(`Notion image upload failed: ${String(error)}`);
    }
  }
  const blocks = buildNotionBlocksV2(draft, sourceItems, imageResult, uploadedImages, businessFlow);
  if (pageId && blocks.length) {
    try {
      await notionFetchJson(`https://api.notion.com/v1/blocks/${normalizeNotionId(pageId)}/children`, targetConfig.token, { children: blocks }, "PATCH");
    } catch (error) {
      const fallbackBlocks = buildNotionBlocksV2(draft, sourceItems, imageResult, new Map(), businessFlow);
      await notionFetchJson(`https://api.notion.com/v1/blocks/${normalizeNotionId(pageId)}/children`, targetConfig.token, { children: fallbackBlocks }, "PATCH");
      return {
        pageId: page.id || null,
        url: page.url || null,
        target: useContentPublish ? "content_publish" : "ai_intel",
        relationCount: sourceRelations.length,
        uploadedImageCount: 0,
        warning: [relationWarning, `image_blocks_failed:${String(error)}`].filter(Boolean).join(";"),
      };
    }
  }
  if (pageId && useContentPublish && sourceRelations.length) {
    try {
      await syncReverseIntelRelations(pageId, sourceRelations, notionConfig.aiIntel, notionConfig.contentPublish);
    } catch (error) {
      relationWarning = [relationWarning, `reverse_relation_failed:${String(error)}`].filter(Boolean).join(";");
      logger?.("WARN", "Notion reverse relation sync failed; content page already written", {
        pageId,
        error: String(error),
      });
    }
  }
  return {
    pageId: page.id || null,
    url: page.url || null,
    target: useContentPublish ? "content_publish" : "ai_intel",
    relationCount: sourceRelations.length,
    uploadedImageCount: uploadedImages.size,
    warning: relationWarning,
  };
}

export function buildIntelRequestV2(userText) {
  const normalized = String(userText || "").trim();
  const direction = extractXiaohongshuDirection(normalized);
  const theme = extractXiaohongshuTheme(normalized);
  if (theme) {
    if (theme === "焦虑疗愈") {
      return "帮我找今天适合做焦虑疗愈主题内容的3条信息";
    }
    if (theme === "睡前疗愈") {
      return "帮我找今天适合做睡前疗愈主题内容的3条信息";
    }
    if (theme === "情绪稳定") {
      return "帮我找今天适合做情绪稳定主题内容的3条信息";
    }
    if (theme === "职场情绪") {
      return "帮我找今天适合做职场情绪主题内容的3条信息";
    }
    if (theme === "亲密关系") {
      return "帮我找今天适合做亲密关系主题内容的3条信息";
    }
    return `帮我找今天适合做“${theme}”主题内容的3条信息`;
  }
  if (direction === "工具推荐") {
    return "帮我找今天最适合做AI工具推荐的3条信息";
  }
  if (direction === "AI工具基础设施") {
    return "帮我找今天适合做AI工具基础设施科普的3条信息，重点关注API、Token、Base URL、接口代理、中转、报错排查、成本优化、Dify、Cursor、Coze等新手痛点";
  }
  if (direction === "趋势观察") {
    return "帮我找今天最适合做AI趋势观察的3条信息";
  }
  if (direction === "经验分享") {
    return "帮我找今天最适合做经验分享的AI信息3条";
  }
  if (direction === "自媒体") {
    return "帮我找今天适合自媒体的AI信息3条";
  }
  if (/[\u884c\u4e1a\u8d5b\u9053\u8d8b\u52bf\u5e02\u573a\u54c1\u724c\u4f01\u4e1a]/u.test(normalized)) {
    return "\u5e2e\u6211\u627e\u4eca\u5929\u503c\u5f97\u5173\u6ce8\u7684\u884c\u4e1a\u60c5\u62a53\u6761";
  }
  if (/[\u81ea\u5a92\u4f53\u5185\u5bb9\u9009\u9898\u6587\u6848\u77ed\u89c6\u9891\u5c0f\u7ea2\u4e66\u6296\u97f3]/u.test(normalized)) {
    return "\u5e2e\u6211\u627e\u4eca\u5929\u9002\u5408\u81ea\u5a92\u4f53\u7684AI\u4fe1\u606f3\u6761";
  }
  return "\u5e2e\u6211\u627e\u4eca\u5929AI\u6700\u6709\u7528\u76843\u6761\u4fe1\u606f";
}

function extractXiaohongshuTheme(userText) {
  const normalized = String(userText || "").trim();
  if (!normalized) return "";
  const themeMap = [
    { pattern: /(\u7126\u8651\u7597\u6108|\u6cbb\u6108\u7126\u8651|\u7f13\u89e3\u7126\u8651)/u, value: "焦虑疗愈" },
    { pattern: /(\u7761\u524d\u7597\u6108|\u7761\u524d\u6cbb\u6108|\u7761\u524d\u653e\u677e)/u, value: "睡前疗愈" },
    { pattern: /(\u60c5\u7eea\u7a33\u5b9a|\u7a33\u5b9a\u60c5\u7eea|\u60c5\u7eea\u81ea\u6551)/u, value: "情绪稳定" },
    { pattern: /(\u804c\u573a\u60c5\u7eea|\u804c\u573a\u5185\u8017|\u804c\u573a\u7126\u8651|\u804c\u573a\u7597\u6108)/u, value: "职场情绪" },
    { pattern: /(\u4eb2\u5bc6\u5173\u7cfb|\u4e24\u6027\u5173\u7cfb|\u604b\u7231\u5173\u7cfb)/u, value: "亲密关系" },
    { pattern: /(\u7597\u6108|\u6cbb\u6108|\u81ea\u6211\u7597\u6108|\u60c5\u7eea\u7597\u6108)/u, value: "疗愈" },
    { pattern: /(\u60c5\u7eea|\u7126\u8651|\u5185\u8017|\u538b\u529b|\u5d29\u6e83|\u60c5\u7eea\u4ef7\u503c)/u, value: "情绪" },
    { pattern: /(\u6210\u957f|\u81ea\u6211\u6210\u957f|\u81ea\u6211\u63d0\u5347|\u4e2a\u4eba\u6210\u957f)/u, value: "成长" },
    { pattern: /(\u5173\u7cfb|\u4eb2\u5bc6\u5173\u7cfb|\u4eba\u9645\u5173\u7cfb|\u4e24\u6027|\u604b\u7231)/u, value: "关系" },
    { pattern: /(\u5973\u6027\u6210\u957f|\u5973\u751f\u6210\u957f|\u5973\u6027\u8bdd\u9898)/u, value: "女性成长" },
    { pattern: /(\u7761\u7720|\u7761\u524d|\u653e\u677e|\u677e\u5f1b\u611f)/u, value: "放松疗愈" },
  ];
  const matched = themeMap.find((item) => item.pattern.test(normalized));
  return matched?.value || "";
}

function extractXiaohongshuDirection(userText) {
  const normalized = String(userText || "").trim();
  if (!normalized) return "";
  if (/(token代理|token\s*代理|api代理|接口代理|中转接口|api中转|base\s*url|apikey|api key|模型接口|接口报错|429|401|timeout|超时|dify|cursor|coze)/i.test(normalized)) {
    return "AI工具基础设施";
  }
  if (/(\u5de5\u5177\u63a8\u8350|\u5de5\u5177\u76d8\u70b9|\u5de5\u5177\u6e05\u5355)/u.test(normalized)) return "工具推荐";
  if (/(\u8d8b\u52bf\u89c2\u5bdf|\u8d8b\u52bf|\u884c\u4e1a\u89c2\u5bdf|\u70ed\u70b9\u89e3\u8bfb)/u.test(normalized)) return "趋势观察";
  if (/(\u7ecf\u9a8c\u5206\u4eab|\u5e72\u8d27\u5206\u4eab|\u5b9e\u64cd\u5206\u4eab|\u65b9\u6cd5\u5206\u4eab)/u.test(normalized)) return "经验分享";
  if (/(\u81ea\u5a92\u4f53|\u9009\u9898|\u5185\u5bb9\u8fd0\u8425|\u5c0f\u7ea2\u4e66\u7206\u6b3e)/u.test(normalized)) return "自媒体";
  if (/(\u884c\u4e1a|\u8d5b\u9053|\u5e02\u573a|\u54c1\u724c|\u4f01\u4e1a)/u.test(normalized)) return "行业";
  return "";
}

export function inferTopicLabelV2(userText) {
  const normalized = String(userText || "").trim();
  const theme = extractXiaohongshuTheme(normalized);
  if (theme) return `主题内容：${theme}`;
  const direction = extractXiaohongshuDirection(normalized);
  if (direction === "AI工具基础设施") return "AI工具基础设施科普";
  if (direction === "工具推荐" || direction === "经验分享" || direction === "自媒体") return "\u5185\u5bb9\u8fd0\u8425";
  if (direction === "趋势观察" || direction === "行业") return "\u884c\u4e1a\u89c2\u5bdf";
  if (/[\u884c\u4e1a\u8d5b\u9053\u8d8b\u52bf\u5e02\u573a\u54c1\u724c\u4f01\u4e1a]/u.test(normalized)) return "\u884c\u4e1a\u89c2\u5bdf";
  if (/[\u81ea\u5a92\u4f53\u5185\u5bb9\u9009\u9898\u6587\u6848\u77ed\u89c6\u9891\u5c0f\u7ea2\u4e66\u6296\u97f3]/u.test(normalized)) return "\u5185\u5bb9\u8fd0\u8425";
  return "AI\u70ed\u70b9";
}

function classifyXiaohongshuDraftIntentV2(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return { mode: "none", normalizedText: "", reason: "empty" };

  const directPatterns = [
    /^\u5c0f\u7ea2\u4e66(?:\s+.+)?$/u,
    /\u5c0f\u7ea2\u4e66\s*(\u8349\u7a3f|\u5f85\u53d1\u5e03|\u53d1\u5e03\u7a3f|\u7b14\u8bb0|\u6587\u6848|\u6587\u7ae0|\u5185\u5bb9|\u56fe\u6587|\u53d1\u5e03\u5305)/u,
    /(\u505a\u6210|\u6574\u7406\u6210|\u6539\u6210).*(\u5c0f\u7ea2\u4e66)/u,
    /\u5e2e\u6211\u505a\s*\u5c0f\u7ea2\u4e66/u,
    /\u505a\s*\u5c0f\u7ea2\u4e66/u,
    /\u53d1\s*\u5c0f\u7ea2\u4e66/u,
    /\u51fa\s*\u5c0f\u7ea2\u4e66/u,
    /\u751f\u6210.*\u5c0f\u7ea2\u4e66/u,
    /\u5199.*\u5c0f\u7ea2\u4e66/u,
  ];

  if (directPatterns.some((pattern) => pattern.test(normalized))) {
    return { mode: "direct", normalizedText: normalized, reason: "direct_pattern" };
  }

  return { mode: "none", normalizedText: normalized, reason: "low_confidence" };
}

function applyWorkflowSkillConfigToInput(userText, workflowRuntimeConfig = {}) {
  const profile = String(workflowRuntimeConfig.skillProfile || "standard").trim();
  const notes = String(workflowRuntimeConfig.skillNotes || "").trim();
  const profileText = profile === "strict"
    ? "Skill 配置档：严格复核。优先保证真实感、结构完整、风险表达和图片可执行性。"
    : profile === "fast"
      ? "Skill 配置档：快速生成。优先减少犹豫，但不能省略交付门禁。"
      : "";
  const additions = [profileText, notes ? `Skill 备注：${notes}` : ""].filter(Boolean);
  if (!additions.length) return userText;
  return `${userText}\n\n工作流配置要求：\n${additions.join("\n")}`;
}

export async function maybeRunXiaohongshuDraftWorkflow({
  baseDir,
  llm,
  userText,
  logger,
  modelTimeoutMs = DEFAULT_TIMEOUT_MS,
  workflowRuntimeConfig = {},
}) {
  const precomputed = workflowRuntimeConfig?.precomputed || {};
  const intent = classifyXiaohongshuDraftIntentV2(userText);
  if (intent.mode !== "direct" && !precomputed.draft) return { handled: false };

  const topicLabel = precomputed.topicLabel || inferTopicLabelV2(userText);
  userText = applyWorkflowSkillConfigToInput(userText, workflowRuntimeConfig);
  const skillConfigs = workflowRuntimeConfig?.skills || {};
  const requirementSkill = precomputed.requirement || await runRequirementStructuringSkill({
    llm,
    userText,
    topicLabel,
    modelTimeoutMs,
    skillConfig: skillConfigs.requirement,
    logger,
  });
  const intelResult = precomputed.intelResult || await maybeRunAiIntelWorkflow({
    baseDir,
    llm,
    userText: buildIntelRequestV2(userText),
    logger,
    modelTimeoutMs,
    force: true,
    aiCallMeta: {
      workflow: "小红书发布包",
      step: 1,
      totalSteps: 6,
      purpose: "情报素材筛选：先找和选题相关的可用素材",
    },
  });

  const intelItems = Array.isArray(precomputed.intelItems)
    ? precomputed.intelItems
    : (Array.isArray(intelResult?.debug?.items) ? intelResult.debug.items : []);
  if (!intelItems.length) {
    return {
      handled: true,
      replyText: "这次没有整理出足够稳定的小红书素材，你再发一次我继续做。",
      debug: { stage: "intel_empty", intel: intelResult?.debug || null },
    };
  }

  const notionConfig = loadNotionConfig(baseDir);
  const humanEditorRules = normalizeHumanEditorRulesConfig(notionConfig);
  const imageMode = resolveImageMode(userText, notionConfig.imageGeneration);
  const effectiveImageConfig = {
    ...notionConfig.imageGeneration,
    enabled:
      notionConfig.imageGeneration?.autoGenerateInWorkflow !== false &&
      imageMode.shouldGenerate &&
      notionConfig.imageGeneration?.enabled === true,
  };

  const hermesBrain = await maybeRunHermesContentBrainV2({
    hermesConfig: notionConfig.hermes,
    llm,
    userText,
    topicLabel,
    intelItems,
    imageMode: imageMode.mode,
    humanEditorRules,
    modelTimeoutMs,
    logger,
  });

  let contentBrainMode = "stable-multi-step";
  let hermesResearch;
  let opportunityScore;
  let selectedIntelItems;
  let draft;
  let repairResult = { repaired: false, issues: [] };
  let humanEditorReview;
  let qualityReview;
  let strategySkill;
  let contentPlanSkill;
  let deliveryGateSkill;

  if (hermesBrain.status === "completed") {
    contentBrainMode = "hermes-content-brain";
    hermesResearch = hermesBrain.hermesResearch;
    opportunityScore = hermesBrain.opportunityScore;
    selectedIntelItems = hermesBrain.selectedIntelItems;
    draft = hermesBrain.draft;
    repairResult = repairAiToolInfrastructureDraft(draft, userText, topicLabel);
    draft = repairResult.draft;
    humanEditorReview = hermesBrain.humanEditorReview;
    humanEditorReview.rewrite_applied = humanEditorReview.rewrite_applied !== false;
    qualityReview = hermesBrain.qualityReview;
    strategySkill = null;
    contentPlanSkill = null;
  } else {
    const hermesMode = String(notionConfig.hermes?.mode || "").trim();
    if (hermesBrain.status === "failed" && ["content_brain", "content-brain", "brain"].includes(hermesMode)) {
      hermesResearch = normalizeHermesResearch({
        ...buildFallbackHermesResearch(userText, topicLabel, intelItems),
        status: "fallback",
        provider: "local-heuristic",
        warning: `hermes_content_brain_failed:${hermesBrain.error || "unknown"}`,
      });
    } else {
      hermesResearch = precomputed.hermesResearch || await maybeRunHermesResearch({
        hermesConfig: notionConfig.hermes,
        llm,
        userText,
        topicLabel,
        intelItems,
        modelTimeoutMs,
        logger,
      });
    }
    if (precomputed.hermesResearch) {
      hermesResearch = {
        ...hermesResearch,
        status: hermesResearch.status || "completed",
        provider: hermesResearch.provider || "precomputed-workflow-step",
      };
    }

  opportunityScore = precomputed.opportunityScore || await scoreContentOpportunities({
    llm,
    userText,
    topicLabel,
    intelItems,
    modelTimeoutMs,
    logger,
  });
    if (precomputed.opportunityScore) {
      opportunityScore = {
        ...opportunityScore,
        status: opportunityScore.status || "scored",
        provider: opportunityScore.provider || "precomputed-workflow-step",
      };
    }
    selectedIntelItems = precomputed.selectedIntelItems || selectScoredIntelItems(intelItems, opportunityScore);
    strategySkill = workflowRuntimeConfig?.precomputed?.strategy || await runContentStrategySkill({
      llm,
      userText,
      topicLabel,
      requirement: requirementSkill,
      intelItems: selectedIntelItems,
      hermesResearch,
      modelTimeoutMs,
      skillConfig: skillConfigs.strategy,
      logger,
    });
    if (workflowRuntimeConfig?.precomputed?.strategy) {
      strategySkill = {
        ...strategySkill,
        status: strategySkill.status || "completed",
        provider: strategySkill.provider || "precomputed-workflow-step",
      };
    }
    contentPlanSkill = precomputed.contentPlan || await runContentPlanSkill({
      llm,
      userText,
      topicLabel,
      requirement: requirementSkill,
      strategy: strategySkill,
      intelItems: selectedIntelItems,
      hermesResearch,
      modelTimeoutMs,
      skillConfig: skillConfigs.plan,
      logger,
    });
    if (precomputed.contentPlan) {
      contentPlanSkill = {
        ...contentPlanSkill,
        status: contentPlanSkill.status || "completed",
        provider: contentPlanSkill.provider || "precomputed-workflow-step",
      };
    }

    if (precomputed.draft) {
      draft = precomputed.draft;
      repairResult = precomputed.repairResult || repairAiToolInfrastructureDraft(draft, userText, topicLabel);
    } else {
      const draftGeneration = await runDraftGenerationSkill({
        llm,
        userText,
        topicLabel,
        intelItems: selectedIntelItems,
        hermesResearch,
        requirement: requirementSkill,
        strategy: strategySkill,
        contentPlan: contentPlanSkill,
        imageMode: imageMode.mode,
        modelTimeoutMs,
        logger,
      });
      draft = draftGeneration.draft;
      repairResult = draftGeneration.repairResult;
    }
    if (precomputed.qualityCheck) {
      draft = precomputed.qualityCheck.draft || draft;
      repairResult = precomputed.qualityCheck.repairResult || repairResult;
      humanEditorReview = precomputed.qualityCheck.humanEditorReview;
      qualityReview = precomputed.qualityCheck.qualityReview;
      deliveryGateSkill = precomputed.qualityCheck.deliveryGate;
    } else {
      const qualityCheck = await runQualityCheckSkill({
        llm,
        userText,
        topicLabel,
        requirement: requirementSkill,
        strategy: strategySkill,
        contentPlan: contentPlanSkill,
        draft,
        selectedIntelItems,
        scoredOpportunities: opportunityScore,
        repairResult,
        humanEditorRules,
        modelTimeoutMs,
        skillConfig: skillConfigs.deliveryGate,
        logger,
      });
      draft = qualityCheck.draft;
      repairResult = qualityCheck.repairResult;
      humanEditorReview = qualityCheck.humanEditorReview;
      qualityReview = qualityCheck.qualityReview;
      deliveryGateSkill = qualityCheck.deliveryGate;
    }
  }
  deliveryGateSkill = deliveryGateSkill || precomputed.deliveryGate || (
    skillConfigs.deliveryGate?.enabled === false
      ? fallbackDeliveryGateFromReviews({ qualityReview, humanEditorReview, strategy: strategySkill, contentPlan: contentPlanSkill })
      : await runDeliveryGateSkill({
          llm,
          userText,
          topicLabel,
          requirement: requirementSkill,
          strategy: strategySkill,
          contentPlan: contentPlanSkill,
          draft,
          selectedIntelItems,
          humanEditorReview,
          qualityReview,
          modelTimeoutMs,
          skillConfig: skillConfigs.deliveryGate,
          logger,
        })
  );
  const businessFlow = {
    version: "content-brain-v1",
    contentBrainMode,
    hermesBrainStatus: hermesBrain.status,
    hermesBrainProvider: notionConfig.hermes?.provider || "",
    hermesBrainMode: notionConfig.hermes?.mode || "",
    hermesBrainExecutor: notionConfig.hermes?.provider === "wsl-hermes-agent"
      ? `WSL Hermes Agent (${notionConfig.hermes?.wsl_distro || "Ubuntu"} / ${notionConfig.hermes?.command || "hermes"})`
      : notionConfig.hermes?.provider === "openclaw-agent"
        ? "OpenClaw Agent"
        : notionConfig.hermes?.provider === "llm"
          ? "当前模型 API"
          : notionConfig.hermes?.provider || "未启用",
    hermesBrainError: hermesBrain.error || "",
    requirementSkill,
    strategySkill,
    contentPlanSkill,
    deliveryGateSkill,
    hermesResearch,
    opportunityScore,
    selectedSourceIndexes: selectedIntelItems
      .map((item) => intelItems.indexOf(item))
      .filter((index) => index >= 0),
    ruleValidation: {
      repaired: repairResult.repaired,
      issues: repairResult.issues,
    },
    humanEditorReview,
    qualityReview,
  };
  businessFlow.qualityReview = {
    ...businessFlow.qualityReview,
    ruleValidation: businessFlow.ruleValidation,
  };
  const artifactPaths = createDraftArtifactPaths(draft);
  const imageResult = await maybeGenerateDraftImages(draft, artifactPaths, effectiveImageConfig, logger);
  const workflow = buildPublishPackageWorkflow({
    userText,
    topicLabel,
    draft,
    selectedIntelItems,
    businessFlow,
    requirementSkill,
    strategySkill,
    contentPlanSkill,
    deliveryGateSkill,
  });
  const saved = saveDraftFilesV2(draft, selectedIntelItems, imageResult, artifactPaths, businessFlow, workflow);
  const notion = {
    status: "skipped",
    pageId: null,
    url: null,
    error: null,
    target: null,
    relationCount: 0,
  };

  if (!notionConfig.xiaohongshu.enableNotion) {
    notion.status = "disabled";
  } else if (!notionConfig.xiaohongshu.syncNotionDuringWorkflow) {
    notion.status = "pending";
    notion.warning = "notion_sync_deferred";
    logger?.("INFO", "Xiaohongshu Notion write deferred", {
      title: draft?.title || null,
      reason: "sync_notion_during_workflow_disabled",
    });
  } else if (notionDbIsConfigured(notionConfig.aiIntel) || notionDbIsConfigured(notionConfig.contentPublish)) {
    try {
      const page = await writePackageToNotionV2(draft, selectedIntelItems, notionConfig, imageResult, businessFlow, logger);
      notion.status = "written";
      notion.pageId = page.pageId;
      notion.url = page.url;
      notion.target = page.target;
      notion.relationCount = page.relationCount;
      notion.warning = page.warning || null;
      notion.uploadedImageCount = page.uploadedImageCount || 0;
    } catch (error) {
      notion.status = "failed";
      notion.error = String(error);
      logger?.("ERROR", "Xiaohongshu Notion write failed", {
        error: notion.error,
        targetDatabaseId: notionDbIsConfigured(notionConfig.contentPublish)
          ? notionConfig.contentPublish.databaseId
          : notionConfig.aiIntel.databaseId,
        title: draft?.title || null,
      });
    }
  }

  patchSavedPackageJson(saved.jsonPath, {
    notion,
    publishStatus: "已生成",
    publishStatusUpdatedAt: new Date().toISOString(),
    businessFlow,
    workflow,
  });

  logger?.("INFO", "Xiaohongshu publish package completed", {
    title: draft?.title || null,
    topicLabel,
    itemCount: selectedIntelItems.length,
    rawItemCount: intelItems.length,
    opportunityScoreStatus: opportunityScore.status,
    ruleRepaired: repairResult.repaired,
    humanEditorStatus: humanEditorReview.status,
    draftHumanTraceScore: humanEditorReview.human_trace_score,
    draftAiFlavorScore: humanEditorReview.ai_flavor_score,
    humanRewriteApplied: humanEditorReview.rewrite_applied,
    finalHumanTraceScore: null,
    finalAiFlavorScore: null,
    qualityScore: qualityReview.score,
    qualityPassed: qualityReview.passed,
    jsonPath: saved.jsonPath,
    mdPath: saved.mdPath,
    notionStatus: notion.status,
    notionUrl: notion.url,
    notionTarget: notion.target,
    notionRelationCount: notion.relationCount,
    imageStatus: imageResult?.status || "unknown",
    imageFileCount: imageResult?.files?.length || 0,
    imageOutputDir: imageResult?.outputDir || null,
    imageMode: imageMode.mode,
    llmMode: llm.mode,
    llmModel: llm.model,
  });

  return {
    handled: true,
    replyText: buildWechatReplyV2(draft, saved, notion, imageResult, businessFlow),
    debug: {
      topicLabel,
      intel: intelResult?.debug || null,
      businessFlow,
      workflow,
      draft,
      saved,
      imageResult,
      imageMode,
      notion,
    },
  };
}

export async function replayXiaohongshuPackageToNotion({
  baseDir,
  packagePath,
  logger,
}) {
  const payload = readJson(packagePath, null);
  if (!payload?.draft) {
    throw new Error(`Invalid Xiaohongshu package: ${packagePath}`);
  }
  const notionConfig = loadNotionConfig(baseDir);
  const result = await writePackageToNotionV2(
    payload.draft,
    Array.isArray(payload.sourceItems) ? payload.sourceItems : [],
    notionConfig,
    payload.images || null,
    payload.businessFlow || null,
    logger,
  );
  logger?.("INFO", "Xiaohongshu package replayed to Notion", {
    packagePath,
    pageId: result.pageId,
    url: result.url,
    target: result.target,
    relationCount: result.relationCount,
    uploadedImageCount: result.uploadedImageCount,
    warning: result.warning || null,
  });
  return result;
}

function resolvePackageImageSlot(payload, slotId) {
  const raw = String(slotId || "").trim();
  const match = raw.match(/-(\d+)$/);
  const index = match ? Math.max(0, Number(match[1]) - 1) : 0;
  const isCover = raw.startsWith("cover") || index === 0;
  return {
    index,
    kind: isCover ? "cover" : "support",
    supportIndex: isCover ? 0 : Math.max(0, index - 1),
  };
}

function packageImageOutputDir(packagePath, payload) {
  const existing = String(payload?.images?.outputDir || "").trim();
  if (existing) return existing;
  return path.join(path.dirname(packagePath), "generated-images");
}

function upsertGeneratedImageFile(files, slot, nextFile) {
  const next = Array.isArray(files) ? [...files] : [];
  const foundIndex = next.findIndex((item) => {
    const kind = String(item?.kind || "").trim();
    if (slot.kind === "cover") return kind === "cover";
    return kind === "support" && Number(item?.index ?? item?.supportIndex ?? -1) === slot.supportIndex;
  });
  if (foundIndex >= 0) next[foundIndex] = { ...next[foundIndex], ...nextFile };
  else next[slot.index] = nextFile;
  return next.filter(Boolean);
}

export function updateXiaohongshuPackageImagePrompt({
  packagePath,
  slotId,
  prompt,
}) {
  const payload = readJson(packagePath, null);
  if (!payload?.draft) {
    throw new Error(`Invalid Xiaohongshu package: ${packagePath}`);
  }
  const slot = resolvePackageImageSlot(payload, slotId);
  const nextPrompt = String(prompt || "").trim();
  payload.images ||= {};
  payload.images.prompts ||= {};
  if (slot.kind === "cover") {
    payload.draft.cover_image_prompt = nextPrompt;
    payload.images.prompts.rawCoverPrompt = nextPrompt;
    payload.images.prompts.coverPrompt = nextPrompt ? hardenImagePrompt(nextPrompt, "cover") : "";
  } else {
    const prompts = Array.isArray(payload.draft.supporting_image_prompts)
      ? [...payload.draft.supporting_image_prompts]
      : [];
    prompts[slot.supportIndex] = nextPrompt;
    payload.draft.supporting_image_prompts = prompts;
    const rawPrompts = Array.isArray(payload.images.prompts.rawSupportingPrompts)
      ? [...payload.images.prompts.rawSupportingPrompts]
      : [...prompts];
    rawPrompts[slot.supportIndex] = nextPrompt;
    payload.images.prompts.rawSupportingPrompts = rawPrompts;
    payload.images.prompts.supportingPrompts = rawPrompts.map((item) => hardenImagePrompt(item, "support"));
  }
  if (Array.isArray(payload.draft.image_plan) && payload.draft.image_plan[slot.index]) {
    payload.draft.image_plan[slot.index] = {
      ...payload.draft.image_plan[slot.index],
      prompt: nextPrompt,
    };
  }
  payload.publishSegments = buildPublishSegments(payload.draft, payload.images);
  payload.updatedAt = new Date().toISOString();
  fs.writeFileSync(packagePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export async function generateXiaohongshuPackageImageAsset({
  baseDir,
  packagePath,
  slotId,
  prompt,
  logger,
}) {
  const payload = await updateXiaohongshuPackageImagePrompt({ packagePath, slotId, prompt });
  const notionConfig = loadNotionConfig(baseDir);
  const imageConfig = {
    ...notionConfig.imageGeneration,
    enabled: notionConfig.imageGeneration?.enabled === true,
  };
  if (!imageGenerationIsConfigured(imageConfig)) {
    throw new Error("Image generation is not configured");
  }

  const slot = resolvePackageImageSlot(payload, slotId);
  const draft = payload.draft;
  const promptText = slot.kind === "cover"
    ? String(draft.cover_image_prompt || "").trim()
    : String((Array.isArray(draft.supporting_image_prompts) ? draft.supporting_image_prompts[slot.supportIndex] : "") || "").trim();
  if (!promptText) throw new Error("Image prompt is empty");

  const outputDir = packageImageOutputDir(packagePath, payload);
  ensureDir(outputDir);
  const hardenedPrompt = hardenImagePrompt(promptText, slot.kind);
  const targetPath = path.join(outputDir, buildImageFileName(slot.kind, slot.supportIndex));
  const startedAt = Date.now();
  logger?.("INFO", "Package image asset generation started", {
    packagePath,
    slotId,
    kind: slot.kind,
    targetPath,
  });
  await generateImage(hardenedPrompt, imageConfig, targetPath);

  const nextFile = {
    kind: slot.kind,
    index: slot.supportIndex,
    path: targetPath,
    prompt: hardenedPrompt,
    rawPrompt: promptText,
    generatedAt: new Date().toISOString(),
  };
  payload.images = {
    ...(payload.images || {}),
    status: "generated",
    outputDir,
    error: null,
    files: upsertGeneratedImageFile(payload.images?.files, slot, nextFile),
  };
  payload.publishSegments = buildPublishSegments(payload.draft, payload.images);
  payload.updatedAt = new Date().toISOString();
  fs.writeFileSync(packagePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  logger?.("INFO", "Package image asset generation completed", {
    packagePath,
    slotId,
    targetPath,
    durationMs: Date.now() - startedAt,
  });
  return {
    ok: true,
    slotId,
    file: nextFile,
    images: payload.images,
  };
}
