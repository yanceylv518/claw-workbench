import { cancelQueuedTask, createTask, deleteTask, getTask, listTasks, retryTask, retryTaskFromStep } from "../services/task-service.mjs";
import { enqueueTaskRun, removeQueuedTaskRun } from "../services/task-executor.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handleTaskRoute({ req, res, url }) {
  if (url.pathname === "/api/local/tasks" && req.method === "GET") {
    sendJson(res, listTasks(url));
    return true;
  }

  if (url.pathname === "/api/local/tasks" && req.method === "POST") {
    const body = await readJsonBody(req);
    const task = createTask(body);
    enqueueTaskRun(task.id);
    sendJson(res, task, 201);
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/local\/tasks\/([^/]+)\/run$/);
  if (runMatch && req.method === "POST") {
    const id = decodeURIComponent(runMatch[1]);
    const item = getTask(id);
    if (!item) {
      sendJson(res, { error: "Task not found" }, 404);
      return true;
    }
    enqueueTaskRun(id);
    sendJson(res, { ok: true, taskId: id });
    return true;
  }

  const retryMatch = url.pathname.match(/^\/api\/local\/tasks\/([^/]+)\/retry$/);
  if (retryMatch && req.method === "POST") {
    const id = decodeURIComponent(retryMatch[1]);
    const body = await readJsonBody(req).catch(() => ({}));
    const result = body?.stepKey ? retryTaskFromStep(id, String(body.stepKey)) : retryTask(id);
    if (!result.ok) {
      sendJson(res, { error: result.error }, result.status);
      return true;
    }
    if (!result.alreadyActive) enqueueTaskRun(id);
    sendJson(res, result.task);
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/local\/tasks\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const id = decodeURIComponent(cancelMatch[1]);
    const result = cancelQueuedTask(id);
    if (!result.ok) {
      sendJson(res, { error: result.error }, result.status);
      return true;
    }
    removeQueuedTaskRun(id);
    sendJson(res, result.task);
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/local\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === "DELETE") {
    const id = decodeURIComponent(taskMatch[1]);
    const result = deleteTask(id);
    if (!result.ok) {
      sendJson(res, { error: result.error }, result.status);
      return true;
    }
    removeQueuedTaskRun(id);
    sendJson(res, result);
    return true;
  }

  if (taskMatch && req.method === "GET") {
    const item = getTask(decodeURIComponent(taskMatch[1]));
    sendJson(res, item ?? { error: "Task not found" }, item ? 200 : 404);
    return true;
  }

  return false;
}
