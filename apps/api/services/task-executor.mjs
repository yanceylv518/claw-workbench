import {
  getTaskForExecution,
  listQueuedTaskIds,
  markTaskFailed,
} from "./task-service.mjs";
import { executeXiaohongshuWorkflowRun } from "./workflow-runner.mjs";
import { XIAOHONGSHU_WORKFLOW_ID } from "./workflow-definitions.mjs";

const MAX_CONCURRENT_RUNS = Math.max(1, Math.min(Number(process.env.XIAOLONGXIA_MAX_CONCURRENT_TASKS || 1), 3));

const handlers = new Map([
  [XIAOHONGSHU_WORKFLOW_ID, executeXiaohongshuWorkflowRun],
]);
const queue = [];
const queuedIds = new Set();
const runningIds = new Set();

export function enqueueTaskRun(id) {
  if (!id || queuedIds.has(id) || runningIds.has(id)) return;
  queuedIds.add(id);
  queue.push(id);
  setImmediate(() => {
    void drainQueue();
  });
}

export function enqueueQueuedTasks() {
  for (const id of listQueuedTaskIds()) enqueueTaskRun(id);
}

export function removeQueuedTaskRun(id) {
  if (!id) return false;
  queuedIds.delete(id);
  const index = queue.indexOf(id);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

export function getRunnerState() {
  return {
    maxConcurrentRuns: MAX_CONCURRENT_RUNS,
    running: runningIds.size,
    queued: queue.length,
    runningIds: Array.from(runningIds),
    queuedIds: [...queue],
  };
}

function drainQueue() {
  while (queue.length && runningIds.size < MAX_CONCURRENT_RUNS) {
    const id = queue.shift();
    queuedIds.delete(id);
    runningIds.add(id);
    void executeTaskRun(id).finally(() => {
      runningIds.delete(id);
      drainQueue();
    });
  }
}

async function executeTaskRun(id) {
  const task = getTaskForExecution(id);
  if (!task || task.status === "succeeded" || task.status === "running" || task.status === "canceled") return;

  const handler = handlers.get(task.workflowId);
  if (!handler) {
    markTaskFailed(id, `Unsupported workflow: ${task.workflowId}`);
    return;
  }

  await handler(id);
}
