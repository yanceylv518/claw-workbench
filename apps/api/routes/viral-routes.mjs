import { getViralServiceInfo, parseXhsReference, runViralAnalysis } from "../services/viral-service.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handleViralRoute({ req, res, url }) {
  if (url.pathname === "/api/local/viral-analysis/info" && req.method === "GET") {
    sendJson(res, getViralServiceInfo());
    return true;
  }

  if (url.pathname === "/api/local/xhs-parse" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, await parseXhsReference(body));
    return true;
  }

  if (url.pathname === "/api/local/viral-analysis" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, await runViralAnalysis(body));
    return true;
  }

  return false;
}
