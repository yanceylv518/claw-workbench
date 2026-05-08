import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { initLocalDb, openLocalDb, getDbPath } from "../../../packages/db/src/local-db.mjs";
import { normalizeLimit } from "../utils/http.mjs";

const NOTION_VERSION = "2022-06-28";
const TEXT = {
  manualSource: "\u624b\u52a8\u5f55\u5165",
  uncategorized: "\u672a\u5206\u7c7b",
  notionSource: "Notion",
  localOnly: "local_only",
  syncedFromNotion: "synced_from_notion",
};
const EVALUATION_STATUSES = new Set(["unreviewed", "promising", "actionable", "watching", "archived", "discarded"]);
const RECOMMENDED_ACTIONS = new Set(["none", "create_post_package", "create_topic_task", "extract_knowledge", "monitor", "archive", "discard"]);
const PROCESSING_STATUSES = new Set(["unprocessed", "queued", "task_created", "package_created", "knowledge_extracted", "archived", "ignored"]);

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function rowToIntel(row) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary || "",
    source: row.source || "",
    sourceUrl: row.source_url || "",
    category: row.category || "",
    tags: parseJsonArray(row.tags_json),
    usage: row.usage || "",
    fitFor: parseJsonArray(row.fit_for_json),
    publishedAt: row.published_at || "",
    fetchedAt: row.fetched_at || "",
    notionPageId: row.notion_page_id || "",
    notionSyncStatus: row.notion_sync_status || "",
    evaluationStatus: row.evaluation_status || "unreviewed",
    valueScore: row.value_score ?? null,
    recommendedAction: row.recommended_action || "none",
    evaluationReason: row.evaluation_reason || "",
    reviewedAt: row.reviewed_at || "",
    reviewedBy: row.reviewed_by || "",
    processingStatus: row.processing_status || "unprocessed",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizePage(value) {
  const page = Number.parseInt(String(value || "1"), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function normalizePageSize(value) {
  const pageSize = Number.parseInt(String(value || "20"), 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 20;
  return Math.min(pageSize, 100);
}

function buildIntelWhere(searchParams) {
  const where = [];
  const params = {};

  const q = String(searchParams.get("q") || "").trim();
  if (q) {
    where.push("(title LIKE @q OR summary LIKE @q OR source LIKE @q OR category LIKE @q OR usage LIKE @q)");
    params.q = `%${q}%`;
  }

  const category = String(searchParams.get("category") || "").trim();
  if (category) {
    where.push("category = @category");
    params.category = category;
  }

  const source = String(searchParams.get("source") || "").trim();
  if (source) {
    where.push("source = @source");
    params.source = source;
  }

  const evaluationStatus = String(searchParams.get("evaluationStatus") || "").trim();
  if (evaluationStatus) {
    where.push("evaluation_status = @evaluationStatus");
    params.evaluationStatus = evaluationStatus;
  }

  const recommendedAction = String(searchParams.get("recommendedAction") || "").trim();
  if (recommendedAction) {
    where.push("recommended_action = @recommendedAction");
    params.recommendedAction = recommendedAction;
  }

  const processingStatus = String(searchParams.get("processingStatus") || "").trim();
  if (processingStatus) {
    where.push("processing_status = @processingStatus");
    params.processingStatus = processingStatus;
  }

  const includeIgnored = String(searchParams.get("includeIgnored") || "").trim() === "1";
  if (!includeIgnored) {
    where.push("COALESCE(evaluation_status, '') != 'discarded'");
    where.push("COALESCE(processing_status, '') != 'ignored'");
    where.push("COALESCE(recommended_action, '') != 'discard'");
  }

  const minScore = Number(searchParams.get("minScore") || "");
  if (Number.isFinite(minScore)) {
    where.push("COALESCE(value_score, 0) >= @minScore");
    params.minScore = minScore;
  }

  const startDate = String(searchParams.get("startDate") || "").trim();
  if (startDate) {
    where.push("datetime(COALESCE(published_at, fetched_at, updated_at, created_at)) >= datetime(@startDate)");
    params.startDate = startDate;
  }

  const endDate = String(searchParams.get("endDate") || "").trim();
  if (endDate) {
    where.push("datetime(COALESCE(published_at, fetched_at, updated_at, created_at)) <= datetime(@endDate)");
    params.endDate = endDate;
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function listIntel(url) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const page = normalizePage(url.searchParams.get("page"));
    const pageSize = url.searchParams.has("pageSize")
      ? normalizePageSize(url.searchParams.get("pageSize"))
      : normalizeLimit(url.searchParams.get("limit"));
    const offset = (page - 1) * pageSize;
    const { clause, params } = buildIntelWhere(url.searchParams);
    const rows = db.prepare(`
      SELECT *
      FROM intel_items
      ${clause}
      ORDER BY COALESCE(published_at, fetched_at, updated_at, created_at) DESC
      LIMIT @pageSize OFFSET @offset
    `).all({ ...params, pageSize, offset });

    const total = db.prepare(`SELECT count(*) AS count FROM intel_items ${clause}`).get(params);
    const categories = db.prepare(`
      SELECT COALESCE(NULLIF(category, ''), @uncategorized) AS category, count(*) AS count
      FROM intel_items
      GROUP BY COALESCE(NULLIF(category, ''), @uncategorized)
      ORDER BY count DESC
    `).all({ uncategorized: TEXT.uncategorized });
    const sources = db.prepare(`
      SELECT COALESCE(NULLIF(source, ''), @manualSource) AS source, count(*) AS count
      FROM intel_items
      GROUP BY COALESCE(NULLIF(source, ''), @manualSource)
      ORDER BY count DESC
    `).all({ manualSource: TEXT.manualSource });
    const evaluations = db.prepare(`
      SELECT COALESCE(NULLIF(evaluation_status, ''), 'unreviewed') AS status, count(*) AS count
      FROM intel_items
      GROUP BY COALESCE(NULLIF(evaluation_status, ''), 'unreviewed')
      ORDER BY count DESC
    `).all();

    return {
      items: rows.map(rowToIntel),
      total: total.count,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total.count / pageSize)),
      categories,
      sources,
      evaluations,
      dbPath: getDbPath(),
    };
  } finally {
    db.close();
  }
}

export function updateIntelEvaluation(id, input = {}) {
  const now = new Date().toISOString();
  const evaluationStatus = String(input.evaluationStatus || "").trim();
  const recommendedAction = String(input.recommendedAction || "").trim();
  const processingStatus = String(input.processingStatus || "").trim();
  const reviewedBy = String(input.reviewedBy || "manual").trim();
  const evaluationReason = String(input.evaluationReason || "").trim();
  const scoreValue = input.valueScore === null || input.valueScore === "" || input.valueScore === undefined
    ? null
    : Math.max(0, Math.min(100, Number(input.valueScore)));

  if (evaluationStatus && !EVALUATION_STATUSES.has(evaluationStatus)) {
    throw new Error(`Unsupported evaluation status: ${evaluationStatus}`);
  }
  if (recommendedAction && !RECOMMENDED_ACTIONS.has(recommendedAction)) {
    throw new Error(`Unsupported recommended action: ${recommendedAction}`);
  }
  if (processingStatus && !PROCESSING_STATUSES.has(processingStatus)) {
    throw new Error(`Unsupported processing status: ${processingStatus}`);
  }

  const db = openLocalDb();
  initLocalDb(db);
  try {
    const existing = db.prepare("SELECT id FROM intel_items WHERE id = ?").get(id);
    if (!existing) return null;
    db.prepare(`
      UPDATE intel_items
      SET
        evaluation_status = COALESCE(NULLIF(?, ''), evaluation_status),
        value_score = COALESCE(?, value_score),
        recommended_action = COALESCE(NULLIF(?, ''), recommended_action),
        evaluation_reason = ?,
        reviewed_at = ?,
        reviewed_by = ?,
        processing_status = COALESCE(NULLIF(?, ''), processing_status),
        updated_at = ?
      WHERE id = ?
    `).run(
      evaluationStatus,
      Number.isFinite(scoreValue) ? scoreValue : null,
      recommendedAction,
      evaluationReason,
      now,
      reviewedBy,
      processingStatus,
      now,
      id,
    );
    return getIntel(id);
  } finally {
    db.close();
  }
}

export function getIntel(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM intel_items WHERE id = ?").get(id);
    return row ? rowToIntel(row) : null;
  } finally {
    db.close();
  }
}

export function createIntel(input) {
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Title is required");

  const now = new Date().toISOString();
  const id = randomUUID();
  const summary = String(input.summary || "").trim();
  const source = String(input.source || TEXT.manualSource).trim();
  const sourceUrl = String(input.sourceUrl || "").trim();
  const category = String(input.category || TEXT.uncategorized).trim();
  const tags = normalizeList(input.tags);
  const usage = String(input.usage || "").trim();
  const fitFor = normalizeList(input.fitFor);
  const publishedAt = String(input.publishedAt || "").trim();
  const fetchedAt = String(input.fetchedAt || now).trim();
  const notionSyncStatus = String(input.notionSyncStatus || TEXT.localOnly).trim();

  const db = openLocalDb();
  initLocalDb(db);
  try {
    db.prepare(`
      INSERT INTO intel_items (
      id, title, summary, source, source_url, category, tags_json, usage,
      fit_for_json, published_at, fetched_at, notion_sync_status,
      evaluation_status, recommended_action, processing_status, created_at, updated_at
    )
      VALUES (?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, NULLIF(?, ''), ?, ?,
        'unreviewed', 'none', 'unprocessed', ?, ?)
    `).run(
      id,
      title,
      summary,
      source,
      sourceUrl,
      category,
      JSON.stringify(tags),
      usage,
      JSON.stringify(fitFor),
      publishedAt,
      fetchedAt,
      notionSyncStatus,
      now,
      now,
    );
    return getIntel(id);
  } finally {
    db.close();
  }
}

function readJson(fileUrl, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

function loadNotionConfig() {
  const config = readJson(new URL("../../../notion-ai-intel.config.json", import.meta.url), {});
  return {
    token: process.env.NOTION_TOKEN || config?.notion?.token || "",
    databaseId: process.env.NOTION_DATABASE_ID || config?.notion?.database_id || "",
    propertyMap: {
      title: config?.notion?.property_map?.title || "\u6807\u9898",
      summary: config?.notion?.property_map?.summary || "\u603b\u7ed3",
      usage: config?.notion?.property_map?.usage || "\u7528\u9014",
      link: config?.notion?.property_map?.link || "\u94fe\u63a5",
      date: config?.notion?.property_map?.date || "\u65e5\u671f",
      category: config?.notion?.property_map?.category || "\u5206\u7c7b",
    },
  };
}

function ensureNotionConfigured(config) {
  if (!config.token || !config.databaseId) {
    throw new Error("Notion token or database id is not configured");
  }
}

async function notionRequest(path, config, body) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
      "notion-version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Notion request failed: ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

function plainText(items) {
  return Array.isArray(items) ? items.map((item) => item.plain_text || "").join("").trim() : "";
}

function propertyText(properties, name) {
  const property = properties?.[name];
  if (!property) return "";
  if (property.type === "title") return plainText(property.title);
  if (property.type === "rich_text") return plainText(property.rich_text);
  if (property.type === "url") return property.url || "";
  if (property.type === "select") return property.select?.name || "";
  if (property.type === "date") return property.date?.start || "";
  if (property.type === "multi_select") return property.multi_select?.map((item) => item.name).join(", ") || "";
  return "";
}

function notionPageToIntel(page, propertyMap) {
  const properties = page.properties || {};
  const sourceUrl = propertyText(properties, propertyMap.link);
  let source = TEXT.notionSource;
  try {
    if (sourceUrl) source = new URL(sourceUrl).hostname;
  } catch {
    source = TEXT.notionSource;
  }

  return {
    id: page.id,
    title: propertyText(properties, propertyMap.title) || "\u672a\u547d\u540d\u60c5\u62a5",
    summary: propertyText(properties, propertyMap.summary),
    source,
    sourceUrl,
    category: propertyText(properties, propertyMap.category) || TEXT.uncategorized,
    tags: [],
    usage: propertyText(properties, propertyMap.usage),
    fitFor: [],
    publishedAt: propertyText(properties, propertyMap.date),
    fetchedAt: page.last_edited_time || page.created_time || new Date().toISOString(),
    notionPageId: page.id,
    notionSyncStatus: TEXT.syncedFromNotion,
  };
}

function upsertIntelItem(db, input) {
  const now = new Date().toISOString();
  const existing = input.sourceUrl
    ? db.prepare("SELECT id FROM intel_items WHERE notion_page_id = ? OR source_url = ? LIMIT 1").get(input.notionPageId, input.sourceUrl)
    : db.prepare("SELECT id FROM intel_items WHERE notion_page_id = ? LIMIT 1").get(input.notionPageId);
  const id = existing?.id || input.id || randomUUID();

  db.prepare(`
    INSERT INTO intel_items (
      id, title, summary, source, source_url, category, tags_json, usage,
      fit_for_json, published_at, fetched_at, notion_page_id, notion_sync_status,
      evaluation_status, recommended_action, processing_status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?,
      'unreviewed', 'none', 'unprocessed', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      source = excluded.source,
      source_url = excluded.source_url,
      category = excluded.category,
      tags_json = excluded.tags_json,
      usage = excluded.usage,
      fit_for_json = excluded.fit_for_json,
      published_at = excluded.published_at,
      fetched_at = excluded.fetched_at,
      notion_page_id = excluded.notion_page_id,
      notion_sync_status = excluded.notion_sync_status,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.title,
    input.summary || "",
    input.source || TEXT.notionSource,
    input.sourceUrl || "",
    input.category || TEXT.uncategorized,
    JSON.stringify(input.tags || []),
    input.usage || "",
    JSON.stringify(input.fitFor || []),
    input.publishedAt || "",
    input.fetchedAt || now,
    input.notionPageId || "",
    input.notionSyncStatus || TEXT.syncedFromNotion,
    now,
    now,
  );
  return id;
}

export async function syncIntelFromNotion({ limit = 100 } = {}) {
  const config = loadNotionConfig();
  ensureNotionConfigured(config);

  const pages = [];
  let startCursor = undefined;
  while (pages.length < limit) {
    const data = await notionRequest(`/databases/${config.databaseId}/query`, config, {
      page_size: Math.min(100, limit - pages.length),
      start_cursor: startCursor,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    pages.push(...(data.results || []));
    if (!data.has_more || !data.next_cursor) break;
    startCursor = data.next_cursor;
  }

  const items = pages.map((page) => notionPageToIntel(page, config.propertyMap));
  const db = openLocalDb();
  initLocalDb(db);
  try {
    db.exec("BEGIN");
    for (const item of items) upsertIntelItem(db, item);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  return {
    ok: true,
    synced: items.length,
    dbPath: getDbPath(),
  };
}
