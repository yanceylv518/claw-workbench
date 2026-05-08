import { getSystemLogs } from "../services/log-service.mjs";
import { sendJson } from "../utils/http.mjs";

export async function handleLogRoute({ req, url, res }) {
  if ((url.pathname === "/api/logs" || url.pathname === "/api/local/logs") && req.method === "GET") {
    sendJson(res, getSystemLogs());
    return true;
  }

  return false;
}
