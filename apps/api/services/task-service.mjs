import { randomUUID } from "node:crypto";
import { initLocalDb, openLocalDb, getDbPath } from "../../../packages/db/src/local-db.mjs";
import { normalizeLimit } from "../utils/http.mjs";
import { XIAOHONGSHU_WORKFLOW_ID, XIAOHONGSHU_WORKFLOW_NAME, getWorkflowSteps } from "./workflow-definitions.mjs";

const DEFAULT_WORKFLOW_ID = XIAOHONGSHU_WORKFLOW_ID;
const DEFAULT_WORKFLOW_NAME = XIAOHONGSHU_WORKFLOW_NAME;
function rowToTask(row) {
  const inputText = row.input_text || "";
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name || row.workflow_id,
    entryType: row.entry_type || "web",
    entryMessageId: row.entry_message_id || "",
    status: row.status,
    inputText: /^\?{3,}$/.test(inputText) ? "" : inputText,
    packageId: row.package_id || "",
    startedAt: row.started_at || "",
    completedAt: row.completed_at || "",
    error: row.error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToStep(row) {
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    stepName: row.step_name || row.step_key,
    status: row.status,
    startedAt: row.started_at || "",
    completedAt: row.completed_at || "",
    durationMs: row.duration_ms,
    inputSummary: row.input_summary || "",
    outputSummary: row.output_summary || "",
    error: row.error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function rowToModelCall(row) {
  const promptTokens = Number(row.prompt_tokens || 0);
  const completionTokens = Number(row.completion_tokens || 0);
  return {
    id: row.id,
    runId: row.run_id || "",
    stepId: row.step_id || "",
    callType: row.call_type || "text",
    provider: row.provider || "",
    model: row.model || "",
    purpose: row.purpose || "",
    status: row.status,
    durationMs: row.duration_ms,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    error: row.error || "",
    createdAt: row.created_at,
  };
}

function summarizeModelCalls(calls = []) {
  return calls.reduce(
    (summary, call) => {
      summary.calls += 1;
      if (call.callType === "image") summary.imageCalls += 1;
      else summary.textCalls += 1;
      if (call.status && call.status !== "succeeded") summary.failedCalls += 1;
      summary.promptTokens += Number(call.promptTokens || 0);
      summary.completionTokens += Number(call.completionTokens || 0);
      summary.totalTokens += Number(call.totalTokens || 0);
      return summary;
    },
    { calls: 0, textCalls: 0, imageCalls: 0, failedCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}
function rowToTaskSummary(row) {
  const item = rowToTask(row);
  return {
    ...item,
    inputText: String(item.inputText || "").slice(0, 240),
    error: String(item.error || "").slice(0, 240),
  };
}

function rowToStepSummary(row) {
  const text = row.error || row.output_summary || row.input_summary || "";
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    stepName: row.step_name || row.step_key,
    status: row.status,
    startedAt: row.started_at || "",
    completedAt: row.completed_at || "",
    durationMs: row.duration_ms,
    summary: String(text || "").slice(0, 180),
    error: row.error ? String(row.error).slice(0, 180) : "",
  };
}

function stepsByRunId(db, runIds) {
  if (!runIds.length) return new Map();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT *
    FROM workflow_steps
    WHERE run_id IN (${placeholders})
    ORDER BY run_id ASC, created_at ASC
  `).all(...runIds);
  const map = new Map();
  for (const row of rows) {
    const item = rowToStep(row);
    if (!map.has(item.runId)) map.set(item.runId, []);
    map.get(item.runId).push(item);
  }
  return map;
}

function stepSummariesByRunId(db, runIds) {
  if (!runIds.length) return new Map();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, run_id, step_key, step_name, status, started_at, completed_at, duration_ms, input_summary, output_summary, error
    FROM workflow_steps
    WHERE run_id IN (${placeholders})
    ORDER BY run_id ASC, created_at ASC
  `).all(...runIds);
  const map = new Map();
  for (const row of rows) {
    const item = rowToStepSummary(row);
    if (!map.has(item.runId)) map.set(item.runId, []);
    map.get(item.runId).push(item);
  }
  return map;
}

function modelCallsByRunId(db, runIds) {
  if (!runIds.length) return new Map();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT *
    FROM model_calls
    WHERE run_id IN (${placeholders})
    ORDER BY run_id ASC, created_at ASC
  `).all(...runIds);
  const map = new Map();
  for (const row of rows) {
    const item = rowToModelCall(row);
    if (!map.has(item.runId)) map.set(item.runId, []);
    map.get(item.runId).push(item);
  }
  return map;
}

export function listTasks(url) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const limit = normalizeLimit(url.searchParams.get("limit"));
    const summaryOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("summary") || "").toLowerCase());
    const rows = db.prepare(`
      SELECT *
      FROM workflow_runs
      WHERE status != 'canceled'
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT @limit
    `).all({ limit });
    const runIds = rows.map((row) => row.id);
    const stepsMap = summaryOnly ? stepSummariesByRunId(db, runIds) : stepsByRunId(db, runIds);
    const modelCallsMap = modelCallsByRunId(db, runIds);
    const total = db.prepare("SELECT count(*) AS count FROM workflow_runs WHERE status != 'canceled'").get();
    const statuses = db.prepare(`
      SELECT status, count(*) AS count
      FROM workflow_runs
      WHERE status != 'canceled'
      GROUP BY status
      ORDER BY count DESC
    `).all();

    return {
      items: rows.map((row) => {
        const modelCalls = modelCallsMap.get(row.id) || [];
        return {
          ...(summaryOnly ? rowToTaskSummary(row) : rowToTask(row)),
          steps: stepsMap.get(row.id) || [],
          modelCalls: summaryOnly ? [] : modelCalls,
          modelUsage: summarizeModelCalls(modelCalls),
        };
      }),
      total: total.count,
      statuses,
      dbPath: getDbPath(),
    };
  } finally {
    db.close();
  }
}

export function listQueuedTaskIds() {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    return db.prepare(`
      SELECT id
      FROM workflow_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 20
    `).all().map((row) => row.id);
  } finally {
    db.close();
  }
}

export function recoverInterruptedTasks(reason = "任务执行被后台重启或中断打断，请重新生成。") {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    const rows = db.prepare(`
      SELECT id
      FROM workflow_runs
      WHERE status = 'running'
    `).all();
    if (!rows.length) return { count: 0, ids: [] };

    db.exec("BEGIN");
    const updateRun = db.prepare(`
      UPDATE workflow_runs
      SET status = 'failed',
          completed_at = ?,
          updated_at = ?,
          error = ?
      WHERE id = ? AND status = 'running'
    `);
    const updateStep = db.prepare(`
      UPDATE workflow_steps
      SET status = 'failed',
          completed_at = ?,
          updated_at = ?,
          error = ?
      WHERE run_id = ? AND status = 'running'
    `);
    for (const row of rows) {
      updateRun.run(now, now, reason, row.id);
      updateStep.run(now, now, reason, row.id);
    }
    db.exec("COMMIT");
    return { count: rows.length, ids: rows.map((row) => row.id) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function getTask(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const run = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
    if (!run) return null;
    const steps = db.prepare(`
      SELECT *
      FROM workflow_steps
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all(id);
    const modelCalls = db.prepare(`
      SELECT *
      FROM model_calls
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all(id).map(rowToModelCall);
    return {
      ...rowToTask(run),
      steps: steps.map(rowToStep),
      modelCalls,
      modelUsage: summarizeModelCalls(modelCalls),
    };
  } finally {
    db.close();
  }
}

export function getTaskForExecution(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
    return row ? rowToTask(row) : null;
  } finally {
    db.close();
  }
}

export function createTask(input) {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  const workflowId = String(input.workflowId || DEFAULT_WORKFLOW_ID).trim();
  const workflowName = String(input.workflowName || DEFAULT_WORKFLOW_NAME).trim();
  const entryType = String(input.entryType || "web").trim();
  const entryMessageId = String(input.entryMessageId || "").trim();
  const inputText = String(input.inputText || "").trim();
  const workflowSteps = getWorkflowSteps(workflowId);
  if (!workflowSteps.length) throw new Error(`Unsupported workflow: ${workflowId}`);

  try {
    const duplicate = db.prepare(`
      SELECT id
      FROM workflow_runs
      WHERE workflow_id = ?
        AND entry_type = ?
        AND input_text = ?
        AND COALESCE(entry_message_id, '') = ?
        AND status IN ('queued', 'running')
        AND datetime(created_at) >= datetime(?, '-2 minutes')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(workflowId, entryType, inputText, entryMessageId, now);
    if (duplicate?.id) return getTask(duplicate.id);

    const id = randomUUID();
    db.exec("BEGIN");
    db.prepare(`
      INSERT INTO workflow_runs (
        id, workflow_id, workflow_name, entry_type, entry_message_id, status, input_text,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(id, workflowId, workflowName, entryType, entryMessageId, inputText, now, now);

    const insertStep = db.prepare(`
      INSERT INTO workflow_steps (
        id, run_id, step_key, step_name, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `);
    for (const step of workflowSteps) {
      insertStep.run(randomUUID(), id, step.key, step.name, now, now);
    }
    db.exec("COMMIT");
    return getTask(id);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function markTaskRunning(id) {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      UPDATE workflow_runs
      SET status = 'running',
          started_at = COALESCE(started_at, ?),
          error = NULL,
          updated_at = ?
      WHERE id = ? AND status IN ('queued', 'failed')
    `).run(now, now, id);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function markTaskSucceeded(id, { packageId = "", outputSummary = "" } = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      UPDATE workflow_runs
      SET status = 'succeeded',
          package_id = COALESCE(NULLIF(?, ''), package_id),
          completed_at = ?,
          updated_at = ?,
          error = NULL
      WHERE id = ? AND status != 'canceled'
    `).run(packageId, now, now, id);
    if (result.changes > 0) {
      markStep(db, id, "sync", {
        status: "completed",
        outputSummary,
        completedAt: now,
      });
    }
  } finally {
    db.close();
  }
}

export function markTaskFailed(id, error) {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    db.prepare(`
      UPDATE workflow_runs
      SET status = 'failed',
          completed_at = ?,
          updated_at = ?,
          error = ?
      WHERE id = ? AND status != 'canceled'
    `).run(now, now, String(error || "Task failed"), id);
  } finally {
    db.close();
  }
}

export function markActiveTaskStepFailed(id, error) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const current = db.prepare(`
      SELECT step_key
      FROM workflow_steps
      WHERE run_id = ? AND status = 'running'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(id);
    const next = current || db.prepare(`
      SELECT step_key
      FROM workflow_steps
      WHERE run_id = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(id);
    if (!next?.step_key) return;
    markStep(db, id, next.step_key, {
      status: "failed",
      error,
      outputSummary: String(error || "Task failed"),
    });
  } finally {
    db.close();
  }
}

export function cancelQueuedTask(id) {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    db.exec("BEGIN");
    const current = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(id);
    if (!current) {
      db.exec("ROLLBACK");
      return { ok: false, status: 404, error: "Task not found" };
    }
    if (current.status !== "queued" && current.status !== "running") {
      db.exec("ROLLBACK");
      return { ok: false, status: 409, error: "Only queued or running tasks can be canceled" };
    }
    db.prepare(`
      UPDATE workflow_runs
      SET status = 'canceled',
          completed_at = ?,
          updated_at = ?,
          error = NULL
      WHERE id = ?
    `).run(now, now, id);
    db.prepare(`
      UPDATE workflow_steps
      SET status = 'canceled',
          completed_at = ?,
          updated_at = ?
      WHERE run_id = ? AND status IN ('pending', 'running')
    `).run(now, now, id);
    db.exec("COMMIT");
    return { ok: true, task: getTask(id) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function retryTask(id) {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    db.exec("BEGIN");
    const current = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(id);
    if (!current) {
      db.exec("ROLLBACK");
      return { ok: false, status: 404, error: "Task not found" };
    }
    if (current.status === "queued" || current.status === "running") {
      db.exec("ROLLBACK");
      return { ok: true, alreadyActive: true, task: getTask(id) };
    }
    if (current.status !== "failed" && current.status !== "canceled") {
      db.exec("ROLLBACK");
      return { ok: false, status: 409, error: "Only failed or canceled tasks can be regenerated" };
    }
    db.prepare(`
      UPDATE workflow_runs
      SET status = 'queued',
          package_id = NULL,
          started_at = NULL,
          completed_at = NULL,
          error = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
    db.prepare(`
      UPDATE workflow_steps
      SET status = 'pending',
          started_at = NULL,
          completed_at = NULL,
          duration_ms = NULL,
          input_summary = '',
          output_summary = '',
          error = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(now, id);
    db.prepare("DELETE FROM model_calls WHERE run_id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return { ok: true, task: getTask(id) };
}

export function retryTaskFromStep(id, stepKey) {
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    db.exec("BEGIN");
    const current = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(id);
    if (!current) {
      db.exec("ROLLBACK");
      return { ok: false, status: 404, error: "Task not found" };
    }
    if (current.status === "queued" || current.status === "running") {
      db.exec("ROLLBACK");
      return { ok: true, alreadyActive: true, task: getTask(id) };
    }

    const target = db.prepare(`
      SELECT created_at
      FROM workflow_steps
      WHERE run_id = ? AND step_key = ?
    `).get(id, stepKey);
    if (!target) {
      db.exec("ROLLBACK");
      return { ok: false, status: 404, error: "Workflow step not found" };
    }

    db.prepare(`
      UPDATE workflow_runs
      SET status = 'queued',
          completed_at = NULL,
          error = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
    db.prepare(`
      UPDATE workflow_steps
      SET status = 'pending',
          started_at = NULL,
          completed_at = NULL,
          duration_ms = NULL,
          input_summary = '',
          output_summary = '',
          error = NULL,
          updated_at = ?
      WHERE run_id = ?
        AND created_at >= ?
    `).run(now, id, target.created_at);
    db.prepare("DELETE FROM model_calls WHERE run_id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return { ok: true, task: getTask(id) };
}

export function deleteTask(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    db.exec("BEGIN");
    const current = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(id);
    if (!current) {
      db.exec("ROLLBACK");
      return { ok: false, status: 404, error: "Task not found" };
    }
    if (current.status === "running") {
      db.exec("ROLLBACK");
      return { ok: false, status: 409, error: "Running task cannot be deleted; cancel it first" };
    }
    db.prepare("DELETE FROM model_calls WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM workflow_steps WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(id);
    db.exec("COMMIT");
    return { ok: true, id };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function recordModelCall({
  runId,
  stepKey = "",
  callType = "text",
  provider = "",
  model = "",
  purpose = "",
  status = "succeeded",
  durationMs = null,
  promptTokens = 0,
  completionTokens = 0,
  error = "",
} = {}) {
  if (!runId) return null;
  const db = openLocalDb();
  initLocalDb(db);
  const now = new Date().toISOString();
  try {
    const step = stepKey
      ? db.prepare("SELECT id FROM workflow_steps WHERE run_id = ? AND step_key = ?").get(runId, stepKey)
      : null;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO model_calls (
        id, run_id, step_id, call_type, provider, model, purpose, status,
        duration_ms, prompt_tokens, completion_tokens, error, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      runId,
      step?.id || null,
      callType === "image" ? "image" : "text",
      String(provider || ""),
      String(model || ""),
      String(purpose || ""),
      String(status || "succeeded"),
      Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : null,
      Number.isFinite(Number(promptTokens)) ? Math.max(0, Math.round(Number(promptTokens))) : 0,
      Number.isFinite(Number(completionTokens)) ? Math.max(0, Math.round(Number(completionTokens))) : 0,
      error ? String(error) : null,
      now,
    );
    return id;
  } finally {
    db.close();
  }
}

export function updateTaskStep(runId, stepKey, data) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    markStep(db, runId, stepKey, data);
  } finally {
    db.close();
  }
}

function markStep(db, runId, stepKey, data = {}) {
  const now = new Date().toISOString();
  const current = db.prepare(`
    SELECT started_at, completed_at
    FROM workflow_steps
    WHERE run_id = ? AND step_key = ?
  `).get(runId, stepKey);
  const startedAt = data.startedAt === false
    ? null
    : data.startedAt || current?.started_at || (data.status === "running" || data.status === "completed" ? now : null);
  const completedAt = data.completedAt
    || (data.status === "completed" || data.status === "failed" ? current?.completed_at || now : null);
  const durationMs = startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null;

  db.prepare(`
    UPDATE workflow_steps
    SET status = COALESCE(?, status),
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at),
        duration_ms = COALESCE(?, duration_ms),
        input_summary = COALESCE(?, input_summary),
        output_summary = COALESCE(?, output_summary),
        error = ?,
        updated_at = ?
    WHERE run_id = ? AND step_key = ?
  `).run(
    data.status || null,
    startedAt,
    completedAt,
    durationMs,
    data.inputSummary ?? null,
    data.outputSummary ?? null,
    data.error ? String(data.error) : null,
    now,
    runId,
    stepKey,
  );
}