import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function getDataDir() {
  return process.env.XIAOLONGXIA_DATA_DIR || path.join(process.cwd(), "data", "runtime");
}

export function getDbPath() {
  return process.env.XIAOLONGXIA_DB_PATH || path.join(getDataDir(), "xiaolongxia.db");
}

export function openLocalDb(dbPath = getDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function initLocalDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_packages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'xiaohongshu',
      kind TEXT NOT NULL,
      status TEXT,
      notion_status TEXT,
      notion_page_id TEXT,
      notion_url TEXT,
      quality_score REAL,
      ai_flavor_score REAL,
      human_trace_score REAL,
      image_count INTEGER NOT NULL DEFAULT 0,
      package_dir TEXT,
      package_json_path TEXT,
      markdown_path TEXT,
      source_path TEXT NOT NULL UNIQUE,
      source_mtime_ms INTEGER NOT NULL,
      generated_at TEXT,
      updated_at TEXT,
      indexed_at TEXT NOT NULL,
      raw_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_content_packages_updated_at
      ON content_packages(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_packages_status
      ON content_packages(status);
    CREATE INDEX IF NOT EXISTS idx_content_packages_notion_status
      ON content_packages(notion_status);
    CREATE INDEX IF NOT EXISTS idx_content_packages_title
      ON content_packages(title);

    CREATE TABLE IF NOT EXISTS intel_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      source TEXT,
      source_url TEXT UNIQUE,
      category TEXT,
      tags_json TEXT,
      usage TEXT,
      fit_for_json TEXT,
      published_at TEXT,
      fetched_at TEXT,
      notion_page_id TEXT,
      notion_sync_status TEXT,
      evaluation_status TEXT NOT NULL DEFAULT 'unreviewed',
      value_score INTEGER,
      recommended_action TEXT NOT NULL DEFAULT 'none',
      evaluation_reason TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      processing_status TEXT NOT NULL DEFAULT 'unprocessed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intel_items_published_at
      ON intel_items(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_intel_items_category
      ON intel_items(category);

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      platform TEXT,
      scenario TEXT,
      project TEXT,
      content TEXT NOT NULL,
      tags_json TEXT,
      source_type TEXT,
      source_id TEXT,
      status TEXT NOT NULL DEFAULT 'enabled',
      priority INTEGER NOT NULL DEFAULT 50,
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      forbidden_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_items_updated_at
      ON knowledge_items(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_type
      ON knowledge_items(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_status
      ON knowledge_items(status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_ai_enabled
      ON knowledge_items(ai_enabled);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT,
      entry_type TEXT,
      entry_message_id TEXT,
      status TEXT NOT NULL,
      input_text TEXT,
      package_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_updated_at
      ON workflow_runs(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
      ON workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id
      ON workflow_runs(workflow_id);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      step_name TEXT,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      input_summary TEXT,
      output_summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_id
      ON workflow_steps(run_id);

    CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      step_id TEXT,
      call_type TEXT NOT NULL DEFAULT 'text',
      provider TEXT,
      model TEXT,
      purpose TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_model_calls_created_at
      ON model_calls(created_at DESC);
  `);

  const columns = db.prepare("PRAGMA table_info(intel_items)").all();
  const existingColumns = new Set(columns.map((column) => column.name));
  const migrations = [
    ["evaluation_status", "ALTER TABLE intel_items ADD COLUMN evaluation_status TEXT NOT NULL DEFAULT 'unreviewed'"],
    ["value_score", "ALTER TABLE intel_items ADD COLUMN value_score INTEGER"],
    ["recommended_action", "ALTER TABLE intel_items ADD COLUMN recommended_action TEXT NOT NULL DEFAULT 'none'"],
    ["evaluation_reason", "ALTER TABLE intel_items ADD COLUMN evaluation_reason TEXT"],
    ["reviewed_at", "ALTER TABLE intel_items ADD COLUMN reviewed_at TEXT"],
    ["reviewed_by", "ALTER TABLE intel_items ADD COLUMN reviewed_by TEXT"],
    ["processing_status", "ALTER TABLE intel_items ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'unprocessed'"],
  ];
  for (const [column, sql] of migrations) {
    if (!existingColumns.has(column)) db.exec(sql);
  }

  const modelCallColumns = db.prepare("PRAGMA table_info(model_calls)").all();
  const existingModelCallColumns = new Set(modelCallColumns.map((column) => column.name));
  if (!existingModelCallColumns.has("call_type")) {
    db.exec("ALTER TABLE model_calls ADD COLUMN call_type TEXT NOT NULL DEFAULT 'text'");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_intel_items_evaluation_status
      ON intel_items(evaluation_status);
    CREATE INDEX IF NOT EXISTS idx_intel_items_recommended_action
      ON intel_items(recommended_action);
    CREATE INDEX IF NOT EXISTS idx_intel_items_processing_status
      ON intel_items(processing_status);
  `);
}
