import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readJsonBody, sendJson } from "../utils/http.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATA_DIR = process.env.XIAOLONGXIA_DATA_DIR || path.join(ROOT, "data", "runtime");
const BRIDGE_CONFIG_PATH = path.join(ROOT, "wechat-bridge.config.json");
const BRIDGE_LOG_PATH = process.env.XIAOLONGXIA_LOG_PATH || path.join(DATA_DIR, "wechat-direct-bridge.log");
const START_SCRIPT = path.join(ROOT, "start-wechat-direct-bridge.ps1");
const STOP_SCRIPT = path.join(ROOT, "stop-wechat-direct-bridge.ps1");
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || "", ".openclaw");
const WEIXIN_STATE_DIR = path.join(OPENCLAW_HOME, "openclaw-weixin");
const WEIXIN_ACCOUNTS_DIR = path.join(WEIXIN_STATE_DIR, "accounts");
const WEIXIN_ACCOUNTS_INDEX = path.join(WEIXIN_STATE_DIR, "accounts.json");
const DEFAULT_ACCOUNT_ID = process.env.WECHAT_ACCOUNT_ID || "8f7c91dbe672-im-bot";
const WEIXIN_API_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (1 << 8) | 9;
const LOGIN_TTL_MS = 5 * 60 * 1000;
const require = createRequire(import.meta.url);

const loginSessions = new Map();

function runPowerShell(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
      { cwd: ROOT, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function randomWechatUin() {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function weixinHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

async function weixinGet(endpoint, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${WEIXIN_API_BASE_URL.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    const res = await fetch(url, { headers: weixinHeaders(), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAccountId(value) {
  return String(value || DEFAULT_ACCOUNT_ID)
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|@.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || DEFAULT_ACCOUNT_ID;
}

function buildQrSvg(value) {
  let qrRoot = "";
  try {
    qrRoot = path.dirname(require.resolve("qrcode-terminal/vendor/QRCode/index.js"));
  } catch {
    qrRoot = path.join(OPENCLAW_HOME, "extensions", "openclaw-weixin", "node_modules", "qrcode-terminal", "vendor", "QRCode");
  }
  const QRCode = require(path.join(qrRoot, "index.js"));
  const QRErrorCorrectLevel = require(path.join(qrRoot, "QRErrorCorrectLevel.js"));
  const qrcode = new QRCode(-1, QRErrorCorrectLevel.L);
  qrcode.addData(value);
  qrcode.make();
  const count = qrcode.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  const rects = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qrcode.isDark(row, col)) rects.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}

function buildQrSvgDataUrl(value) {
  const svg = buildQrSvg(value);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

async function registerAccountId(accountId) {
  await fs.mkdir(WEIXIN_STATE_DIR, { recursive: true });
  let accounts = [];
  try {
    const parsed = JSON.parse(await fs.readFile(WEIXIN_ACCOUNTS_INDEX, "utf8"));
    accounts = Array.isArray(parsed) ? parsed : [];
  } catch {
    accounts = [];
  }
  if (!accounts.includes(accountId)) accounts.push(accountId);
  await fs.writeFile(WEIXIN_ACCOUNTS_INDEX, JSON.stringify(accounts, null, 2), "utf8");
}

async function saveWeixinAccount({ accountId, botId, botToken, baseUrl, userId }) {
  const normalizedId = normalizeAccountId(accountId || botId || DEFAULT_ACCOUNT_ID);
  const token = String(botToken || "").includes(":") ? String(botToken) : `${botId}:${botToken}`;
  const payload = {
    token,
    savedAt: new Date().toISOString(),
    baseUrl: baseUrl || WEIXIN_API_BASE_URL,
    ...(userId ? { userId } : {}),
  };
  await fs.mkdir(WEIXIN_ACCOUNTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(WEIXIN_ACCOUNTS_DIR, `${normalizedId}.json`),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  if (normalizedId !== DEFAULT_ACCOUNT_ID) {
    await fs.writeFile(
      path.join(WEIXIN_ACCOUNTS_DIR, `${DEFAULT_ACCOUNT_ID}.json`),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  }
  await registerAccountId(normalizedId);
  await registerAccountId(DEFAULT_ACCOUNT_ID);
  return normalizedId;
}

function purgeLoginSessions() {
  const now = Date.now();
  for (const [key, session] of loginSessions.entries()) {
    if (now - session.startedAt > LOGIN_TTL_MS) loginSessions.delete(key);
  }
}

async function startLoginSession(action) {
  purgeLoginSessions();
  if (action === "restart") {
    await runPowerShell(["-File", STOP_SCRIPT], 30000);
  }
  const response = await weixinGet("ilink/bot/get_bot_qrcode?bot_type=3");
  const sessionKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const session = {
    sessionKey,
    qrcode: response.qrcode,
    qrcodeUrl: response.qrcode_img_content,
    startedAt: Date.now(),
    status: "wait",
    action,
  };
  loginSessions.set(sessionKey, session);
  return {
    ...await wechatBridgeStatus(),
    login: {
      sessionKey,
      qrcodeUrl: session.qrcodeUrl,
      qrcodeImage: buildQrSvgDataUrl(session.qrcodeUrl),
      qrcodeImageUrl: `/api/local/entries/wechat-bridge/qr/${encodeURIComponent(sessionKey)}.svg`,
      status: session.status,
      message: "请使用微信扫码，并在手机上确认连接。",
      expiresAt: new Date(session.startedAt + LOGIN_TTL_MS).toISOString(),
    },
  };
}

async function checkLoginSession(sessionKey) {
  purgeLoginSessions();
  const session = loginSessions.get(sessionKey);
  if (!session) {
    return {
      ...await wechatBridgeStatus(),
      login: { status: "expired", message: "二维码已过期，请重新生成。" },
    };
  }

  const response = await weixinGet(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`, 35000);
  session.status = response.status || "wait";

  if (session.status === "confirmed") {
    if (!response.ilink_bot_id || !response.bot_token) {
      loginSessions.delete(sessionKey);
      return {
        ...await wechatBridgeStatus(),
        login: { status: "failed", message: "扫码已确认，但微信服务未返回完整凭证。" },
      };
    }
    const accountId = await saveWeixinAccount({
      accountId: response.ilink_bot_id,
      botId: response.ilink_bot_id,
      botToken: response.bot_token,
      baseUrl: response.baseurl,
      userId: response.ilink_user_id,
    });
    await runPowerShell(["-File", START_SCRIPT], 45000);
    loginSessions.delete(sessionKey);
    return {
      ...await wechatBridgeStatus(),
      login: {
        status: "confirmed",
        connected: true,
        accountId,
        message: "微信扫码连接成功，bridge 已启动。",
      },
    };
  }

  if (session.status === "expired") loginSessions.delete(sessionKey);

  return {
    ...await wechatBridgeStatus(),
    login: {
      sessionKey,
      qrcodeUrl: session.qrcodeUrl,
      qrcodeImage: buildQrSvgDataUrl(session.qrcodeUrl),
      qrcodeImageUrl: `/api/local/entries/wechat-bridge/qr/${encodeURIComponent(sessionKey)}.svg`,
      status: session.status,
      message: session.status === "scaned" ? "已扫码，请在手机上确认。" : "等待微信扫码确认。",
      expiresAt: new Date(session.startedAt + LOGIN_TTL_MS).toISOString(),
    },
  };
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function tailLog(filePath, count = 12) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

async function getBridgeProcesses() {
  const command = [
    "$items = Get-CimInstance Win32_Process |",
    "Where-Object { $_.Name -match '^node(\\.exe)?$' -and $_.CommandLine -match 'wechat-direct-bridge\\.mjs' } |",
    "Select-Object ProcessId,CreationDate,CommandLine;",
    "$items | ConvertTo-Json -Depth 4",
  ].join(" ");
  const { stdout } = await runPowerShell(["-Command", command], 10000);
  const text = String(stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: item.ProcessId,
    creationDate: item.CreationDate,
    commandLine: item.CommandLine,
  }));
}

async function wechatBridgeStatus() {
  const config = await readJson(BRIDGE_CONFIG_PATH, {});
  const processes = await getBridgeProcesses();
  const logs = await tailLog(BRIDGE_LOG_PATH);
  const lastLog = logs[logs.length - 1] || "";
  return {
    ok: true,
    running: processes.length > 0,
    status: processes.length > 0 ? "online" : "offline",
    activeMode: config.active_mode || config.activeMode || "",
    processes,
    logPath: BRIDGE_LOG_PATH,
    logs,
    lastLog,
    updatedAt: new Date().toISOString(),
  };
}

async function controlBridge(action) {
  if (action === "start") {
    return startLoginSession("start");
  }
  if (action === "stop") {
    await runPowerShell(["-File", STOP_SCRIPT], 30000);
    return wechatBridgeStatus();
  }
  if (action === "restart") {
    return startLoginSession("restart");
  }
  if (action === "check-login") {
    return checkLoginSession(arguments[1]);
  }
  return null;
}

export async function handleEntryRoute({ req, res, url }) {
  const qrMatch = url.pathname.match(/^\/api\/local\/entries\/wechat-bridge\/qr\/(.+)\.svg$/);
  if (qrMatch && req.method === "GET") {
    const sessionKey = decodeURIComponent(qrMatch[1]);
    const session = loginSessions.get(sessionKey);
    if (!session) {
      res.writeHead(404, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="#fff"/><text x="80" y="82" text-anchor="middle" font-size="12" fill="#111">二维码已过期</text></svg>`);
      return true;
    }
    res.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(buildQrSvg(session.qrcodeUrl));
    return true;
  }

  if (url.pathname === "/api/local/entries/wechat-bridge" && req.method === "GET") {
    sendJson(res, await wechatBridgeStatus());
    return true;
  }

  if (url.pathname === "/api/local/entries/wechat-bridge" && req.method === "POST") {
    const body = await readJsonBody(req);
    const action = String(body.action || "").toLowerCase();
    const result = action === "check-login"
      ? await checkLoginSession(String(body.sessionKey || ""))
      : await controlBridge(action);
    if (!result) {
      sendJson(res, { error: "Unsupported bridge action" }, 400);
      return true;
    }
    sendJson(res, { ...result, action });
    return true;
  }

  return false;
}
