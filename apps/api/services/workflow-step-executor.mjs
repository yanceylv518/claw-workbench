import { getTaskForExecution, updateTaskStep } from "./task-service.mjs";

export class TaskCanceledError extends Error {
  constructor(runId) {
    super(`Task canceled: ${runId}`);
    this.name = "TaskCanceledError";
    this.runId = runId;
  }
}

export function isTaskCanceledError(error) {
  return error instanceof TaskCanceledError || error?.name === "TaskCanceledError";
}

export function createWorkflowExecutionContext({ runId, task, llm, runtimeConfig, logger }) {
  return {
    runId,
    task,
    llm,
    runtimeConfig,
    logger,
    assertActive() {
      return assertTaskActive(runId);
    },
  };
}

export function assertTaskActive(runId) {
  const task = getTaskForExecution(runId);
  if (task?.status === "canceled") throw new TaskCanceledError(runId);
  return task;
}

export function setWorkflowStepPending(runId, stepKey, data = {}) {
  updateTaskStep(runId, stepKey, {
    status: "pending",
    ...data,
  });
}

export function startWorkflowStep(runId, stepKey, data = {}) {
  assertTaskActive(runId);
  updateTaskStep(runId, stepKey, {
    status: "running",
    ...data,
  });
}

export function completeWorkflowStep(runId, stepKey, data = {}) {
  assertTaskActive(runId);
  updateTaskStep(runId, stepKey, {
    status: "completed",
    ...data,
  });
}

export function failWorkflowStep(runId, stepKey, error, data = {}) {
  updateTaskStep(runId, stepKey, {
    status: "failed",
    error,
    outputSummary: String(error || "Task failed"),
    ...data,
  });
}

export async function runWorkflowStep(runId, stepKey, data, executor) {
  startWorkflowStep(runId, stepKey, data);
  try {
    const result = await executor();
    completeWorkflowStep(runId, stepKey, result?.step || {});
    return result?.value ?? result;
  } catch (error) {
    if (!isTaskCanceledError(error)) failWorkflowStep(runId, stepKey, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
