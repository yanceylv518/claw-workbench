import { buildWechatSessionId, runOpenClawAgent } from "../../../openclaw-agent-client.mjs";
import { appendRunnerLog, loadWorkflowLlm } from "./workflow-runner.mjs";

const DEFAULT_TIMEOUT_MS = Number(process.env.XIAOLONGXIA_VIRAL_MODEL_TIMEOUT_MS || 120000);

function ensureTrailingSlash(value) {
  return String(value || "").endsWith("/") ? String(value) : `${String(value || "")}/`;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .trim();
}

function extractJsonObject(input) {
  const source = String(input || "").trim();
  try {
    return JSON.parse(source);
  } catch {
    // Continue with balanced-object extraction.
  }
  const starts = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "{") starts.push(index);
  }
  for (let startIndex = starts.length - 1; startIndex >= 0; startIndex -= 1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = starts[startIndex]; index < source.length; index += 1) {
      const ch = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(source.slice(starts[startIndex], index + 1));
      }
    }
  }
  throw new Error(`模型没有返回可解析 JSON：${source.slice(0, 180)}`);
}

function extractFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s"'<>，。；、）)]+/i);
  return match ? match[0] : "";
}

function getTagAttr(tag, attr) {
  const match = String(tag || "").match(new RegExp(`${attr}=["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function getMetaContents(html, names = []) {
  const wanted = new Set(names.map((item) => String(item).toLowerCase()));
  const values = [];
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (getTagAttr(tag, "property") || getTagAttr(tag, "name")).toLowerCase();
    if (!wanted.has(key)) continue;
    const content = getTagAttr(tag, "content");
    if (content) values.push(content);
  }
  return values;
}

function extractXhsInitialState(html) {
  const match = String(html || "").match(/<script>\s*window\.__INITIAL_STATE__=([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/\bundefined\b/g, "null"));
  } catch {
    return null;
  }
}

function findPrimaryXhsNote(initialState) {
  const noteMap = initialState?.note?.noteDetailMap;
  if (!noteMap || typeof noteMap !== "object") return null;
  const currentId = initialState?.note?.currentNoteId || initialState?.note?.firstNoteId || "";
  const current = currentId ? noteMap[currentId]?.note : null;
  if (current) return current;
  const first = Object.values(noteMap).find((item) => item?.note);
  return first?.note || null;
}

function normalizeImageUrl(url) {
  return decodeHtml(String(url || ""))
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .trim();
}

function uniqueList(values, limit = 30) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = normalizeImageUrl(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    output.push(cleaned);
    if (output.length >= limit) break;
  }
  return output;
}

function extractXhsNoteImages(note) {
  const imageList = Array.isArray(note?.imageList) ? note.imageList : [];
  const urls = [];
  for (const image of imageList) {
    const infoList = Array.isArray(image?.infoList) ? image.infoList : [];
    const defaultScene = infoList.find((item) => String(item?.imageScene || "").toUpperCase() === "WB_DFT")?.url;
    const previewScene = infoList.find((item) => String(item?.imageScene || "").toUpperCase() === "WB_PRV")?.url;
    const fallback = image?.urlDefault || image?.urlPre || infoList.find((item) => item?.url)?.url;
    const url = defaultScene || fallback || previewScene;
    if (url) urls.push(url);
  }
  return uniqueList(urls, 20);
}

function scoreImageUrl(url) {
  const clean = normalizeImageUrl(url);
  let score = 0;
  if (/notes_pre_post/i.test(clean)) score += 100;
  if (/sns-webpic|xhscdn/i.test(clean)) score += 20;
  if (/!nd_dft/i.test(clean)) score += 10;
  if (/webp|jpg|jpeg|png/i.test(clean)) score += 5;
  if (/avatar|profile|icon|logo|qrcode|qr_code|comment|emoji|sticker|recommend|feed|search|user/i.test(clean)) score -= 80;
  if (!/notes_pre_post/i.test(clean)) score -= 30;
  return score;
}

function filterXhsNoteImages(values, limit = 12) {
  return uniqueList(values, 120)
    .map((url, index) => ({ url: normalizeImageUrl(url), index, score: scoreImageUrl(url) }))
    .filter((item) => item.url && item.score > 0)
    .sort((left, right) => left.index - right.index)
    .slice(0, limit)
    .map((item) => item.url);
}

function classifySourceInput(sourceText) {
  const text = String(sourceText || "").trim();
  const hasUrl = /https?:\/\/|xhslink\.com|xiaohongshu\.com|xsec_token|share_id|appuid|apptime/i.test(text);
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
  return {
    hasUrl,
    chineseChars,
    lineCount,
    looksLikeOnlyLink: hasUrl && chineseChars < 12 && lineCount <= 3,
  };
}

export function getViralServiceInfo() {
  return {
    mode: "local-api-native",
    description: "爆款拆解已由本地 API 直接处理，不再依赖旧控制台服务。",
  };
}

export async function parseXhsReference(input = {}) {
  const sourceText = String(input.sourceText || input.url || "").trim();
  const sourceUrl = extractFirstUrl(sourceText);
  if (!sourceUrl) {
    return { ok: false, error: "请先粘贴小红书链接、分享文案或可分析的正文素材。" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    const html = await response.text();
    const initialState = extractXhsInitialState(html);
    const note = findPrimaryXhsNote(initialState);
    const title = decodeHtml(
      note?.title
      || getMetaContents(html, ["og:title", "twitter:title"])[0]
      || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
      || "",
    ).replace(/\s*-\s*小红书\s*$/, "");
    const description = decodeHtml(note?.desc || getMetaContents(html, ["description", "og:description", "twitter:description"])[0] || "");
    const metaImages = getMetaContents(html, ["og:image", "twitter:image"]);
    const cdnImages = Array.from(html.matchAll(/https?:\/\/[^"'<>\\\s]+(?:xhscdn|sns-webpic)[^"'<>\\\s]*/gi)).map((item) => item[0]);
    const noteImages = extractXhsNoteImages(note);
    const rawImages = uniqueList([...metaImages, ...cdnImages], 120);
    const images = noteImages.length ? noteImages : filterXhsNoteImages(rawImages, 12);

    return {
      ok: Boolean(title || description || images.length),
      sourceUrl,
      finalUrl: response.url || sourceUrl,
      statusCode: response.status,
      title,
      description,
      images,
      imageCount: images.length,
      rawImageCount: Math.max(rawImages.length, noteImages.length),
      parseSource: note ? "xhs_initial_state" : "html_meta",
      warning: images.length ? "" : "未解析到图片。可手动补充截图、图片描述或正文内容后继续拆解。",
    };
  } catch (error) {
    return {
      ok: false,
      sourceUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildNeedsMoreInfoResult(sourceText, payload = {}) {
  const targetTopic = String(payload.targetTopic || "").trim();
  const accountDirection = String(payload.accountDirection || "").trim();
  return {
    mode: "needs_more_info",
    reference_summary: "当前只识别到链接或分享参数，还没有拿到正文、标题和图片内容，不能可靠拆解爆款逻辑。",
    available_signals: [
      "用户提供了小红书分享链接或分享参数",
      targetTopic ? `目标迁移主题：${targetTopic}` : "尚未填写明确迁移主题",
      accountDirection ? `账号方向：${accountDirection}` : "尚未填写账号方向",
    ],
    missing_info: [
      "参考笔记标题",
      "参考笔记正文或至少前 200 字",
      "封面图、正文图截图，或图片内容描述",
      "如需分析评论区，还需要 3-5 条高赞评论",
    ],
    viral_logic: {
      hook: "缺少标题和开头，暂时无法判断。",
      pain_or_desire: "缺少正文和评论反馈，暂时无法判断。",
      emotion: "缺少正文和画面信息，暂时无法判断。",
      structure: "缺少正文结构，暂时无法判断。",
      why_it_works: "只有链接时不做伪拆解，避免生成看似专业但不可靠的结论。",
    },
    image_strategy: {
      cover_role: "需要补充封面截图或描述后判断。",
      visual_style: "需要补充图片截图或描述后判断。",
      new_image_directions: [
        "补充封面截图后，可拆解构图、色彩、主体和文字策略。",
        "补充正文图后，可设计新的图片顺序和信息任务。",
        targetTopic ? `也可以直接围绕「${targetTopic}」设计原创配图方向。` : "也可以直接填写目标主题，跳过参考图拆解。",
      ],
    },
    migration_angles: [
      {
        title: targetTopic ? `${targetTopic}：先做原创选题，不依赖原链接` : "先补充截图或正文，再做拆解",
        angle: "如果只有链接，建议不要假装已经解析原文。要么补充截图和正文，要么直接按目标主题做原创发布包。",
        fit_score: targetTopic ? 68 : 30,
        risk: "信息不足，继续拆解会变成模型猜测。",
        why: "小红书链接在未登录或反爬环境下不一定能稳定解析，完整素材比链接本身更重要。",
      },
    ],
    recommended_direction: {
      title: targetTopic ? `直接围绕「${targetTopic}」做原创发布包` : "先补充参考笔记截图或正文",
      reason: targetTopic ? "当前已有目标主题，可以先走原创内容生产。" : "补齐素材后，拆解结果才可信。",
    },
    draft_brief: {
      topic: targetTopic || "",
      goal: "基于用户补充素材或目标主题，生成一篇不复制原文原图的原创小红书发布包。",
      audience: accountDirection || "",
      style: "真实、有具体场景、避免模板化拆解腔。",
      material: [
        `原始分享内容：${sourceText}`,
        "注意：当前只有链接或参数时，不能当作已解析原文。",
        "建议补充：标题、正文、截图、图片描述或评论区反馈。",
      ].join("\n"),
      image_prompt_brief: "暂不生成同款图。先补充参考图截图，或改用原创配图策略。",
    },
    safety_notes: [
      "不要直接搬运原文原图。",
      "只有链接时不要生成伪拆解。",
      "如果目标是学习爆款方法，应迁移结构和洞察，不复刻表达。",
    ],
  };
}

function buildAnalysisPrompt(payload = {}) {
  const parsed = payload.parsedReference || null;
  const parsedBlock = parsed ? [
    "已解析到的小红书页面信息：",
    parsed.finalUrl ? `最终链接：${parsed.finalUrl}` : "",
    parsed.title ? `标题：${parsed.title}` : "",
    parsed.description ? `摘要或正文：${parsed.description}` : "",
    Array.isArray(parsed.images) && parsed.images.length ? `原图 URL（${parsed.images.length} 张）：\n${parsed.images.slice(0, 12).join("\n")}` : "",
    parsed.warning ? `解析提醒：${parsed.warning}` : "",
  ].filter(Boolean).join("\n") : "";

  return [
    "你是小红书爆款拆解和参考创作顾问。任务不是洗稿，而是提取底层创作逻辑，并迁移到用户自己的账号方向。",
    "如果信息不足，要明确说明缺什么，不要假装已经解析到完整原文。",
    "",
    "用户输入：",
    String(payload.sourceText || "").trim() || "（空）",
    parsedBlock,
    "",
    `账号方向：${String(payload.accountDirection || "未填写").trim() || "未填写"}`,
    `想迁移到的主题：${String(payload.targetTopic || "未填写").trim() || "未填写"}`,
    `软广或产品：${String(payload.productMention || "无").trim() || "无"}`,
    "",
    "只输出 JSON，不要输出 markdown。字段如下：",
    JSON.stringify({
      reference_summary: "对参考内容的简短概括，不能编造未提供的信息",
      available_signals: ["已经能确定的信息"],
      missing_info: ["还缺的信息"],
      viral_logic: {
        hook: "开头或标题如何抓人",
        pain_or_desire: "命中的痛点或欲望",
        emotion: "情绪机制",
        structure: "内容结构",
        why_it_works: "为什么有效",
      },
      image_strategy: {
        cover_role: "封面承担什么作用",
        visual_style: "视觉风格",
        new_image_directions: ["新图方向 1", "新图方向 2", "新图方向 3"],
      },
      migration_angles: [
        { title: "迁移方向标题", angle: "如何换主题、人群或场景", fit_score: 0, risk: "风险", why: "为什么值得做" },
      ],
      recommended_direction: { title: "推荐方向", reason: "推荐理由" },
      draft_brief: {
        topic: "可带入内容工作台的主题",
        goal: "内容目标",
        audience: "目标受众",
        style: "表达风格",
        material: "应该带入的素材说明",
        image_prompt_brief: "配图提示词方向",
      },
      safety_notes: ["风险提醒"],
    }, null, 2),
  ].join("\n");
}

async function callJsonModel(llm, prompt, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();
  if (llm.mode === "openclaw-agent") {
    const sessionId = buildWechatSessionId("viral-analysis", `${Date.now()}-${prompt.slice(0, 120)}`);
    const result = await runOpenClawAgent({
      sessionId,
      message: [
        "你是小龙虾工作台里的结构化分析助手。",
        "请严格只输出 JSON，不要输出 markdown 代码块，不要解释。",
        prompt,
      ].join("\n\n"),
      timeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      thinking: "medium",
    });
    return { parsed: extractJsonObject(result.text), durationMs: Date.now() - startedAt };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("chat/completions", ensureTrailingSlash(llm.baseUrl)).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: "你是小龙虾工作台里的结构化分析助手。请严格只输出 JSON。" },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`模型调用失败：${response.status} ${text}`);
    const content = JSON.parse(text)?.choices?.[0]?.message?.content || "";
    return { parsed: extractJsonObject(content), durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export async function runViralAnalysis(input = {}) {
  const sourceText = String(input.sourceText || "").trim();
  if (!sourceText) throw new Error("请先粘贴小红书分享文案、链接、截图文字或图片描述。");

  const sourceKind = classifySourceInput(sourceText);
  const parsedReference = input.parsedReference?.ok
    ? input.parsedReference
    : sourceKind.hasUrl
      ? await parseXhsReference({ sourceText })
      : null;

  if (sourceKind.looksLikeOnlyLink && !parsedReference?.ok) {
    return {
      taskId: `viral-local-${Date.now()}`,
      durationMs: 0,
      sourceKind,
      parsedReference,
      result: buildNeedsMoreInfoResult(sourceText, input),
    };
  }

  const { activeModeName, llm } = await loadWorkflowLlm();
  const taskId = `viral-${Date.now()}`;
  await appendRunnerLog("INFO", "Viral analysis started", {
    workflowRunId: taskId,
    source: "local-api",
    activeModeName,
    model: llm.model,
    targetTopic: input.targetTopic || null,
  });

  const { parsed, durationMs } = await callJsonModel(
    llm,
    buildAnalysisPrompt({ ...input, parsedReference }),
    DEFAULT_TIMEOUT_MS,
  );

  await appendRunnerLog("INFO", "Viral analysis completed", {
    workflowRunId: taskId,
    source: "local-api",
    activeModeName,
    durationMs,
    angleCount: Array.isArray(parsed?.migration_angles) ? parsed.migration_angles.length : 0,
  });

  return {
    taskId,
    durationMs,
    sourceKind,
    parsedReference,
    result: parsed,
  };
}
