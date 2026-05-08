import { getSettingsConfig, SettingsValidationError, updateSettingsConfig } from "../services/settings-service.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handleSettingsRoute({ req, url, res }) {
  if (url.pathname === "/api/local/settings" && req.method === "GET") {
    sendJson(res, await getSettingsConfig());
    return true;
  }

  if (url.pathname === "/api/local/settings" && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      sendJson(res, await updateSettingsConfig(body));
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        sendJson(res, { error: error.message, details: error.details || [] }, error.status || 400);
        return true;
      }
      throw error;
    }
    return true;
  }

  return false;
}
