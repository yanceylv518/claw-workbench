import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDbPath, initLocalDb, openLocalDb } from "../../../packages/db/src/local-db.mjs";
import { getRunnerState } from "../services/task-executor.mjs";
import { listWorkflowDefinitions } from "../services/workflow-definitions.mjs";
import { sendJson } from "../utils/http.mjs";

const SERVICE_NAME = "小龙虾本地 API";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function runtimeSummary() {
  const cwd = process.cwd();
  const root = ROOT;
  const wrongPattern = /覆盖升级包|overlay-upgrade/i;
  const wrongRunDir = wrongPattern.test(cwd) || wrongPattern.test(root);
  const runDir = wrongPattern.test(cwd) ? cwd : root;
  const suggestedDir = runDir
    .replace(/-覆盖升级包$/i, "")
    .replace(/\\xiaolongxia-overlay-upgrade$/i, "\\xiaolongxia-local");
  return {
    cwd,
    root,
    wrongRunDir,
    suggestedDir,
    message: wrongRunDir
      ? `当前运行在覆盖升级包目录：${runDir}。请关闭当前窗口，进入原安装目录运行“启动小龙虾.bat”：${suggestedDir}`
      : "",
  };
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function packageSummary() {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const count = db.prepare("SELECT count(*) AS count FROM content_packages").get()?.count || 0;
    const latest = db.prepare(`
      SELECT *
      FROM content_packages
      ORDER BY COALESCE(updated_at, generated_at, indexed_at) DESC
      LIMIT 1
    `).get();
    return {
      count,
      latest: latest ? {
        id: latest.id,
        kind: latest.kind,
        name: latest.id,
        title: latest.title,
        path: latest.package_dir || latest.markdown_path || latest.source_path,
        updatedAt: latest.updated_at || latest.generated_at || latest.indexed_at,
        publishStatus: latest.status,
        notionStatus: latest.notion_status,
        imageCount: latest.image_count,
      } : null,
      items: [],
    };
  } finally {
    db.close();
  }
}

function statusPayload(port) {
  const notionConfig = readJson(path.join(ROOT, "notion-ai-intel.config.json"), {});
  const bridgeConfig = readJson(path.join(ROOT, "wechat-bridge.config.json"), {});
  const openclawHome = process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || "", ".openclaw");
  const openclawConfig = readJson(path.join(openclawHome, "openclaw.json"), {});
  const activeModeName = bridgeConfig.active_mode || "";
  const activeMode = bridgeConfig.modes?.[activeModeName] || {};
  const providerId = activeMode.provider_id || "";
  const provider = openclawConfig.models?.providers?.[providerId] || {};
  const modelConfigured = Boolean(providerId && provider.baseUrl && provider.apiKey && activeMode.model);
  const notionEnabled = notionConfig.enabled === true;
  const notionIntelConfigured = notionEnabled && Boolean(notionConfig.notion?.token && notionConfig.notion?.database_id);
  const notionContentConfigured = notionEnabled && Boolean(notionConfig.content_publish?.token && notionConfig.content_publish?.database_id);
  const entries = [
    { id: "wechat", name: "微信助手", type: "wechat", enabled: true, status: "active", description: "本地微信入口" },
    { id: "web", name: "网页后台入口", type: "web", enabled: true, status: "active", description: "本地后台入口" },
  ];

  return {
    ok: true,
    service: SERVICE_NAME,
    port,
    workflows: listWorkflowDefinitions(),
    packages: packageSummary(),
    hermes: {
      enabled: Boolean(notionConfig.hermes?.enabled),
      mode: notionConfig.hermes?.mode || "",
      provider: notionConfig.hermes?.provider || "",
    },
    model: {
      configured: modelConfigured,
      providerId,
      model: activeMode.model || "",
      baseUrlConfigured: Boolean(provider.baseUrl),
      apiKeyConfigured: Boolean(provider.apiKey),
    },
    notion: {
      enabled: notionEnabled,
      intelConfigured: notionIntelConfigured,
      contentConfigured: notionContentConfigured,
    },
    entryConfig: { entries },
    runtime: runtimeSummary(),
    runner: getRunnerState(),
    dbPath: getDbPath(),
  };
}

export function handleHealthRoute({ url, res, port }) {
  if (url.pathname === "/api/status") {
    sendJson(res, statusPayload(port));
    return true;
  }


  if (url.pathname !== "/api/local/health") return false;

  sendJson(res, statusPayload(port));
  return true;
}
