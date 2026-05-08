import crypto from "node:crypto";
import { runOpenClawAgent, buildWechatSessionId } from "./openclaw-agent-client.mjs";

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_FETCH_LIMIT = 8;
const DEFAULT_REPLY_LIMIT = 3;
const FINANCE_FEED_URLS = [
  "https://news.google.com/rss/search?q=%E4%B8%AD%E5%9B%BD%20%E8%B4%A2%E7%BB%8F%20%E8%82%A1%E5%B8%82%20when%3A1d&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans",
  "https://news.google.com/rss/search?q=%E5%AE%8F%E8%A7%82%20%E6%94%BF%E7%AD%96%20%E5%B8%82%E5%9C%BA%20when%3A1d&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans",
  "https://news.google.com/rss/search?q=%E8%A1%8C%E4%B8%9A%20%E5%85%AC%E5%91%8A%20%E8%B4%A2%E6%8A%A5%20when%3A1d&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans"
];

const DIRECT_PATTERNS = [
  /财经.*(分析|解读|影响)/i,
  /(分析|解读).*(财经|新闻|消息|公告)/i,
  /(利好|利空).*(板块|个股)/i,
  /(板块|个股).*(利好|利空|影响)/i,
  /(政策|公告|财报|业绩|降息|加息|补贴|并购|重组).*(板块|个股|行业)/i,
];

const HINT_PATTERNS = [
  /财经|宏观|板块|个股|利好|利空|财报|业绩|公告|消息|新闻|行业/i,
  /影响|怎么看|解读|分析|受益|受损|受影响/i,
];

const BRIEF_PATTERNS = [
  /财经早报/i,
  /财经简报/i,
  /板块早报/i,
  /市场早报/i,
  /今天.*财经.*(值得看|重点|简报)/i,
];

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

function truncate(text, max = 1200) {
  const normalized = String(text || "").trim();
  if (!normalized) return "这条财经新闻我暂时没整理出稳定结论，你可以再发一次更完整的新闻原文。";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

export function classifyFinanceNewsIntent(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return { mode: "none", score: 0, normalizedText: "", reason: "empty" };

  if (DIRECT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { mode: "direct", score: 100, normalizedText: normalized, reason: "direct_pattern" };
  }

  let score = 0;
  if (HINT_PATTERNS[0].test(normalized)) score += 2;
  if (HINT_PATTERNS[1].test(normalized)) score += 2;
  if (normalized.length >= 25) score += 1;
  if (/板块|个股/.test(normalized)) score += 1;

  if (score >= 4) {
    return { mode: "direct", score, normalizedText: normalized, reason: "high_confidence" };
  }
  return { mode: "none", score, normalizedText: normalized, reason: "low_confidence" };
}

export function classifyFinanceBriefIntent(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return { mode: "none", normalizedText: "", reason: "empty" };
  if (BRIEF_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { mode: "direct", normalizedText: normalized, reason: "direct_pattern" };
  }
  return { mode: "none", normalizedText: normalized, reason: "low_confidence" };
}

function buildAnalysisPrompt(userText) {
  return [
    "You are a finance news impact analyst for Chinese users.",
    "Analyze the news as scenario-based market interpretation, not direct investment advice.",
    "Return strict JSON only.",
    'Schema: {"event":"string","core_conclusion":"string","bullish_sectors":["string"],"bullish_stocks":["string"],"bearish_sectors":["string"],"bearish_stocks":["string"],"impact_logic":["string"],"short_term_impact":"string","medium_term_impact":"string","watch_items":["string"],"risk_notes":["string"]}',
    "Rules:",
    "- Be cautious and concrete.",
    "- If impact is mixed or uncertain, say so in core_conclusion and risk_notes.",
    "- Do not invent too many stock names. Use only reasonably inferable names.",
    "- Focus on sectors, stocks, mechanism, short-term and medium-term impact.",
    "- Write values in concise Chinese.",
    `User input: ${userText}`,
  ].join("\n");
}

function buildBriefSelectionPrompt(userText, items, limit) {
  return [
    "You are selecting the most important finance and market-moving news items for a Chinese user.",
    "Return strict JSON only.",
    'Schema: {"items":[{"title":"string","summary":"string","bullish_sectors":["string"],"bullish_stocks":["string"],"bearish_sectors":["string"],"bearish_stocks":["string"],"impact_logic":["string"]}],"lead":"string"}',
    `Need exactly ${limit} items if enough candidates exist, otherwise return as many as are credible.`,
    "Choose items that are most likely to affect sectors, stocks, or broad market sentiment.",
    "Write concise Chinese.",
    `User request: ${userText}`,
    `Candidates: ${JSON.stringify(items)}`,
  ].join("\n");
}

async function callModelJsonViaApi(llm, prompt, timeoutMs, meta = {}) {
  const startedAt = Date.now();
  meta.logger?.("INFO", "AI API call", {
    workflow: meta.workflow || "财经流程",
    step: meta.step || 1,
    totalSteps: meta.totalSteps || 1,
    purpose: meta.purpose || "分析财经新闻影响",
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
    const res = await fetch(new URL("chat/completions", llm.baseUrl).toString(), {
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
      throw new Error(`Finance analysis call failed: ${res.status} ${text}`);
    }
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Finance analysis returned empty content");
    }
    const parsed = JSON.parse(content);
    meta.logger?.("INFO", "AI API call completed", {
      workflow: meta.workflow || "财经流程",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "分析财经新闻影响",
      model: llm.model,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function callModelJson(llm, prompt, timeoutMs, meta = {}) {
  if (llm.mode === "openclaw-agent") {
    const startedAt = Date.now();
    const sessionId = buildWechatSessionId("wechat-finance", `${Date.now()}-${crypto.randomUUID()}`);
    meta.logger?.("INFO", "AI API call", {
      workflow: meta.workflow || "财经流程",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "分析财经新闻影响",
      mode: llm.mode,
      providerId: llm.providerId,
      model: llm.model,
      endpoint: "openclaw-agent",
      sessionId,
    });
    const result = await runOpenClawAgent({
      message: [
        "你现在是财经新闻影响分析助手。",
        "请严格只输出 JSON，不要输出 markdown 代码块，不要解释。",
        prompt,
      ].join("\n\n"),
      sessionId,
      timeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      thinking: "minimal",
    });
    const parsed = JSON.parse(result.text);
    meta.logger?.("INFO", "AI API call completed", {
      workflow: meta.workflow || "财经流程",
      step: meta.step || 1,
      totalSteps: meta.totalSteps || 1,
      purpose: meta.purpose || "分析财经新闻影响",
      model: llm.model,
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  }
  return callModelJsonViaApi(llm, prompt, timeoutMs, meta);
}

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function buildReply(data) {
  const bullishSectors = normalizeList(data?.bullish_sectors);
  const bullishStocks = normalizeList(data?.bullish_stocks);
  const bearishSectors = normalizeList(data?.bearish_sectors);
  const bearishStocks = normalizeList(data?.bearish_stocks);
  const impactLogic = normalizeList(data?.impact_logic);
  const watchItems = normalizeList(data?.watch_items);
  const riskNotes = normalizeList(data?.risk_notes);

  const lines = [];
  if (data?.event) lines.push(`事件：${String(data.event).trim()}`);
  if (data?.core_conclusion) lines.push(`核心结论：${String(data.core_conclusion).trim()}`);
  if (bullishSectors.length) lines.push(`利好板块：${bullishSectors.join("、")}`);
  if (bullishStocks.length) lines.push(`利好个股：${bullishStocks.join("、")}`);
  if (bearishSectors.length) lines.push(`利空板块：${bearishSectors.join("、")}`);
  if (bearishStocks.length) lines.push(`利空个股：${bearishStocks.join("、")}`);
  if (impactLogic.length) lines.push(`影响逻辑：${impactLogic.join("；")}`);
  if (data?.short_term_impact) lines.push(`短期影响：${String(data.short_term_impact).trim()}`);
  if (data?.medium_term_impact) lines.push(`中期影响：${String(data.medium_term_impact).trim()}`);
  if (watchItems.length) lines.push(`需要跟踪：${watchItems.join("；")}`);
  if (riskNotes.length) lines.push(`风险提示：${riskNotes.join("；")}`);
  return truncate(lines.join("\n"));
}

function buildBriefReply(selected) {
  const items = Array.isArray(selected?.items) ? selected.items : [];
  const lines = [String(selected?.lead || "今天值得关注的财经影响简报如下：").trim()];
  for (const [index, item] of items.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${String(item.title || "").trim()}`);
    if (item.summary) lines.push(`看点：${String(item.summary).trim()}`);
    const bullishSectors = normalizeList(item?.bullish_sectors);
    const bullishStocks = normalizeList(item?.bullish_stocks);
    const bearishSectors = normalizeList(item?.bearish_sectors);
    const bearishStocks = normalizeList(item?.bearish_stocks);
    const impactLogic = normalizeList(item?.impact_logic);
    if (bullishSectors.length) lines.push(`利好板块：${bullishSectors.join("、")}`);
    if (bullishStocks.length) lines.push(`利好个股：${bullishStocks.join("、")}`);
    if (bearishSectors.length) lines.push(`利空板块：${bearishSectors.join("、")}`);
    if (bearishStocks.length) lines.push(`利空个股：${bearishStocks.join("、")}`);
    if (impactLogic.length) lines.push(`影响逻辑：${impactLogic.join("；")}`);
  }
  return truncate(lines.join("\n"));
}

function parseRequestedLimit(text) {
  const match = String(text || "").match(/(\d+)\s*条/);
  if (!match) return DEFAULT_REPLY_LIMIT;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 10) : DEFAULT_REPLY_LIMIT;
}

export async function maybeRunFinanceNewsWorkflow({
  llm,
  userText,
  logger = () => {},
  modelTimeoutMs = DEFAULT_TIMEOUT_MS,
  force = false,
}) {
  const intent = classifyFinanceNewsIntent(userText);
  if (!force && intent.mode !== "direct") {
    return { handled: false, replyText: null, debug: { reason: intent.reason, score: intent.score } };
  }

  const prompt = buildAnalysisPrompt(intent.normalizedText || userText);
  const data = await callModelJson(llm, prompt, modelTimeoutMs, {
    logger,
    workflow: "财经新闻分析",
    step: 1,
    totalSteps: 1,
    purpose: "分析单条财经新闻对板块、个股和产业链的影响",
  });
  const replyText = buildReply(data);

  logger("INFO", "Finance news analysis completed", {
    llmMode: llm.mode,
    llmModel: llm.model,
    intentScore: intent.score,
    bullishSectors: normalizeList(data?.bullish_sectors).length,
    bullishStocks: normalizeList(data?.bullish_stocks).length,
    bearishSectors: normalizeList(data?.bearish_sectors).length,
    bearishStocks: normalizeList(data?.bearish_stocks).length,
  });

  return {
    handled: true,
    replyText,
    debug: data,
  };
}

export async function maybeRunFinanceBriefWorkflow({
  llm,
  userText,
  logger = () => {},
  modelTimeoutMs = DEFAULT_TIMEOUT_MS,
  force = false,
}) {
  const intent = classifyFinanceBriefIntent(userText);
  if (!force && intent.mode !== "direct") {
    return { handled: false, replyText: null, debug: { reason: intent.reason } };
  }

  const limit = parseRequestedLimit(userText);
  const candidates = (await fetchCandidateItems(FINANCE_FEED_URLS, DEFAULT_FETCH_LIMIT)).filter((item) => item.title && item.link);
  if (!candidates.length) {
    return {
      handled: true,
      replyText: "今天暂时没有抓到稳定的财经新闻源，你稍后再试一次。",
      debug: { stage: "fetch", candidateCount: 0 },
    };
  }

  const selected = await callModelJson(llm, buildBriefSelectionPrompt(userText, candidates, limit), modelTimeoutMs, {
    logger,
    workflow: "财经简报",
    step: 1,
    totalSteps: 1,
    purpose: "从财经来源中筛选值得关注的新闻并生成简报",
  });
  const replyText = buildBriefReply(selected);

  logger("INFO", "Finance brief completed", {
    llmMode: llm.mode,
    llmModel: llm.model,
    candidateCount: candidates.length,
    selectedCount: Array.isArray(selected?.items) ? selected.items.length : 0,
  });

  return {
    handled: true,
    replyText,
    debug: selected,
  };
}
