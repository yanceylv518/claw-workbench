import { syncNotionAll } from "../services/notion-sync-service.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handleNotionRoute({ req, res, url }) {
  if (url.pathname === "/api/local/notion/sync" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, await syncNotionAll(body));
    return true;
  }

  return false;
}
