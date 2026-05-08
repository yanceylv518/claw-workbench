import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, Eye, RefreshCw, Search, Sparkles, Trash2, Upload, X, Zap } from "lucide-react";
import type { LocalIntelItem } from "../types";
import { patchJson, postJson } from "../lib/api";
import { cleanText, compactText, cx, formatDate } from "../lib/utils";
import { PageTitle } from "../components/common";

type IntelFilter = "all" | "pending" | "actionable" | "ignored";
type IntelSort = "newest" | "oldest";
type Notice = { tone: "success" | "error"; text: string } | null;

const PAGE_SIZE = 10;

function itemUrl(item: LocalIntelItem) {
  return cleanText(item.sourceUrl || item.url);
}

function itemSource(item: LocalIntelItem) {
  const url = itemUrl(item);
  if (!url) return cleanText(item.source, "本地情报");
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return cleanText(item.source, "来源链接");
  }
}

function itemTitle(item: LocalIntelItem) {
  return cleanText(item.title, "未命名情报");
}

function itemSummary(item: LocalIntelItem) {
  return cleanText(item.summary || item.evaluationReason || item.usage, "暂无摘要");
}

function itemCategory(item: LocalIntelItem) {
  return cleanText(item.category || item.source, "情报");
}

function itemDate(item: LocalIntelItem) {
  return item.publishedAt || item.updatedAt || item.createdAt || "";
}

function isActionable(item: LocalIntelItem) {
  return item.evaluationStatus === "actionable" || item.recommendedAction === "create_post_package";
}

function isPending(item: LocalIntelItem) {
  const raw = String(item.processingStatus || item.evaluationStatus || item.valueStatus || "").toLowerCase();
  return !raw || raw === "pending" || raw === "review" || raw === "unreviewed" || raw === "unprocessed";
}

function isIgnored(item: LocalIntelItem) {
  return item.evaluationStatus === "discarded" || item.processingStatus === "ignored" || item.recommendedAction === "discard";
}

function hasCreatedOutput(item: LocalIntelItem) {
  return ["task_created", "package_created", "knowledge_extracted", "archived"].includes(String(item.processingStatus || "").toLowerCase());
}

function canCreateTask(item: LocalIntelItem) {
  if (isIgnored(item) || hasCreatedOutput(item)) return false;
  const evaluation = String(item.evaluationStatus || "").toLowerCase();
  const recommendation = String(item.recommendedAction || "").toLowerCase();
  const processing = String(item.processingStatus || "").toLowerCase();
  return (
    isActionable(item) ||
    isPending(item) ||
    evaluation === "promising" ||
    recommendation === "create_task" ||
    processing === "unprocessed"
  );
}

function statusLabel(item: LocalIntelItem) {
  const raw = String(
    hasCreatedOutput(item)
      ? item.processingStatus
      : item.evaluationStatus || item.recommendedAction || item.processingStatus || item.valueStatus || "",
  ).toLowerCase();
  const map: Record<string, string> = {
    actionable: "可行动",
    pending: "待评估",
    unprocessed: "待处理",
    review: "待复核",
    unreviewed: "未评估",
    processed: "已处理",
    processing: "处理中",
    ignored: "已忽略",
    discarded: "已丢弃",
    task_created: "已生成任务",
    knowledge_extracted: "已入知识",
    create_post_package: "建议成稿",
    create_task: "建议建任务",
    save_knowledge: "建议入库",
    discard: "建议忽略",
  };
  return map[raw] || cleanText(raw, "待处理");
}

function processingLabel(status?: string) {
  const raw = String(status || "").toLowerCase();
  const map: Record<string, string> = {
    unprocessed: "待处理",
    queued: "排队中",
    task_created: "已生成任务",
    package_created: "已生成发布包",
    knowledge_extracted: "已入知识",
    archived: "已归档",
    ignored: "已忽略",
  };
  return map[raw] || cleanText(status, "待处理");
}

function statusTone(item: LocalIntelItem) {
  if (hasCreatedOutput(item)) return "done";
  if (isActionable(item)) return "actionable";
  if (isPending(item)) return "pending";
  if (item.processingStatus === "ignored" || item.evaluationStatus === "discarded") return "muted";
  return "default";
}

function taskBrief(item: LocalIntelItem) {
  return [
    "请基于这条情报生成一套可执行的小红书内容任务。",
    `情报标题：${itemTitle(item)}`,
    `摘要：${itemSummary(item)}`,
    cleanText(item.usage) ? `可用方向：${cleanText(item.usage)}` : "",
    cleanText(item.evaluationReason) ? `判断依据：${cleanText(item.evaluationReason)}` : "",
    Array.isArray(item.tags) && item.tags.length ? `标签：${item.tags.map((tag) => cleanText(tag)).filter(Boolean).join("、")}` : "",
    itemUrl(item) ? `来源：${itemUrl(item)}` : "",
  ].filter(Boolean).join("\n");
}

function sortValue(item: LocalIntelItem, sort: IntelSort) {
  const time = Date.parse(itemDate(item));
  return Number.isFinite(time) ? time : 0;
}

export function IntelView({
  intel,
  notionConfigured,
  onReload,
  onCreateTask,
}: {
  intel: LocalIntelItem[];
  notionConfigured: boolean;
  onReload: () => Promise<void>;
  onCreateTask: (inputText: string, sourceLabel?: string, options?: { entryType?: string; entryMessageId?: string }) => void | Promise<void>;
}) {
  const [creatingId, setCreatingId] = useState("");
  const [updatingId, setUpdatingId] = useState("");
  const [selected, setSelected] = useState<LocalIntelItem | null>(null);
  const [filter, setFilter] = useState<IntelFilter>("all");
  const [sort, setSort] = useState<IntelSort>("newest");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [fetchingTopics, setFetchingTopics] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importingTopic, setImportingTopic] = useState(false);
  const [importForm, setImportForm] = useState({ sourceType: "xhs", sourceUrl: "", text: "" });
  const [topicQuery, setTopicQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [page, setPage] = useState(1);
  const hasFilterApplied = query.trim() !== "" || filter !== "all" || sort !== "newest";

  const counts = useMemo(
    () => ({
      all: intel.length,
      pending: intel.filter((item) => isPending(item) && !isActionable(item) && !isIgnored(item)).length,
      actionable: intel.filter(isActionable).length,
      ignored: intel.filter(isIgnored).length,
    }),
    [intel],
  );

  const filteredIntel = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return intel
      .filter((item) => {
        if (filter === "pending" && (!isPending(item) || isActionable(item) || isIgnored(item))) return false;
        if (filter === "actionable" && !isActionable(item)) return false;
        if (filter === "ignored" && !isIgnored(item)) return false;
        if (!keyword) return true;
        const text = [item.title, item.summary, item.evaluationReason, item.usage, item.category, item.source, ...(item.tags || [])]
          .map((part) => cleanText(part))
          .join(" ")
          .toLowerCase();
        return text.includes(keyword);
      })
      .sort((a, b) => {
        const left = sortValue(a, sort);
        const right = sortValue(b, sort);
        return sort === "oldest" ? left - right : right - left;
      });
  }, [filter, intel, query, sort]);
  const totalPages = Math.max(1, Math.ceil(filteredIntel.length / PAGE_SIZE));
  const visibleIntel = useMemo(() => {
    const safePage = Math.min(page, totalPages);
    return filteredIntel.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [filteredIntel, page, totalPages]);

  async function reloadIntel() {
    setRefreshing(true);
    setNotice(null);
    try {
      await onReload();
      setNotice({ tone: "success", text: "情报库已刷新。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "刷新失败，请稍后重试。" });
    } finally {
      setRefreshing(false);
    }
  }

  async function syncNotionIntel() {
    setRefreshing(true);
    setNotice(null);
    try {
      await postJson("/api/local/intel/sync-notion", { limit: 100 });
      await onReload();
      setNotice({ tone: "success", text: "已从 Notion 同步情报库。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "同步 Notion 失败，请检查接入配置。" });
    } finally {
      setRefreshing(false);
    }
  }

  async function fetchTopics() {
    const topic = topicQuery.trim();
    if (!topic) {
      setNotice({ tone: "error", text: "请先输入行业、类目或话题关键词，再获取话题。" });
      return;
    }
    setFetchingTopics(true);
    setNotice(null);
    try {
      const result = await postJson<{ selected?: number; written?: number; duplicate?: number; message?: string }>("/api/local/intel/fetch-topics", {
        topic,
        limit: 5,
        mode: "topic",
      });
      await onReload();
      const selected = Number(result.selected || 0);
      const written = Number(result.written || 0);
      const duplicate = Number(result.duplicate || 0);
      setNotice({
        tone: selected > 0 ? "success" : "error",
        text: selected > 0
          ? `已获取 ${selected} 条候选话题，新增 ${written} 条，重复 ${duplicate} 条。`
          : result.message || "暂时没有获取到可用话题，可以换一组关键词再试。",
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "获取话题失败，请检查模型 API 和情报源状态。" });
    } finally {
      setFetchingTopics(false);
    }
  }

  async function importTopic() {
    const text = importForm.text.trim();
    const sourceUrl = importForm.sourceUrl.trim();
    if (!text && !sourceUrl) {
      setNotice({ tone: "error", text: "请先粘贴话题内容、文章正文或来源链接。" });
      return;
    }
    setImportingTopic(true);
    setNotice(null);
    try {
      const result = await postJson<{ structured?: boolean; item?: LocalIntelItem }>("/api/local/intel/import-topic", {
        sourceType: importForm.sourceType,
        sourceUrl,
        text,
      });
      await onReload();
      setImportOpen(false);
      setImportForm({ sourceType: "xhs", sourceUrl: "", text: "" });
      setNotice({
        tone: "success",
        text: result.structured ? "话题已结构化导入情报库。" : "话题已按原文导入情报库。",
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "导入话题失败，请稍后重试。" });
    } finally {
      setImportingTopic(false);
    }
  }

  async function createTask(item: LocalIntelItem) {
    setCreatingId(item.id);
    setNotice(null);
    try {
      await onCreateTask(taskBrief(item), "情报库", { entryType: "intel", entryMessageId: item.id });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "生成任务失败，请检查本地 API。" });
    } finally {
      setCreatingId("");
    }
  }

  async function updateManualStatus(item: LocalIntelItem, next: "actionable" | "ignored") {
    setUpdatingId(`${next}:${item.id}`);
    setNotice(null);
    try {
      const body =
        next === "actionable"
          ? { evaluationStatus: "actionable", recommendedAction: "create_post_package", processingStatus: "unprocessed" }
          : { evaluationStatus: "discarded", recommendedAction: "discard", processingStatus: "ignored" };
      await patchJson(`/api/local/intel/${encodeURIComponent(item.id)}`, body);
      await onReload();
      setNotice({ tone: "success", text: next === "actionable" ? "已标为可行动。" : "已忽略该情报。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "更新状态失败，请稍后重试。" });
    } finally {
      setUpdatingId("");
    }
  }

  function resetFilters() {
    setFilter("all");
    setSort("newest");
    setQuery("");
    setPage(1);
  }

  return (
    <main className="pageStack x-page intelPage">
      <PageTitle
        group="资产中心"
        title="情报库"
        desc="筛选可转化为选题、知识和任务的外部信息。"
        right={
          <div className="intelTitleActions">
            <button className="ghost x-secondary intelSyncButton" type="button" onClick={() => setImportOpen(true)}>
              <Upload size={15} />
              导入话题
            </button>
            <label className="intelTopicFetch">
              <input
                value={topicQuery}
                onChange={(event) => setTopicQuery(event.target.value)}
                placeholder="输入行业/话题，如：疗愈 情绪管理"
              />
              <button className="ghost x-secondary intelSyncButton" type="button" disabled={fetchingTopics || !topicQuery.trim()} onClick={() => void fetchTopics()}>
                <Sparkles size={15} className={cx(fetchingTopics && "isSpinning")} />
                {fetchingTopics ? "获取中" : "获取话题"}
              </button>
            </label>
            {notionConfigured ? <button className="ghost x-secondary intelSyncButton" type="button" disabled={refreshing} onClick={() => void syncNotionIntel()}>
              <RefreshCw size={15} className={cx(refreshing && "isSpinning")} />
              {refreshing ? "同步中" : "同步 Notion"}
            </button> : null}
            <button className="ghost x-secondary intelSyncButton" type="button" disabled={refreshing} onClick={() => void reloadIntel()}>
              <RefreshCw size={15} className={cx(refreshing && "isSpinning")} />
              {refreshing ? "刷新中" : "刷新情报"}
            </button>
          </div>
        }
      />

      <section className="panel x-panel intelPanel">
        <div className="intelControls">
          <div className="intelFilters" role="tablist" aria-label="情报筛选">
            {[
              ["all", "全部", counts.all],
              ["pending", "待处理", counts.pending],
              ["actionable", "可行动", counts.actionable],
              ["ignored", "已忽略", counts.ignored],
            ].map(([id, label, count]) => (
              <button
                key={id}
                className={cx("intelFilterButton", filter === id && "selected")}
                type="button"
                onClick={() => {
                  setFilter(id as IntelFilter);
                  setPage(1);
                }}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <div className="intelTools">
            <span className="intelResultCount">
              显示 {filteredIntel.length} / {intel.length}
            </span>
            <label className="intelSearch">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索标题、摘要、分类或标签"
              />
            </label>
            <label className="intelSort">
              <span>排序</span>
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as IntelSort);
                  setPage(1);
                }}
              >
                <option value="newest">最新优先</option>
                <option value="oldest">最早优先</option>
              </select>
            </label>
          </div>
        </div>

        {notice ? <div className={cx("intelNotice", `intelNotice-${notice.tone}`)}>{notice.text}</div> : null}

        <div className="intelList">
          {visibleIntel.map((item) => {
            const url = itemUrl(item);
            return (
              <article className={cx("intelItem", isActionable(item) && "isActionable", isIgnored(item) && "isMuted")} key={item.id}>
                <div className="intelItemBody">
                  <div className="intelMeta">
                    <span className={cx("intelStatusChip", `intelStatusChip-${statusTone(item)}`)}>{statusLabel(item)}</span>
                    <span>{itemCategory(item)}</span>
                  </div>
                  <button className="intelTitleButton" type="button" onClick={() => setSelected(item)}>
                    {itemTitle(item)}
                  </button>
                  <div className="intelSourceLine">
                    <span>{itemSource(item)}</span>
                    <i>{formatDate(itemDate(item))}</i>
                  </div>
                  <p>{compactText(itemSummary(item), 180)}</p>
                  {Array.isArray(item.tags) && item.tags.length ? (
                    <div className="intelTags">
                      {item.tags.slice(0, 6).map((tag) => (
                        <span key={tag}>{cleanText(tag)}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="intelActions">
                  {!hasCreatedOutput(item) && !isActionable(item) && !isIgnored(item) ? (
                    <button className="ghost x-secondary intelMarkAction" type="button" disabled={updatingId === `actionable:${item.id}`} onClick={() => void updateManualStatus(item, "actionable")}>
                      <CheckCircle2 size={15} />
                      可行动
                    </button>
                  ) : null}
                  {!hasCreatedOutput(item) && !isIgnored(item) ? (
                    <button className="ghost x-secondary intelIgnoreAction" type="button" disabled={updatingId === `ignored:${item.id}`} onClick={() => void updateManualStatus(item, "ignored")}>
                      <Trash2 size={15} />
                      忽略
                    </button>
                  ) : null}
                  <button className="ghost x-secondary" type="button" onClick={() => setSelected(item)}>
                    <Eye size={15} />
                    详情
                  </button>
                  {url ? (
                    <a className="ghost x-secondary" href={url} target="_blank" rel="noreferrer">
                      <ExternalLink size={15} />
                      来源
                    </a>
                  ) : null}
                  {canCreateTask(item) ? (
                    <button className={cx("ghost x-secondary intelCreateAction", isActionable(item) && "isProminent")} type="button" disabled={creatingId === item.id} onClick={() => void createTask(item)}>
                      {creatingId === item.id ? <Sparkles size={15} /> : <Zap size={15} />}
                      {creatingId === item.id ? "生成中" : "生成任务"}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
          {!filteredIntel.length ? (
            <div className={cx("intelEmpty", hasFilterApplied && "isFiltered")}>
              <div className="intelEmptyText">
                <strong>{hasFilterApplied ? "没有符合条件的情报" : "暂无情报数据"}</strong>
                <span>{hasFilterApplied ? "当前筛选可能过窄，可以清空条件后查看全部情报。" : "在上方输入行业或话题关键词，点击“获取话题”后会写入本地情报库。"}</span>
              </div>
              <div className="intelEmptyActions">
                {hasFilterApplied ? (
                  <button className="ghost x-secondary" type="button" onClick={resetFilters}>
                    清空筛选
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="intelPagerBar" aria-label="情报分页">
          <span>
            当前显示 {visibleIntel.length} 条 / 筛选后 {filteredIntel.length} 条 / 共 {intel.length} 条
          </span>
          <div>
            <button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              上一页
            </button>
            <strong>
              {Math.min(page, totalPages)} / {totalPages}
            </strong>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
              下一页
            </button>
          </div>
        </div>
      </section>

      {importOpen ? (
        <div className="modalBackdrop x-modal-backdrop">
          <section className="modalPanel x-modal intelImportModal" role="dialog" aria-modal="true" aria-label="导入话题素材">
            <button className="iconButton x-close" type="button" aria-label="关闭" onClick={() => setImportOpen(false)}>
              <X size={18} />
            </button>
            <header>
              <div className="intelDetailKicker">话题源导入</div>
              <h2>导入话题/素材</h2>
              <p>粘贴小红书、公众号、知乎、网页内容或链接，保存为本地情报。</p>
            </header>
            <div className="intelImportForm">
              <label>
                <span>来源类型</span>
                <select value={importForm.sourceType} onChange={(event) => setImportForm((current) => ({ ...current, sourceType: event.target.value }))}>
                  <option value="xhs">小红书</option>
                  <option value="wechat">公众号</option>
                  <option value="zhihu">知乎</option>
                  <option value="web">网页</option>
                  <option value="manual">手动文本</option>
                </select>
              </label>
              <label>
                <span>来源链接（选填）</span>
                <input
                  value={importForm.sourceUrl}
                  onChange={(event) => setImportForm((current) => ({ ...current, sourceUrl: event.target.value }))}
                  placeholder="粘贴小红书、公众号或网页链接"
                />
              </label>
              <label className="intelImportText">
                <span>话题内容 / 原文片段</span>
                <textarea
                  value={importForm.text}
                  onChange={(event) => setImportForm((current) => ({ ...current, text: event.target.value }))}
                  placeholder="粘贴标题、正文片段、评论洞察、选题想法或客户提供的素材..."
                />
              </label>
              <p>模型已配置时会自动提炼标题、摘要和使用建议；未配置或结构化失败时，会保留原文导入。</p>
            </div>
            <footer className="intelDetailActions">
              <button className="ghost x-secondary" type="button" onClick={() => setImportOpen(false)} disabled={importingTopic}>
                取消
              </button>
              <button className="primary x-primary intelPrimaryAction" type="button" onClick={() => void importTopic()} disabled={importingTopic}>
                <Upload size={15} />
                {importingTopic ? "导入中" : "导入情报库"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {selected ? <IntelDetailModal item={selected} onClose={() => setSelected(null)} onCreateTask={createTask} creating={creatingId === selected.id} /> : null}
    </main>
  );
}

function IntelDetailModal({
  item,
  onClose,
  onCreateTask,
  creating,
}: {
  item: LocalIntelItem;
  onClose: () => void;
  onCreateTask: (item: LocalIntelItem) => Promise<void>;
  creating: boolean;
}) {
  const url = itemUrl(item);
  const tags = (item.tags || []).map((tag) => cleanText(tag)).filter(Boolean);
  const taskCreatable = canCreateTask(item);
  return (
    <div className="modalBackdrop x-modal-backdrop">
      <section className="modalPanel x-modal intelDetailModal" role="dialog" aria-modal="true" aria-label="情报详情">
        <button className="iconButton x-close" type="button" aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
        <header>
          <div className="intelDetailKicker">{itemCategory(item)}</div>
          <h2>{itemTitle(item)}</h2>
          <p>{formatDate(itemDate(item))}</p>
        </header>
        <div className="intelDecisionGrid">
          <div>
            <span>人工判断</span>
            <strong>{statusLabel(item)}</strong>
          </div>
          <div>
            <span>处理状态</span>
            <strong>{processingLabel(item.processingStatus)}</strong>
          </div>
          <div>
            <span>分类</span>
            <strong>{itemCategory(item)}</strong>
          </div>
          <div>
            <span>来源</span>
            <strong>{itemSource(item)}</strong>
          </div>
        </div>
        <div className="intelDetailGrid">
          <section>
            <span>摘要</span>
            <div className="intelDetailText">{itemSummary(item)}</div>
          </section>
          <section>
            <span>使用建议</span>
            <div className="intelDetailText">{cleanText(item.usage || item.evaluationReason, "暂无使用建议")}</div>
          </section>
          <section>
            <span>来源链接</span>
            {url ? (
              <a className="intelDetailLink" href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            ) : (
              <div className="intelDetailText isMuted">暂无链接</div>
            )}
          </section>
          <section>
            <span>标签</span>
            <div className="intelDetailTags">
              {tags.length ? (
                tags.map((tag) => <b key={tag}>{tag}</b>)
              ) : (
                <em>暂无标签</em>
              )}
            </div>
          </section>
        </div>
        <footer className="intelDetailActions">
          <button className="ghost x-secondary" type="button" onClick={onClose}>
            关闭
          </button>
          {taskCreatable ? (
            <button className="primary x-primary intelPrimaryAction" type="button" disabled={creating} onClick={() => void onCreateTask(item)}>
              {creating ? <Sparkles size={15} /> : <Zap size={15} />}
              {creating ? "生成中" : "生成任务"}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
