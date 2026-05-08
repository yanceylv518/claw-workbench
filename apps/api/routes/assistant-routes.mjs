import { runAssistantChat } from "../services/assistant-service.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handleAssistantRoute({ req, url, res }) {
  if (url.pathname === "/api/local/assistant/chat" && req.method === "POST") {
    const body = await readJsonBody(req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      sendJson(res, { ok: false, fallback: true, reason: "问题不能为空" }, 400);
      return true;
    }
    sendJson(res, await runAssistantChat({ message, context: body.context || {} }));
    return true;
  }

  return false;
}
