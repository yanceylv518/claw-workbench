import { createIntel, getIntel, listIntel, syncIntelFromNotion, updateIntelEvaluation } from "../services/intel-service.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";
import { addIntelFeedSource, checkIntelFeedSources, listIntelFeedSources, maybeRunAiIntelWorkflow, removeIntelFeedSource } from "../../../notion-ai-intel-workflow.mjs";
import { appendRunnerLog, loadWorkflowLlm, loadWorkflowRuntimeConfig } from "../services/workflow-runner.mjs";

function normalizeTopic(value) {
  return String(value || "").trim();
}

function normalizeTopicLimit(value) {
  const limit = Number.parseInt(String(value || "5"), 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 10) : 5;
}

function ensureTrailingSlash(value) {
  return String(value || "").endsWith("/") ? String(value || "") : `${value}/`;
}

function compactText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeSourceType(value) {
  const raw = String(value || "manual").trim();
  const map = {
    xhs: "小红书",
    rednote: "小红书",
    wechat: "公众号",
    mp: "公众号",
    zhihu: "知乎",
    web: "网页",
    manual: "手动导入",
  };
  return map[raw] || raw || "手动导入";
}

async function callImportStructurer(llm, prompt, timeoutMs) {
  if (llm.mode !== "direct-api") return null;
  const startedAt = Date.now();
  appendRunnerLog("INFO", "AI API call", {
    workflow: "情报库",
    step: "import",
    totalSteps: 1,
    purpose: "话题导入结构化",
    mode: llm.mode,
    providerId: llm.providerId,
    model: llm.model,
    endpoint: "chat/completions",
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
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: "Return valid JSON only. No markdown fences. No commentary." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Import structuring failed: ${res.status} ${text}`);
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Import structuring returned empty content");
    appendRunnerLog("INFO", "AI API call completed", {
      workflow: "情报库",
      step: "import",
      totalSteps: 1,
      purpose: "话题导入结构化",
      model: llm.model,
      durationMs: Date.now() - startedAt,
      modelUsage: data?.usage || null,
    });
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

async function importIntelTopic(body = {}) {
  const rawText = String(body.text || body.content || "").trim();
  const sourceUrl = String(body.sourceUrl || body.url || "").trim();
  const sourceType = normalizeSourceType(body.sourceType || body.source);
  if (!rawText && !sourceUrl) {
    return { ok: false, error: "请先粘贴话题内容、文章正文或来源链接。" };
  }

  let structured = null;
  try {
    const { llm } = await loadWorkflowLlm();
    const runtime = await loadWorkflowRuntimeConfig();
    structured = await callImportStructurer(llm, [
      "请把用户导入的话题/素材整理成一条可进入情报库的 JSON。",
      'Schema: {"title":"string","summary":"string","usage":"string","category":"自媒体选题|行业情报|AI情报","tags":["string"],"fit_for":["string"]}',
      "要求：标题、摘要、使用建议必须忠于原文或链接上下文；不要编造原文没有的信息；适合转化为小红书内容时，usage 写具体内容角度。",
      `来源类型：${sourceType}`,
      sourceUrl ? `来源链接：${sourceUrl}` : "",
      `导入内容：${rawText}`,
    ].filter(Boolean).join("\n"), runtime.modelTimeoutMs);
  } catch (error) {
    appendRunnerLog("WARN", "Intel import structuring fallback", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const title = compactText(structured?.title || body.title || rawText || sourceUrl, 42);
  const summary = compactText(structured?.summary || rawText || sourceUrl, 260);
  const usage = compactText(structured?.usage || "已导入为话题素材，可人工评估后生成小红书内容任务。", 220);
  const item = createIntel({
    title,
    summary,
    usage,
    source: sourceType,
    sourceUrl,
    category: structured?.category || "自媒体选题",
    tags: Array.isArray(structured?.tags) ? structured.tags : [],
    fitFor: Array.isArray(structured?.fit_for) ? structured.fit_for : [],
    notionSyncStatus: "local_only",
  });
  return { ok: true, structured: Boolean(structured), item };
}

async function fetchIntelTopics(body = {}) {
  const topic = normalizeTopic(body.topic || body.query);
  if (!topic) {
    return {
      ok: false,
      error: "请先输入行业或话题关键词",
    };
  }
  const limit = normalizeTopicLimit(body.limit);
  const mode = String(body.mode || "topic").trim();
  const prompt = [
    `情报：请获取 ${topic} 方向适合转化成小红书内容的热门话题和行业素材，${limit}条。`,
    "不只看最新新闻，也要优先选择长期有人讨论、能反映用户痛点、适合做内容选题的素材。",
    "如果来源是英文，请整理成中文标题、摘要和可用方向。",
  ].join("\n");
  const { llm } = await loadWorkflowLlm();
  const runtime = await loadWorkflowRuntimeConfig();
  const result = await maybeRunAiIntelWorkflow({
    baseDir: process.cwd(),
    llm,
    userText: prompt,
    logger: appendRunnerLog,
    modelTimeoutMs: runtime.modelTimeoutMs,
    force: true,
    aiCallMeta: {
      workflow: "情报库",
      step: 1,
      totalSteps: 1,
      purpose: "获取行业热门话题和可转化情报",
    },
  });
  return {
    ok: Boolean(result?.handled),
    mode,
    topic,
    limit,
    written: result?.debug?.local?.writtenCount || 0,
    duplicate: result?.debug?.local?.duplicateCount || 0,
    selected: result?.debug?.items?.length || 0,
    candidateCount: result?.debug?.candidateCount || 0,
    message: result?.replyText || "未获取到可用话题",
  };
}

export async function handleIntelRoute({ req, res, url }) {
  if (url.pathname === "/api/local/intel" && req.method === "GET") {
    sendJson(res, listIntel(url));
    return true;
  }

  if (url.pathname === "/api/local/intel" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, createIntel(body), 201);
    return true;
  }

  if (url.pathname === "/api/local/intel/sync-notion" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, await syncIntelFromNotion(body));
    return true;
  }

  if (url.pathname === "/api/local/intel/fetch-topics" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = await fetchIntelTopics(body);
    sendJson(res, result, result.ok === false ? 400 : 200);
    return true;
  }

  if (url.pathname === "/api/local/intel/import-topic" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = await importIntelTopic(body);
    sendJson(res, result, result.ok === false ? 400 : 201);
    return true;
  }

  if (url.pathname === "/api/local/intel/source-status" && req.method === "GET") {
    const check = url.searchParams.get("check") !== "0";
    sendJson(res, check
      ? await checkIntelFeedSources({ baseDir: process.cwd() })
      : { sources: listIntelFeedSources(process.cwd()) });
    return true;
  }

  if (url.pathname === "/api/local/intel/sources" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, addIntelFeedSource({ baseDir: process.cwd(), url: body.url }), 201);
    return true;
  }

  const sourceMatch = url.pathname.match(/^\/api\/local\/intel\/sources\/(.+)$/);
  if (sourceMatch && req.method === "DELETE") {
    sendJson(res, removeIntelFeedSource({ baseDir: process.cwd(), url: decodeURIComponent(sourceMatch[1]) }));
    return true;
  }

  const intelMatch = url.pathname.match(/^\/api\/local\/intel\/([^/]+)$/);
  if (intelMatch) {
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const item = updateIntelEvaluation(decodeURIComponent(intelMatch[1]), body);
      sendJson(res, item ?? { error: "Intel item not found" }, item ? 200 : 404);
      return true;
    }

    const item = getIntel(decodeURIComponent(intelMatch[1]));
    sendJson(res, item ?? { error: "Intel item not found" }, item ? 200 : 404);
    return true;
  }

  return false;
}
