import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownUp, CheckCircle2, Clipboard, ExternalLink, Eye, FileText, Image as ImageIcon, Images, PackageCheck, RefreshCw, Send, Search, Upload, X } from "lucide-react";
import type { LocalPackageItem, PackageImageSlot } from "../types";
import { getJson, postJson } from "../lib/api";
import { compactText, cx, formatDate, statusText } from "../lib/utils";
import { EmptyState, PageTitle, StatusPill } from "../components/common";

const PAGE_SIZE = 10;
type PackageFilter = "all" | "unsynced" | "missingImages" | "lowQuality";
type PackageSort = "latest" | "quality" | "images" | "action";
type PrefillStatus = { ok?: boolean; stage?: string; message?: string; title?: string; updatedAt?: string };
type PackageNotice = { packageId: string; text: string; tone: "success" | "danger" | "info" };

function prefillNoticeText(status: PrefillStatus) {
  const message = status.message || "";
  if (status.stage === "completed" || status.ok === true || /退出码\s*0/.test(message)) {
    return "小红书预填完成，已打开发布页，请在浏览器中检查内容";
  }
  if (status.stage === "failed") {
    return `小红书预填失败：${message || "请查看运行日志"}`;
  }
  return message ? `小红书预填：${message}` : "正在启动小红书发布页预填";
}

function prefillNoticeTone(status?: PrefillStatus): PackageNotice["tone"] {
  if (status?.stage === "failed") return "danger";
  if (status?.stage === "completed" || status?.ok === true) return "success";
  return "info";
}

function notionText(status?: string) {
  return status === "synced" ? "已同步 Notion" : "待同步 Notion";
}

function packageDesc(item: LocalPackageItem) {
  const imageText = `图片 ${item.imageCount || item.detail?.images?.length || 0} 张`;
  const qualityText = item.qualityScore == null ? "质量分 -" : `质量分 ${item.qualityScore}`;
  return `${imageText}，${qualityText}`;
}

function packageHealth(item: LocalPackageItem, notionConfigured: boolean) {
  const imageCount = item.imageCount || item.detail?.images?.length || 0;
  if (notionConfigured && item.notionStatus !== "synced") return { tone: "warning", text: "待同步" };
  if (!imageCount) return { tone: "muted", text: "待配图" };
  if (typeof item.qualityScore === "number" && item.qualityScore < 75) return { tone: "warning", text: "需复核" };
  return { tone: "success", text: "可交付" };
}

function packageBody(selected: LocalPackageItem | null) {
  if (!selected) return "";
  return selected.detail?.postText || selected.detail?.markdown || "";
}

function packageTags(selected: LocalPackageItem | null) {
  return selected?.detail?.hashtags?.join(" ") || "";
}

function matchesFilter(item: LocalPackageItem, filter: PackageFilter, notionConfigured: boolean) {
  if (filter === "unsynced") return notionConfigured && item.notionStatus !== "synced";
  if (filter === "missingImages") return !(item.imageCount || item.detail?.images?.length || 0);
  if (filter === "lowQuality") return typeof item.qualityScore === "number" && item.qualityScore < 75;
  return true;
}

function matchesQuery(item: LocalPackageItem, query: string) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return [
    item.id,
    item.title,
    item.status,
    item.notionStatus,
    item.packageDir,
    item.packageJsonPath,
    item.markdownPath,
    item.sourcePath,
  ].some((value) => String(value || "").toLowerCase().includes(text));
}

function imageStatus(image: PackageImageSlot) {
  if (image.missing) return { tone: "warning", text: "文件缺失" };
  if (image.dataUrl || image.filePath) return { tone: "success", text: "已生成" };
  if (image.prompt) return { tone: "muted", text: "待生成" };
  return { tone: "warning", text: "待补提示词" };
}

function sortPackages(items: LocalPackageItem[], sort: PackageSort, notionConfigured: boolean) {
  const score = (item: LocalPackageItem) => {
    if (sort === "quality") return item.qualityScore ?? -1;
    if (sort === "images") return item.imageCount || item.detail?.images?.length || 0;
    if (sort === "action") {
      const health = packageHealth(item, notionConfigured);
      if (health.text === "待同步") return 4;
      if (health.text === "需复核") return 3;
      if (health.text === "待配图") return 2;
      return 1;
    }
    return Date.parse(item.generatedAt || item.updatedAt || "") || 0;
  };
  return [...items].sort((a, b) => score(b) - score(a));
}

function reviewSummary(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function PackagesView({ packages, notionConfigured, onReload }: { packages: LocalPackageItem[]; notionConfigured: boolean; onReload: () => Promise<void> }) {
  const [selected, setSelected] = useState<LocalPackageItem | null>(null);
  const [preview, setPreview] = useState<PackageImageSlot | null>(null);
  const [busyId, setBusyId] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<PackageNotice | null>(null);
  const [modalNotice, setModalNotice] = useState("");
  const [filter, setFilter] = useState<PackageFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PackageSort>("latest");
  const [promptDraft, setPromptDraft] = useState("");
  const [bodyExpanded, setBodyExpanded] = useState(false);

  const filteredPackages = useMemo(() => sortPackages(packages.filter((item) => matchesFilter(item, filter, notionConfigured) && matchesQuery(item, query)), sort, notionConfigured), [filter, notionConfigured, packages, query, sort]);
  const totalPages = Math.max(1, Math.ceil(filteredPackages.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visiblePackages = useMemo(() => filteredPackages.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filteredPackages, safePage]);
  const stats = useMemo(() => {
    const scored = packages.filter((item) => typeof item.qualityScore === "number");
    const qualityAvg = scored.length ? Math.round(scored.reduce((sum, item) => sum + (item.qualityScore || 0), 0) / scored.length) : null;
    return {
      images: packages.reduce((sum, item) => sum + (item.imageCount || item.detail?.images?.length || 0), 0),
      synced: packages.filter((item) => item.notionStatus === "synced").length,
      qualityAvg,
    };
  }, [packages]);
  const selectedBody = packageBody(selected);
  const selectedMarkdown = selected?.detail?.markdown || selectedBody;
  const selectedTags = packageTags(selected);
  const filters = useMemo(() => [
    { id: "all" as const, label: "全部", count: packages.length },
    ...(notionConfigured ? [{ id: "unsynced" as const, label: "待同步", count: packages.filter((item) => matchesFilter(item, "unsynced", notionConfigured)).length }] : []),
    { id: "missingImages" as const, label: "待配图", count: packages.filter((item) => matchesFilter(item, "missingImages", notionConfigured)).length },
    { id: "lowQuality" as const, label: "需复核", count: packages.filter((item) => matchesFilter(item, "lowQuality", notionConfigured)).length },
  ], [notionConfigured, packages]);

  useEffect(() => {
    if (!notionConfigured && filter === "unsynced") setFilter("all");
  }, [filter, notionConfigured]);

  useEffect(() => {
    if (!selected && !preview) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPreview(null);
        if (!preview) setSelected(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview, selected]);

  async function reloadPackages() {
    setBusyId("reload");
    setError("");
    try {
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function openDetail(id: string) {
    setBusyId(`detail:${id}`);
    setError("");
    setNotice(null);
    setModalNotice("");
    try {
      const detail = await getJson<LocalPackageItem>(`/api/local/packages/${encodeURIComponent(id)}`);
      setSelected(detail);
      setBodyExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function syncNotion(id: string) {
    setBusyId(`notion:${id}`);
    setError("");
    try {
      await postJson(`/api/local/packages/${encodeURIComponent(id)}/sync-notion`);
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function launchPrefill(id: string) {
    setBusyId(`prefill:${id}`);
    setError("");
    setNotice(null);
    try {
      await postJson(`/api/local/packages/${encodeURIComponent(id)}/prefill-xhs`);
      setNotice({ packageId: id, text: "正在启动小红书发布页预填", tone: "info" });
      for (let index = 0; index < 18; index += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, index < 3 ? 1000 : 2500));
        const status = await getJson<PrefillStatus>("/api/local/packages/prefill-status");
        setNotice({ packageId: id, text: prefillNoticeText(status), tone: prefillNoticeTone(status) });
        if (status.stage === "completed" || status.stage === "failed" || status.stage === "login_required") break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  function closeDetail() {
    setPreview(null);
    setSelected(null);
    setBodyExpanded(false);
    setModalNotice("");
  }

  function changeFilter(nextFilter: PackageFilter) {
    setFilter(nextFilter);
    setPage(1);
  }

  function changeQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  function changeSort(nextSort: PackageSort) {
    setSort(nextSort);
    setPage(1);
  }

  function openPreview(image: PackageImageSlot) {
    setPreview(image);
    setPromptDraft(image.prompt || "");
    setModalNotice("");
  }

  async function copyText(value: string, label: string, scope: "page" | "modal" = "page") {
    const setScopedNotice = scope === "modal" ? setModalNotice : setModalNotice;
    if (!value.trim()) {
      setScopedNotice(`${label}暂无可复制内容`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setScopedNotice(`${label}已复制`);
    } catch {
      setScopedNotice("浏览器暂不允许复制，请手动选中文本复制");
    }
  }

  async function updateImagePrompt() {
    if (!selected || !preview) return;
    setBusyId(`prompt:${preview.id}`);
    setError("");
    try {
      const detail = await postJson<LocalPackageItem>(`/api/local/packages/${encodeURIComponent(selected.id)}/image-prompt`, {
        slotId: preview.id,
        prompt: promptDraft.trim(),
      });
      const nextPreview = detail.detail?.images?.find((image) => image.id === preview.id) || { ...preview, prompt: promptDraft.trim() };
      setSelected(detail);
      setPreview(nextPreview);
      setModalNotice("图片提示词已保存");
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function generateImage() {
    if (!selected || !preview) return;
    setBusyId(`image:${preview.id}`);
    setError("");
    try {
      const detail = await postJson<LocalPackageItem>(`/api/local/packages/${encodeURIComponent(selected.id)}/generate-image`, {
        slotId: preview.id,
        prompt: promptDraft.trim() || preview.prompt || "",
      });
      const nextPreview = detail.detail?.images?.find((image) => image.id === preview.id) || preview;
      setSelected(detail);
      setPreview(nextPreview);
      setPromptDraft(nextPreview.prompt || promptDraft);
      setModalNotice("图片素材已更新");
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function uploadImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!selected || !preview || !file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setModalNotice("请上传 PNG、JPG 或 WebP 图片");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setModalNotice("图片不能超过 12MB");
      return;
    }
    setBusyId(`upload:${preview.id}`);
    setError("");
    setModalNotice("正在上传图片");
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });
      setPreview({ ...preview, dataUrl, missing: false });
      const detail = await postJson<LocalPackageItem>(`/api/local/packages/${encodeURIComponent(selected.id)}/upload-image`, {
        slotId: preview.id,
        dataUrl,
        prompt: promptDraft.trim() || preview.prompt || "",
      });
      const nextPreview = detail.detail?.images?.find((image) => image.id === preview.id) || preview;
      setSelected(detail);
      setPreview(nextPreview);
      setPromptDraft(nextPreview.prompt || promptDraft);
      setModalNotice("图片已上传");
      await onReload();
    } catch (err) {
      setModalNotice(`图片上传失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId("");
    }
  }

  return (
    <main className="pageStack x-page packagesPage">
      <PageTitle
        group="资产中心"
        title="发布包"
        desc={notionConfigured ? "集中管理历史内容包、正文、图片素材和 Notion 同步状态。" : "集中管理历史内容包、正文和图片素材。"}
        right={(
          <button className="x-secondary packageReloadButton" disabled={busyId === "reload"} onClick={() => void reloadPackages()} type="button">
            <RefreshCw size={15} />
            {busyId === "reload" ? "刷新中" : "刷新"}
          </button>
        )}
      />

      {error ? <div className="x-api-error">发布包操作失败：{error}</div> : null}
      <section className={cx("packageSummaryGrid", !notionConfigured && "withoutNotion")} aria-label="发布包概览">
        <article>
          <PackageCheck size={18} />
          <span>本地发布包</span>
          <strong>{packages.length}</strong>
        </article>
        <article>
          <Images size={18} />
          <span>图片素材</span>
          <strong>{stats.images}</strong>
        </article>
        {notionConfigured ? <article>
          <RefreshCw size={18} />
          <span>Notion 已同步</span>
          <strong>{notionConfigured ? stats.synced : "-"}</strong>
        </article> : null}
        <article>
          <Eye size={18} />
          <span>平均质量分</span>
          <strong>{stats.qualityAvg ?? "-"}</strong>
        </article>
      </section>

      <section className="panel packageList x-list packageListPro">
        <div className="packageListHead">
          <div>
            <strong>发布包列表</strong>
            <p>查看生成结果、正文内容、图片提示词和本地素材。</p>
          </div>
          <span>{filteredPackages.length} / {packages.length} 个发布包</span>
        </div>
        <div className="packageFilterBar" role="tablist" aria-label="发布包筛选">
          <div className="packageFilterButtons">
            {filters.map((item) => (
              <button
                className={cx("packageFilterButton", filter === item.id && "active")}
                key={item.id}
                onClick={() => changeFilter(item.id)}
                role="tab"
                type="button"
                aria-selected={filter === item.id}
              >
                {item.label}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
          <label className="packageSearchBox">
            <Search size={15} />
            <input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="搜索标题、ID、状态或本地路径" />
            {query ? <button type="button" onClick={() => changeQuery("")} aria-label="清空搜索"><X size={14} /></button> : null}
          </label>
          <label className="packageSortBox">
            <ArrowDownUp size={15} />
            <select value={sort} onChange={(event) => changeSort(event.target.value as PackageSort)}>
              <option value="latest">最新生成</option>
              <option value="action">待处理优先</option>
              <option value="quality">质量分最高</option>
              <option value="images">图片数最多</option>
            </select>
          </label>
        </div>

        {visiblePackages.length ? (
          visiblePackages.map((item) => {
            const health = packageHealth(item, notionConfigured);
            return (
            <article className="packageRow x-row-card packageRowPro" key={item.id}>
              <div className="packageMain">
                <div className="packageMeta x-tags">
                  <StatusPill status={item.status} />
                  <span className={cx("packageHealthPill", `packageHealthPill-${health.tone}`)}>
                    {health.tone === "success" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                    {health.text}
                  </span>
                  {notionConfigured ? <span className={cx("packageNotionPill", item.notionStatus === "synced" && "synced")}>{notionText(item.notionStatus)}</span> : null}
                  <span>{formatDate(item.generatedAt || item.updatedAt)}</span>
                  <span>ID {item.id.slice(0, 8)}</span>
                </div>
                <h3>{item.title || "未命名发布包"}</h3>
                <p>{packageDesc(item)}</p>
              </div>
              <div className="packageActionStack">
                <div className="packageActions x-row-actions">
                  <button className="packagePrimaryAction" disabled={busyId === `detail:${item.id}`} onClick={() => void openDetail(item.id)} type="button">
                    <Eye size={15} />
                    {busyId === `detail:${item.id}` ? "打开中" : "查看详情"}
                  </button>
                  <button className="ghost x-secondary" disabled={busyId === `prefill:${item.id}`} onClick={() => void launchPrefill(item.id)} type="button">
                    <Send size={15} />
                    {busyId === `prefill:${item.id}` ? "启动中" : "自动预填"}
                  </button>
                  {notionConfigured && item.notionStatus !== "synced" ? (
                    <button className="ghost x-secondary" disabled={busyId === `notion:${item.id}`} onClick={() => void syncNotion(item.id)}>
                      <RefreshCw size={15} />
                      {busyId === `notion:${item.id}` ? "同步中" : "同步 Notion"}
                    </button>
                  ) : null}
                  {notionConfigured && item.notionUrl ? (
                    <a className="ghost x-secondary packageExternalLink" href={item.notionUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={15} />
                      Notion
                    </a>
                  ) : null}
                </div>
                {notice?.packageId === item.id ? (
                  <div className={cx("packageNotice", `packageNotice-${notice.tone}`)} role="status">
                    {notice.tone === "danger" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
                    {notice.text}
                  </div>
                ) : null}
              </div>
            </article>
            );
          })
        ) : (
          <EmptyState text={filter === "all" ? "暂无发布包，完成内容任务后，生成的发布包会出现在这里。" : "当前筛选下暂无发布包。"} />
        )}

        {packages.length > PAGE_SIZE ? (
          <div className="packagePager">
            <button className="ghost" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            <span>{safePage} / {totalPages}</span>
            <button className="ghost" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
          </div>
        ) : null}
      </section>

      {selected ? (
        <div className="x-modal-backdrop">
          <section className="x-modal packageModal" role="dialog" aria-modal="true" aria-labelledby="package-detail-title">
            <div className="x-modal-head">
              <div>
                <span className="packageModalKicker"><PackageCheck size={14} />发布包详情</span>
                <strong id="package-detail-title">{selected.title || "发布包详情"}</strong>
                <p>{statusText(selected.status)} · {formatDate(selected.generatedAt || selected.updatedAt)}</p>
              </div>
              <div className="packageModalActions">
                {notionConfigured && selected.notionUrl ? (
                  <a className="ghost x-secondary packageExternalLink" href={selected.notionUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={15} />
                    Notion
                  </a>
                ) : null}
                <button className="ghost x-secondary" onClick={() => void copyText(selectedBody, "正文", "modal")} type="button">
                  <Clipboard size={15} />
                  复制正文
                </button>
                <button className="ghost x-secondary" onClick={() => void copyText(selectedMarkdown, "Markdown 全文", "modal")} type="button">
                  <FileText size={15} />
                  复制 Markdown
                </button>
                <button className="ghost x-icon-button" onClick={closeDetail} aria-label="关闭" type="button">
                  <X size={18} />
                </button>
              </div>
            </div>
            {modalNotice ? <div className="packageModalNotice" role="status"><CheckCircle2 size={16} />{modalNotice}</div> : null}

            <div className={cx("packageDeliveryStrip", !notionConfigured && "withoutNotion")}>
              <span><CheckCircle2 size={14} />图片 {selected.detail?.images?.length || selected.imageCount || 0} 张</span>
              <span><FileText size={14} />正文 {selectedBody ? `${selectedBody.length} 字` : "未生成"}</span>
              <span><PackageCheck size={14} />质量分 {selected.qualityScore ?? "-"}</span>
              {notionConfigured ? <span><RefreshCw size={14} />{notionText(selected.notionStatus)}</span> : null}
            </div>

            <div className="packageDetailGrid">
              <article>
                <span>标题</span>
                <p>{selected.detail?.title || selected.title || "暂无标题"}</p>
              </article>
              <article>
                <span>副标题</span>
                <p>{selected.detail?.subtitle || selected.detail?.hook || "暂无副标题"}</p>
              </article>
              <article className="packageDetailWide">
                <span>质量检查</span>
                <div className="packageQualityGrid">
                  <div><small>质量分</small><strong>{selected.qualityScore ?? "-"}</strong></div>
                  <div><small>AI 味</small><strong>{selected.aiFlavorScore ?? "-"}</strong></div>
                  <div><small>人味分</small><strong>{selected.humanTraceScore ?? "-"}</strong></div>
                </div>
                {reviewSummary(selected.detail?.qualityReview || selected.detail?.humanEditorReview) ? (
                  <pre className="packageReviewText">{compactText(reviewSummary(selected.detail?.qualityReview || selected.detail?.humanEditorReview), 900)}</pre>
                ) : null}
              </article>
              <article className="packageDetailWide">
                <div className="packageFieldHead">
                  <span>正文</span>
                  <button className="packageTextTool" onClick={() => setBodyExpanded((value) => !value)} type="button">
                    {bodyExpanded ? "收起正文" : "展开正文"}
                  </button>
                </div>
                <p className={cx("packagePostText", bodyExpanded && "expanded")}>{selectedBody || "暂无正文内容"}</p>
              </article>
              {selected.detail?.hashtags?.length ? (
                <article className="packageDetailWide">
                  <span>标签</span>
                  <p className="packageTagsText">{selectedTags}</p>
                  <button className="packageTextTool" onClick={() => void copyText(selectedTags, "标签", "modal")} type="button">
                    <Clipboard size={14} />
                    复制标签
                  </button>
                </article>
              ) : null}
              {selected.detail?.checklist?.length ? (
                <article className="packageDetailWide">
                  <span>发布检查清单</span>
                  <ul className="packageChecklist">
                    {selected.detail.checklist.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </article>
              ) : null}
              {selected.detail?.files?.packageDir ? (
                <article className="packageDetailWide">
                  <div className="packageFieldHead">
                    <span>本地资产位置</span>
                    <button className="packageTextTool" onClick={() => void copyText(selected.detail?.files?.packageDir || "", "本地资产路径", "modal")} type="button">
                      <Clipboard size={14} />
                      复制路径
                    </button>
                  </div>
                  <p className="packagePathText">{selected.detail.files.packageDir}</p>
                </article>
              ) : null}
            </div>

            <div className="packageImageBlock">
              <div className="packageImageHead">
                <strong>图片素材</strong>
                <span>{selected.detail?.images?.length || 0} 张</span>
              </div>
              {(selected.detail?.images || []).length ? (
                <div className="packageImageGrid">
                  {(selected.detail?.images || []).map((image) => {
                    const status = imageStatus(image);
                    return (
                <button className="packageImageCard" type="button" key={image.id} onClick={() => openPreview(image)}>
                  <em className={cx("packageImageStatus", `packageImageStatus-${status.tone}`)}>{status.text}</em>
                  {image.dataUrl ? <img src={image.dataUrl} alt={image.label || image.title || image.id} /> : <ImageIcon size={22} />}
                  <span>{image.label || image.title || image.id}</span>
                  <small>{compactText(image.purpose || image.prompt || "", 72)}</small>
                </button>
                    );
                  })}
                </div>
              ) : (
                <EmptyState text="该发布包暂未生成图片素材，后续素材会显示在这里。" />
              )}
            </div>
          </section>
        </div>
      ) : null}

      {preview ? (
        <div className="x-modal-backdrop">
          <section className="x-modal packagePreviewModal" role="dialog" aria-modal="true" aria-labelledby="package-preview-title">
            <div className="x-modal-head">
              <div>
                <strong id="package-preview-title">{preview.label || preview.title || "图片预览"}</strong>
                <p>{preview.type || "素材图片"}</p>
              </div>
              <div className="packageModalActions">
                <label className={cx("ghost x-secondary packageUploadButton", busyId === `upload:${preview.id}` && "disabled")}>
                  <Upload size={15} />
                  {busyId === `upload:${preview.id}` ? "上传中" : "上传图片"}
                  <input accept="image/png,image/jpeg,image/webp" disabled={busyId === `upload:${preview.id}`} onChange={(event) => void uploadImage(event)} type="file" />
                </label>
                <button className="ghost x-secondary" disabled={busyId === `prompt:${preview.id}`} onClick={() => void updateImagePrompt()} type="button">
                  <Clipboard size={15} />
                  {busyId === `prompt:${preview.id}` ? "保存中" : "保存提示词"}
                </button>
                <button className="packagePrimaryAction" disabled={busyId === `image:${preview.id}`} onClick={() => void generateImage()} type="button">
                  <RefreshCw size={15} />
                  {busyId === `image:${preview.id}` ? "生成中" : "重新生成"}
                </button>
                <button className="ghost x-icon-button" onClick={() => setPreview(null)} aria-label="关闭">
                  <X size={18} />
                </button>
              </div>
            </div>
            {modalNotice ? <div className="packageModalNotice" role="status"><CheckCircle2 size={16} />{modalNotice}</div> : null}
            {preview.dataUrl ? <img src={preview.dataUrl} alt={preview.label || preview.title || preview.id} /> : <EmptyState text="该素材没有可预览的数据。" />}
            {preview.filePath ? (
              <div className="packagePreviewFile">
                <span>图片文件</span>
                <p>{preview.filePath}</p>
                <button className="packageTextTool" onClick={() => void copyText(preview.filePath || "", "图片文件路径", "modal")} type="button">
                  <Clipboard size={14} />
                  复制路径
                </button>
              </div>
            ) : null}
            <div className="packagePreviewPrompt">
              <div>
                <span>提示词</span>
                <button className="packageTextTool" onClick={() => void copyText(promptDraft, "图片提示词", "modal")} type="button">
                  <Clipboard size={14} />
                  复制
                </button>
              </div>
              <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} placeholder="为这张素材补充或调整图片生成提示词" />
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
