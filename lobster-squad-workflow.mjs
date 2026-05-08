import crypto from "node:crypto";
import { maybeRunAiIntelWorkflow } from "./notion-ai-intel-workflow.mjs";
import { runOpenClawAgent, buildWechatSessionId } from "./openclaw-agent-client.mjs";

const DIRECT_PATTERNS = [
  /龙虾小队/i,
  /多龙虾/i,
  /小龙虾小队/i,
  /作战会/i,
  /协同.*龙虾/i,
  /盯盘会/i,
];

const INTRO_PATTERNS = [
  /龙虾小队.*(怎么玩|怎么用|介绍|说明)/i,
  /(怎么玩|怎么用|介绍|说明).*龙虾小队/i,
];

const MEETING_PATTERNS = [
  /开会/i,
  /作战会/i,
  /碰一下/i,
  /拉一下/i,
  /小队模式/i,
];

const DEFAULT_TIMEOUT_MS = 120000;

const PERSONA_OPENERS = {
  captain: {
    default: "总控虾：龙虾小队开会了，今天这场是「{mission}」。今天由{lead}主讲，大家按顺序汇报。",
    content: "总控虾：龙虾小队开会了，今天这场是「{mission}」。今天由内容虾主讲，目标是把信息直接打成可发的内容。",
    industry: "总控虾：龙虾小队开会了，今天这场是「{mission}」。今天由分析虾主讲，目标是先把行业动向看清，再决定跟进方向。",
    market: "总控虾：龙虾小队开会了，今天这场是「{mission}」。今天由盯盘虾主讲，目标是先看市场信号，再定轻重缓急。",
  },
  intel: {
    default: "情报虾：我先报情况，先把今天盯到的重点摆上桌。",
    content: "情报虾：我先报素材，今天这些线索最适合往内容方向做。",
    industry: "情报虾：我先报盘面外的情况，今天行业侧这几条最值得盯。",
    market: "情报虾：我先报消息面，今天盘前最该看的几条在这。",
  },
  analyst: {
    default: "分析虾：我先说判断，不急着下结论，先看哪几条最值得跟。",
    content: "分析虾：我先说判断，这几条里哪些真能转成流量和选题，我帮你挑出来。",
    industry: "分析虾：我先说结论，先看这几条是趋势信号，还是短期噪音。",
    market: "盯盘虾：我先说盘感，这几条里谁是情绪催化，谁是能走出持续性的逻辑。",
  },
  content: {
    default: "内容虾：我来给打法，不只讲信息，直接给你可执行角度。",
    content: "内容虾：我来出打法，这一轮直接按能发、能写、能做的方向拆。",
    industry: "内容虾：我来转译，把行业信息改成你能发、能讲、能跟进的动作。",
    market: "内容虾：我来转成外行也能看懂的话，再给你能继续追踪的切口。",
  },
  knowledge: {
    default: "知识虾：我来归档收口，哪些该沉淀、哪些不用重复记，我最后统一报。",
    content: "知识虾：我来收口，今天这轮哪些该进库、哪些已经有底稿，我帮你看清楚。",
    industry: "知识虾：我来收档，行业这类东西要留线索，不是只记标题。",
    market: "知识虾：我来收口，市场这类信息我更关心后续要跟踪什么。",
  },
  close: {
    default: "总控虾：收到，今天这轮先这样收口。{close}",
    content: "总控虾：收到，内容会到这里先收口。{close}",
    industry: "总控虾：收到，行业会先收口，后面看你要不要继续深挖。{close}",
    market: "总控虾：收到，今天这轮盘面会先收口。{close}",
  },
};

function truncate(text, max = 1400) {
  const normalized = String(text || "").trim();
  if (!normalized) return "这次龙虾小队还没整理出稳定结果，你再发一次我继续开会。";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function buildIntelRequest(userText) {
  const normalized = String(userText || "").trim();
  if (/财经|板块|个股|盯盘/i.test(normalized)) {
    return "帮我找今天值得关注的行业情报3条";
  }
  if (/短视频|公众号|小红书|内容|文案|选题|自媒体/i.test(normalized)) {
    return "帮我找今天适合自媒体的AI信息3条";
  }
  if (/行业|赛道|竞品|市场|企业/i.test(normalized)) {
    return "帮我找今天值得关注的行业情报3条";
  }
  return "帮我找今天AI最有用的3条信息";
}

function buildMissionLabel(userText) {
  const normalized = String(userText || "").trim();
  if (/短视频|公众号|小红书|内容|文案|选题|自媒体/i.test(normalized)) {
    return "内容作战会";
  }
  if (/行业|赛道|竞品|市场|企业/i.test(normalized)) {
    return "行业侦察会";
  }
  if (/财经|板块|个股|盯盘/i.test(normalized)) {
    return "市场盯盘会";
  }
  return "情报作战会";
}

function getSquadMode(userText) {
  const normalized = String(userText || "").trim();
  if (/短视频|公众号|小红书|内容|文案|选题|自媒体/i.test(normalized)) return "content";
  if (/行业|赛道|竞品|市场|企业/i.test(normalized)) return "industry";
  if (/财经|板块|个股|盯盘/i.test(normalized)) return "market";
  return "default";
}

function formatOpener(template, missionLabel, lead) {
  return String(template || "")
    .replace("{mission}", missionLabel)
    .replace("{lead}", lead)
    .replace("{close}", "");
}

function buildIntroReply() {
  return [
    "小龙虾小队目前有 5 只内部龙虾：",
    "总控虾：像小队队长，负责接需求、排任务、统一回你。",
    "情报虾：语气冷静，擅长先把今天值得看的内容筛出来。",
    "分析虾：像策略会上的判断手，负责说清为什么重要、轻重缓急和机会点。",
    "内容虾：更有创意，擅长把信息改成选题、标题、脚本和下一步动作。",
    "知识虾：像档案官，负责判断哪些该沉淀进 Notion、怎么记更清楚。",
    "盯盘虾：偏交易台分析员口吻，负责财经新闻对板块和个股的影响判断。",
    "",
    "你可以直接这样试：",
    "龙虾小队，帮我开个今天的内容作战会",
    "龙虾小队，帮我看今天最值得做成短视频的3条",
    "龙虾小队，帮我做一个行业侦察会",
    "龙虾小队，帮我开个盯盘会",
  ].join("\n");
}

function buildSquadPrompt(userText, missionLabel, intelItems, notion) {
  return [
    "You are orchestrating a fun but practical multi-lobster squad reply for a Chinese WeChat assistant.",
    "There is only one visible assistant, but internally several lobster roles collaborate: 总控虾, 情报虾, 分析虾, 内容虾, 知识虾. If the topic implies finance/market watching, let 盯盘虾 style subtly appear in analysis.",
    "Return strict JSON only.",
    'Schema: {"captain_line":"string","intel_style_line":"string","intel_points":["string"],"analysis_style_line":"string","analysis_points":["string"],"content_style_line":"string","content_actions":[{"title":"string","angle":"string","next_step":"string"}],"knowledge_style_line":"string","knowledge_line":"string","close_line":"string"}',
    "Rules:",
    "- Write concise, lively Chinese.",
    "- Make it feel like a small team just collaborated, but do not be childish or overact.",
    "- 总控虾 should sound like a calm but energetic team lead.",
    "- 情报虾 should sound冷静、克制、像情报员在报情况.",
    "- 分析虾 should sound像策略会上的判断手，强调重要性、轻重缓急和机会点.",
    "- 内容虾 should sound更有创意、更会出角度，但仍然务实，不要浮夸.",
    "- 知识虾 should sound像档案官或知识库管理员，简短说明沉淀状态.",
    "- If missionLabel implies 市场盯盘会, let analysis_style_line and analysis_points show a more交易台/市场观察口吻.",
    "- Keep content_actions to at most 3 items.",
    `Mission label: ${missionLabel}`,
    `Original user request: ${userText}`,
    `Intel items: ${JSON.stringify(intelItems)}`,
    `Notion status: ${JSON.stringify(notion)}`,
  ].join("\n");
}

async function callModelJsonViaApi(llm, prompt, timeoutMs) {
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
    if (!res.ok) throw new Error(`Lobster squad call failed: ${res.status} ${text}`);
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Lobster squad returned empty content");
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

async function callModelJson(llm, prompt, timeoutMs) {
  if (llm.mode === "openclaw-agent") {
    const sessionId = buildWechatSessionId("wechat-lobster-squad", `${Date.now()}-${crypto.randomUUID()}`);
    const result = await runOpenClawAgent({
      message: [
        "你现在是小龙虾小队的总控虾。",
        "请严格只输出 JSON，不要输出 markdown 代码块，不要解释。",
        prompt,
      ].join("\n\n"),
      sessionId,
      timeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      thinking: "minimal",
    });
    return JSON.parse(result.text);
  }
  return callModelJsonViaApi(llm, prompt, timeoutMs);
}

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeActions(value) {
  return Array.isArray(value)
    ? value
        .map((item) => ({
          title: String(item?.title || "").trim(),
          angle: String(item?.angle || "").trim(),
          nextStep: String(item?.next_step || "").trim(),
        }))
        .filter((item) => item.title && item.angle)
        .slice(0, 3)
    : [];
}

function toShortList(lines, limit = 2) {
  return Array.isArray(lines) ? lines.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit) : [];
}

function buildReply(missionLabel, intelResult, squadData) {
  const intelPoints = normalizeList(squadData?.intel_points);
  const analysisPoints = normalizeList(squadData?.analysis_points);
  const contentActions = normalizeActions(squadData?.content_actions);
  const notion = intelResult?.debug?.notion || {};

  const lines = [
    `小龙虾小队 | ${missionLabel}`,
    String(squadData?.captain_line || "总控虾已经把今天这场小队协作会开完了。").trim(),
    "",
    "情报虾：",
  ];

  if (squadData?.intel_style_line) lines.push(String(squadData.intel_style_line).trim());
  if (intelPoints.length) {
    for (const point of intelPoints) lines.push(`- ${point}`);
  } else {
    const titles = Array.isArray(intelResult?.debug?.items)
      ? intelResult.debug.items.map((item) => item?.title).filter(Boolean).slice(0, 3)
      : [];
    for (const title of titles) lines.push(`- 今天盯到一条重点：${title}`);
  }

  lines.push("", "分析虾：");
  if (squadData?.analysis_style_line) lines.push(String(squadData.analysis_style_line).trim());
  if (analysisPoints.length) {
    for (const point of analysisPoints) lines.push(`- ${point}`);
  } else {
    lines.push("- 这几条里有能马上转成行动和选题的内容，适合今天跟进。");
  }

  lines.push("", "内容虾：");
  if (squadData?.content_style_line) lines.push(String(squadData.content_style_line).trim());
  if (contentActions.length) {
    contentActions.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title}`);
      lines.push(`角度：${item.angle}`);
      if (item.nextStep) lines.push(`下一步：${item.nextStep}`);
    });
  } else {
    lines.push("- 今天先把重点看完，再决定往短视频、选题还是笔记沉淀。");
  }

  lines.push("", "知识虾：");
  if (squadData?.knowledge_style_line) lines.push(String(squadData.knowledge_style_line).trim());
  if (squadData?.knowledge_line) {
    lines.push(String(squadData.knowledge_line).trim());
  } else if (notion.status === "written") {
    lines.push(`已帮你记进 Notion：${Number(notion.writtenCount || 0)} 条，重复跳过：${Number(notion.duplicateCount || 0)} 条。`);
  } else if (notion.status === "failed") {
    lines.push("今天这轮内容已经整理好了，但写入 Notion 失败了，我建议稍后补写一次。");
  } else {
    lines.push("这轮以整理和判断为主，暂时没有额外写库动作。");
  }

  lines.push("", String(squadData?.close_line || "如果你愿意，我可以继续让下一只龙虾接着干，比如直接出标题、脚本或待办。").trim());
  return truncate(lines.join("\n"));
}

function buildMeetingMessages(missionLabel, intelResult, squadData, squadMode) {
  const intelPoints = toShortList(normalizeList(squadData?.intel_points), 2);
  const analysisPoints = toShortList(normalizeList(squadData?.analysis_points), 2);
  const contentActions = normalizeActions(squadData?.content_actions).slice(0, 2);
  const notion = intelResult?.debug?.notion || {};
  const leadMap = {
    content: "内容虾",
    industry: "分析虾",
    market: "盯盘虾",
    default: "总控虾",
  };
  const lead = leadMap[squadMode] || leadMap.default;
  const bucket = PERSONA_OPENERS;
  const variant = squadMode in bucket.captain ? squadMode : "default";

  const messages = [
    formatOpener(bucket.captain[variant] || bucket.captain.default, missionLabel, lead),
  ];

  const intelLines = [];
  intelLines.push(bucket.intel[variant] || bucket.intel.default);
  if (squadData?.intel_style_line) intelLines.push(String(squadData.intel_style_line).trim());
  if (intelPoints.length) {
    intelLines.push(...intelPoints.map((point) => `- ${point}`));
  }
  messages.push(intelLines.join("\n") || "情报虾：今天先报三条重点，我已经筛完。");

  const analysisLines = [];
  analysisLines.push(bucket.analyst[variant] || bucket.analyst.default);
  if (squadData?.analysis_style_line) analysisLines.push(String(squadData.analysis_style_line).trim());
  if (analysisPoints.length) {
    analysisLines.push(...analysisPoints.map((point) => `- ${point}`));
  }
  messages.push(analysisLines.join("\n") || "分析虾：我先说判断，这里面有可立刻跟进的重点。");

  const contentLines = [];
  contentLines.push(bucket.content[variant] || bucket.content.default);
  if (squadData?.content_style_line) contentLines.push(String(squadData.content_style_line).trim());
  if (contentActions.length) {
    contentActions.forEach((item, index) => {
      contentLines.push(`${index + 1}. ${item.title}`);
      contentLines.push(`角度：${item.angle}`);
      if (item.nextStep) contentLines.push(`动作：${item.nextStep}`);
    });
  } else {
    contentLines.push("今天先把重点转成执行动作，后面再细拆。");
  }
  messages.push(contentLines.join("\n"));

  const knowledgeLines = [];
  knowledgeLines.push(bucket.knowledge[variant] || bucket.knowledge.default);
  if (squadData?.knowledge_style_line) knowledgeLines.push(String(squadData.knowledge_style_line).trim());
  if (squadData?.knowledge_line) {
    knowledgeLines.push(String(squadData.knowledge_line).trim());
  } else if (notion.status === "written") {
    knowledgeLines.push(`已写入 Notion：${Number(notion.writtenCount || 0)} 条，重复跳过：${Number(notion.duplicateCount || 0)} 条。`);
  } else if (notion.status === "failed") {
    knowledgeLines.push("这轮内容已经整理好，但写入 Notion 失败了，建议稍后补写。");
  } else {
    knowledgeLines.push("这轮以整理和判断为主，暂时没有额外写库动作。");
  }
  messages.push(knowledgeLines.join("\n"));

  const closeText = String(squadData?.close_line || "如果你要，我下一步可以直接继续出标题、脚本或待办。").trim();
  messages.push((bucket.close[variant] || bucket.close.default).replace("{close}", closeText));
  return messages.map((text) => truncate(text, 900)).filter(Boolean);
}

function shouldUseMeetingMode(userText) {
  const normalized = String(userText || "").trim();
  return MEETING_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyLobsterSquadIntent(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return { mode: "none", normalizedText: "", reason: "empty" };
  if (INTRO_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { mode: "intro", normalizedText: normalized, reason: "intro_pattern" };
  }
  if (DIRECT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { mode: "direct", normalizedText: normalized, reason: "direct_pattern" };
  }
  return { mode: "none", normalizedText: normalized, reason: "low_confidence" };
}

export async function maybeRunLobsterSquadWorkflow({
  baseDir,
  llm,
  userText,
  logger,
  modelTimeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const intent = classifyLobsterSquadIntent(userText);
  if (intent.mode === "none") return { handled: false };
  if (intent.mode === "intro") {
    return { handled: true, replyText: buildIntroReply(), debug: { stage: "intro" } };
  }

  const missionLabel = buildMissionLabel(userText);
  const squadMode = getSquadMode(userText);
  const intelRequest = buildIntelRequest(userText);
  const intelResult = await maybeRunAiIntelWorkflow({
    baseDir,
    llm,
    userText: intelRequest,
    logger,
    modelTimeoutMs,
    force: true,
  });

  const intelItems = Array.isArray(intelResult?.debug?.items) ? intelResult.debug.items : [];
  if (!intelItems.length) {
    return {
      handled: true,
      replyText: "龙虾小队已经集合了，但今天这一轮还没抓到稳定素材，你再发一次我继续开会。",
      debug: { stage: "intel_empty", intelResult: intelResult?.debug || null },
    };
  }

  const squadData = await callModelJson(
    llm,
    buildSquadPrompt(userText, missionLabel, intelItems, intelResult?.debug?.notion || {}),
    modelTimeoutMs,
  );

  const meetingMode = shouldUseMeetingMode(userText);

  logger?.("INFO", "Lobster squad workflow completed", {
      missionLabel,
      squadMode,
      itemCount: intelItems.length,
    notionStatus: intelResult?.debug?.notion?.status || null,
    llmMode: llm.mode,
    llmModel: llm.model,
    meetingMode,
  });

  return {
    handled: true,
    replyText: buildReply(missionLabel, intelResult, squadData),
    replyMessages: meetingMode ? buildMeetingMessages(missionLabel, intelResult, squadData, squadMode) : null,
    debug: {
      missionLabel,
      squadMode,
      intel: intelResult?.debug || null,
      squadData,
      meetingMode,
    },
  };
}
