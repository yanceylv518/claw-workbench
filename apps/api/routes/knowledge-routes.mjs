import { createKnowledge, deleteKnowledge, getKnowledge, listKnowledge, updateKnowledge, updateKnowledgeStatus } from "../services/knowledge-service.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handleKnowledgeRoute({ req, res, url }) {
  if (url.pathname === "/api/local/knowledge" && req.method === "GET") {
    sendJson(res, listKnowledge(url));
    return true;
  }

  if (url.pathname === "/api/local/knowledge" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, createKnowledge(body), 201);
    return true;
  }

  const detailMatch = url.pathname.match(/^\/api\/local\/knowledge\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const item = getKnowledge(decodeURIComponent(detailMatch[1]));
    sendJson(res, item || { error: "Not found" }, item ? 200 : 404);
    return true;
  }

  if (detailMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const item = updateKnowledge(decodeURIComponent(detailMatch[1]), body);
    sendJson(res, item || { error: "Not found" }, item ? 200 : 404);
    return true;
  }

  if (detailMatch && req.method === "DELETE") {
    const result = deleteKnowledge(decodeURIComponent(detailMatch[1]));
    sendJson(res, result || { error: "Not found" }, result ? 200 : 404);
    return true;
  }

  const statusMatch = url.pathname.match(/^\/api\/local\/knowledge\/([^/]+)\/status$/);
  if (statusMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const item = updateKnowledgeStatus(decodeURIComponent(statusMatch[1]), body.status);
    sendJson(res, item || { error: "Not found" }, item ? 200 : 404);
    return true;
  }

  return false;
}
