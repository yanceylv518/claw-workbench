import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  maybeRunAiIntelWorkflow,
  classifyAiIntelIntent,
  classifyAiIntelIntentV2,
  buildAiIntelConfirmationReply,
} from "./notion-ai-intel-workflow.mjs";
import {
  maybeRunFinanceNewsWorkflow,
  classifyFinanceNewsIntent,
  maybeRunFinanceBriefWorkflow,
  classifyFinanceBriefIntent,
} from "./finance-news-workflow.mjs";
import { runOpenClawAgent, buildWechatSessionId } from "./openclaw-agent-client.mjs";
import { runWeatherSkill, buildWeatherSkillReply } from "./apps/api/services/weather-skill.mjs";
import { createTask } from "./apps/api/services/task-service.mjs";
import { enqueueTaskRun } from "./apps/api/services/task-executor.mjs";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || "", ".openclaw");
const ACCOUNT_ID = process.env.WECHAT_ACCOUNT_ID || "8f7c91dbe672-im-bot";
const STATE_DIR = path.join(OPENCLAW_HOME, "openclaw-weixin", "accounts");
const ACCOUNT_PATH = path.join(STATE_DIR, `${ACCOUNT_ID}.json`);
const REMOTE_SYNC_PATH = path.join(STATE_DIR, `${ACCOUNT_ID}.sync.json`);
const REMOTE_CONTEXT_PATH = path.join(STATE_DIR, `${ACCOUNT_ID}.context-tokens.json`);
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const BRIDGE_CONFIG_PATH = path.join(process.cwd(), "wechat-bridge.config.json");
const NOTION_INTEL_CONFIG_PATH = path.join(process.cwd(), "notion-ai-intel.config.json");
const LOCAL_STATE_DIR = process.env.XIAOLONGXIA_DATA_DIR || path.join(process.cwd(), ".wechat-direct-bridge");
const LOG_PATH = process.env.XIAOLONGXIA_LOG_PATH || path.join(LOCAL_STATE_DIR, "wechat-direct-bridge.log");
const SYNC_PATH = path.join(LOCAL_STATE_DIR, `${ACCOUNT_ID}.sync.json`);
const CONTEXT_PATH = path.join(LOCAL_STATE_DIR, `${ACCOUNT_ID}.context-tokens.json`);
const PENDING_PATH = path.join(LOCAL_STATE_DIR, `${ACCOUNT_ID}.pending-actions.json`);
const LAST_ACTIVE_PEER_PATH = path.join(LOCAL_STATE_DIR, `${ACCOUNT_ID}.last-active-peer.json`);
const USER_PREFERENCES_PATH = path.join(LOCAL_STATE_DIR, `${ACCOUNT_ID}.user-preferences.json`);
const LATEST_BRIEF_PATH = path.join(LOCAL_STATE_DIR, "latest-morning-brief.json");
const XIAOHONGSHU_PREFILL_SCRIPT_PATH = path.join(process.cwd(), "prefill-xiaohongshu-publish.ps1");
const XIAOHONGSHU_PREFILL_STATUS_PATH = path.join(LOCAL_STATE_DIR, "xiaohongshu-prefill-status.json");
const WEIXIN_PLUGIN_PACKAGE_PATH = path.join(
  OPENCLAW_HOME,
  "extensions",
  "openclaw-weixin",
  "package.json",
);

const DEFAULT_SYSTEM_PROMPT =
  process.env.WECHAT_BRIDGE_SYSTEM_PROMPT ||
  "你是一个简洁、自然、可靠的微信助手。默认使用中文回复，除非用户明确要求其他语言。回复尽量简短，不要像客服套话。";

const POLL_TIMEOUT_MS = Number(process.env.WECHAT_POLL_TIMEOUT_MS || 35000);
const MODEL_TIMEOUT_MS = Number(process.env.WECHAT_MODEL_TIMEOUT_MS || 45000);
const WORKFLOW_MODEL_TIMEOUT_MS = Number(process.env.WECHAT_WORKFLOW_MODEL_TIMEOUT_MS || 180000);
const SEND_TIMEOUT_MS = Number(process.env.WECHAT_SEND_TIMEOUT_MS || 15000);
const RETRY_DELAY_MS = 2000;
const MAX_REPLY_CHARS = Number(process.env.WECHAT_MAX_REPLY_CHARS || 1200);
const PENDING_CONFIRM_TTL_MS = Number(process.env.WECHAT_PENDING_CONFIRM_TTL_MS || 5 * 60 * 1000);

const CONFIRM_WORDS = new Set(["\u8981", "\u7ee7\u7eed", "\u786e\u8ba4", "\u597d\u7684", "\u597d", "yes", "ok"]);
const CANCEL_WORDS = new Set(["\u4e0d\u7528", "\u53d6\u6d88", "\u7b97\u4e86", "no"]);
const PROCESSING_REPLY = "\u6536\u5230\uff0c\u6211\u6b63\u5728\u6574\u7406\u60c5\u62a5\uff0c\u7a0d\u7b49\u7247\u523b\u3002";
const WORKFLOW_FAILED_REPLY = "\u8fd9\u6b21 AI \u60c5\u62a5\u6574\u7406\u8d85\u65f6\u4e86\uff0c\u6211\u5df2\u7ecf\u8bb0\u4e0b\u8fd9\u4e2a\u95ee\u9898\u3002\u4f60\u53ef\u4ee5\u7a0d\u540e\u518d\u8bd5\u4e00\u6b21\u3002";
const EXPIRED_CONFIRM_REPLY = "\u521a\u624d\u90a3\u6761\u5f85\u786e\u8ba4\u7684\u60c5\u62a5\u4efb\u52a1\u5df2\u7ecf\u8fc7\u671f\u4e86\uff0c\u4f60\u518d\u8bf4\u4e00\u6b21\u6211\u5c31\u91cd\u65b0\u5f00\u59cb\u3002";
const CANCEL_REPLY = "\u597d\u7684\uff0c\u8fd9\u6b21\u6211\u5148\u4e0d\u6293\u60c5\u62a5\u3002";
const CONTENT_OPPORTUNITY_CONFIRM_REPLY = "\u6211\u5148\u5e2e\u4f60\u6311\u51fa\u4e86\u51e0\u6761\u66f4\u9002\u5408\u505a\u5185\u5bb9\u7684\u60c5\u62a5\u3002\u8981\u7684\u8bdd\u56de\u6211\u201c\u8981\u201d\uff0c\u6211\u5c31\u76f4\u63a5\u7ed9\u4f60\u505a\u6210\u5c0f\u7ea2\u4e66\u53d1\u5e03\u5305\u3002";

const XIAOHONGSHU_PROCESSING_REPLY = "\u6536\u5230\uff0c\u6211\u6b63\u5728\u6574\u7406\u5c0f\u7ea2\u4e66\u53d1\u5e03\u5305\uff0c\u5e76\u51c6\u5907\u9884\u586b\u53d1\u5e03\u9875\uff0c\u7a0d\u7b49\u7247\u523b\u3002";
const XIAOHONGSHU_TASK_CREATED_REPLY = "\u5df2\u521b\u5efa\u5c0f\u7ea2\u4e66\u53d1\u5e03\u5305\u4efb\u52a1\u3002\n\u4f60\u53ef\u4ee5\u5728\u540e\u53f0\u300c\u4efb\u52a1\u4e2d\u5fc3\u300d\u67e5\u770b\u8fdb\u5ea6\uff0c\u5b8c\u6210\u540e\u4f1a\u51fa\u73b0\u5728\u300c\u53d1\u5e03\u5305\u300d\u3002";

function isMorningBriefCommand(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized === "早报" || normalized === "晨报" || normalized === "ai早报";
}

function buildMorningBriefReply(latestBrief) {
  if (!latestBrief?.brief?.text) {
    return "今天的早报还没有生成好，稍后再试试。";
  }
  return latestBrief.brief.text;
}

function classifyContentOpportunityIntent(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return { mode: "none", normalizedText: "", reason: "empty" };
  const patterns = [
    /(?:\u9002\u5408\u505a\u5185\u5bb9|\u9002\u5408\u5199|\u9002\u5408\u53d1)/u,
    /(?:\u503c\u5f97\u505a\u5185\u5bb9|\u503c\u5f97\u505a\u9009\u9898|\u503c\u5f97\u5199)/u,
    /(?:\u54ea\u4e9b.*\u9002\u5408.*\u5185\u5bb9|\u54ea\u4e9b.*\u9002\u5408.*\u9009\u9898)/u,
    /(?:\u54ea\u4e9b.*\u53ef\u4ee5\u505a.*\u5185\u5bb9|\u54ea\u4e9b.*\u80fd\u505a.*\u5185\u5bb9)/u,
    /(?:\u9009\u9898|\u5185\u5bb9\u673a\u4f1a|\u53ef\u4ee5\u5199\u4ec0\u4e48)/u,
  ];
  if (patterns.some((pattern) => pattern.test(normalized))) {
    return { mode: "suggest", normalizedText: normalized, reason: "content_opportunity" };
  }
  return { mode: "none", normalizedText: normalized, reason: "low_confidence" };
}

function inferContentAngle(item) {
  const text = `${item?.title || ""} ${item?.summary || ""} ${item?.usage || ""}`;
  if (/(?:\u5de5\u5177|\u6548\u7387|\u5199\u4f5c|\u751f\u6210|\u81ea\u52a8\u5316)/u.test(text)) return "更适合做“工具推荐”";
  if (/(?:\u8d8b\u52bf|\u53d1\u5e03|\u5347\u7ea7|\u65b0\u6a21\u578b|\u65b0\u529f\u80fd|\u52a8\u6001)/u.test(text)) return "更适合做“趋势观察”";
  return "更适合做“经验分享”";
}

function buildContentOpportunitySuggestion(workflowResult) {
  const items = Array.isArray(workflowResult?.debug?.items) ? workflowResult.debug.items.slice(0, 3) : [];
  if (!items.length) return "今天先没筛出特别适合直接做内容的条目，你稍后再试试。";
  const lines = ["我先帮你挑了几条更适合做内容的：", ""];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`角度：${inferContentAngle(item)}`);
    lines.push(`原因：${item.usage || item.summary}`);
    lines.push("");
  });
  lines.push(CONTENT_OPPORTUNITY_CONFIRM_REPLY);
  return lines.join("\n").trim();
}

function isXiaohongshuDirectCommand(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  const patterns = [
    /^\u5c0f\u7ea2\u4e66(?:\s+.+)?$/u,
    /\u5c0f\u7ea2\u4e66\s*(\u8349\u7a3f|\u5f85\u53d1\u5e03|\u53d1\u5e03\u7a3f|\u7b14\u8bb0|\u6587\u6848|\u53d1\u5e03\u5305)/u,
    /(\u505a\u6210|\u6574\u7406\u6210|\u6539\u6210).*(\u5c0f\u7ea2\u4e66)/u,
    /\u5e2e\u6211\u505a\s*\u5c0f\u7ea2\u4e66/u,
    /\u505a\s*\u5c0f\u7ea2\u4e66/u,
    /\u53d1\s*\u5c0f\u7ea2\u4e66/u,
    /\u51fa\s*\u5c0f\u7ea2\u4e66/u,
    /\u751f\u6210.*\u5c0f\u7ea2\u4e66/u,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function isXiaohongshuHelpCommand(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return [
    "小红书帮助",
    "小红书菜单",
    "小红书命令",
    "小红书怎么用",
    "xhs help",
  ].includes(normalized);
}

function isQuickMenuCommand(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return [
    "菜单",
    "小龙虾菜单",
    "帮助",
    "小龙虾帮助",
    "快捷菜单",
    "命令",
  ].includes(normalized);
}

function buildQuickMenuReply() {
  return [
    "小龙虾快捷菜单：",
    "",
    "你想做哪件事？直接复制一句发我就行。",
    "",
    "一、看今天有什么",
    "早报",
    "今天有哪些热点",
    "今天有什么值得看的",
    "",
    "二、找能做内容的选题",
    "今天AI里哪些适合做内容",
    "",
    "三、直接生成小红书",
    "小红书 token代理",
    "小红书 API报错排查",
    "小红书 焦虑疗愈",
    "小红书 睡前疗愈",
    "小红书 工具推荐",
    "",
    "四、发布相关",
    "小红书 不生图",
    "小红书帮助",
    "",
    "不知道发什么时，先发：今天有什么值得看的",
  ].join("\n");
}

function buildXiaohongshuHelpReply() {
  return [
    "小红书助手用法：",
    "",
    "1. 直接生成",
    "小红书 token代理",
    "小红书 API报错排查",
    "小红书 Dify接API",
    "小红书 焦虑疗愈",
    "小红书 睡前疗愈",
    "小红书 工具推荐",
    "",
    "2. 图片控制",
    "小红书 不生图",
    "小红书 生图 亲密关系",
    "",
    "3. 常用主题",
    "焦虑疗愈 / 睡前疗愈 / 情绪稳定 / 亲密关系 / 女性成长 / 职场情绪",
    "",
    "4. 结果在哪里",
    "我会生成本地素材包，并优先尝试预填小红书草稿；如果失败，按素材包手工发布即可。",
  ].join("\n");
}

function buildClientVersion(version) {
  const parts = String(version || "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function loadAssistantConfig() {
  const bridgeConfig = readJson(BRIDGE_CONFIG_PATH, {});
  return {
    defaultCity: String(bridgeConfig?.assistant?.default_city || "").trim(),
    weatherEnabled: bridgeConfig?.assistant?.weather_enabled !== false,
  };
}

function normalizeCity(value) {
  return String(value || "")
    .replace(/[，。！？?!.、；;：:]/g, " ")
    .replace(/^(?:我在|查一下|查询|看看|帮我看下|帮我查下)/u, "")
    .replace(/(?:的)?(?:天气|气温|温度|预报|下雨|会下雨|怎么样|如何|情况).*$/u, "")
    .replace(/^(?:今天|明天|后天|本周|这周|一周|最近)\s*/u, "")
    .trim();
}

function normalizeWeatherCity(value) {
  const city = normalizeCity(value).replace(/^(?:的|当地|本地)$/u, "").trim();
  if (/^(?:什么|啥|哪里|哪儿|哪个城市)$/u.test(city)) return "";
  return city;
}

function getUserDefaultCity(fromUserId) {
  const preferences = readJson(USER_PREFERENCES_PATH, {});
  return String(preferences?.[fromUserId]?.defaultCity || "").trim();
}

function setUserDefaultCity(fromUserId, city) {
  const preferences = readJson(USER_PREFERENCES_PATH, {});
  preferences[fromUserId] = {
    ...(preferences[fromUserId] || {}),
    defaultCity: city,
    updatedAt: new Date().toISOString(),
  };
  writeJson(USER_PREFERENCES_PATH, preferences);
}

function parseWeatherIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const setMatch =
    raw.match(/^设置(?:我的|微信助手)?(?:默认)?城市\s*[:：]?\s*(.+)$/u) ||
    raw.match(/^(?:默认城市|城市)\s*(?:设为|设置为|改成|是)\s*(.+)$/u);
  if (setMatch) {
    const city = normalizeWeatherCity(setMatch[1]);
    return city ? { type: "set-city", city } : { type: "set-city", city: "" };
  }

  if (!/(天气|气温|温度|下雨|降雨|预报)/u.test(raw)) return null;

  let range = "today";
  if (/(明天|明日)/u.test(raw)) range = "tomorrow";
  if (/(本周|这周|一周|未来几天|最近几天)/u.test(raw)) range = "week";

  const cityMatch =
    raw.match(/(?:今天|明天|明日|本周|这周|一周)?\s*([\u4e00-\u9fa5A-Za-z·\-\s]{2,24})\s*(?:天气|气温|温度|预报|会下雨|下雨)/u) ||
    raw.match(/(?:天气|气温|温度|预报)\s*([\u4e00-\u9fa5A-Za-z·\-\s]{2,24})/u);
  const city = normalizeWeatherCity(cityMatch?.[1] || "");

  return { type: "weather", city, range };
}

function readJsonWithFallback(primaryPath, fallbackPath, fallbackValue) {
  if (fs.existsSync(primaryPath)) return readJson(primaryPath, fallbackValue);
  if (fallbackPath && fs.existsSync(fallbackPath)) return readJson(fallbackPath, fallbackValue);
  return fallbackValue;
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function isPendingExpired(pending) {
  if (!pending?.createdAt) return true;
  const createdAt = new Date(pending.createdAt);
  if (Number.isNaN(createdAt.getTime())) return true;
  return Date.now() - createdAt.getTime() > PENDING_CONFIRM_TTL_MS;
}

function cleanupExpiredPending(pendingActions) {
  let changed = false;
  for (const [userId, pending] of Object.entries(pendingActions)) {
    if (isPendingExpired(pending)) {
      delete pendingActions[userId];
      changed = true;
    }
  }
  return changed;
}

function loadWeixinPluginMeta() {
  const pkg = readJson(WEIXIN_PLUGIN_PACKAGE_PATH, {});
  return {
    appId: String(pkg?.ilink_appid || "bot"),
    clientVersion: String(buildClientVersion(pkg?.version || "0.0.0")),
    channelVersion: String(pkg?.version || "standalone-bridge"),
  };
}

function log(level, message, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
}

function buildBaseInfo() {
  return { channel_version: loadWeixinPluginMeta().channelVersion };
}

function loadRouteTag(accountId) {
  const config = readJson(OPENCLAW_CONFIG_PATH, {});
  const section = config?.channels?.["openclaw-weixin"];
  if (!section || typeof section !== "object") return undefined;
  const accountTag = section?.accounts?.[accountId]?.routeTag;
  if (typeof accountTag === "number") return String(accountTag);
  if (typeof accountTag === "string" && accountTag.trim()) return accountTag.trim();
  const sectionTag = section?.routeTag;
  if (typeof sectionTag === "number") return String(sectionTag);
  if (typeof sectionTag === "string" && sectionTag.trim()) return sectionTag.trim();
  return undefined;
}

function maybeLaunchXiaohongshuPrefill(draftResult) {
  if (draftResult?.debug?.prefillEnabled === false) return false;
  const packagePath = String(draftResult?.debug?.saved?.jsonPath || "").trim();
  if (!packagePath) return false;
  if (!fs.existsSync(XIAOHONGSHU_PREFILL_SCRIPT_PATH)) return false;
  try {
    writeJson(XIAOHONGSHU_PREFILL_STATUS_PATH, {
      ok: null,
      stage: "launching",
      packagePath,
      message: "正在启动小红书发布页预填脚本",
      updatedAt: new Date().toISOString(),
    });
    const psCommand = [
      "$ErrorActionPreference = 'Stop'",
      `Set-Location -LiteralPath ${JSON.stringify(process.cwd())}`,
      `& ${JSON.stringify(XIAOHONGSHU_PREFILL_SCRIPT_PATH)} -Package ${JSON.stringify(packagePath)}`,
    ].join("; ");
    const encodedCommand = Buffer.from(psCommand, "utf16le").toString("base64");
    const child = spawn(
      "cmd.exe",
      [
        "/c",
        "start",
        "Xiaohongshu Prefill",
        "powershell.exe",
        "-NoExit",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();
    return true;
  } catch (error) {
    writeJson(XIAOHONGSHU_PREFILL_STATUS_PATH, {
      ok: false,
      stage: "launch_failed",
      packagePath,
      message: String(error?.message || error),
      updatedAt: new Date().toISOString(),
    });
    return false;
  }
}

function appendXiaohongshuFallback(replyText, draftResult, launched) {
  const saved = draftResult?.debug?.saved || {};
  const packageDir = String(saved.packageDir || "").trim();
  const finalPostPath = String(saved.finalPostPath || "").trim();
  const manualGuidePath = String(saved.manualGuidePath || "").trim();
  const prefillDisabled = draftResult?.debug?.prefillEnabled === false;
  const note = prefillDisabled
    ? "小红书自动预填已关闭；本次只生成发布文档、本地素材包，并按配置写入内容库。"
    : launched
      ? "已尝试自动打开小红书发布页并预填内容；默认不保存草稿，会停留在发布编辑页供你检查。"
      : "小红书自动预填未启动，已保留本地完整素材包，请按本地素材包手工发布。";
  const extra = [note];
  if (packageDir) extra.push(`本地素材包：${packageDir}`);
  if (finalPostPath) extra.push(`最终成稿：${finalPostPath}`);
  if (manualGuidePath) extra.push(`手工发布说明：${manualGuidePath}`);
  return `${String(replyText || "").trim()}\n${extra.join("\n")}`.trim();
}

function createWechatXiaohongshuTask({ userText, fromUserId, contextToken, logger }) {
  const task = createTask({
    entryType: "wechat",
    entryMessageId: contextToken || `${fromUserId}-${Date.now()}`,
    inputText: userText,
  });
  enqueueTaskRun(task.id);
  logger?.("INFO", "Wechat Xiaohongshu task queued", {
    taskId: task.id,
    fromUserId,
    inputLength: String(userText || "").length,
  });
  return task;
}

function normalizePathKey(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function resolveXiaohongshuPublishStatus(status) {
  if (status?.ok === true && status?.draftSaved) return "\u8349\u7a3f\u5df2\u4fdd\u5b58";
  if (status?.ok === true && status?.saveDraftEnabled === false) return "\u5f85\u624b\u5de5\u53d1\u5e03";
  if (status?.ok === true) return "\u5f85\u624b\u5de5\u53d1\u5e03";
  return "\u5f85\u624b\u5de5\u53d1\u5e03";
}
function patchLocalPackagePublishStatus(packagePath, publishStatus, prefillStatus) {
  const normalizedPackagePath = String(packagePath || "").trim();
  if (!normalizedPackagePath || !fs.existsSync(normalizedPackagePath)) return null;
  const payload = readJson(normalizedPackagePath, null);
  if (!payload || typeof payload !== "object") return null;
  const next = {
    ...payload,
    publishStatus,
    prefillStatus,
    publishStatusUpdatedAt: new Date().toISOString(),
  };
  writeJson(normalizedPackagePath, next);
  return next;
}

async function updateContentPublishNotionStatus(packagePayload, publishStatus) {
  const cfg = readJson(NOTION_INTEL_CONFIG_PATH, {});
  if (cfg?.xiaohongshu?.enable_notion !== true) return false;
  const notion = packagePayload?.notion;
  if (notion?.status !== "written" || !notion?.pageId) return false;

  const token =
    process.env.NOTION_CONTENT_PUBLISH_TOKEN ||
    cfg?.content_publish?.token ||
    process.env.NOTION_TOKEN ||
    cfg?.notion?.token ||
    "";
  const propertyName = cfg?.content_publish?.property_map?.publish_status || "\u53d1\u5e03\u72b6\u6001";
  if (!token || !propertyName) return false;

  const res = await fetch(`https://api.notion.com/v1/pages/${String(notion.pageId).replace(/-/g, "")}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2026-03-11",
    },
    body: JSON.stringify({
      properties: {
        [propertyName]: { select: { name: publishStatus } },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notion publish status update failed: HTTP ${res.status}: ${text}`);
  }
  return true;
}

async function writeXiaohongshuPublishStatus(packagePath, publishStatus, prefillStatus) {
  const packagePayload = patchLocalPackagePublishStatus(packagePath, publishStatus, prefillStatus);
  if (!packagePayload) return;
  try {
    const notionUpdated = await updateContentPublishNotionStatus(packagePayload, publishStatus);
    log("INFO", "Xiaohongshu publish status updated", {
      packagePath,
      publishStatus,
      notionUpdated,
    });
  } catch (error) {
    log("WARN", "Xiaohongshu Notion publish status update failed", {
      packagePath,
      publishStatus,
      error: String(error?.message || error),
    });
  }
}

function buildXiaohongshuPrefillStatusReply(status) {
  if (status?.ok === true) {
    const lines = ["\u5c0f\u7ea2\u4e66\u53d1\u5e03\u9875\u9884\u586b\u5b8c\u6210\u3002"];
    lines.push(`\u56fe\u7247\u4e0a\u4f20\uff1a${status.uploaded ? "\u5df2\u5b8c\u6210" : "\u672a\u786e\u8ba4"}`);
    if (status.saveDraftEnabled === false) {
      lines.push("\u9875\u9762\u72b6\u6001\uff1a\u5df2\u505c\u7559\u5728\u53d1\u5e03\u7f16\u8f91\u9875\uff0c\u8bf7\u4f60\u68c0\u67e5\u540e\u624b\u52a8\u53d1\u5e03\u6216\u4fdd\u5b58");
    } else {
      lines.push(`\u4fdd\u5b58\u8349\u7a3f\uff1a${status.draftSaved ? "\u5df2\u4fdd\u5b58" : "\u672a\u786e\u8ba4\uff0c\u8bf7\u5728\u9875\u9762\u624b\u52a8\u68c0\u67e5"}`);
    }
    return lines.join("\n");
  }
  if (status?.ok === false) {
    return [
      "\u5c0f\u7ea2\u4e66\u53d1\u5e03\u9875\u81ea\u52a8\u9884\u586b\u6ca1\u6709\u5b8c\u5168\u6210\u529f\u3002",
      `\u539f\u56e0\uff1a${status.message || "\u9875\u9762\u7ed3\u6784\u672a\u8bc6\u522b"}`,
      "\u4e0d\u7528\u62c5\u5fc3\uff0c\u5b8c\u6574\u53d1\u5e03\u7d20\u6750\u5df2\u7ecf\u4fdd\u5b58\u5728\u672c\u5730\u7d20\u6750\u5305\u91cc\uff0c\u53ef\u4ee5\u6309\u624b\u5de5\u53d1\u5e03\u8bf4\u660e\u64cd\u4f5c\u3002",
    ].join("\n");
  }
  return null;
}
function watchXiaohongshuPrefillStatus({ wechat, toUserId, contextToken, packagePath }) {
  const expectedPackage = normalizePathKey(packagePath);
  if (!expectedPackage) return;

  const startedAt = Date.now();
  const timeoutMs = 120000;
  const intervalMs = 3000;
  const timer = setInterval(async () => {
    try {
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        await writeXiaohongshuPublishStatus(packagePath, "\u5f85\u624b\u5de5\u53d1\u5e03", {
          ok: false,
          stage: "timeout",
          packagePath,
          message: "\u9884\u586b\u8d85\u65f6\uff0c\u5df2\u5207\u6362\u4e3a\u624b\u5de5\u53d1\u5e03\u515c\u5e95",
          updatedAt: new Date().toISOString(),
        });
        await sendWechatText(wechat, {
          toUserId,
          contextToken,
          text: "小红书发布页预填仍未返回明确结果。完整素材包已经保存在本地，如果页面没有自动填好，可以先按 README 手工发布。",
        });
        return;
      }

      const status = readJson(XIAOHONGSHU_PREFILL_STATUS_PATH, null);
      if (!status || status.ok === null || status.ok === undefined) return;
      if (normalizePathKey(status.packagePath) !== expectedPackage) return;

      const reply = buildXiaohongshuPrefillStatusReply(status);
      if (!reply) return;
      clearInterval(timer);
      const publishStatus = resolveXiaohongshuPublishStatus(status);
      await writeXiaohongshuPublishStatus(status.packagePath, publishStatus, status);
      await sendWechatText(wechat, { toUserId, contextToken, text: reply });
    } catch (error) {
      log("WARN", "Xiaohongshu prefill status watcher failed", { error: String(error?.message || error) });
    }
  }, intervalMs);
  timer.unref?.();
}

function buildWechatHeaders(bodyText, token, accountId) {
  const pluginMeta = loadWeixinPluginMeta();
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(bodyText, "utf8")),
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": pluginMeta.appId,
    "iLink-App-ClientVersion": pluginMeta.clientVersion,
  };
  const routeTag = loadRouteTag(accountId);
  if (routeTag) headers.SKRouteTag = routeTag;
  return headers;
}

async function postJson({ url, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function extractText(itemList) {
  if (!Array.isArray(itemList)) return "";
  for (const item of itemList) {
    if (item?.type === 1 && item?.text_item?.text) return String(item.text_item.text).trim();
    if (item?.type === 3 && item?.voice_item?.text) return String(item.voice_item.text).trim();
  }
  return "";
}

function summarizeMessage(msg) {
  return {
    fromUserId: msg?.from_user_id || null,
    toUserId: msg?.to_user_id || null,
    hasContextToken: Boolean(msg?.context_token),
    itemTypes: Array.isArray(msg?.item_list) ? msg.item_list.map((item) => item?.type ?? null) : [],
  };
}

function truncateReply(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "我收到了，但这次没有生成可发送的内容。";
  return normalized.length > MAX_REPLY_CHARS ? `${normalized.slice(0, MAX_REPLY_CHARS)}...` : normalized;
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

function loadActiveLlm(oc) {
  const bridgeConfig = readJson(BRIDGE_CONFIG_PATH, {});
  const configuredModes = bridgeConfig?.modes && typeof bridgeConfig.modes === "object" ? bridgeConfig.modes : {};
  const activeModeName =
    process.env.WECHAT_BRIDGE_ACTIVE_MODE ||
    bridgeConfig?.active_mode ||
    "gpt-account";
  const activeMode = configuredModes[activeModeName];

  if (activeMode?.type === "provider") {
    const providerId = String(activeMode.provider_id || "").trim();
    const model = String(activeMode.model || "gpt-4o").trim();
    const provider = oc?.models?.providers?.[providerId];
    return {
      activeModeName,
      llm: buildDirectApiMode(providerId, provider, model),
    };
  }

  if (activeMode?.type === "openclaw-agent") {
    const providerId = String(activeMode.provider_id || "openai-codex").trim();
    const model = String(activeMode.model || "gpt-5.4").trim();
    return {
      activeModeName,
      llm: buildOpenClawAgentMode(providerId, model),
    };
  }

  const primaryModel =
    process.env.WECHAT_BRIDGE_MODEL ||
    oc?.agents?.defaults?.model?.primary ||
    "openai-codex/gpt-5.4";
  const [providerId, modelId] = String(primaryModel).split("/");
  const provider = oc?.models?.providers?.[providerId];

  if (provider?.baseUrl && provider?.apiKey) {
    return {
      activeModeName: "fallback-provider",
      llm: buildDirectApiMode(providerId, provider, modelId || "gpt-4o"),
    };
  }

  return {
    activeModeName: "fallback-openclaw-agent",
    llm: buildOpenClawAgentMode(providerId || "openai-codex", modelId || "gpt-5.4"),
  };
}

function loadBridgeConfig() {
  const account = readJson(ACCOUNT_PATH, null);
  if (!account?.token || !account?.baseUrl || !account?.userId) {
    throw new Error(`Missing or invalid WeChat account file: ${ACCOUNT_PATH}`);
  }

  const oc = readJson(OPENCLAW_CONFIG_PATH, {});
  const { activeModeName, llm } = loadActiveLlm(oc);

  return {
    wechat: {
      token: account.token,
      baseUrl: ensureTrailingSlash(account.baseUrl),
      botUserId: account.userId,
      accountId: ACCOUNT_ID,
    },
    llm,
    workflowLlm: llm,
    activeModeName,
  };
}

async function getUpdates(wechat, getUpdatesBuf) {
  const bodyText = JSON.stringify({
    get_updates_buf: getUpdatesBuf || "",
    base_info: buildBaseInfo(),
  });
  try {
    return await postJson({
      url: new URL("ilink/bot/getupdates", wechat.baseUrl).toString(),
      headers: buildWechatHeaders(bodyText, wechat.token, wechat.accountId),
      body: bodyText,
      timeoutMs: POLL_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  }
}

async function sendWechatText(wechat, { toUserId, contextToken, text }) {
  const bodyText = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: buildBaseInfo(),
  });

  await postJson({
    url: new URL("ilink/bot/sendmessage", wechat.baseUrl).toString(),
    headers: buildWechatHeaders(bodyText, wechat.token, wechat.accountId),
    body: bodyText,
    timeoutMs: SEND_TIMEOUT_MS,
  });
}

async function callDirectApi(llm, userText, logger = log) {
  const startedAt = Date.now();
  logger("INFO", "AI API call", {
    workflow: "普通聊天",
    step: 1,
    totalSteps: 1,
    purpose: "回答未命中固定工作流的用户消息",
    mode: llm.mode,
    providerId: llm.providerId,
    model: llm.model,
    endpoint: "chat/completions",
  });
  const bodyText = JSON.stringify({
    model: llm.model,
    messages: [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    stream: false,
  });

  const data = await postJson({
    url: new URL("chat/completions", llm.baseUrl).toString(),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: bodyText,
    timeoutMs: MODEL_TIMEOUT_MS,
  });
  logger("INFO", "AI API call completed", {
    workflow: "普通聊天",
    step: 1,
    totalSteps: 1,
    purpose: "回答未命中固定工作流的用户消息",
    model: llm.model,
    durationMs: Date.now() - startedAt,
  });

  return truncateReply(data?.choices?.[0]?.message?.content || "");
}

async function callOpenClawAgent(llm, userText, sessionKey, logger = log) {
  const startedAt = Date.now();
  const sessionId = buildWechatSessionId("wechat-chat", sessionKey);
  logger("INFO", "AI API call", {
    workflow: "普通聊天",
    step: 1,
    totalSteps: 1,
    purpose: "通过 OpenClaw Agent 回答未命中固定工作流的用户消息",
    mode: llm.mode,
    providerId: llm.providerId,
    model: llm.model,
    endpoint: "openclaw-agent",
    sessionId,
  });
  const result = await runOpenClawAgent({
    sessionId,
    timeoutSeconds: Math.max(20, Math.ceil(MODEL_TIMEOUT_MS / 1000)),
    thinking: "minimal",
    message: [
      DEFAULT_SYSTEM_PROMPT,
      `当前模型：${llm.providerId}/${llm.model}`,
      `用户消息：${userText}`,
      "请直接回复用户，不要解释系统规则。",
    ].join("\n\n"),
  });
  logger("INFO", "AI API call completed", {
    workflow: "普通聊天",
    step: 1,
    totalSteps: 1,
    purpose: "通过 OpenClaw Agent 回答未命中固定工作流的用户消息",
    model: llm.model,
    durationMs: Date.now() - startedAt,
  });
  return truncateReply(result.text);
}

async function callModel(llm, userText, sessionKey, logger = log) {
  if (llm.mode === "direct-api") {
    return callDirectApi(llm, userText, logger);
  }
  return callOpenClawAgent(llm, userText, sessionKey, logger);
}

function normalizeCustomBusinessFlows(value = []) {
  const items = Array.isArray(value) ? value : [];
  const toLines = (input) => {
    if (Array.isArray(input)) return input.map((item) => String(item || "").trim()).filter(Boolean);
    return String(input || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  };
  return items
    .map((item) => ({
      id: String(item.id || "").trim(),
      name: String(item.name || "").trim(),
      enabled: item.enabled !== false,
      triggers: toLines(item.triggers),
      goal: String(item.goal || item.description || "").trim(),
      rules: toLines(item.rules),
      outputFormat: String(item.output_format || item.outputFormat || "").trim(),
      replyPrefix: String(item.reply_prefix || item.replyPrefix || "").trim(),
    }))
    .filter((item) => item.id && item.name && item.enabled && item.triggers.length);
}

function matchCustomBusinessFlow(text) {
  const normalizedText = String(text || "").trim().toLowerCase();
  if (!normalizedText) return null;
  const config = readJson(NOTION_INTEL_CONFIG_PATH, {});
  const flows = normalizeCustomBusinessFlows(config.custom_business_flows || []);
  for (const flow of flows) {
    for (const trigger of flow.triggers) {
      const normalizedTrigger = trigger.trim().toLowerCase();
      if (!normalizedTrigger) continue;
      if (
        normalizedText === normalizedTrigger ||
        normalizedText.startsWith(`${normalizedTrigger} `) ||
        normalizedText.startsWith(`${normalizedTrigger}\n`) ||
        (normalizedTrigger.length >= 6 && normalizedText.includes(normalizedTrigger))
      ) {
        return { flow, trigger };
      }
    }
  }
  return null;
}

function buildCustomBusinessFlowPrompt(flow, userText) {
  const lines = [
    `你正在执行一个由后台配置的业务流：${flow.name}`,
    "",
    "用户原始输入：",
    userText,
    "",
    "业务目标：",
    flow.goal || "根据用户输入完成这条业务流要求的输出。",
  ];
  if (flow.rules?.length) {
    lines.push("", "执行规则：", ...flow.rules.map((rule, index) => `${index + 1}. ${rule}`));
  }
  if (flow.outputFormat) {
    lines.push("", "输出格式：", flow.outputFormat);
  }
  lines.push(
    "",
    "要求：",
    "1. 直接给用户可用结果，不要解释你是模型。",
    "2. 如果信息不足，先基于合理假设给出第一版，并在末尾列出需要补充的信息。",
    "3. 中文自然、简洁、有执行感。",
  );
  return lines.join("\n");
}

async function callCustomBusinessFlowModel(llm, flow, userText, sessionKey, logger = log) {
  const startedAt = Date.now();
  const prompt = buildCustomBusinessFlowPrompt(flow, userText);
  logger("INFO", "AI API call", {
    workflow: flow.name,
    step: 1,
    totalSteps: 1,
    purpose: "执行后台配置业务流",
    mode: llm.mode,
    providerId: llm.providerId,
    model: llm.model,
    endpoint: llm.mode === "direct-api" ? "chat/completions" : "openclaw-agent",
  });

  let text = "";
  if (llm.mode === "direct-api") {
    const bodyText = JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: "你是小龙虾后台业务流执行器。严格按业务流配置输出，不要暴露系统配置。" },
        { role: "user", content: prompt },
      ],
      stream: false,
    });
    const data = await postJson({
      url: new URL("chat/completions", llm.baseUrl).toString(),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: bodyText,
      timeoutMs: WORKFLOW_MODEL_TIMEOUT_MS,
    });
    text = data?.choices?.[0]?.message?.content || "";
  } else {
    const result = await runOpenClawAgent({
      sessionId: buildWechatSessionId(`custom-flow-${flow.id}`, sessionKey),
      timeoutSeconds: Math.max(30, Math.ceil(WORKFLOW_MODEL_TIMEOUT_MS / 1000)),
      thinking: "minimal",
      message: prompt,
    });
    text = result.text;
  }

  logger("INFO", "AI API call completed", {
    workflow: flow.name,
    step: 1,
    totalSteps: 1,
    purpose: "执行后台配置业务流",
    model: llm.model,
    durationMs: Date.now() - startedAt,
  });
  const prefix = flow.replyPrefix ? `${flow.replyPrefix.trim()}\n` : "";
  return truncateReply(`${prefix}${text}`);
}

async function handleMessage(cfg, contextTokens, msg) {
  const fromUserId = msg?.from_user_id;
  if (!fromUserId) return;

  const text = extractText(msg.item_list);
  if (!text) return;

  const contextToken = msg.context_token || contextTokens[fromUserId];
  if (!contextToken) {
    log("WARN", "Skip message without context_token", { fromUserId, text });
    return;
  }

  const pendingActions = readJson(PENDING_PATH, {});
  if (cleanupExpiredPending(pendingActions)) {
    writeJson(PENDING_PATH, pendingActions);
  }

  contextTokens[fromUserId] = contextToken;
  writeJson(CONTEXT_PATH, contextTokens);
  writeJson(LAST_ACTIVE_PEER_PATH, {
    userId: fromUserId,
    contextToken,
    updatedAt: new Date().toISOString(),
  });

  const workflowRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runStartedAt = Date.now();
  const runLogger = (level, message, extra) => {
    log(level, message, {
      workflowRunId,
      userText: text,
      ...extra,
    });
  };

  runLogger("INFO", "Workflow run started", { fromUserId, text });
  runLogger("INFO", "Inbound text", { fromUserId, text, llmMode: cfg.llm.mode, model: cfg.llm.model });
  try {
    let reply = null;
    const normalizedText = text.trim().toLowerCase();
    const pending = pendingActions[fromUserId];

    if (pending?.type === "ai_intel_confirm") {
      if (isPendingExpired(pending)) {
        delete pendingActions[fromUserId];
        writeJson(PENDING_PATH, pendingActions);
        reply = EXPIRED_CONFIRM_REPLY;
      } else if (CONFIRM_WORDS.has(normalizedText)) {
        delete pendingActions[fromUserId];
        writeJson(PENDING_PATH, pendingActions);
        const workflowResult = await maybeRunAiIntelWorkflow({
          baseDir: process.cwd(),
          llm: cfg.workflowLlm,
          userText: pending.originalText,
          logger: runLogger,
          modelTimeoutMs: WORKFLOW_MODEL_TIMEOUT_MS,
          force: true,
        });
        reply = workflowResult?.handled
          ? workflowResult.replyText
          : await callModel(cfg.llm, pending.originalText, fromUserId, runLogger);
      } else if (CANCEL_WORDS.has(normalizedText)) {
        delete pendingActions[fromUserId];
        writeJson(PENDING_PATH, pendingActions);
        reply = CANCEL_REPLY;
      }
    } else if (pending?.type === "content_opportunity_confirm") {
      if (isPendingExpired(pending)) {
        delete pendingActions[fromUserId];
        writeJson(PENDING_PATH, pendingActions);
        reply = EXPIRED_CONFIRM_REPLY;
      } else if (CONFIRM_WORDS.has(normalizedText)) {
        delete pendingActions[fromUserId];
        writeJson(PENDING_PATH, pendingActions);
        const draftRequest =
          pending?.draftRequest ||
          "帮我把今天情报里适合做内容的部分做成一个完整的小红书发布包";
        const task = createWechatXiaohongshuTask({
          userText: draftRequest,
          fromUserId,
          contextToken,
          logger: runLogger,
        });
        reply = `${XIAOHONGSHU_TASK_CREATED_REPLY}\n任务 ID：${task.id}`;
      } else if (CANCEL_WORDS.has(normalizedText)) {
        delete pendingActions[fromUserId];
        writeJson(PENDING_PATH, pendingActions);
        reply = CANCEL_REPLY;
      }
    }

    if (!reply) {
      const weatherIntent = parseWeatherIntent(text);
      if (weatherIntent?.type === "set-city") {
        if (!weatherIntent.city) {
          reply = "你可以这样设置默认城市：设置城市 成都";
        } else {
          setUserDefaultCity(fromUserId, weatherIntent.city);
          reply = `已把你的默认城市设置为：${weatherIntent.city}\n以后直接问“今天什么天气”，我就按这个城市查。`;
        }
      } else if (weatherIntent?.type === "weather") {
        const assistantConfig = loadAssistantConfig();
        if (!assistantConfig.weatherEnabled) {
          reply = "后台暂时关闭了天气查询。";
        } else {
          const city = weatherIntent.city || getUserDefaultCity(fromUserId) || assistantConfig.defaultCity;
          if (!city) {
            reply = "我还不知道你要查哪个城市。你可以在后台设置微信助手默认城市，或直接发：设置城市 成都";
          } else {
            try {
              const weather = await runWeatherSkill({ city, range: weatherIntent.range, logger: runLogger });
              reply = buildWeatherSkillReply(city, weatherIntent.range, weather);
            } catch (error) {
              runLogger("WARN", "Weather query failed", { city, error: String(error?.message || error) });
              reply = "天气接口这次没有返回结果，稍后再试一下。";
            }
          }
        }
      } else if (isQuickMenuCommand(text)) {
        reply = buildQuickMenuReply();
      } else if (isXiaohongshuHelpCommand(text)) {
        reply = buildXiaohongshuHelpReply();
      } else if (isMorningBriefCommand(text)) {
        const latestBrief = readJson(LATEST_BRIEF_PATH, null);
        reply = buildMorningBriefReply(latestBrief);
      } else {
        const customBusinessFlowMatch = matchCustomBusinessFlow(text);
        if (customBusinessFlowMatch) {
          const { flow, trigger } = customBusinessFlowMatch;
          await sendWechatText(cfg.wechat, {
            toUserId: fromUserId,
            contextToken,
            text: `收到，正在执行「${flow.name}」业务流，稍等片刻。`,
          });
          runLogger("INFO", "Custom business flow matched", {
            workflow: flow.name,
            flowId: flow.id,
            trigger,
          });
          reply = await callCustomBusinessFlowModel(cfg.workflowLlm, flow, text, fromUserId, runLogger);
        } else if (isXiaohongshuDirectCommand(text)) {
          const task = createWechatXiaohongshuTask({
            userText: text,
            fromUserId,
            contextToken,
            logger: runLogger,
          });
          reply = `${XIAOHONGSHU_TASK_CREATED_REPLY}\n任务 ID：${task.id}`;
        }
        if (!reply) {
          const contentOpportunityIntent = classifyContentOpportunityIntent(text);
          const financeBriefIntent = classifyFinanceBriefIntent(text);
          if (contentOpportunityIntent.mode === "suggest") {
            await sendWechatText(cfg.wechat, {
              toUserId: fromUserId,
              contextToken,
              text: PROCESSING_REPLY,
            });
            const workflowResult = await maybeRunAiIntelWorkflow({
              baseDir: process.cwd(),
              llm: cfg.workflowLlm,
              userText: text,
              logger: runLogger,
              modelTimeoutMs: WORKFLOW_MODEL_TIMEOUT_MS,
              force: true,
            });
            if (workflowResult?.handled) {
              pendingActions[fromUserId] = {
                type: "content_opportunity_confirm",
                originalText: text,
                draftRequest: "帮我把今天情报里适合做内容的部分做成一个完整的小红书发布包",
                createdAt: new Date().toISOString(),
              };
              writeJson(PENDING_PATH, pendingActions);
              reply = buildContentOpportunitySuggestion(workflowResult);
            } else {
              reply = await callModel(cfg.llm, text, fromUserId, runLogger);
            }
          } else if (financeBriefIntent.mode === "direct") {
            const financeBriefResult = await maybeRunFinanceBriefWorkflow({
              llm: cfg.workflowLlm,
              userText: text,
              logger: runLogger,
              modelTimeoutMs: WORKFLOW_MODEL_TIMEOUT_MS,
            });
            reply = financeBriefResult?.handled ? financeBriefResult.replyText : await callModel(cfg.llm, text, fromUserId, runLogger);
          } else {
            const financeIntent = classifyFinanceNewsIntent(text);
            if (financeIntent.mode === "direct") {
              const financeResult = await maybeRunFinanceNewsWorkflow({
                llm: cfg.workflowLlm,
                userText: text,
                logger: runLogger,
                modelTimeoutMs: WORKFLOW_MODEL_TIMEOUT_MS,
              });
              reply = financeResult?.handled ? financeResult.replyText : await callModel(cfg.llm, text, fromUserId, runLogger);
            } else {
              const intent = classifyAiIntelIntentV2(text);
              if (intent.mode === "confirm") {
                pendingActions[fromUserId] = {
                  type: "ai_intel_confirm",
                  originalText: text,
                  createdAt: new Date().toISOString(),
                };
                writeJson(PENDING_PATH, pendingActions);
                reply = buildAiIntelConfirmationReply();
              } else if (intent.mode === "direct") {
                await sendWechatText(cfg.wechat, {
                  toUserId: fromUserId,
                  contextToken,
                  text: PROCESSING_REPLY,
                });
                const workflowResult = await maybeRunAiIntelWorkflow({
                  baseDir: process.cwd(),
                  llm: cfg.workflowLlm,
                  userText: text,
                  logger: runLogger,
                  modelTimeoutMs: WORKFLOW_MODEL_TIMEOUT_MS,
                });
                reply = workflowResult?.handled ? workflowResult.replyText : await callModel(cfg.llm, text, fromUserId, runLogger);
              } else {
              reply = await callModel(cfg.llm, text, fromUserId, runLogger);
            }
          }
        }
      }
      }
    }

    await sendWechatText(cfg.wechat, {
      toUserId: fromUserId,
      contextToken,
      text: reply,
    });
    runLogger("INFO", "Replied", { fromUserId, reply });
    runLogger("INFO", "Workflow run completed", {
      fromUserId,
      durationMs: Date.now() - runStartedAt,
      status: "completed",
    });
  } catch (error) {
    runLogger("ERROR", "Handle message failure", { fromUserId, text, error: String(error) });
    if (
      classifyAiIntelIntentV2(text).mode === "direct" ||
      classifyFinanceNewsIntent(text).mode === "direct"
    ) {
      await sendWechatText(cfg.wechat, {
        toUserId: fromUserId,
        contextToken,
        text: WORKFLOW_FAILED_REPLY,
      });
      runLogger("INFO", "Replied", { fromUserId, reply: WORKFLOW_FAILED_REPLY });
    }
    runLogger("ERROR", "Workflow run completed", {
      fromUserId,
      durationMs: Date.now() - runStartedAt,
      status: "failed",
      error: String(error),
    });
  }
}

async function main() {
  const cfg = loadBridgeConfig();
  let syncState = readJsonWithFallback(SYNC_PATH, REMOTE_SYNC_PATH, { get_updates_buf: "" });
  const contextTokens = readJsonWithFallback(CONTEXT_PATH, REMOTE_CONTEXT_PATH, {});

  log("INFO", "Bridge starting", {
    accountId: ACCOUNT_ID,
    activeMode: cfg.activeModeName,
    llmMode: cfg.llm.mode,
    model: cfg.llm.model,
    providerId: cfg.llm.providerId,
    workflowModel: cfg.workflowLlm.model,
    workflowProviderId: cfg.workflowLlm.providerId,
    wechatBaseUrl: cfg.wechat.baseUrl,
    llmBaseUrl: cfg.llm.baseUrl || null,
  });

  while (true) {
    try {
      const resp = await getUpdates(cfg.wechat, syncState.get_updates_buf || "");
      log("INFO", "Poll result", {
        ret: resp?.ret ?? null,
        msgCount: Array.isArray(resp?.msgs) ? resp.msgs.length : 0,
        hasBuf: Boolean(resp?.get_updates_buf),
        errcode: resp?.errcode ?? null,
      });
      if (resp?.get_updates_buf) {
        syncState = { get_updates_buf: resp.get_updates_buf };
        writeJson(SYNC_PATH, syncState);
      }

      if ((resp?.ret ?? 0) !== 0) {
        log("WARN", "getUpdates returned error", {
          ret: resp?.ret,
          errcode: resp?.errcode,
          errmsg: resp?.errmsg,
        });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      const list = Array.isArray(resp?.msgs) ? resp.msgs : [];
      for (const msg of list) {
        log("INFO", "Received message", summarizeMessage(msg));
        await handleMessage(cfg, contextTokens, msg);
      }
    } catch (error) {
      log("ERROR", "Loop failure", { error: String(error) });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

main().catch((error) => {
  log("ERROR", "Fatal startup failure", { error: String(error) });
  process.exitCode = 1;
});
