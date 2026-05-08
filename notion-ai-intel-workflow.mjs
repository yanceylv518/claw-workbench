import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runOpenClawAgent, buildWechatSessionId } from "./openclaw-agent-client.mjs";
import { initLocalDb, openLocalDb } from "./packages/db/src/local-db.mjs";

const NOTION_VERSION = "2022-06-28";
const DEFAULT_REPLY_LIMIT = 3;
const DEFAULT_FETCH_LIMIT = 12;
const NOTION_TIMEOUT_MS = 20000;
const NOTION_RETRY_COUNT = 2;
const DEFAULT_FEED_URLS = [
  "https://openai.com/news/rss.xml",
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  "https://venturebeat.com/category/ai/feed/",
  "https://blog.google/technology/ai/rss/",
  "https://news.mit.edu/rss/topic/artificial-intelligence2",
  "https://www.marktechpost.com/feed/",
];
const DOMESTIC_FEED_URLS = [
  "https://www.qbitai.com/feed",
  "https://sspai.com/feed",
  "https://www.leiphone.com/feed",
  "https://www.geekpark.net/rss",
];
const HEALING_FEED_URLS = [
  "https://www.xinli001.com/feed",
  "https://www.mindful.org/feed/",
  "https://greatergood.berkeley.edu/rss",
  "https://tinybuddha.com/feed/",
  "https://positivepsychology.com/feed/",
  "https://www.tarabrach.com/feed/",
];
const BUILT_IN_FEED_URLS = new Set([
  ...DEFAULT_FEED_URLS,
  ...DOMESTIC_FEED_URLS,
  ...HEALING_FEED_URLS,
]);
const FEED_LABELS = {
  "https://www.qbitai.com/feed": { name: "量子位", region: "domestic" },
  "https://sspai.com/feed": { name: "少数派", region: "domestic" },
  "https://www.leiphone.com/feed": { name: "雷峰网", region: "domestic" },
  "https://www.geekpark.net/rss": { name: "极客公园", region: "domestic" },
  "https://www.xinli001.com/feed": { name: "Xinli001 Psychology", region: "healing" },
  "https://www.mindful.org/feed/": { name: "Mindful", region: "healing" },
  "https://greatergood.berkeley.edu/rss": { name: "Greater Good Science Center", region: "healing" },
  "https://tinybuddha.com/feed/": { name: "Tiny Buddha", region: "healing" },
  "https://positivepsychology.com/feed/": { name: "PositivePsychology.com", region: "healing" },
  "https://www.tarabrach.com/feed/": { name: "Tara Brach", region: "healing" },
  "https://openai.com/news/rss.xml": { name: "OpenAI News", region: "global" },
  "https://techcrunch.com/category/artificial-intelligence/feed/": { name: "TechCrunch AI", region: "global" },
  "https://venturebeat.com/category/ai/feed/": { name: "VentureBeat AI", region: "global" },
  "https://blog.google/technology/ai/rss/": { name: "Google AI Blog", region: "global" },
  "https://news.mit.edu/rss/topic/artificial-intelligence2": { name: "MIT News AI", region: "global" },
  "https://www.marktechpost.com/feed/": { name: "MarkTechPost", region: "global" },
};
const VALID_CATEGORIES = ["AI情报", "自媒体选题", "行业情报"];

const TEXT = {
  title: "标题",
  summary: "总结",
  usage: "用途",
  link: "链接",
  date: "日期",
  category: "分类",
  noFeed: "今天没有拉到可用的情报源，稍后再试一次。",
  noStructuredItems: "今天的信息已经抓到了，但这次结构化整理失败了，稍后我再试。",
  replyLead: "今天筛了几条值得关注的信息：",
  notionSkipped: "未写入 Notion：当前还没配置 Notion Token 或数据库 ID",
  confirmPrompt: "这条要我帮你抓情报并写入 Notion 吗？要的话回“要”就行。",
};

const COMMAND_PREFIXES = ["情报：", "情报:", "intel:", "intel："];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function stripCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "");
}

function decodeXml(value) {
  return stripCdata(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return decodeXml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function matchTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? stripCdata(match[1]).trim() : "";
}

function parseRssItems(xmlText) {
  const items = [];
  const matches = xmlText.match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const block of matches) {
    const rawTitle = decodeXml(matchTag(block, "title"));
    const title = rawTitle.replace(/\s+-\s+[^-]+$/, "").trim() || rawTitle.trim();
    const source = rawTitle.includes(" - ") ? rawTitle.split(" - ").at(-1)?.trim() || null : null;
    items.push({
      title,
      rawTitle,
      link: decodeXml(matchTag(block, "link")),
      published_at: matchTag(block, "pubDate") || null,
      summary: stripHtml(matchTag(block, "description")),
      source,
    });
  }
  return items;
}

async function fetchRssFeed(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 OpenClaw-WeChat-Bridge/1.0",
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status}`);
  }
  return parseRssItems(await res.text());
}

function uniqueFeedUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls.map((item) => String(item || "").trim()).filter(Boolean)) {
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

async function fetchCandidateItems(feedUrls, fetchLimit) {
  const collected = [];
  for (const feedUrl of feedUrls) {
    try {
      const items = await fetchRssFeed(feedUrl);
      for (const item of items) {
        collected.push({
          ...item,
          source: item.source || new URL(feedUrl).hostname,
        });
        if (collected.length >= fetchLimit * 2) break;
      }
    } catch {
      // Ignore single-source failures.
    }
    if (collected.length >= fetchLimit * 2) break;
  }

  const deduped = [];
  const seen = new Set();
  for (const item of collected) {
    const key = `${item.title}|${item.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= fetchLimit) break;
  }
  return deduped;
}

function normalizeIsoDate(input) {
  if (!input) return null;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function inferItemCategory(text) {
  const normalized = String(text || "").trim();
  if (/自媒体|选题|内容|文案|写作|短视频|小红书|抖音/i.test(normalized)) {
    return "自媒体选题";
  }
  if (/行业|赛道|竞品|市场|企业|公司|产业|投融资/i.test(normalized)) {
    return "行业情报";
  }
  return "AI情报";
}

function buildSelectionPrompt(userText, items, limit, nowIso, category, audience) {
  return [
    "You are selecting the most useful updates for a Notion database and WeChat reply.",
    "Return strict JSON only.",
    "Choose the most practically useful items for a busy operator, builder, or creator.",
    "Favor concrete product launches, model releases, workflow tools, automation leverage, and actionable business moves.",
    `Need exactly ${limit} items if enough candidates exist, otherwise return as many as are credible.`,
    'Schema: {"items":[{"title":"string","summary":"string","usage":"string","link":"string","date":"ISO-8601 string","category":"AI情报|自媒体选题|行业情报","fit_for":["string"]}],"wechat_summary":"string"}',
    "Rules:",
    "- `title` should be concise Chinese.",
    "- `summary` should be one short Chinese sentence summarizing the update.",
    "- `usage` should explain how the info can be used in work, content, or automation.",
    "- If the user requested a specific niche topic or industry, only select candidates whose title or summary is truly about that topic.",
    "- Do not force an unrelated AI/product/news item into the requested topic. If a candidate is unrelated, omit it.",
    "- The `usage` must be derived from the selected candidate itself, not invented by attaching the user's topic to an unrelated article.",
    "- `category` must be one of: AI情报, 自媒体选题, 行业情报.",
    "- `fit_for` should be a short list of Chinese labels such as 自媒体, 编程, 自动化, 短视频, 运营, 创业.",
    "- `link` must be taken from the candidate item.",
    "- `date` should be the best available published date in ISO-8601 format. Use current time if missing.",
    "- `wechat_summary` should be a short Chinese lead-in for the final reply.",
    `Preferred category: ${category}`,
    audience ? `Prefer items especially useful for this audience/use-case: ${audience.label}` : "No fixed audience filter.",
    `Current time: ${nowIso}`,
    `User request: ${userText}`,
    `Candidates: ${JSON.stringify(items)}`,
  ].join("\n");
}

async function callModelJsonViaApi(llm, prompt, timeoutMs, meta = {}) {
  const startedAt = Date.now();
  meta.logger?.("INFO", "AI API call", {
    workflow: meta.workflow || "情报流程",
    step: meta.step || 1,
    totalSteps: meta.totalSteps || 1,
    purpose: meta.purpose || "筛选、总结和分类情报",
    mode: llm.mode,
    providerId: llm.providerId,
    model: llm.model,
    endpoint: "chat/completions",
  });
  const bodyText = JSON.stringify({
    model: llm.model,
    messages: [
      { role: "system", content: "Return valid JSON only. No markdown fences. No commentary." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("chat/completions", ensureTrailingSlash(llm.baseUrl)).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: bodyText,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Model JSON call failed: ${res.status} ${text}`);
    }
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Model JSON call returned empty content");
    }
    const parsed = JSON.parse(content);
    const durationMs = Date.now() - startedAt;
    const usage = data?.usage || {};
    const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0;
    const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? 0) || 0;
    const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? Math.max(0, totalTokens - promptTokens)) || 0;
    meta.logger?.("INFO", "AI API call completed", {
      workflow: meta.workflow || "情报流程",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "筛选、总结和分类情报",
      model: llm.model,
      durationMs,
      modelUsage: {
        provider: llm.providerId || llm.mode || "",
        model: llm.model,
        purpose: meta.purpose || "筛选、总结和分类情报",
        promptTokens,
        completionTokens,
        totalTokens: totalTokens || promptTokens + completionTokens,
        durationMs,
      },
    });
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function callModelJson(llm, prompt, timeoutMs, meta = {}) {
  if (llm.mode === "openclaw-agent") {
    const startedAt = Date.now();
    const sessionId = buildWechatSessionId("wechat-intel", `${Date.now()}-${crypto.randomUUID()}`);
    meta.logger?.("INFO", "AI API call", {
      workflow: meta.workflow || "情报流程",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "筛选、总结和分类情报",
      mode: llm.mode,
      providerId: llm.providerId,
      model: llm.model,
      endpoint: "openclaw-agent",
      sessionId,
    });
    const message = [
      "你现在只做结构化整理。",
      "请严格只输出 JSON，不要输出 markdown 代码块，不要解释。",
      prompt,
    ].join("\n\n");
    const result = await runOpenClawAgent({
      message,
      sessionId,
      timeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      thinking: "minimal",
    });
    const parsed = JSON.parse(result.text);
    meta.logger?.("INFO", "AI API call completed", {
      workflow: meta.workflow || "情报流程",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "筛选、总结和分类情报",
      model: llm.model,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  }
  return callModelJsonViaApi(llm, prompt, timeoutMs, meta);
}

function parseRequestedLimit(text) {
  const match = String(text).match(/(\d+)\s*条/);
  if (!match) return DEFAULT_REPLY_LIMIT;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 10) : DEFAULT_REPLY_LIMIT;
}

function stripCommandPrefix(text) {
  const normalized = String(text || "").trim();
  for (const prefix of COMMAND_PREFIXES) {
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      return normalized.slice(prefix.length).trim();
    }
  }
  return null;
}

function normalizeIntentText(text) {
  return stripCommandPrefix(text) || String(text || "").trim();
}

function buildIntentSignalsV2(text) {
  const normalized = normalizeIntentText(text);
  return {
    normalized,
    hasExplicitPrefix: Boolean(stripCommandPrefix(text)),
    mentionsToday: /(?:\u4eca\u5929|\u4eca\u65e5|\u6700\u8fd1|\u8fd1\u671f)/i.test(normalized),
    mentionsAi: /(?:\bAI\b|\u4eba\u5de5\u667a\u80fd|\u5927\u6a21\u578b|\u667a\u80fd\u4f53|\u6a21\u578b)/i.test(normalized),
    mentionsIntelType: /(?:\u60c5\u62a5|\u8d44\u8baf|\u65b0\u95fb|\u52a8\u6001|\u9009\u9898|\u70ed\u70b9|\u70ed\u95e8|\u770b\u70b9|\u8d8b\u52bf|\u503c\u5f97\u770b|\u503c\u5f97\u5173\u6ce8|\u503c\u5f97\u7559\u610f|\u884c\u4e1a)/i.test(normalized),
    mentionsFind: /(?:\u5e2e\u6211\u627e|\u5e2e\u6211\u770b\u770b|\u770b\u770b|\u76d8\u4e00\u76d8|\u76d8\u70b9|\u6574\u7406|\u6c47\u603b|\u6311\u6311|\u7b5b\u4e00\u4e0b|\u63a8\u8350|\u5217\u51fa|\u7ed9\u6211\d+\u6761|\u6709\u4ec0\u4e48)/i.test(normalized),
    mentionsCount: /(\d+)\s*(?:\u6761|\u4e2a)/.test(normalized),
    mentionsUseCase: /(?:\u9002\u5408|\u53ef\u4ee5\u505a|\u80fd\u505a|\u503c\u5f97\u505a|\u9002\u5408\u505a\u5185\u5bb9|\u9002\u5408\u5199|\u9002\u5408\u53d1|\u81ea\u5a92\u4f53|\u5185\u5bb9|\u6587\u6848|\u5199\u4f5c|\u7f16\u7a0b|\u81ea\u52a8\u5316|\u77ed\u89c6\u9891|\u8fd0\u8425)/i.test(normalized),
    mentionsWriteNotion: /(?:Notion|\u5199\u5165|\u8bb0\u5f55|\u5165\u5e93|\u5b58\u5165)/i.test(normalized),
    mentionsHotspotStyle: /(?:\u4eca\u5929\u6709\u4ec0\u4e48(?:\u70ed\u70b9|\u503c\u5f97\u770b|\u503c\u5f97\u5173\u6ce8)|\u4eca\u5929\u6709\u54ea\u4e9b(?:\u70ed\u70b9|\u70ed\u95e8|\u503c\u5f97\u770b|\u503c\u5f97\u5173\u6ce8)|\u4eca\u5929AI\u91cc\u54ea\u4e9b\u9002\u5408\u505a\u5185\u5bb9|\u4eca\u5929AI\u91cc\u6709\u54ea\u4e9b\u503c\u5f97\u770b|\u4eca\u5929AI\u6709\u4ec0\u4e48(?:\u70ed\u70b9|\u503c\u5f97\u770b|\u503c\u5f97\u5173\u6ce8)|\u4eca\u5929AI\u6709\u54ea\u4e9b(?:\u70ed\u70b9|\u503c\u5f97\u770b|\u503c\u5f97\u5173\u6ce8)|\u4eca\u5929\u6709\u54ea\u4e9b\u503c\u5f97\u770b|\u4eca\u5929\u6709\u54ea\u4e9b\u70ed\u95e8|\u4eca\u5929\u6709\u4ec0\u4e48\u70ed\u95e8)/i.test(normalized),
    isLikelyQuestion: /(?:\uff1f|\?|[\u5417\u5462]$|\u600e\u4e48|\u4ec0\u4e48|\u54ea\u4e9b|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5)/i.test(normalized),
  };
}

export function classifyAiIntelIntentV2(text) {
  const s = buildIntentSignalsV2(text);
  if (!s.normalized) {
    return { mode: "none", score: 0, normalizedText: "", reason: "empty" };
  }
  if (s.hasExplicitPrefix) {
    return { mode: "direct", score: 99, normalizedText: s.normalized, reason: "explicit_prefix" };
  }

  let score = 0;
  if (s.mentionsAi) score += 2;
  if (s.mentionsToday) score += 1;
  if (s.mentionsIntelType) score += 2;
  if (s.mentionsFind) score += 2;
  if (s.mentionsCount) score += 1;
  if (s.mentionsUseCase) score += 1;
  if (s.mentionsWriteNotion) score += 2;
  if (s.mentionsHotspotStyle) score += 3;
  if (s.isLikelyQuestion && !s.mentionsFind && !s.mentionsWriteNotion && !s.mentionsHotspotStyle) score -= 2;

  if (s.mentionsHotspotStyle && (s.mentionsAi || s.mentionsToday || s.mentionsIntelType)) {
    return { mode: "direct", score: Math.max(score, 6), normalizedText: s.normalized, reason: "hotspot_style" };
  }
  if (score >= 5) {
    return { mode: "direct", score, normalizedText: s.normalized, reason: "high_confidence" };
  }
  if (score >= 3 && (s.mentionsAi || s.mentionsIntelType) && (s.mentionsToday || s.mentionsFind || s.mentionsHotspotStyle)) {
    return { mode: "confirm", score, normalizedText: s.normalized, reason: "needs_confirmation" };
  }
  return { mode: "none", score, normalizedText: s.normalized, reason: "low_confidence" };
}

function parseTopicV2(text) {
  const normalized = String(text || "").trim();
  const rules = [
    { keyword: /(?:\u7597\u6108|\u6cbb\u6108|\u5fc3\u7406|\u60c5\u7eea|\u6b63\u5ff5|\u51a5\u60f3|\u7126\u8651|\u7761\u7720|\u4eb2\u5bc6\u5173\u7cfb|\u5973\u6027\u6210\u957f|healing|mindful|mindfulness|therapy|mental health|meditation)/i, label: "\u7597\u6108\u8bdd\u9898", query: "healing mindfulness mental health meditation relationships sleep anxiety" },
    { keyword: /(?:\u70ed\u70b9|\u70ed\u95e8|\u770b\u70b9|\u503c\u5f97\u770b|\u503c\u5f97\u5173\u6ce8)/i, label: "\u4eca\u65e5\u70ed\u70b9", query: "trends launches tools market updates" },
    { keyword: /(?:\u89c6\u9891|\u77ed\u89c6\u9891|video)/i, label: "\u89c6\u9891\u751f\u6210", query: "video generation" },
    { keyword: /(?:\u81ea\u5a92\u4f53|\u5185\u5bb9|\u5199\u4f5c|content)/i, label: "\u5185\u5bb9\u751f\u6210", query: "content creation writing" },
    { keyword: /(?:\u667a\u80fd\u4f53|agent)/i, label: "\u667a\u80fd\u4f53", query: "AI agents automation" },
    { keyword: /(?:\u81ea\u52a8\u5316|\u5de5\u4f5c\u6d41|\u6548\u7387)/i, label: "\u81ea\u52a8\u5316", query: "automation workflow productivity" },
    { keyword: /(?:\u7f16\u7a0b|\u4ee3\u7801|\u5f00\u53d1|dev|codex)/i, label: "\u5f00\u53d1\u6548\u7387", query: "developer coding tools" },
    { keyword: /(?:\u884c\u4e1a|\u8d5b\u9053|\u5e02\u573a|\u7ade\u54c1)/i, label: "\u884c\u4e1a\u8d8b\u52bf", query: "industry market enterprise business" },
  ];
  return rules.find((rule) => rule.keyword.test(normalized)) || null;
}

function parseAudienceV2(text) {
  const normalized = String(text || "").trim();
  const rules = [
    { keyword: /(?:\u9002\u5408\u505a\u5185\u5bb9|\u9002\u5408\u5199|\u5185\u5bb9\u9009\u9898)/i, label: "\u5185\u5bb9", hint: "content ideas creator topics" },
    { keyword: /(?:\u81ea\u5a92\u4f53|\u535a\u4e3b|\u5185\u5bb9\u53f7)/i, label: "\u81ea\u5a92\u4f53", hint: "content creator self-media" },
    { keyword: /(?:\u77ed\u89c6\u9891|\u6296\u97f3|\u5c0f\u7ea2\u4e66|\u89c6\u9891\u53f7)/i, label: "\u77ed\u89c6\u9891", hint: "short video creator" },
    { keyword: /(?:\u7f16\u7a0b|\u5f00\u53d1|\u5de5\u7a0b\u5e08|coder|developer)/i, label: "\u7f16\u7a0b", hint: "developer coding engineering" },
    { keyword: /(?:\u81ea\u52a8\u5316|\u5de5\u4f5c\u6d41|\u6548\u7387|\u81ea\u52a8\u53d1\u5e03)/i, label: "\u81ea\u52a8\u5316", hint: "automation workflow productivity" },
    { keyword: /(?:\u8fd0\u8425|\u589e\u957f|\u8425\u9500)/i, label: "\u8fd0\u8425", hint: "operations growth marketing" },
  ];
  return rules.find((rule) => rule.keyword.test(normalized)) || null;
}

function extractRequestedTopicPhrase(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const patterns = [
    /\u8bf7\u83b7\u53d6\s+(.+?)\s+\u65b9\u5411/u,
    /\u83b7\u53d6\s+(.+?)\s+\u65b9\u5411/u,
    /\u641c\u7d22\s+(.+?)(?:\u76f8\u5173|\u65b9\u5411|\u7684)/u,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function buildTopicRelevanceTerms(text, topic) {
  const phrase = extractRequestedTopicPhrase(text);
  const raw = [phrase, topic?.label || "", topic?.query || ""].join(" ");
  const stopWords = new Set([
    "\u60c5\u62a5",
    "\u8bdd\u9898",
    "\u884c\u4e1a",
    "\u7d20\u6750",
    "\u70ed\u95e8",
    "\u65b9\u5411",
    "\u5185\u5bb9",
    "\u5c0f\u7ea2\u4e66",
    "content",
    "ideas",
    "topics",
  ]);
  const terms = new Set();
  for (const match of raw.matchAll(/[a-z0-9][a-z0-9._-]{2,}/gi)) {
    const term = match[0].toLowerCase();
    if (!stopWords.has(term)) terms.add(term);
  }
  for (const match of raw.matchAll(/[\u4e00-\u9fff]{2,8}/gu)) {
    const term = match[0];
    if (!stopWords.has(term)) terms.add(term);
  }
  return [...terms].slice(0, 20);
}

function itemMatchesTopic(item, terms) {
  if (!terms.length) return true;
  const haystack = `${item?.title || ""} ${item?.summary || ""} ${item?.source || ""} ${item?.category || ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(String(term).toLowerCase()));
}

function buildIntentSignals(text) {
  const normalized = normalizeIntentText(text);
  return {
    normalized,
    hasExplicitPrefix: Boolean(stripCommandPrefix(text)),
    mentionsToday: /今天|今日/.test(normalized),
    mentionsAi: /AI|人工智能|大模型|智能体/i.test(normalized),
    mentionsIntelType: /情报|资讯|新闻|选题|行业/.test(normalized),
    mentionsFind: /找|搜|整理|汇总|信息|盘点|筛/.test(normalized),
    mentionsCount: /(\d+)\s*条/.test(normalized),
    mentionsUseCase: /适合|用于|用途|自媒体|编程|自动化|短视频|运营/.test(normalized),
    mentionsWriteNotion: /Notion|写入|记录|入库|存入/i.test(normalized),
    isLikelyQuestion: /？|\?|怎么|为什么|啥|是什么|能不能|可不可以/.test(normalized),
  };
}

export function classifyAiIntelIntent(text) {
  const s = buildIntentSignals(text);
  if (!s.normalized) {
    return { mode: "none", score: 0, normalizedText: "", reason: "empty" };
  }
  if (s.hasExplicitPrefix) {
    return { mode: "direct", score: 99, normalizedText: s.normalized, reason: "explicit_prefix" };
  }

  let score = 0;
  if (s.mentionsAi) score += 2;
  if (s.mentionsToday) score += 1;
  if (s.mentionsIntelType) score += 2;
  if (s.mentionsFind) score += 2;
  if (s.mentionsCount) score += 1;
  if (s.mentionsUseCase) score += 1;
  if (s.mentionsWriteNotion) score += 2;
  if (s.isLikelyQuestion && !s.mentionsFind && !s.mentionsWriteNotion) score -= 2;

  if (score >= 5) {
    return { mode: "direct", score, normalizedText: s.normalized, reason: "high_confidence" };
  }
  if (score >= 3 && (s.mentionsAi || s.mentionsIntelType) && (s.mentionsToday || s.mentionsFind)) {
    return { mode: "confirm", score, normalizedText: s.normalized, reason: "needs_confirmation" };
  }
  return { mode: "none", score, normalizedText: s.normalized, reason: "low_confidence" };
}

function parseTopic(text) {
  const normalized = String(text).trim();
  const rules = [
    { keyword: /视频|短视频|video/i, label: "视频生成", query: "video generation" },
    { keyword: /自媒体|内容|写作|content/i, label: "内容生成", query: "content creation writing" },
    { keyword: /智能体|agent/i, label: "智能体", query: "AI agents automation" },
    { keyword: /自动化|工作流|效率/i, label: "自动化", query: "automation workflow productivity" },
    { keyword: /编程|代码|开发|dev|codex/i, label: "开发效率", query: "developer coding tools" },
    { keyword: /行业|赛道|市场|竞品/i, label: "行业趋势", query: "industry market enterprise AI" },
  ];
  return rules.find((rule) => rule.keyword.test(normalized)) || null;
}

function parseAudience(text) {
  const normalized = String(text).trim();
  const rules = [
    { keyword: /自媒体|博主|内容号/i, label: "自媒体", hint: "content creator self-media" },
    { keyword: /短视频|抖音|小红书|视频号/i, label: "短视频", hint: "short video creator" },
    { keyword: /编程|开发|工程师|coder|developer/i, label: "编程", hint: "developer coding engineering" },
    { keyword: /自动化|工作流|效率|自动发布/i, label: "自动化", hint: "automation workflow productivity" },
    { keyword: /运营|增长|营销/i, label: "运营", hint: "operations growth marketing" },
  ];
  return rules.find((rule) => rule.keyword.test(normalized)) || null;
}

function loadWorkflowConfig(baseDir) {
  const configPath = path.join(baseDir, "notion-ai-intel.config.json");
  const examplePath = path.join(baseDir, "notion-ai-intel.config.example.json");
  const config = readJson(configPath, null) || readJson(examplePath, {});
  const disabledFeedUrls = new Set(uniqueFeedUrls(Array.isArray(config.disabled_feed_urls) ? config.disabled_feed_urls : []));
  return {
    path: configPath,
    enabled: config.enabled !== false,
    feedUrls: uniqueFeedUrls([
      ...DOMESTIC_FEED_URLS,
      ...HEALING_FEED_URLS,
      ...(Array.isArray(config.feed_urls) && config.feed_urls.length
        ? config.feed_urls
        : config.feed_url
          ? [config.feed_url]
          : DEFAULT_FEED_URLS),
    ]).filter((url) => !disabledFeedUrls.has(url)),
    fetchLimit: config.fetch_limit || DEFAULT_FETCH_LIMIT,
    notion: {
      token: process.env.NOTION_TOKEN || config?.notion?.token || "",
      databaseId: process.env.NOTION_DATABASE_ID || config?.notion?.database_id || "",
      propertyMap: {
        title: config?.notion?.property_map?.title || TEXT.title,
        summary: config?.notion?.property_map?.summary || TEXT.summary,
        usage: config?.notion?.property_map?.usage || TEXT.usage,
        link: config?.notion?.property_map?.link || TEXT.link,
        date: config?.notion?.property_map?.date || TEXT.date,
        category: config?.notion?.property_map?.category || TEXT.category,
      },
    },
  };
}

function buildTopicFeedUrls(topic, text = "") {
  if (!topic?.query) return [];
  const normalized = String(text || "");
  const needsAiScope = /(?:\bAI\b|\u4eba\u5de5\u667a\u80fd|\u5927\u6a21\u578b|\u667a\u80fd\u4f53|\u6a21\u578b)/i.test(normalized);
  const query = needsAiScope ? `${topic.query} AI` : topic.query;
  const encoded = encodeURIComponent(query);
  return [
    `https://news.google.com/rss/search?q=${encoded}%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen`,
  ];
}

function notionIsConfigured(config) {
  const token = String(config?.notion?.token || "").trim();
  const databaseId = String(config?.notion?.databaseId || "").trim();
  if (!token || !databaseId) return false;
  if (/secret_xxx/i.test(token)) return false;
  if (/^[x]+$/i.test(databaseId)) return false;
  return true;
}

export function listIntelFeedSources(baseDir = process.cwd()) {
  const workflowConfig = loadWorkflowConfig(baseDir);
  return workflowConfig.feedUrls.map((url) => {
    const meta = FEED_LABELS[url] || {};
    const builtIn = BUILT_IN_FEED_URLS.has(url);
    return {
      url,
      name: meta.name || new URL(url).hostname,
      region: meta.region || "custom",
      builtIn,
      removable: true,
    };
  });
}

async function checkSingleFeedSource(source, timeoutMs = 8000) {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 OpenClaw-Intel-Source-Check/1.0",
          Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
      });
      const body = await res.text();
      const items = res.ok ? parseRssItems(body) : [];
      return {
        ...source,
        ok: res.ok && items.length > 0,
        status: res.status,
        itemCount: items.length,
        ms: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        message: res.ok
          ? items.length > 0 ? "可用" : "未解析到 RSS 条目"
          : `HTTP ${res.status}`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      ...source,
      ok: false,
      status: 0,
      itemCount: 0,
      ms: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      message: String(error?.name || error?.message || error),
    };
  }
}

export async function checkIntelFeedSources({ baseDir = process.cwd(), timeoutMs = 8000 } = {}) {
  const sources = listIntelFeedSources(baseDir);
  const results = [];
  for (const source of sources) {
    results.push(await checkSingleFeedSource(source, timeoutMs));
  }
  const okCount = results.filter((item) => item.ok).length;
  return {
    ok: okCount > 0,
    checkedAt: new Date().toISOString(),
    total: results.length,
    okCount,
    failedCount: results.length - okCount,
    sources: results,
  };
}

export function addIntelFeedSource({ baseDir = process.cwd(), url } = {}) {
  const feedUrl = String(url || "").trim();
  if (!feedUrl) throw new Error("请输入 RSS 源地址");
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    throw new Error("RSS 源地址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("RSS 源只支持 http 或 https");
  }

  const configPath = path.join(baseDir, "notion-ai-intel.config.json");
  const examplePath = path.join(baseDir, "notion-ai-intel.config.example.json");
  const config = readJson(configPath, null) || readJson(examplePath, {});
  const existing = uniqueFeedUrls([
    ...(Array.isArray(config.feed_urls) ? config.feed_urls : []),
    ...(config.feed_url ? [config.feed_url] : []),
  ]);
  if (!existing.includes(feedUrl)) existing.push(feedUrl);
  config.feed_urls = existing;
  config.disabled_feed_urls = uniqueFeedUrls(Array.isArray(config.disabled_feed_urls) ? config.disabled_feed_urls : [])
    .filter((item) => item !== feedUrl);
  delete config.feed_url;
  writeJson(configPath, config);
  return {
    added: true,
    url: feedUrl,
    sources: listIntelFeedSources(baseDir),
  };
}

export function removeIntelFeedSource({ baseDir = process.cwd(), url } = {}) {
  const feedUrl = String(url || "").trim();
  if (!feedUrl) throw new Error("请输入要删除的 RSS 源地址");

  const configPath = path.join(baseDir, "notion-ai-intel.config.json");
  const examplePath = path.join(baseDir, "notion-ai-intel.config.example.json");
  const config = readJson(configPath, null) || readJson(examplePath, {});
  const customFeeds = uniqueFeedUrls([
    ...(Array.isArray(config.feed_urls) ? config.feed_urls : []),
    ...(config.feed_url ? [config.feed_url] : []),
  ]).filter((item) => item !== feedUrl);
  config.feed_urls = customFeeds;
  delete config.feed_url;

  const disabled = uniqueFeedUrls(Array.isArray(config.disabled_feed_urls) ? config.disabled_feed_urls : []);
  if (BUILT_IN_FEED_URLS.has(feedUrl) && !disabled.includes(feedUrl)) disabled.push(feedUrl);
  config.disabled_feed_urls = disabled;

  writeJson(configPath, config);
  return {
    removed: true,
    url: feedUrl,
    sources: listIntelFeedSources(baseDir),
  };
}

async function notionFetchJson(url, token, body) {
  let lastError = null;
  for (let attempt = 0; attempt <= NOTION_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Notion request failed: ${res.status} ${text}`);
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt >= NOTION_RETRY_COUNT) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Unknown Notion request failure");
}

function buildNotionPayload(item, notionConfig) {
  return {
    parent: { database_id: notionConfig.databaseId },
    properties: {
      [notionConfig.propertyMap.title]: {
        title: [{ text: { content: item.title } }],
      },
      [notionConfig.propertyMap.summary]: {
        rich_text: [{ text: { content: item.summary } }],
      },
      [notionConfig.propertyMap.usage]: {
        rich_text: [{ text: { content: item.usage } }],
      },
      [notionConfig.propertyMap.link]: {
        url: item.link || null,
      },
      [notionConfig.propertyMap.date]: {
        date: { start: item.date || new Date().toISOString() },
      },
      [notionConfig.propertyMap.category]: {
        select: { name: item.category || "AI情报" },
      },
    },
  };
}

async function writeItemsToNotion(items, notionConfig) {
  const results = [];
  for (const item of items) {
    const payload = buildNotionPayload(item, notionConfig);
    const data = await notionFetchJson("https://api.notion.com/v1/pages", notionConfig.token, payload);
    results.push({
      title: item.title,
      pageId: data.id || null,
      url: data.url || null,
    });
  }
  return results;
}

function inferSourceFromLink(link) {
  try {
    return link ? new URL(link).hostname : "";
  } catch {
    return "";
  }
}

function upsertItemsToLocalIntel(items, { notionPages = [], notionStatus = "local_only" } = {}) {
  if (!Array.isArray(items) || !items.length) {
    return { writtenCount: 0, duplicateCount: 0 };
  }

  const pageByTitle = new Map(
    notionPages
      .filter((page) => page?.title)
      .map((page) => [page.title, page]),
  );
  const db = openLocalDb();
  initLocalDb(db);
  let writtenCount = 0;
  let duplicateCount = 0;
  const now = new Date().toISOString();

  try {
    db.exec("BEGIN");
    for (const item of items) {
      const sourceUrl = String(item.link || "").trim();
      const page = pageByTitle.get(item.title) || {};
      const existing = sourceUrl
        ? db.prepare("SELECT id FROM intel_items WHERE source_url = ? LIMIT 1").get(sourceUrl)
        : null;
      const id = existing?.id || crypto.randomUUID();
      if (existing?.id) duplicateCount += 1;
      else writtenCount += 1;

      db.prepare(`
        INSERT INTO intel_items (
          id, title, summary, source, source_url, category, tags_json, usage,
          fit_for_json, published_at, fetched_at, notion_page_id, notion_sync_status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          source = excluded.source,
          source_url = excluded.source_url,
          category = excluded.category,
          tags_json = excluded.tags_json,
          usage = excluded.usage,
          fit_for_json = excluded.fit_for_json,
          published_at = excluded.published_at,
          fetched_at = excluded.fetched_at,
          notion_page_id = COALESCE(NULLIF(excluded.notion_page_id, ''), intel_items.notion_page_id),
          notion_sync_status = excluded.notion_sync_status,
          updated_at = excluded.updated_at
      `).run(
        id,
        item.title,
        item.summary || "",
        inferSourceFromLink(sourceUrl),
        sourceUrl,
        item.category || "",
        JSON.stringify([]),
        item.usage || "",
        JSON.stringify(item.fit_for || []),
        item.date || "",
        now,
        page.pageId || "",
        notionStatus,
        now,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  return { writtenCount, duplicateCount };
}

async function findExistingLinks(items, notionConfig) {
  const existing = new Set();
  for (const item of items) {
    if (!item.link) continue;
    const data = await notionFetchJson(
      `https://api.notion.com/v1/databases/${notionConfig.databaseId}/query`,
      notionConfig.token,
      {
        page_size: 1,
        filter: {
          property: notionConfig.propertyMap.link,
          url: { equals: item.link },
        },
      },
    );
    if (Array.isArray(data.results) && data.results.length > 0) {
      existing.add(item.link);
    }
  }
  return existing;
}

function buildWechatReply(result) {
  const lines = [];
  lines.push(result.wechatSummary || TEXT.replyLead);
  for (const [index, item] of result.items.entries()) {
    lines.push(`${index + 1}. ${item.title}`);
    if (item.category) lines.push(`分类：${item.category}`);
    if (item.usage) lines.push(`用途：${item.usage}`);
    if (Array.isArray(item.fit_for) && item.fit_for.length) {
      lines.push(`适合：${item.fit_for.join(" / ")}`);
    }
    lines.push("");
  }

  if (result.notion.status === "written") {
    lines.push(`状态：已写入 Notion ${result.notion.writtenCount}/${result.items.length} 条`);
    if (result.notion.duplicateCount > 0) {
      lines.push(`重复跳过：${result.notion.duplicateCount} 条`);
    }
  } else if (result.notion.status === "skipped") {
    lines.push("状态：未写入 Notion");
  } else {
    lines.push("状态：写入 Notion 失败");
  }

  return lines.filter(Boolean).join("\n\n");
}

export async function maybeRunAiIntelWorkflow({ baseDir, llm, userText, logger, modelTimeoutMs, force = false, aiCallMeta = null }) {
  const intent = classifyAiIntelIntentV2(userText);
  const normalizedUserText = intent.normalizedText;
  if (!normalizedUserText || (!force && intent.mode !== "direct")) {
    return null;
  }

  const workflowConfig = loadWorkflowConfig(baseDir);
  const requestedLimit = parseRequestedLimit(normalizedUserText);
  const topic = parseTopicV2(normalizedUserText);
  const requestedTopicPhrase = extractRequestedTopicPhrase(normalizedUserText);
  const effectiveTopic = topic || (requestedTopicPhrase ? { label: requestedTopicPhrase, query: requestedTopicPhrase } : null);
  const audience = parseAudienceV2(normalizedUserText);
  const requestedCategory = inferItemCategory(normalizedUserText);
  const topicTerms = buildTopicRelevanceTerms(normalizedUserText, effectiveTopic);
  const feedUrls = [...buildTopicFeedUrls(effectiveTopic, normalizedUserText), ...workflowConfig.feedUrls];

  let candidates = (await fetchCandidateItems(feedUrls, workflowConfig.fetchLimit * 2))
    .filter((item) => item.title && item.link)
    .slice(0, workflowConfig.fetchLimit * 2);

  if (effectiveTopic && topicTerms.length) {
    const filtered = candidates.filter((item) => {
      return itemMatchesTopic(item, topicTerms) ||
        `${item.title} ${item.summary} ${item.source || ""}`.toLowerCase().includes(String(effectiveTopic.query || "").split(" ")[0].toLowerCase());
    });
    candidates = filtered;
  }

  if (audience) {
    const filtered = candidates.filter((item) => {
      const haystack = `${item.title} ${item.summary} ${item.source || ""}`.toLowerCase();
      return audience.hint.split(" ").some((token) => token && haystack.includes(token.toLowerCase()));
    });
    if (filtered.length > 0) candidates = filtered;
  }

  candidates = candidates.slice(0, workflowConfig.fetchLimit);
  if (!candidates.length) {
    return {
      handled: true,
      replyText: TEXT.noFeed,
      debug: { stage: "fetch", candidateCount: 0 },
    };
  }

  const selected = await callModelJson(
    llm,
    buildSelectionPrompt(
      normalizedUserText,
      candidates,
      requestedLimit,
      new Date().toISOString(),
      requestedCategory,
      audience,
    ),
    modelTimeoutMs,
    {
      logger,
      workflow: aiCallMeta?.workflow || "情报流程",
      step: aiCallMeta?.step || 1,
      totalSteps: aiCallMeta?.totalSteps || 1,
      purpose: aiCallMeta?.purpose || "从抓取到的来源里筛选、总结、分类成可推送情报",
    },
  );

  const items = Array.isArray(selected?.items)
    ? selected.items
        .map((item) => ({
          title: String(item?.title || "").trim(),
          summary: String(item?.summary || "").trim(),
          usage: String(item?.usage || "").trim(),
          link: String(item?.link || "").trim(),
          date: normalizeIsoDate(item?.date) || new Date().toISOString(),
          category: VALID_CATEGORIES.includes(String(item?.category || "").trim())
            ? String(item?.category || "").trim()
            : requestedCategory,
          fit_for: Array.isArray(item?.fit_for)
            ? item.fit_for.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 4)
            : [],
        }))
        .filter((item) => item.title && item.summary && item.usage)
        .filter((item) => itemMatchesTopic(item, topicTerms))
        .slice(0, requestedLimit)
    : [];

  if (!items.length) {
    return {
      handled: true,
      replyText: TEXT.noStructuredItems,
      debug: { stage: "selection", candidateCount: candidates.length },
    };
  }

  const result = {
    items,
    wechatSummary: String(selected?.wechat_summary || "").trim(),
    notion: {
      status: "skipped",
      writtenCount: 0,
      duplicateCount: 0,
      pages: [],
      error: null,
      configPath: workflowConfig.path,
    },
    local: {
      status: "skipped",
      writtenCount: 0,
      duplicateCount: 0,
      error: null,
    },
  };

  try {
    const local = upsertItemsToLocalIntel(items, {
      notionPages: [],
      notionStatus: "pending",
    });
    result.local.status = "written";
    result.local.writtenCount = local.writtenCount;
    result.local.duplicateCount = local.duplicateCount;
  } catch (error) {
    result.local.status = "failed";
    result.local.error = String(error);
  }

  if (workflowConfig.enabled && notionIsConfigured(workflowConfig)) {
    try {
      const existingLinks = await findExistingLinks(items, workflowConfig.notion);
      const freshItems = items.filter((item) => !existingLinks.has(item.link));
      result.notion.duplicateCount = items.length - freshItems.length;
      if (freshItems.length > 0) {
        const pages = await writeItemsToNotion(freshItems, workflowConfig.notion);
        result.notion.status = "written";
        result.notion.writtenCount = pages.length;
        result.notion.pages = pages;
      } else {
        result.notion.status = "written";
        result.notion.writtenCount = 0;
      }
    } catch (error) {
      result.notion.status = "failed";
      result.notion.error = String(error);
    }
  }

  if (result.local.status === "written" && result.notion.status === "written") {
    try {
      const local = upsertItemsToLocalIntel(items, {
        notionPages: result.notion.pages,
        notionStatus: "synced_from_notion",
      });
      result.local.duplicateCount = local.duplicateCount;
    } catch (error) {
      result.notion.status = "failed";
      result.notion.error = String(error);
    }
  }

  logger?.("INFO", "AI intel workflow completed", {
    selectedCount: items.length,
    notionStatus: result.notion.status,
    writtenCount: result.notion.writtenCount,
    duplicateCount: result.notion.duplicateCount,
    localStatus: result.local.status,
    localWrittenCount: result.local.writtenCount,
    localDuplicateCount: result.local.duplicateCount,
    category: requestedCategory,
    topic: effectiveTopic?.label || null,
    audience: audience?.label || null,
    llmMode: llm.mode,
    llmModel: llm.model,
  });

  return {
    handled: true,
    replyText: buildWechatReply(result),
    debug: result,
  };
}

export function buildAiIntelConfirmationReply() {
  return TEXT.confirmPrompt;
}
