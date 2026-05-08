import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookmarkPlus, ExternalLink, Flame, ImageIcon, Layers3, Loader2, Plus, RefreshCw, ShieldCheck, Sparkles, Target, Wand2 } from "lucide-react";
import { postJson } from "../lib/api";
import { PageTitle } from "../components/common";

type JsonRecord = Record<string, unknown>;

type ViralPayload = {
  taskId?: string;
  durationMs?: number;
  result?: JsonRecord;
};

type ParsedReference = {
  ok?: boolean;
  title?: string;
  description?: string;
  finalUrl?: string;
  sourceUrl?: string;
  images?: string[];
  rawImageCount?: number;
  parseSource?: string;
  warning?: string;
  error?: string;
};

type ViralViewProps = {
  onCreateTask: (inputText: string) => void | Promise<void>;
};

type ViralDraft = {
  sourceText?: string;
  accountDirection?: string;
  targetTopic?: string;
  productMention?: string;
  payload?: ViralPayload | null;
  parsedReference?: ParsedReference | null;
  knowledgeSaved?: boolean;
  knowledgeSaveMessage?: string;
};

type AnalyzeJob = {
  draft: ViralDraft;
  promise: Promise<ViralPayload>;
};

const VIRAL_DRAFT_KEY = "openclaw.viral.draft.v1";
let activeAnalyzeJob: AnalyzeJob | null = null;

function readViralDraft(): ViralDraft {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VIRAL_DRAFT_KEY);
    return raw ? (JSON.parse(raw) as ViralDraft) : {};
  } catch {
    return {};
  }
}

function writeViralDraft(draft: ViralDraft) {
  if (typeof window === "undefined") return;
  try {
    const hasContent = Boolean(
      draft.sourceText?.trim() ||
      draft.accountDirection?.trim() ||
      draft.targetTopic?.trim() ||
      draft.productMention?.trim() ||
      draft.payload ||
      draft.parsedReference ||
      draft.knowledgeSaved,
    );
    if (!hasContent) return;
    window.localStorage.setItem(VIRAL_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // 本地缓存不可用时不影响页面主流程。
  }
}

function clearViralDraft() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(VIRAL_DRAFT_KEY);
  } catch {
    // 忽略本地缓存清理失败。
  }
}

function startAnalyzeJob(draft: ViralDraft) {
  if (activeAnalyzeJob) return activeAnalyzeJob;
  const promise = postJson<ViralPayload>("/api/local/viral-analysis", {
    sourceText: String(draft.sourceText || "").trim(),
    accountDirection: String(draft.accountDirection || "").trim(),
    targetTopic: String(draft.targetTopic || "").trim(),
    productMention: String(draft.productMention || "").trim(),
    parsedReference: draft.parsedReference || null,
  }).then((payload) => {
    writeViralDraft({ ...draft, payload });
    return payload;
  });
  activeAnalyzeJob = { draft, promise };
  return activeAnalyzeJob;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  const text = String(value ?? "").trim();
  return text ? [text] : [];
}

function textOf(value: unknown, fallback = "暂无内容") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function getScore(value: unknown) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "-";
  return score > 1 ? Math.round(score) : Math.round(score * 100);
}

function scoreNumber(value: unknown) {
  const score = Number(value);
  if (!Number.isFinite(score)) return -1;
  return score > 1 ? score : score * 100;
}

function ResultList({ items, empty = "暂无内容" }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="viralMuted">{empty}</p>;
  return (
    <ul className="viralList">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

function validateSourceInput(text: string) {
  const value = text.trim();
  if (!value) return "请先粘贴小红书笔记链接。";
  const hasAnyUrl = /https?:\/\/|www\./i.test(value);
  const hasXhsUrl = /(?:https?:\/\/)?(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\S*/i.test(value);
  if (hasAnyUrl && !hasXhsUrl) return "链接格式不对，请粘贴小红书笔记链接或 xhslink 分享链接。";
  if (!hasXhsUrl) return "未识别到小红书链接，请粘贴 xiaohongshu.com 或 xhslink.com 链接。";
  return "";
}

export function ViralView({ onCreateTask }: ViralViewProps) {
  const initialDraft = useMemo(() => readViralDraft(), []);
  const [sourceText, setSourceText] = useState(() => initialDraft.sourceText || "");
  const [accountDirection, setAccountDirection] = useState(() => initialDraft.accountDirection || "");
  const [targetTopic, setTargetTopic] = useState(() => initialDraft.targetTopic || "");
  const [productMention, setProductMention] = useState(() => initialDraft.productMention || "");
  const [payload, setPayload] = useState<ViralPayload | null>(() => initialDraft.payload || null);
  const [parsedReference, setParsedReference] = useState<ParsedReference | null>(() => initialDraft.parsedReference || null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [creatingTask, setCreatingTask] = useState(false);
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [knowledgeSaved, setKnowledgeSaved] = useState(() => Boolean(initialDraft.knowledgeSaved));
  const [knowledgeSaveMessage, setKnowledgeSaveMessage] = useState(() => initialDraft.knowledgeSaveMessage || (initialDraft.knowledgeSaved ? "已保存到知识库" : ""));
  const [selectedAngleIndex, setSelectedAngleIndex] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const resultRef = useRef<HTMLElement | null>(null);

  const analysis = useMemo(() => asRecord(payload?.result || payload), [payload]);
  const logic = asRecord(analysis.viral_logic);
  const imageStrategy = asRecord(analysis.image_strategy);
  const recommended = asRecord(analysis.recommended_direction);
  const draftBrief = asRecord(analysis.draft_brief);
  const migrationAngles = Array.isArray(analysis.migration_angles) ? analysis.migration_angles.map(asRecord) : [];
  const hasResult = Boolean(payload);
  const confirmedSignals = asList(analysis.available_signals);
  const missingSignals = asList(analysis.missing_info);
  const topAngle = migrationAngles.reduce((best, item) => (scoreNumber(item.fit_score) > scoreNumber(best.fit_score) ? item : best), migrationAngles[0] || {});
  const selectedAngle = migrationAngles[selectedAngleIndex] || topAngle || {};
  const selectedAngleTitle = textOf(selectedAngle.title, textOf(recommended.title, textOf(draftBrief.topic, "未给出推荐方向")));
  const selectedAngleReason = textOf(selectedAngle.why, textOf(recommended.reason));
  const selectedAngleText = textOf(selectedAngle.angle, textOf(recommended.reason));
  const parsedImages = Array.isArray(parsedReference?.images) ? parsedReference.images.filter(Boolean).slice(0, 12) : [];
  const failedImageSet = useMemo(() => new Set(failedImages), [failedImages]);
  const canAnalyze = Boolean(parsedReference && (`${parsedReference.title || ""}\n${parsedReference.description || ""}`.trim().length >= 30 || parsedImages.length));
  const topicHint = selectedAngleTitle !== "未给出推荐方向" ? selectedAngleTitle : textOf(parsedReference?.title, "");
  const audienceHint = textOf(draftBrief.audience, "例如：面向同类受众或你的目标人群");
  const productHint = textOf(draftBrief.material, "可选：需要融入的产品、服务、地点或观点");

  useEffect(() => {
    writeViralDraft({
      sourceText,
      accountDirection,
      targetTopic,
      productMention,
      payload,
      parsedReference,
      knowledgeSaved,
      knowledgeSaveMessage,
    });
  }, [sourceText, accountDirection, targetTopic, productMention, payload, parsedReference, knowledgeSaved, knowledgeSaveMessage]);

  useEffect(() => {
    if (!migrationAngles.length) {
      setSelectedAngleIndex(0);
      return;
    }
    const bestIndex = migrationAngles.reduce((bestIndex, item, index) => (
      scoreNumber(item.fit_score) > scoreNumber(migrationAngles[bestIndex]?.fit_score) ? index : bestIndex
    ), 0);
    setSelectedAngleIndex(bestIndex);
  }, [payload]);

  useEffect(() => {
    const job = activeAnalyzeJob;
    if (!job) return undefined;
    let ignore = false;
    setAnalyzing(true);
    setError("");
    setNotice("AI 拆解中，离开页面后会继续处理。");
    void job.promise
      .then((parsed) => {
        if (ignore) return;
        setPayload(parsed);
        setNotice("AI 拆解完成，结果已更新。");
      })
      .catch((err) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (activeAnalyzeJob === job) activeAnalyzeJob = null;
        if (!ignore) setAnalyzing(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function parseLink() {
    const validationMessage = validateSourceInput(sourceText);
    if (validationMessage) {
      setError(validationMessage);
      setNotice("");
      return;
    }
    setBusy(true);
    setParsing(false);
    setAnalyzing(false);
    setError("");
    setNotice("");
    setFailedImages([]);
    try {
      setParsing(true);
      setNotice("正在解析链接，先读取原文和图片。");
      const reference = await postJson<ParsedReference>("/api/local/xhs-parse", {
        sourceText: sourceText.trim(),
      });
      setParsedReference(reference);
      window.setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
      const parsedText = `${reference.title || ""}\n${reference.description || ""}`.trim();
      if (!reference.ok && parsedText.length < 30 && !reference.images?.length) {
        setError("链接没有解析到可拆解的正文或图片，请换一个有效链接后再试。");
        setNotice("");
        return;
      }
      setPayload(null);
      setKnowledgeSaved(false);
      setKnowledgeSaveMessage("");
      setNotice(reference.ok ? "原素材解析完成，请确认后点击 AI 拆解。" : "链接未完整解析，请确认可用内容后再 AI 拆解。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
      setBusy(false);
    }
  }

  async function analyzeReference() {
    if (!canAnalyze) {
      setError("当前解析内容不足，无法进行 AI 拆解，请先换一个有效链接重新解析。");
      setNotice("");
      return;
    }
    setAnalyzing(true);
    setError("");
    setKnowledgeSaved(false);
    setKnowledgeSaveMessage("");
    setNotice("AI 拆解中，离开页面后会继续处理。");
    try {
      const job = startAnalyzeJob({
        sourceText: sourceText.trim(),
        accountDirection: accountDirection.trim(),
        targetTopic: targetTopic.trim(),
        productMention: productMention.trim(),
        parsedReference,
      });
      const parsed = await job.promise;
      setPayload(parsed);
      setKnowledgeSaved(false);
      setKnowledgeSaveMessage("");
      window.setTimeout(() => {
        if (window.matchMedia("(max-width: 760px)").matches) {
          resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 80);
      setNotice("AI 拆解完成，结果已更新。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      activeAnalyzeJob = null;
      setAnalyzing(false);
    }
  }

  async function createTaskFromResult() {
    await createTaskFromAngle(migrationAngles.length ? selectedAngle : undefined);
  }

  async function createTaskFromAngle(angle?: JsonRecord) {
    if (!hasResult) return;
    setCreatingTask(true);
    setError("");
    const title = angle
      ? textOf(angle.title, "未命名迁移方向")
      : textOf(recommended.title, textOf(draftBrief.topic, targetTopic || "未给出"));
    const reason = angle ? textOf(angle.why, "暂无") : textOf(recommended.reason, "暂无");
    const risk = angle ? textOf(angle.risk, "需人工判断") : "";
    try {
      await onCreateTask([
        "从爆款拆解结果生成一条原创内容任务。",
        `推荐方向：${title}`,
        `方向角度：${angle ? textOf(angle.angle) : textOf(recommended.reason, "暂无")}`,
        `推荐理由：${reason}`,
        risk ? `风险提醒：${risk}` : "",
        `内容目标：${textOf(draftBrief.goal, "生成不复刻原文原图的原创小红书发布包")}`,
        `目标受众：${textOf(draftBrief.audience, accountDirection || "未填写")}`,
        `表达风格：${textOf(draftBrief.style, "真实、具体、有场景")}`,
        `素材说明：${textOf(draftBrief.material, sourceText)}`,
        `配图方向：${textOf(draftBrief.image_prompt_brief, "参考拆解结果重新设计原创配图")}`,
      ].filter(Boolean).join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingTask(false);
    }
  }

  async function saveLogicToKnowledge() {
    if (!hasResult) {
      setKnowledgeSaveMessage("请先完成 AI 拆解。");
      return;
    }
    setSavingKnowledge(true);
    setKnowledgeSaved(false);
    setKnowledgeSaveMessage("正在保存...");
    setError("");
    try {
      const titleSeed = textOf(parsedReference?.title, textOf(recommended.title, textOf(draftBrief.topic, "未命名对标")));
      const content = [
        `对标摘要：${textOf(analysis.reference_summary)}`,
        `核心钩子：${textOf(logic.hook)}`,
        `痛点/欲望：${textOf(logic.pain_or_desire)}`,
        `情绪：${textOf(logic.emotion)}`,
        `结构：${textOf(logic.structure)}`,
        `有效原因：${textOf(logic.why_it_works)}`,
        `推荐迁移：${textOf(recommended.title, textOf(draftBrief.topic, "暂无"))}`,
        `迁移理由：${textOf(recommended.reason)}`,
      ].join("\n");

      await postJson<JsonRecord>("/api/local/knowledge", {
        title: `爆款拆解：${titleSeed}`.slice(0, 80),
        type: "内容方法",
        platform: "小红书",
        scenario: "爆款拆解",
        project: "小龙虾后台",
        content,
        tags: ["爆款拆解", "小红书", "内容结构"],
        sourceType: "viral_analysis",
        sourceId: String(payload?.taskId || parsedReference?.finalUrl || parsedReference?.sourceUrl || "").trim(),
        status: "enabled",
        priority: 60,
        aiEnabled: true,
      });
      setKnowledgeSaved(true);
      setKnowledgeSaveMessage("已保存到知识库");
      setNotice("爆款逻辑已保存到知识库。");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setKnowledgeSaveMessage(`保存失败：${message}`);
      setError(message);
    } finally {
      setSavingKnowledge(false);
    }
  }

  function clearAll() {
    setSourceText("");
    setAccountDirection("");
    setTargetTopic("");
    setProductMention("");
    setPayload(null);
    setParsedReference(null);
    setFailedImages([]);
    setKnowledgeSaved(false);
    setKnowledgeSaveMessage("");
    activeAnalyzeJob = null;
    setError("");
    setNotice("");
    clearViralDraft();
  }

  return (
    <main className="pageStack x-page viralPage">
      <PageTitle
        group="内容策略"
        title="爆款拆解"
        desc="拆解对标内容的选题、钩子、结构、图片策略和可迁移方向。"
      />

      <section className={`viralWorkspacePro ${hasResult ? "hasResult" : ""}`}>
        <form
          className="panel x-panel viralComposerPro"
          onSubmit={(event) => {
            event.preventDefault();
            void parseLink();
          }}
        >
          <label className="viralField viralLinkField">
            <span>小红书链接</span>
            <input
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="粘贴小红书笔记链接，例如：https://www.xiaohongshu.com/explore/..."
            />
          </label>

          <div className="viralActionsPro">
            <button className="ghost" type="button" onClick={clearAll} disabled={busy || analyzing}>
              <RefreshCw size={15} />
              清空
            </button>
            <button className="primary viralRunButton" type="submit" disabled={busy || analyzing || !sourceText.trim()}>
              {busy ? <Loader2 className="viralSpin" size={16} /> : <Wand2 size={16} />}
              {parsing ? "解析中" : parsedReference ? "重新解析" : "解析链接"}
            </button>
          </div>
        </form>

        <section className="viralResultColumn" ref={resultRef}>
          {error ? (
            <div className="viralMessage viralMessageError">
              <AlertTriangle size={17} />
              <div className="viralMessageContent">
                <strong>解析/拆解失败</strong>
                <span>{error}</span>
                <small>可以检查本地 API 是否运行，或换一个有效的小红书链接后重试。</small>
                <div className="viralRecoveryActions">
                  <button className="ghost viralIconButton" type="button" onClick={() => void parseLink()} disabled={busy || !sourceText.trim()}>
                    {busy ? <Loader2 className="viralSpin" size={15} /> : <RefreshCw size={15} />}
                    重试
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {notice ? (
            <div className="viralMessage">
              <Sparkles size={16} />
              <span>{notice}</span>
            </div>
          ) : null}

          {parsedReference ? (
            <section className={`viralSectionCard viralParsedCard ${parsedReference.ok === false ? "isWarning" : ""}`}>
              <div className="viralSectionHead">
                <h3><ImageIcon size={16} /> 解析到的原素材</h3>
                <div className="viralParsedHeadActions">
                  <div className="viralParsedMeta">
                    <span>图片 {parsedImages.length || Number(parsedReference.rawImageCount || 0)}</span>
                    {parsedReference.parseSource ? <span>{parsedReference.parseSource}</span> : null}
                  </div>
                  <button className="primary viralIconButton" type="button" onClick={() => void analyzeReference()} disabled={analyzing || !canAnalyze}>
                    {analyzing ? <Loader2 className="viralSpin" size={15} /> : <Sparkles size={15} />}
                    {analyzing ? "拆解中" : "AI 拆解"}
                  </button>
                </div>
              </div>
              <div className="viralParsedLayout">
                <div className="viralParsedText">
                  <strong>{textOf(parsedReference.title, "未解析到标题")}</strong>
                  <p>{textOf(parsedReference.description, "未解析到正文，建议补充标题、正文或截图描述。")}</p>
                  {parsedReference.warning || parsedReference.error ? <small>{parsedReference.warning || parsedReference.error}</small> : null}
                  {parsedReference.finalUrl || parsedReference.sourceUrl ? (
                    <a href={parsedReference.finalUrl || parsedReference.sourceUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={14} />
                      打开原链接
                    </a>
                  ) : null}
                </div>
                {parsedImages.length ? (
                  <div className="viralParsedImages" aria-label="解析到的图片">
                    {parsedImages.map((image, index) => (
                      <a className={`viralParsedImage ${failedImageSet.has(image) ? "isBroken" : ""}`} href={image} target="_blank" rel="noreferrer" key={`${image}-${index}`}>
                        {failedImageSet.has(image) ? (
                          <>
                            <ImageIcon size={18} />
                            <span>图片加载失败</span>
                          </>
                        ) : (
                          <img
                            src={image}
                            alt={`解析图片 ${index + 1}`}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            onError={() => setFailedImages((items) => (items.includes(image) ? items : [...items, image]))}
                          />
                        )}
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="viralParsedNoImage">暂未解析到图片</div>
                )}
              </div>
            </section>
          ) : null}

          {!hasResult ? (
            <section className="panel x-panel viralEmptyResult">
              <Sparkles size={24} />
              <h2>{busy ? "正在解析素材" : "等待解析链接"}</h2>
              <p>{busy ? "解析完成后会先显示原文和图片，再由你手动发起 AI 拆解。" : "粘贴小红书链接后，先解析原素材，再确认是否进入 AI 拆解。"}</p>
              <div className="viralEmptyGuide">
                <span>先看原文和图片</span>
                <span>再看爆款逻辑</span>
                <span>可保存到知识库</span>
              </div>
            </section>
          ) : (
            <>
              <section className="panel x-panel viralSummaryCard">
                <div className="viralPanelHead">
                  <span><Sparkles size={17} /></span>
                  <div>
                    <h2>AI 拆解摘要</h2>
                    <p>{textOf(analysis.reference_summary)}</p>
                  </div>
                </div>
                <div className="viralMetaStrip">
                  <span>耗时 {payload?.durationMs ? `${Math.round(payload.durationMs / 1000)} 秒` : "-"}</span>
                  <span>迁移方向 {migrationAngles.length} 个</span>
                  {payload?.taskId ? <span>任务 {payload.taskId}</span> : null}
                </div>
              </section>

              <section className="viralSectionCard viralLogicPanel">
                <div className="viralSectionHead">
                  <h3><Layers3 size={16} /> 爆款逻辑</h3>
                  <button className="ghost viralIconButton" type="button" onClick={() => void saveLogicToKnowledge()} disabled={savingKnowledge || knowledgeSaved}>
                    {savingKnowledge ? <Loader2 className="viralSpin" size={15} /> : <BookmarkPlus size={15} />}
                    {savingKnowledge ? "保存中" : knowledgeSaved ? "已保存" : "保存知识库"}
                  </button>
                </div>
                {knowledgeSaveMessage ? <p className={`viralInlineStatus ${knowledgeSaved ? "isSuccess" : ""}`}>{knowledgeSaveMessage}</p> : null}
                <div className="viralLogicGrid">
                  <article className="viralLogicPrimary">
                    <span>核心钩子</span>
                    <strong>{textOf(logic.hook)}</strong>
                    <p>{textOf(logic.why_it_works)}</p>
                  </article>
                  <article><span>痛点/欲望</span><p>{textOf(logic.pain_or_desire)}</p></article>
                  <article><span>情绪</span><p>{textOf(logic.emotion)}</p></article>
                  <article><span>结构</span><p>{textOf(logic.structure)}</p></article>
                </div>
              </section>

              <section className="viralSectionCard viralMigrationPanel">
                <div className="viralSectionHead">
                  <h3><Flame size={16} /> 推荐迁移</h3>
                  <div className="viralRecommendActions">
                    <button className="primary viralIconButton" type="button" disabled={creatingTask} onClick={() => void createTaskFromResult()}>
                      {creatingTask ? <Loader2 className="viralSpin" size={15} /> : <Plus size={15} />}
                      按当前推荐生成任务
                    </button>
                  </div>
                </div>
                <article className="viralRecommendedAngle">
                  <span>当前推荐</span>
                  <strong>{selectedAngleTitle}</strong>
                  <p>{selectedAngleText}</p>
                  <small>理由：{selectedAngleReason}</small>
                </article>
                <div className="viralMigrationSettings">
                  <label>
                    <span>账号方向</span>
                    <input value={accountDirection} onChange={(event) => setAccountDirection(event.target.value)} placeholder={audienceHint} />
                  </label>
                  <label>
                    <span>迁移主题</span>
                    <input value={targetTopic} onChange={(event) => setTargetTopic(event.target.value)} placeholder={topicHint || "例如：基于当前素材迁移出的新选题"} />
                  </label>
                  <label className="viralMigrationWide">
                    <span>需要带入的信息</span>
                    <input value={productMention} onChange={(event) => setProductMention(event.target.value)} placeholder={productHint} />
                  </label>
                </div>
                <div className="viralAngleGridPro">
                  {migrationAngles.length ? migrationAngles.map((item, index) => {
                    const isSelected = index === selectedAngleIndex;
                    return (
                    <article className={`viralAngleCardPro ${isSelected ? "isSelected" : ""}`} key={`${textOf(item.title, "方向")}-${index}`} onClick={() => setSelectedAngleIndex(index)}>
                      <div>
                        <strong>{textOf(item.title, "未命名方向")}</strong>
                        <span className="viralScoreBadge">{isSelected ? "当前推荐" : `适配 ${getScore(item.fit_score)}`}</span>
                      </div>
                      <p>{textOf(item.angle)}</p>
                      <small>风险：{textOf(item.risk, "需人工判断")}</small>
                      <small>理由：{textOf(item.why)}</small>
                    </article>
                    );
                  }) : <p className="viralMuted">暂无迁移方向。</p>}
                </div>
              </section>

              <section className="viralSectionCard viralImagePanel">
                <h3><Layers3 size={16} /> 图片策略</h3>
                <div className="viralImageStrategyGrid">
                  <article>
                    <span>封面作用</span>
                    <p>{textOf(imageStrategy.cover_role)}</p>
                  </article>
                  <article>
                    <span>视觉风格</span>
                    <p>{textOf(imageStrategy.visual_style)}</p>
                  </article>
                  <article className="viralImageDirections">
                    <span>新图方向</span>
                    <ResultList items={asList(imageStrategy.new_image_directions)} empty="暂无新图方向。" />
                  </article>
                </div>
              </section>

              <section className="viralSectionCard viralTrustCard">
                <h3><ShieldCheck size={16} /> 可信度与风险</h3>
                <div className="viralTrustGrid">
                  <article>
                    <span><Target size={14} /> 可确认</span>
                    <ResultList items={confirmedSignals} />
                  </article>
                  <article className="viralWarningBlock">
                    <span><AlertTriangle size={14} /> 缺失信息</span>
                    <ResultList items={asList(analysis.missing_info)} empty="未提示缺失信息。" />
                  </article>
                  <article>
                    <span><ShieldCheck size={14} /> 安全提醒</span>
                    <ResultList items={asList(analysis.safety_notes)} empty="暂无额外提醒。" />
                  </article>
                </div>
              </section>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
