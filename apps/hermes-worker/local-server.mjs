import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.XIAOLONGXIA_HERMES_WORKER_PORT || 3307);
const HOST = process.env.XIAOLONGXIA_HERMES_WORKER_HOST || "127.0.0.1";
const DEFAULT_TIMEOUT_MS = Number(process.env.XIAOLONGXIA_HERMES_TIMEOUT_MS || 180000);

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(data, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function clampTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(10000, Math.min(numeric, 300000));
}

function buildWslHermesPythonBridge(maxTurns = 3) {
  const safeTurns = Math.max(1, Math.min(Number(maxTurns) || 3, 8));
  return [
    "import os, sys",
    "command = sys.argv[1]",
    "query = sys.stdin.read()",
    `args = [command, "chat", "-Q", "--ignore-rules", "--source", "tool", "--max-turns", "${safeTurns}", "-q", query]`,
    "try:",
    "    os.execvp(command, args)",
    "except FileNotFoundError:",
    '    fallback = os.path.expanduser("~/.local/bin/" + command)',
    "    os.execv(fallback, args)",
  ].join("\n");
}

function runProcessWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = new Error(`Command timed out after ${options.timeoutMs}ms`);
      error.stdout = Buffer.concat(stdoutChunks).toString("utf8");
      error.stderr = Buffer.concat(stderrChunks).toString("utf8");
      error.durationMs = Date.now() - startedAt;
      reject(error);
    }, clampTimeoutMs(options.timeoutMs));

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error.stdout = Buffer.concat(stdoutChunks).toString("utf8");
      error.stderr = Buffer.concat(stderrChunks).toString("utf8");
      error.durationMs = Date.now() - startedAt;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const durationMs = Date.now() - startedAt;
      if (code === 0) return resolve({ stdout, stderr, durationMs });
      const error = new Error(`Command failed with code ${code}${signal ? ` (${signal})` : ""}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      error.durationMs = durationMs;
      reject(error);
    });
    child.stdin.end(input || "", "utf8");
  });
}

function extractJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty JSON output");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("No JSON object found in Hermes output");
  }
}

function normalizeList(value, fallback = []) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : fallback;
}

function normalizeResearch(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    recommended_angle: String(source.recommended_angle || "").trim(),
    real_materials: normalizeList(source.real_materials),
    reference_structure: normalizeList(source.reference_structure),
    opening_style: String(source.opening_style || "").trim(),
    image_direction: String(source.image_direction || "").trim(),
    avoid: normalizeList(source.avoid),
    sample_pattern_notes: normalizeList(source.sample_pattern_notes),
  };
}

function buildFallbackResearch({ userText, topicLabel, intelItems }) {
  const first = Array.isArray(intelItems) && intelItems.length ? intelItems[0] : {};
  const topic = String(first.title || topicLabel || userText || "当前选题").trim();
  return {
    recommended_angle: `从一个具体运营场景切入：围绕“${topic}”，写清楚发生了什么、为什么要提前调整，以及普通内容团队现在能做的检查动作。`,
    real_materials: [
      "一次真实发布前检查场景",
      "团队内部对标题、正文、配图和标注口径的复盘",
      "平台规则变化带来的不确定感",
    ],
    reference_structure: [
      "先写一个具体问题或踩坑",
      "再解释这条情报真正影响的发布动作",
      "最后给出可执行的检查清单",
    ],
    opening_style: "用第一人称经验开头，少讲概念，先说自己遇到的具体判断。",
    image_direction: "封面用清单、标签、流程箭头或发布界面抽象图，正文图用检查表或前后对比。",
    avoid: ["不要写成新闻搬运", "不要夸大平台已经全面执行", "不要把建议写成确定规则"],
    sample_pattern_notes: ["保留不确定性", "强调人工复核", "把情报转成操作清单"],
  };
}

function buildResearchPrompt({ userText, topicLabel, intelItems }) {
  return [
    "Return one strict JSON object only. No Markdown. No explanation.",
    "You are a research assistant for a Xiaohongshu content workflow. Do not write the final post.",
    "Schema:",
    '{"recommended_angle":"string","real_materials":["string"],"reference_structure":["string"],"opening_style":"string","image_direction":"string","avoid":["string"],"sample_pattern_notes":["string"]}',
    "Rules:",
    "- Keep it concise and practical.",
    "- Focus on real scenes, structure references, image direction, and pitfalls.",
    "- Output Chinese values unless the source term is English.",
    `Topic label: ${topicLabel || ""}`,
    `Original request: ${userText || ""}`,
    `Source items: ${JSON.stringify(intelItems || []).slice(0, 12000)}`,
  ].join("\n");
}

async function runHermes({ prompt, wslDistro = "Ubuntu", command = "hermes", timeoutMs, maxTurns = 3 }) {
  const safeCommand = /^[\w./-]+$/.test(String(command || "")) ? command : "hermes";
  return runProcessWithInput(
    "wsl",
    ["-d", String(wslDistro || "Ubuntu"), "python3", "-c", buildWslHermesPythonBridge(maxTurns), safeCommand],
    prompt,
    { timeoutMs },
  );
}

async function handleResearch(req, res) {
  const body = await readJsonBody(req);
  const prompt = buildResearchPrompt(body);
  const startedAt = Date.now();
  try {
    const result = await runHermes({
      prompt,
      wslDistro: body.wslDistro,
      command: body.command,
      timeoutMs: clampTimeoutMs(body.timeoutMs || body.timeoutSeconds * 1000),
      maxTurns: body.maxTurns || 3,
    });
    const parsed = extractJsonFromText(result.stdout);
    sendJson(res, {
      ok: true,
      status: "completed",
      provider: "hermes-worker",
      durationMs: result.durationMs,
      research: normalizeResearch(parsed),
      diagnostics: {
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
      },
    });
  } catch (error) {
    sendJson(res, {
      ok: true,
      status: "fallback",
      provider: "hermes-worker",
      durationMs: error.durationMs || Date.now() - startedAt,
      error: error.message || String(error),
      research: buildFallbackResearch(body),
      diagnostics: {
        stdout: String(error.stdout || "").slice(0, 1200),
        stderr: String(error.stderr || "").slice(0, 1200),
      },
    }, 200);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, { ok: true });
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health" || url.pathname === "/api/hermes/health") {
      return sendJson(res, {
        ok: true,
        service: "小龙虾 Hermes Worker",
        port: PORT,
        mode: "local-wsl-hermes",
      });
    }
    if (url.pathname === "/api/hermes/research" && req.method === "POST") {
      return await handleResearch(req, res);
    }
    return sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    return sendJson(res, { error: error.message || String(error) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`小龙虾 Hermes Worker started: http://${HOST}:${PORT}`);
});
