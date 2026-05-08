import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || "", ".openclaw");
const ACCOUNT_ID = process.env.WECHAT_ACCOUNT_ID || "8f7c91dbe672-im-bot";
const ACCOUNT_PATH = path.join(OPENCLAW_HOME, "openclaw-weixin", "accounts", `${ACCOUNT_ID}.json`);
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const LOCAL_STATE_DIR = path.join(process.cwd(), ".wechat-direct-bridge");
const CONTEXT_PATH = path.join(LOCAL_STATE_DIR, `${ACCOUNT_ID}.context-tokens.json`);
const LAST_ACTIVE_PEER_PATH = path.join(LOCAL_STATE_DIR, `${ACCOUNT_ID}.last-active-peer.json`);
const WEIXIN_PLUGIN_PACKAGE_PATH = path.join(
  OPENCLAW_HOME,
  "extensions",
  "openclaw-weixin",
  "package.json",
);
const SEND_TIMEOUT_MS = 20000;

function aesEcbPaddedSize(rawsize) {
  return Math.ceil(Number(rawsize || 0) / 16) * 16;
}

function encryptAesEcb(buf, aeskey) {
  const cipher = crypto.createCipheriv("aes-128-ecb", aeskey, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildClientVersion(version) {
  const parts = String(version || "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function loadWeixinPluginMeta() {
  const pkg = readJson(WEIXIN_PLUGIN_PACKAGE_PATH, {});
  return {
    appId: String(pkg?.ilink_appid || "bot"),
    clientVersion: String(buildClientVersion(pkg?.version || "0.0.0")),
    channelVersion: String(pkg?.version || "standalone-bridge"),
  };
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

function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function getImageSize(filePath, buf) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png" && buf.length >= 24) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  return { width: 0, height: 0 };
}

async function getUploadUrl(wechat, { filekey, mediaType, rawsize, rawfilemd5, filesize, aeskey }) {
  const body = {
    filekey,
    media_type: mediaType,
    to_user_id: wechat.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey,
    base_info: buildBaseInfo(),
  };
  const bodyText = JSON.stringify(body);
  return postJson({
    url: new URL("ilink/bot/getuploadurl", wechat.baseUrl).toString(),
    headers: buildWechatHeaders(bodyText, wechat.token, wechat.accountId),
    body: bodyText,
    timeoutMs: SEND_TIMEOUT_MS,
  });
}

async function uploadBufferToCdn({ buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = uploadFullUrl?.trim()
    ? uploadFullUrl.trim()
    : buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey);
  const res = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CDN upload failed: ${res.status} ${text}`);
  }
  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload missing x-encrypted-param");
  }
  return { downloadParam };
}

export function loadTarget() {
  const account = readJson(ACCOUNT_PATH, null);
  if (!account?.token || !account?.baseUrl || !account?.userId) {
    throw new Error(`Missing or invalid WeChat account file: ${ACCOUNT_PATH}`);
  }
  const contextMap = readJson(CONTEXT_PATH, {});
  const lastActivePeer = readJson(LAST_ACTIVE_PEER_PATH, null);
  const toUserId = String(lastActivePeer?.userId || account.userId || "").trim();
  const contextToken = String(lastActivePeer?.contextToken || contextMap[toUserId] || "").trim();
  if (!contextToken) {
    throw new Error(`Missing context token for target user: ${toUserId}`);
  }
  return {
    token: account.token,
    baseUrl: ensureTrailingSlash(account.baseUrl),
    accountId: ACCOUNT_ID,
    toUserId,
    contextToken,
  };
}

export async function sendWechatText(wechat, text, clientPrefix = "manual") {
  const bodyText = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: wechat.toUserId,
      client_id: `${clientPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      context_token: wechat.contextToken,
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

export async function sendWechatFile(wechat, filePath, fileName, clientPrefix = "manual-file") {
  const account = readJson(ACCOUNT_PATH, null);
  const cdnBaseUrl = ensureTrailingSlash(String(account?.baseUrl || "").trim()).replace(/\/+$/, "");
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadInfo = await getUploadUrl(wechat, {
    filekey,
    mediaType: 3,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });

  const uploaded = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadInfo.upload_full_url,
    uploadParam: uploadInfo.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
  });

  const body = {
    msg: {
      from_user_id: "",
      to_user_id: wechat.toUserId,
      client_id: `${clientPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      context_token: wechat.contextToken,
      item_list: [
        {
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(aeskey).toString("base64"),
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(rawsize),
          },
        },
      ],
    },
    base_info: buildBaseInfo(),
  };
  const bodyText = JSON.stringify(body);
  await postJson({
    url: new URL("ilink/bot/sendmessage", wechat.baseUrl).toString(),
    headers: buildWechatHeaders(bodyText, wechat.token, wechat.accountId),
    body: bodyText,
    timeoutMs: SEND_TIMEOUT_MS,
  });
}

export async function sendWechatImage(wechat, filePath, clientPrefix = "manual-image") {
  const account = readJson(ACCOUNT_PATH, null);
  const cdnBaseUrl = ensureTrailingSlash(String(account?.baseUrl || "").trim()).replace(/\/+$/, "");
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const { width, height } = getImageSize(filePath, plaintext);

  const uploadInfo = await getUploadUrl(wechat, {
    filekey,
    mediaType: 1,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });

  const uploaded = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadInfo.upload_full_url,
    uploadParam: uploadInfo.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
  });

  const body = {
    msg: {
      from_user_id: "",
      to_user_id: wechat.toUserId,
      client_id: `${clientPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      context_token: wechat.contextToken,
      item_list: [
        {
          type: 3,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(aeskey).toString("base64"),
              encrypt_type: 1,
            },
            width: String(width || 0),
            height: String(height || 0),
          },
        },
      ],
    },
    base_info: buildBaseInfo(),
  };
  const bodyText = JSON.stringify(body);
  await postJson({
    url: new URL("ilink/bot/sendmessage", wechat.baseUrl).toString(),
    headers: buildWechatHeaders(bodyText, wechat.token, wechat.accountId),
    body: bodyText,
    timeoutMs: SEND_TIMEOUT_MS,
  });
}
