import { randomUUID } from "node:crypto";
import { initLocalDb, openLocalDb, getDbPath } from "../../../packages/db/src/local-db.mjs";
import { normalizeLimit } from "../utils/http.mjs";

const DEFAULT_TYPE = "内容方法";
const DEFAULT_STATUS = "enabled";

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

function rowToKnowledge(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    platform: row.platform || "",
    scenario: row.scenario || "",
    project: row.project || "",
    content: row.content || "",
    tags: parseJsonArray(row.tags_json),
    sourceType: row.source_type || "",
    sourceId: row.source_id || "",
    status: row.status || DEFAULT_STATUS,
    priority: row.priority ?? 50,
    aiEnabled: Boolean(row.ai_enabled),
    forbiddenNote: row.forbidden_note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildKnowledgeWhere(searchParams) {
  const where = [];
  const params = {};

  const q = String(searchParams.get("q") || "").trim();
  if (q) {
    where.push("(title LIKE @q OR content LIKE @q OR type LIKE @q OR scenario LIKE @q OR project LIKE @q OR tags_json LIKE @q)");
    params.q = `%${q}%`;
  }

  const type = String(searchParams.get("type") || "").trim();
  if (type) {
    where.push("type = @type");
    params.type = type;
  }

  const status = String(searchParams.get("status") || "").trim();
  if (status) {
    where.push("status = @status");
    params.status = status;
  }

  const platform = String(searchParams.get("platform") || "").trim();
  if (platform) {
    where.push("platform = @platform");
    params.platform = platform;
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function listKnowledge(url) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const limit = normalizeLimit(url.searchParams.get("limit"));
    const { clause, params } = buildKnowledgeWhere(url.searchParams);
    const rows = db.prepare(`
      SELECT *
      FROM knowledge_items
      ${clause}
      ORDER BY priority DESC, updated_at DESC
      LIMIT @limit
    `).all({ ...params, limit });
    const total = db.prepare(`SELECT count(*) AS count FROM knowledge_items ${clause}`).get(params);
    const types = db.prepare(`
      SELECT type, count(*) AS count
      FROM knowledge_items
      GROUP BY type
      ORDER BY count DESC, type ASC
    `).all();
    const statuses = db.prepare(`
      SELECT status, count(*) AS count
      FROM knowledge_items
      GROUP BY status
      ORDER BY count DESC
    `).all();

    return {
      items: rows.map(rowToKnowledge),
      total: total.count,
      types,
      statuses,
      dbPath: getDbPath(),
    };
  } finally {
    db.close();
  }
}

function compactKnowledge(item) {
  return {
    id: item.id,
    title: item.title,
    summary: item.content,
    source: "知识库",
    category: item.type,
    tags: item.tags,
    usage: item.scenario || item.project || "",
    priority: item.priority,
  };
}

function buildKnowledgeTerms(text) {
  const value = String(text || "").toLowerCase();
  const terms = new Set(
    value
      .split(/[\s,，。；;:：、/\\|()[\]{}"'“”‘’!?！？-]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  );
  for (const match of value.matchAll(/[a-z0-9][a-z0-9._-]{2,}/gi)) terms.add(match[0].toLowerCase());
  for (const match of value.matchAll(/[\u4e00-\u9fff]{2,8}/gu)) terms.add(match[0]);
  return [...terms].slice(0, 40);
}

function scoreKnowledge(item, terms) {
  const haystack = [
    item.title,
    item.type,
    item.platform,
    item.scenario,
    item.project,
    item.content,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].join("\n").toLowerCase();
  let score = Number(item.priority || 0) / 100;
  for (const term of terms) {
    if (!term) continue;
    if (String(item.title || "").toLowerCase().includes(term)) score += 8;
    else if (String(item.tags || "").toLowerCase().includes(term)) score += 5;
    else if (haystack.includes(term)) score += 2;
  }
  if (/小红书|xiaohongshu|rednote/i.test(haystack)) score += 2;
  if (/禁止|不要|避坑|规则|风格|模板|方法|检查/i.test(haystack)) score += 1;
  return score;
}

export function selectKnowledgeForWorkflow({ userText = "", topicLabel = "", limit = 5 } = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const rows = db.prepare(`
      SELECT *
      FROM knowledge_items
      WHERE status = 'enabled'
        AND ai_enabled = 1
      ORDER BY priority DESC, updated_at DESC
      LIMIT 80
    `).all();
    const terms = buildKnowledgeTerms(`${topicLabel}\n${userText}`);
    return rows
      .map(rowToKnowledge)
      .map((item) => ({ item, score: scoreKnowledge(item, terms) }))
      .filter(({ score }) => score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)))
      .map(({ item }) => compactKnowledge(item));
  } finally {
    db.close();
  }
}

export function getKnowledge(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ?").get(id);
    return row ? rowToKnowledge(row) : null;
  } finally {
    db.close();
  }
}

function normalizeKnowledgeInput(input) {
  const title = String(input.title || "").trim();
  const content = String(input.content || "").trim();
  if (!title) throw new Error("Title is required");
  if (!content) throw new Error("Content is required");

  return {
    title,
    type: String(input.type || DEFAULT_TYPE).trim(),
    platform: String(input.platform || "").trim(),
    scenario: String(input.scenario || "").trim(),
    project: String(input.project || "").trim(),
    content,
    tags: normalizeList(input.tags),
    sourceType: String(input.sourceType || "manual").trim(),
    sourceId: String(input.sourceId || "").trim(),
    status: String(input.status || DEFAULT_STATUS).trim(),
    priority: Math.max(0, Math.min(100, Number.parseInt(String(input.priority ?? 50), 10) || 50)),
    aiEnabled: input.aiEnabled === false ? 0 : 1,
    forbiddenNote: String(input.forbiddenNote || "").trim(),
  };
}

export function createKnowledge(input) {
  const item = normalizeKnowledgeInput(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const duplicate = db.prepare(`
      SELECT id
      FROM knowledge_items
      WHERE title = ?
        AND content = ?
        AND source_type = ?
        AND status != 'archived'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(item.title, item.content, item.sourceType);
    if (duplicate?.id) return getKnowledge(duplicate.id);

    db.prepare(`
      INSERT INTO knowledge_items (
        id, title, type, platform, scenario, project, content, tags_json,
        source_type, source_id, status, priority, ai_enabled, forbidden_note,
        created_at, updated_at
      )
      VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), ?, ?)
    `).run(
      id,
      item.title,
      item.type,
      item.platform,
      item.scenario,
      item.project,
      item.content,
      JSON.stringify(item.tags),
      item.sourceType,
      item.sourceId,
      item.status,
      item.priority,
      item.aiEnabled,
      item.forbiddenNote,
      now,
      now,
    );
    return getKnowledge(id);
  } finally {
    db.close();
  }
}

export function updateKnowledge(id, input) {
  const current = getKnowledge(id);
  if (!current) return null;
  const item = normalizeKnowledgeInput({ ...current, ...input });
  const now = new Date().toISOString();
  const db = openLocalDb();
  initLocalDb(db);
  try {
    db.prepare(`
      UPDATE knowledge_items
      SET title = ?,
          type = ?,
          platform = NULLIF(?, ''),
          scenario = NULLIF(?, ''),
          project = NULLIF(?, ''),
          content = ?,
          tags_json = ?,
          source_type = ?,
          source_id = NULLIF(?, ''),
          status = ?,
          priority = ?,
          ai_enabled = ?,
          forbidden_note = NULLIF(?, ''),
          updated_at = ?
      WHERE id = ?
    `).run(
      item.title,
      item.type,
      item.platform,
      item.scenario,
      item.project,
      item.content,
      JSON.stringify(item.tags),
      item.sourceType,
      item.sourceId,
      item.status,
      item.priority,
      item.aiEnabled,
      item.forbiddenNote,
      now,
      id,
    );
    return getKnowledge(id);
  } finally {
    db.close();
  }
}

export function updateKnowledgeStatus(id, status) {
  const nextStatus = String(status || "").trim();
  if (!["enabled", "disabled", "archived"].includes(nextStatus)) throw new Error("Invalid knowledge status");
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const result = db.prepare(`
      UPDATE knowledge_items
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, new Date().toISOString(), id);
    return result.changes ? getKnowledge(id) : null;
  } finally {
    db.close();
  }
}

export function deleteKnowledge(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const existing = db.prepare("SELECT id FROM knowledge_items WHERE id = ?").get(id);
    if (!existing) return null;
    db.prepare("DELETE FROM knowledge_items WHERE id = ?").run(id);
    return { id, deleted: true };
  } finally {
    db.close();
  }
}
