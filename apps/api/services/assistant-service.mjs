import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NOTION_CONFIG_PATH = path.join(ROOT, "notion-ai-intel.config.json");
const ASSISTANT_TIMEOUT_MS = 30000;

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildChatUrl(baseUrl) {
  const url = new URL(withTrailingSlash(baseUrl));
  const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (pathname.endsWith("/chat/completions/")) return url.toString();
  url.pathname = `${pathname}chat/completions`;
  return url.toString();
}

function compactJson(value, maxLength = 9000) {
  const text = JSON.stringify(value || {}, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...已截断` : text;
}

function parseAssistantText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text ?? "";
  return normalizeString(content);
}

export async function runAssistantChat({ message, context }) {
  const config = await readJson(NOTION_CONFIG_PATH, {});
  const assistantApi = config.assistant_api || {};
  if (assistantApi.enabled !== true) {
    return { ok: false, fallback: true, reason: "小助手模型增强未启用" };
  }

  const baseUrl = normalizeString(assistantApi.base_url);
  const apiKey = normalizeString(assistantApi.api_key);
  const model = normalizeString(assistantApi.model);
  if (!baseUrl || !apiKey || !model) {
    return { ok: false, fallback: true, reason: "小助手 API 配置不完整" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSISTANT_TIMEOUT_MS);
  try {
    const response = await fetch(buildChatUrl(baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "你是小龙虾后台的产品内助手。",
              "你必须用简洁中文回答，优先结合当前系统状态、最近任务、日志摘要和用户所在页面。",
              "如果配置、日志或任务数据不足，要明确说明缺少什么，不要编造。",
              "不要输出 Markdown 大标题；可以用短列表。",
              "不要泄露或猜测 API Key、Token 等敏感信息。",
            ].join("\n"),
          },
          {
            role: "user",
            content: `用户问题：${normalizeString(message)}\n\n当前系统上下文：\n${compactJson(context)}`,
          },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`;
      return { ok: false, fallback: true, reason: `小助手 API 调用失败：${error}` };
    }
    const text = parseAssistantText(payload);
    if (!text) return { ok: false, fallback: true, reason: "小助手 API 没有返回内容" };
    return { ok: true, text, providerId: normalizeString(assistantApi.provider_id), model };
  } catch (error) {
    return { ok: false, fallback: true, reason: `小助手 API 暂不可用：${error.message || String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
