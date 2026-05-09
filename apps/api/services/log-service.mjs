import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = process.env.XIAOLONGXIA_DATA_DIR || path.join(ROOT, "data", "runtime");
const MAX_TAIL_BYTES = 260 * 1024;
const MAX_LINE_CHARS = 1200;
const MAX_LINES_PER_SOURCE = 120;
const MAX_TOTAL_LINES = 800;

const LOG_SOURCES = [
  {
    id: "workflow-runner",
    name: "任务工作流",
    path: process.env.XIAOLONGXIA_WORKFLOW_LOG_PATH || path.join(DATA_DIR, "workflow-runner.log"),
    kind: "workflow",
  },
  {
    id: "wechat-bridge",
    name: "微信 Bridge",
    path: process.env.XIAOLONGXIA_LOG_PATH || path.join(DATA_DIR, "wechat-direct-bridge.log"),
    kind: "runtime",
  },
  {
    id: "wechat-bridge-legacy",
    name: "微信 Bridge 旧日志",
    path: path.join(ROOT, "wechat-direct-bridge.log"),
    kind: "archive",
  },
  {
    id: "morning-brief",
    name: "情报晨报",
    path: path.join(ROOT, "morning-ai-brief.log"),
    kind: "workflow",
  },
  {
    id: "xhs-prefill",
    name: "小红书预填",
    path: path.join(ROOT, ".wechat-direct-bridge", "xiaohongshu-prefill-launch.log"),
    kind: "publisher",
  },
];

function readTail(filePath, maxBytes = MAX_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } finally {
    fs.closeSync(fd);
  }
}

function inferLevel(line) {
  const value = String(line || "");
  const upper = value.toUpperCase();
  if (/\b(ERROR|ERR|FATAL|FAIL|FAILED)\b/.test(upper) || /异常|失败|错误/.test(value)) return "error";
  if (/\b(WARN|WARNING)\b/.test(upper) || /警告|超时|timeout/i.test(value)) return "warn";
  if (/\b(DEBUG|TRACE)\b/.test(upper)) return "debug";
  if (/\b(INFO|OK|SUCCESS)\b/.test(upper) || /完成|成功|started|running/i.test(value)) return "info";
  return "default";
}

function parseTime(line, fallback) {
  const value = String(line || "");
  const iso = value.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (iso) return iso[0];
  const local = value.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/);
  if (local) {
    const parsed = new Date(local[0].replace(/\//g, "-"));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function isTracebackNoise(line) {
  const value = String(line || "").trim();
  if (!value) return true;
  if (/^\^+$/.test(value)) return true;
  if (/^(return|result|raise)\s+/.test(value)) return true;
  if (/site-packages[\\/](playwright|pyee|greenlet)/i.test(value)) return true;
  if (/Lib[\\/]site-packages[\\/]playwright/i.test(value)) return true;
  return false;
}

function compactTracebacks(lines) {
  const compacted = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/Traceback \(most recent call last\):/.test(line)) {
      if (!isTracebackNoise(line)) compacted.push(line);
      continue;
    }

    const block = [line];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(next) && !/Traceback \(most recent call last\):/.test(next)) break;
      block.push(next);
      if (/^[\w.]+(?:Error|Exception):\s+/.test(next.trim())) {
        cursor += 1;
        break;
      }
    }
    index = cursor - 1;

    const errorLine = [...block].reverse().find((item) => /^[\w.]+(?:Error|Exception):\s+/.test(item.trim()));
    const appFrame = block.find((item) => /D:[\\/].*openclaw.*\.py", line \d+/i.test(item));
    compacted.push([
      errorLine ? errorLine.trim() : "Python traceback",
      appFrame ? `位置：${appFrame.trim().replace(/^File\s+/, "File ")}` : "",
      `堆栈已折叠 ${block.length} 行`,
    ].filter(Boolean).join(" | "));
  }
  return compacted;
}

function normalizeLines(text, source, fallbackTime) {
  const compactedLines = compactTracebacks(
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-900),
  );

  return compactedLines.slice(-700).map((line, index) => {
    const message = line.length > MAX_LINE_CHARS
      ? `${line.slice(0, MAX_LINE_CHARS)} ...（已截断 ${line.length - MAX_LINE_CHARS} 字）`
      : line;
    return {
      id: `${source.id}-${index}`,
      sourceId: source.id,
      sourceName: source.name,
      kind: source.kind,
      level: inferLevel(message),
      time: parseTime(message, fallbackTime),
      message,
    };
  });
}

function readSource(source) {
  if (!fs.existsSync(source.path)) {
    return {
      ...source,
      exists: false,
      size: 0,
      updatedAt: "",
      lines: [],
    };
  }

  const stat = fs.statSync(source.path);
  const updatedAt = stat.mtime.toISOString();
  const text = stat.size > 0 ? readTail(source.path) : "";
  return {
    ...source,
    exists: true,
    size: stat.size,
    updatedAt,
    lines: normalizeLines(text, source, updatedAt),
  };
}

function summarize(lines, sources) {
  const byLevel = { error: 0, warn: 0, info: 0, debug: 0, default: 0 };
  for (const line of lines) byLevel[line.level] = (byLevel[line.level] || 0) + 1;
  return {
    totalLines: lines.length,
    activeSources: sources.filter((source) => source.exists && source.size > 0).length,
    errors: byLevel.error,
    warnings: byLevel.warn,
    latestAt: lines.map((line) => line.time).filter(Boolean).sort().at(-1) || "",
    byLevel,
  };
}

export function getSystemLogs() {
  const sources = LOG_SOURCES.map(readSource);
  const lines = sources
    .flatMap((source) => source.lines.slice(0, MAX_LINES_PER_SOURCE))
    .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))
    .slice(0, MAX_TOTAL_LINES);

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    summary: summarize(lines, sources),
    sources: sources.map(({ lines: sourceLines, ...source }) => ({
      ...source,
      loadedLineCount: Math.min(sourceLines.length, MAX_LINES_PER_SOURCE),
    })),
    lines,
  };
}
