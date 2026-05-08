import { useEffect, useMemo, useState } from "react";
import { Archive, BookOpen, CheckCircle2, Pencil, Plus, Search, Tag, Trash2, X } from "lucide-react";
import type { KnowledgeItem } from "../types";
import { deleteJson, postJson } from "../lib/api";
import { cleanText, cx, formatDate } from "../lib/utils";
import { EmptyState, PageTitle, StatusPill } from "../components/common";

const KNOWLEDGE_TYPES = ["全部知识", "业务知识", "账号知识", "内容方法", "平台规则", "流程经验"];
const DEFAULT_TYPE = "内容方法";
const PAGE_SIZE = 8;

function FieldMark({ required }: { required?: boolean }) {
  return <em className={cx("knowledgeFieldMark", required ? "isRequired" : "isOptional")}>{required ? "必填" : "选填"}</em>;
}

function splitTags(tags: KnowledgeItem["tags"]) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  return String(tags || "")
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function knowledgeType(item: KnowledgeItem) {
  return cleanText(item.type || item.category, "知识");
}

function knowledgeTitle(item: KnowledgeItem) {
  return cleanText(item.title, "未命名知识");
}

function knowledgeContent(item: KnowledgeItem) {
  return cleanText(item.content, "暂无内容");
}

function normalizeDuplicateText(value: unknown) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function textSimilarity(left: string, right: string) {
  if (!left || !right) return 0;
  const short = left.length < right.length ? left : right;
  const long = left.length < right.length ? right : left;
  if (long.includes(short) && short.length >= 80) return 1;
  const grams = new Set<string>();
  for (let index = 0; index < long.length - 1; index += 1) grams.add(long.slice(index, index + 2));
  let hits = 0;
  for (let index = 0; index < short.length - 1; index += 1) {
    if (grams.has(short.slice(index, index + 2))) hits += 1;
  }
  return hits / Math.max(1, short.length - 1);
}

function hasSharedTag(left: KnowledgeItem, right: KnowledgeItem) {
  const leftTags = new Set(splitTags(left.tags));
  return splitTags(right.tags).some((tag) => leftTags.has(tag));
}

function isDuplicateKnowledge(left: KnowledgeItem, right: KnowledgeItem) {
  if (knowledgeType(left) !== knowledgeType(right)) return false;
  const leftContent = normalizeDuplicateText(left.content);
  const rightContent = normalizeDuplicateText(right.content);
  if (leftContent.length < 80 || rightContent.length < 80) return false;
  if (leftContent === rightContent) return true;
  const similarity = textSimilarity(leftContent, rightContent);
  return similarity >= 0.64 || (similarity >= 0.48 && hasSharedTag(left, right));
}

function knowledgeRank(item: KnowledgeItem) {
  const status = item.status || "enabled";
  const statusScore = status === "enabled" ? 3 : status === "disabled" ? 2 : 1;
  const aiScore = item.aiEnabled === false ? 0 : 1;
  const updatedAt = Date.parse(item.updatedAt || "") || 0;
  return statusScore * 1_000_000_000_000_000 + aiScore * 1_000_000_000_000 + updatedAt;
}

function mergeDuplicateKnowledge(primary: KnowledgeItem, secondary: KnowledgeItem) {
  const tags = Array.from(new Set([...splitTags(primary.tags), ...splitTags(secondary.tags)]));
  return {
    ...primary,
    platform: primary.platform || secondary.platform,
    scenario: primary.scenario || secondary.scenario,
    project: primary.project || secondary.project,
    forbiddenNote: primary.forbiddenNote || secondary.forbiddenNote,
    tags,
  };
}

function dedupeKnowledgeItems(items: KnowledgeItem[]) {
  const result: KnowledgeItem[] = [];
  for (const item of items) {
    const duplicateIndex = result.findIndex((existing) => isDuplicateKnowledge(existing, item));
    if (duplicateIndex < 0) {
      result.push(item);
      continue;
    }
    const existing = result[duplicateIndex];
    result[duplicateIndex] = knowledgeRank(item) > knowledgeRank(existing)
      ? mergeDuplicateKnowledge(item, existing)
      : mergeDuplicateKnowledge(existing, item);
  }
  return result;
}

export function KnowledgeView({ knowledge, onReload }: { knowledge: KnowledgeItem[]; onReload: () => Promise<void> }) {
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeItem | null>(null);
  const [typeFilter, setTypeFilter] = useState("全部知识");
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const visibleKnowledge = useMemo(() => dedupeKnowledgeItems(knowledge), [knowledge]);

  const filteredKnowledge = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return visibleKnowledge.filter((item) => {
      const haystack = [
        item.title,
        item.content,
        item.type,
        item.category,
        item.platform,
        item.scenario,
        item.project,
        splitTags(item.tags).join(" "),
      ].join(" ").toLowerCase();

      return (
        (typeFilter === "全部知识" || knowledgeType(item) === typeFilter) &&
        (statusFilter === "all" || (item.status || "enabled") === statusFilter) &&
        (!normalizedQuery || haystack.includes(normalizedQuery))
      );
    });
  }, [query, statusFilter, typeFilter, visibleKnowledge]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set("全部知识", visibleKnowledge.length);
    for (const item of visibleKnowledge) {
      const type = knowledgeType(item);
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    return counts;
  }, [visibleKnowledge]);

  const enabledCount = visibleKnowledge.filter((item) => (item.status || "enabled") === "enabled").length;
  const archivedCount = visibleKnowledge.filter((item) => item.status === "archived").length;
  const totalPages = Math.max(1, Math.ceil(filteredKnowledge.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pagedKnowledge = filteredKnowledge.slice(pageStart, pageStart + PAGE_SIZE);
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1).filter((pageNumber) => (
    pageNumber === 1 ||
    pageNumber === totalPages ||
    Math.abs(pageNumber - currentPage) <= 1
  ));

  useEffect(() => {
    setPage(1);
  }, [query, statusFilter, typeFilter]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  async function changeStatus(item: KnowledgeItem, status: string) {
    setBusy(`${status}:${item.id}`);
    setNotice("");
    try {
      await postJson(`/api/local/knowledge/${encodeURIComponent(item.id)}/status`, { status });
      await onReload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "状态更新失败");
    } finally {
      setBusy("");
    }
  }

  async function removeConfirmed() {
    if (!pendingDelete) return;
    setBusy(`delete:${pendingDelete.id}`);
    setNotice("");
    try {
      await deleteJson(`/api/local/knowledge/${encodeURIComponent(pendingDelete.id)}`);
      setPendingDelete(null);
      await onReload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="pageStack x-page knowledgePage">
      <PageTitle
        group="资产中心"
        title="知识库"
        desc="维护可复用的业务知识、内容方法、平台规则和流程经验。"
        right={
          <button className="primary x-primary" onClick={() => setEditing({ id: "", title: "", content: "", type: DEFAULT_TYPE, status: "enabled", priority: 50, aiEnabled: true })} type="button">
            <Plus size={16} />
            新建知识
          </button>
        }
      />

      <section className="panel x-panel knowledgePanel">
        <div className="knowledgeSummary">
          <article>
            <BookOpen size={18} />
            <span>知识总量</span>
            <strong>{knowledge.length}</strong>
          </article>
          <article>
            <CheckCircle2 size={18} />
            <span>可调用</span>
            <strong>{enabledCount}</strong>
          </article>
          <article>
            <Archive size={18} />
            <span>已归档</span>
            <strong>{archivedCount}</strong>
          </article>
        </div>

        <div className="knowledgeToolbar">
          <div className="knowledgeTypeFilters" role="tablist" aria-label="知识类型筛选">
            {KNOWLEDGE_TYPES.map((type) => (
              <button className={cx("knowledgeFilterButton", typeFilter === type && "selected")} key={type} onClick={() => setTypeFilter(type)} type="button">
                {type}
                <span>{typeCounts.get(type) || 0}</span>
              </button>
            ))}
          </div>
          <div className="knowledgeTools">
            <label className="knowledgeSearch">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、内容或标签" />
            </label>
            <select className="knowledgeStatusSelect" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="知识状态筛选">
              <option value="all">全部状态</option>
              <option value="enabled">已启用</option>
              <option value="disabled">已停用</option>
              <option value="archived">已归档</option>
            </select>
          </div>
        </div>

        {notice ? <p className="knowledgeNotice isError">{notice}</p> : null}

        <div className="knowledgeGrid">
          {pagedKnowledge.map((item) => {
            const tags = splitTags(item.tags).slice(0, 4);
            const isBusy = busy.endsWith(item.id);
            return (
              <article className={cx("knowledgeCard", item.status === "archived" && "isArchived")} key={item.id}>
                <div className="knowledgeCardHead">
                  <div className="knowledgeMeta">
                    <span>{knowledgeType(item)}</span>
                    <StatusPill status={item.status || "enabled"} />
                  </div>
                  <small>{formatDate(item.updatedAt)}</small>
                </div>
                <h3>{knowledgeTitle(item)}</h3>
                <p>{knowledgeContent(item)}</p>
                <div className="knowledgeTags">
                  {item.scenario ? <span>{item.scenario}</span> : null}
                  {tags.map((tag) => (
                    <span key={tag}><Tag size={12} />{tag}</span>
                  ))}
                </div>
                {item.forbiddenNote ? <div className="knowledgeForbidden">禁用说明：{item.forbiddenNote}</div> : null}
                <div className="knowledgeActions">
                  <button className="ghost x-secondary" onClick={() => setEditing(item)} type="button">
                    <Pencil size={14} />
                    编辑
                  </button>
                  <button className="ghost x-secondary" disabled={isBusy} onClick={() => changeStatus(item, item.status === "enabled" ? "disabled" : "enabled")} type="button">
                    {item.status === "enabled" ? "停用" : "启用"}
                  </button>
                  <button className="ghost x-secondary" disabled={isBusy || item.status === "archived"} onClick={() => changeStatus(item, "archived")} type="button">
                    归档
                  </button>
                  <button className="danger x-danger" disabled={isBusy} onClick={() => setPendingDelete(item)} type="button">
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
              </article>
            );
          })}
          {!filteredKnowledge.length ? <EmptyState text={knowledge.length ? "没有符合筛选条件的知识" : "暂无知识资产"} /> : null}
        </div>
        {filteredKnowledge.length > PAGE_SIZE ? (
          <div className="knowledgePager">
            <span>
              显示 {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, filteredKnowledge.length)} 条
              <small>共 {filteredKnowledge.length} 条</small>
            </span>
            <div>
              <button disabled={currentPage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">上一页</button>
              {pageNumbers.map((pageNumber, index) => (
                <span className="knowledgePagerNumberWrap" key={pageNumber}>
                  {index > 0 && pageNumber - pageNumbers[index - 1] > 1 ? <small>...</small> : null}
                  <button className={cx(pageNumber === currentPage && "selected")} onClick={() => setPage(pageNumber)} type="button">{pageNumber}</button>
                </span>
              ))}
              <button disabled={currentPage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} type="button">下一页</button>
            </div>
          </div>
        ) : null}
      </section>

      {editing ? <KnowledgeEditor item={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await onReload(); }} /> : null}
      {pendingDelete ? (
        <ConfirmDeleteDialog
          busy={busy === `delete:${pendingDelete.id}`}
          item={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void removeConfirmed()}
        />
      ) : null}
    </main>
  );
}

function ConfirmDeleteDialog({ busy, item, onCancel, onConfirm }: { busy: boolean; item: KnowledgeItem; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modalBackdrop x-modal-backdrop">
      <div className="modalPanel x-modal knowledgeConfirmModal" role="dialog" aria-modal="true" aria-labelledby="knowledge-delete-title">
        <button className="iconButton x-close" onClick={onCancel} type="button" aria-label="关闭确认窗口"><X size={18} /></button>
        <header>
          <h2 id="knowledge-delete-title">删除知识</h2>
          <p>删除后会从本地知识库移除，不影响任务运行记录、发布包或本地文件。</p>
        </header>
        <div className="knowledgeConfirmBody">
          <strong>{knowledgeTitle(item)}</strong>
          <p>{knowledgeContent(item)}</p>
          <div className="knowledgeConfirmActions">
            <button className="x-secondary" onClick={onCancel} type="button">取消</button>
            <button className="x-danger" disabled={busy} onClick={onConfirm} type="button">{busy ? "删除中" : "确认删除"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function KnowledgeEditor({ item, onClose, onSaved }: { item: KnowledgeItem; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<KnowledgeItem>(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!form.title?.trim() || !form.content?.trim()) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        title: form.title.trim(),
        type: form.type || form.category || DEFAULT_TYPE,
        platform: form.platform || "",
        scenario: form.scenario || "",
        project: form.project || "",
        content: form.content.trim(),
        tags: splitTags(form.tags),
        status: form.status || "enabled",
        priority: form.priority ?? 50,
        aiEnabled: form.aiEnabled !== false,
        forbiddenNote: form.forbiddenNote || "",
      };
      if (form.id) await postJson(`/api/local/knowledge/${encodeURIComponent(form.id)}`, body);
      else await postJson("/api/local/knowledge", body);
      await onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBackdrop x-modal-backdrop">
      <div className="modalPanel x-modal knowledgeEditorModal" role="dialog" aria-modal="true" aria-labelledby="knowledge-editor-title">
        <button className="iconButton x-close" onClick={onClose} type="button" aria-label="关闭编辑窗口"><X size={18} /></button>
        <header>
          <h2 id="knowledge-editor-title">{form.id ? "编辑知识" : "新建知识"}</h2>
          <p>知识库用于长期复用，不直接存放临时情报。</p>
        </header>
        <form className="x-form-grid knowledgeEditorForm" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label>
            <span>标题 <FieldMark required /></span>
            <input value={form.title || ""} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：疗愈类账号的选题边界" />
            <small className="knowledgeFieldHint">一句话说明这条知识会解决什么问题，便于后续搜索和工作流匹配。</small>
          </label>
          <label>
            <span>类型 <FieldMark required /></span>
            <select value={form.type || DEFAULT_TYPE} onChange={(event) => setForm({ ...form, type: event.target.value })}><option>业务知识</option><option>账号知识</option><option>内容方法</option><option>平台规则</option><option>流程经验</option></select>
            <small className="knowledgeFieldHint">用于决定这条知识在工作流里如何被理解和调用。</small>
          </label>
          <label>
            <span>平台 <FieldMark /></span>
            <input value={form.platform || ""} onChange={(event) => setForm({ ...form, platform: event.target.value })} placeholder="例如：小红书 / 微信 / 通用" />
            <small className="knowledgeFieldHint">不限定平台可以填“通用”，也可以留空。</small>
          </label>
          <label>
            <span>场景 <FieldMark /></span>
            <input value={form.scenario || ""} onChange={(event) => setForm({ ...form, scenario: event.target.value })} placeholder="例如：选题判断、标题优化、避坑检查" />
            <small className="knowledgeFieldHint">描述这条知识最适合在哪个环节使用。</small>
          </label>
          <label>
            <span>项目 <FieldMark /></span>
            <input value={form.project || ""} onChange={(event) => setForm({ ...form, project: event.target.value })} placeholder="例如：某客户、某账号、某行业类目" />
            <small className="knowledgeFieldHint">用于区分客户、账号或专题；没有固定项目可以留空。</small>
          </label>
          <label>
            <span>标签 <FieldMark /></span>
            <input value={splitTags(form.tags).join(", ")} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="例如：疗愈, 情绪价值, 小红书, 禁忌" />
            <small className="knowledgeFieldHint">多个标签用逗号分隔，标签会参与搜索和任务匹配。</small>
          </label>
          <label className="x-wide">
            <span>内容 <FieldMark required /></span>
            <textarea value={form.content || ""} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="写清楚可复用的方法、规则、判断标准或客户偏好。例如：疗愈内容可以讲情绪体验和陪伴感，但不要做医疗承诺。" />
            <small className="knowledgeFieldHint">建议写成可执行规则或经验，不要只放一个关键词。</small>
          </label>
          <label className="x-wide">
            <span>禁用说明 <FieldMark /></span>
            <input value={form.forbiddenNote || ""} onChange={(event) => setForm({ ...form, forbiddenNote: event.target.value })} placeholder="例如：不要承诺治愈焦虑，不要使用诊断式表达" />
            <small className="knowledgeFieldHint">用于记录不能做、不能说、容易踩线的边界。</small>
          </label>
          <label className="x-inline-check knowledgeAiToggle"><input checked={form.aiEnabled !== false} type="checkbox" onChange={(event) => setForm({ ...form, aiEnabled: event.target.checked })} />允许工作流调用</label>
          {error ? <p className="knowledgeNotice isError x-wide">{error}</p> : null}
          <div className="x-form-actions">
            <button className="x-secondary" onClick={onClose} type="button">取消</button>
            <button className="x-primary" disabled={busy || !form.title?.trim() || !form.content?.trim()} type="submit">{busy ? "保存中" : "保存"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
