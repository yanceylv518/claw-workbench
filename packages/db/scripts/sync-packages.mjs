import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { initLocalDb, openLocalDb, getDataDir, getDbPath } from "../src/local-db.mjs";

const DATA_DIR = getDataDir();
const DRAFTS_DIR = process.env.XIAOLONGXIA_DRAFTS_DIR || path.join(DATA_DIR, "xiaohongshu-drafts");
const EXTRA_DRAFTS_DIRS = [
  ...(process.env.XIAOLONGXIA_EXTRA_DRAFTS_DIRS || "").split(path.delimiter),
  path.join(process.cwd(), ".wechat-direct-bridge", "xiaohongshu-drafts"),
].map((item) => String(item || "").trim()).filter(Boolean);

function idFor(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function asText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isSqliteSidecar(name) {
  const lower = String(name || "").toLowerCase();
  return lower.endsWith(".db")
    || lower.endsWith(".db-wal")
    || lower.endsWith(".db-shm")
    || lower.endsWith(".sqlite")
    || lower.endsWith(".sqlite-wal")
    || lower.endsWith(".sqlite-shm");
}

function normalizePackageStatus(value) {
  const raw = asText(value).toLowerCase();
  if (["published", "synced", "completed", "done", "已发布", "已完成"].includes(raw)) return "completed";
  if (["disabled", "archived", "已停用", "已归档"].includes(raw)) return "archived";
  if (["failed", "error", "失败", "异常"].includes(raw)) return "failed";
  if (["running", "queued", "pending", "processing", "处理中", "生成中", "排队中"].includes(raw)) return "processing";
  return "review";
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function findPackageJson(dir) {
  const candidates = ["发布包数据.json", "package.json"];
  for (const name of candidates) {
    const candidate = path.join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function findMarkdown(dir, title) {
  const candidates = ["完整发布包.md", "发布包.md", "publish-package.md", `${title}.md`].filter(Boolean);
  for (const name of candidates) {
    const candidate = path.join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const firstMd = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
  return firstMd ? path.join(dir, firstMd.name) : null;
}

function summarizeRaw(payload) {
  const draft = payload?.draft || {};
  return JSON.stringify({
    packageType: payload?.packageType || null,
    subtitle: draft.subtitle || null,
    hook: draft.hook || null,
    hashtags: Array.isArray(draft.hashtags) ? draft.hashtags.slice(0, 12) : [],
    topicLabel: payload?.topicLabel || null,
  });
}

async function packageFromDirectory(dirPath) {
  let jsonPath = null;
  let stat = null;
  try {
    jsonPath = await findPackageJson(dirPath);
    if (!jsonPath) return null;
    stat = await fs.stat(jsonPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const payload = await readJson(jsonPath);
  if (!payload) return null;
  const draft = payload.draft || {};
  const title = asText(draft.title || payload.title || path.basename(dirPath), path.basename(dirPath));
  const markdownPath = await findMarkdown(dirPath, title);
  const quality = payload.businessFlow?.qualityReview || payload.qualityReview || {};
  const human = payload.businessFlow?.humanEditorReview || payload.humanEditorReview || {};
  const notion = payload.notion || {};
  const images = payload.images || {};
  return {
    id: idFor(dirPath),
    title,
    platform: "xiaohongshu",
    kind: asText(payload.packageType || "publish-package", "publish-package"),
    status: normalizePackageStatus(payload.publishStatus),
    notionStatus: asText(notion.status || ""),
    notionPageId: asText(notion.pageId || ""),
    notionUrl: asText(notion.url || ""),
    qualityScore: asNumber(quality.score),
    aiFlavorScore: asNumber(human.ai_flavor_score),
    humanTraceScore: asNumber(human.human_trace_score),
    imageCount: Array.isArray(images.files) ? images.files.length : 0,
    packageDir: dirPath,
    packageJsonPath: jsonPath,
    markdownPath,
    sourcePath: dirPath,
    sourceMtimeMs: Math.trunc(stat.mtimeMs),
    generatedAt: asText(payload.generatedAt || ""),
    updatedAt: asText(payload.updatedAt || payload.publishStatusUpdatedAt || stat.mtime.toISOString()),
    indexedAt: new Date().toISOString(),
    rawSummary: summarizeRaw(payload),
  };
}

async function packageFromLegacyFile(filePath) {
  const payload = await readJson(filePath);
  if (!payload) return null;
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const draft = payload?.draft || payload || {};
  const title = asText(draft.title || payload?.title || path.basename(filePath, ".json"), path.basename(filePath, ".json"));
  const markdownPath = filePath.replace(/\.json$/i, ".md");
  return {
    id: idFor(filePath),
    title,
    platform: "xiaohongshu",
    kind: "legacy-file",
    status: normalizePackageStatus(payload?.publishStatus),
    notionStatus: asText(payload?.notion?.status || ""),
    notionPageId: asText(payload?.notion?.pageId || ""),
    notionUrl: asText(payload?.notion?.url || ""),
    qualityScore: asNumber(payload?.qualityReview?.score),
    aiFlavorScore: asNumber(payload?.humanEditorReview?.ai_flavor_score),
    humanTraceScore: asNumber(payload?.humanEditorReview?.human_trace_score),
    imageCount: Array.isArray(payload?.images?.files) ? payload.images.files.length : 0,
    packageDir: path.dirname(filePath),
    packageJsonPath: filePath,
    markdownPath: (await exists(markdownPath)) ? markdownPath : null,
    sourcePath: filePath,
    sourceMtimeMs: Math.trunc(stat.mtimeMs),
    generatedAt: asText(payload?.generatedAt || ""),
    updatedAt: asText(payload?.updatedAt || stat.mtime.toISOString()),
    indexedAt: new Date().toISOString(),
    rawSummary: summarizeRaw(payload || {}),
  };
}

async function collectPackagesFromDir(draftsDir) {
  const items = [];
  const entries = await fs.readdir(draftsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isSqliteSidecar(entry.name)) continue;
    const fullPath = path.join(draftsDir, entry.name);
    try {
      if (entry.isDirectory()) {
        const item = await packageFromDirectory(fullPath);
        if (item) items.push(item);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        const item = await packageFromLegacyFile(fullPath);
        if (item) items.push(item);
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return items;
}

async function collectPackages() {
  const items = [];
  const dirs = [...new Set([DRAFTS_DIR, ...EXTRA_DRAFTS_DIRS].map((item) => path.resolve(item)))];
  for (const draftsDir of dirs) {
    if (!(await exists(draftsDir))) continue;
    items.push(...await collectPackagesFromDir(draftsDir));
  }
  return { items, dirs };
}

function upsertPackage(db, item) {
  db.prepare(`
    INSERT INTO content_packages (
      id, title, platform, kind, status, notion_status, notion_page_id, notion_url,
      quality_score, ai_flavor_score, human_trace_score, image_count,
      package_dir, package_json_path, markdown_path, source_path, source_mtime_ms,
      generated_at, updated_at, indexed_at, raw_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      title = excluded.title,
      platform = excluded.platform,
      kind = excluded.kind,
      status = excluded.status,
      notion_status = excluded.notion_status,
      notion_page_id = excluded.notion_page_id,
      notion_url = excluded.notion_url,
      quality_score = excluded.quality_score,
      ai_flavor_score = excluded.ai_flavor_score,
      human_trace_score = excluded.human_trace_score,
      image_count = excluded.image_count,
      package_dir = excluded.package_dir,
      package_json_path = excluded.package_json_path,
      markdown_path = excluded.markdown_path,
      source_mtime_ms = excluded.source_mtime_ms,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at,
      indexed_at = excluded.indexed_at,
      raw_summary = excluded.raw_summary
  `).run(
    item.id,
    item.title,
    item.platform,
    item.kind,
    item.status,
    item.notionStatus,
    item.notionPageId,
    item.notionUrl,
    item.qualityScore,
    item.aiFlavorScore,
    item.humanTraceScore,
    item.imageCount,
    item.packageDir,
    item.packageJsonPath,
    item.markdownPath,
    item.sourcePath,
    item.sourceMtimeMs,
    item.generatedAt,
    item.updatedAt,
    item.indexedAt,
    item.rawSummary,
  );
}

async function main() {
  const primaryExists = await exists(DRAFTS_DIR);
  const extraExists = await Promise.all(EXTRA_DRAFTS_DIRS.map((dir) => exists(dir)));
  if (!primaryExists && !extraExists.some(Boolean)) {
    throw new Error(`Drafts directory not found: ${DRAFTS_DIR}`);
  }

  const db = openLocalDb();
  initLocalDb(db);
  const { items, dirs } = await collectPackages();

  db.exec("BEGIN;");
  try {
    for (const item of items) upsertPackage(db, item);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }

  console.log(JSON.stringify({
    ok: true,
    dbPath: getDbPath(),
    draftsDir: DRAFTS_DIR,
    draftsDirs: dirs,
    indexed: items.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
