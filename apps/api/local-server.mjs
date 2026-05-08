import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleHealthRoute } from "./routes/health-routes.mjs";
import { handleAssistantRoute } from "./routes/assistant-routes.mjs";
import { handleEntryRoute } from "./routes/entry-routes.mjs";
import { handleIntelRoute } from "./routes/intel-routes.mjs";
import { handleKnowledgeRoute } from "./routes/knowledge-routes.mjs";
import { handleLogRoute } from "./routes/log-routes.mjs";
import { handleNotionRoute } from "./routes/notion-routes.mjs";
import { handlePackageRoute } from "./routes/package-routes.mjs";
import { handleSettingsRoute } from "./routes/settings-routes.mjs";
import { handleTaskRoute } from "./routes/task-routes.mjs";
import { handleViralRoute } from "./routes/viral-routes.mjs";
import { handleWeatherRoute } from "./routes/weather-routes.mjs";
import { recoverInterruptedTasks } from "./services/task-service.mjs";
import { enqueueQueuedTasks } from "./services/task-executor.mjs";
import { sendJson } from "./utils/http.mjs";

const PORT = Number(process.env.XIAOLONGXIA_LOCAL_API_PORT || 3200);
const SERVICE_NAME = "\u5c0f\u9f99\u867e\u672c\u5730 API";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_DIST = process.env.XIAOLONGXIA_WEB_DIST || path.join(ROOT, "apps", "web", "dist");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

async function serveWebAsset(url, res) {
  if (url.pathname.startsWith("/api/")) return false;
  const decodedPath = decodeURIComponent(url.pathname);
  const safePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_DIST, safePath);
  if (!filePath.startsWith(path.resolve(WEB_DIST))) return false;

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME_TYPES.get(ext) || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    res.end(await fs.readFile(filePath));
    return true;
  } catch {
    if (path.extname(filePath)) return false;
  }

  try {
    const indexPath = path.join(WEB_DIST, "index.html");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(await fs.readFile(indexPath));
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, { ok: true });

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const context = { req, res, url, port: PORT };

    if (handleHealthRoute(context)) return;
    if (await handleAssistantRoute(context)) return;
    if (await handleEntryRoute(context)) return;
    if (await handleLogRoute(context)) return;
    if (await handleNotionRoute(context)) return;
    if (await handlePackageRoute(context)) return;
    if (await handleSettingsRoute(context)) return;
    if (await handleTaskRoute(context)) return;
    if (await handleIntelRoute(context)) return;
    if (await handleKnowledgeRoute(context)) return;
    if (await handleViralRoute(context)) return;
    if (await handleWeatherRoute(context)) return;
    if (await serveWebAsset(url, res)) return;

    return sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    return sendJson(res, { error: error.message || String(error) }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${SERVICE_NAME} started: http://127.0.0.1:${PORT}`);
  const recovered = recoverInterruptedTasks();
  if (recovered.count) {
    console.log(`Recovered ${recovered.count} interrupted task(s): ${recovered.ids.join(", ")}`);
  }
  enqueueQueuedTasks();
});
