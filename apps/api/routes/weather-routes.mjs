import { runWeatherSkill, buildWeatherSkillReply } from "../services/weather-skill.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handleWeatherRoute({ req, url, res }) {
  if (url.pathname === "/api/local/weather/skill" && req.method === "GET") {
    const city = url.searchParams.get("city") || "";
    const range = url.searchParams.get("range") || "today";
    const weather = await runWeatherSkill({ city, range });
    sendJson(res, { weather, reply: buildWeatherSkillReply(city, range, weather) });
    return true;
  }

  if (url.pathname === "/api/local/weather/skill" && req.method === "POST") {
    const body = await readJsonBody(req);
    const city = String(body.city || "").trim();
    const range = String(body.range || "today").trim() || "today";
    const weather = await runWeatherSkill({ city, range });
    sendJson(res, { weather, reply: buildWeatherSkillReply(city, range, weather) });
    return true;
  }

  return false;
}
