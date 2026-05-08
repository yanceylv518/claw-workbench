import { useMemo, useState } from "react";
import { Activity, AlertTriangle, Bug, Clock3, FileText, RefreshCcw, Search, Server, ShieldCheck } from "lucide-react";
import type { LogLine, LogSource, LogsPayload } from "../types";
import { cx, formatDate } from "../lib/utils";
import { PageTitle } from "../components/common";

function normalizeLines(logs: LogsPayload | null): LogLine[] {
  if (!logs) return [];
  if (Array.isArray(logs)) return logs.map((message, index) => ({ id: `legacy-${index}`, message: String(message), level: "default", sourceName: "旧日志" }));
  if (typeof logs === "string") return logs.split(/\r?\n/).filter(Boolean).map((message, index) => ({ id: `text-${index}`, message, level: "default", sourceName: "旧日志" }));
  if (Array.isArray(logs.lines) && logs.lines.length && typeof logs.lines[0] === "object") return logs.lines;
  const legacyLines = [...(Array.isArray(logs.lines) ? logs.lines : []), ...(logs.logs || [])];
  if (legacyLines.length) return legacyLines.map((message, index) => ({ id: `legacy-${index}`, message: String(message), level: "default", sourceName: "旧日志" }));
  return logs.text ? [{ id: "text", message: logs.text, level: "default", sourceName: "旧日志" }] : [];
}

function normalizeSources(logs: LogsPayload | null): LogSource[] {
  if (!logs || Array.isArray(logs) || typeof logs === "string") return [];
  return Array.isArray(logs.sources) ? logs.sources : [];
}

function levelLabel(level?: string) {
  if (level === "error") return "错误";
  if (level === "warn") return "警告";
  if (level === "info") return "信息";
  if (level === "debug") return "调试";
  return "普通";
}

function formatBytes(value?: number) {
  const size = Number(value || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function rawMessage(lines: LogLine[]) {
  return lines.map((line) => line.message || "").join("\n");
}

export function LogsView({ logs }: { logs: LogsPayload | null }) {
  const [level, setLevel] = useState("all");
  const [sourceId, setSourceId] = useState("all");
  const [query, setQuery] = useState("");
  const [rawMode, setRawMode] = useState(false);

  const lines = useMemo(() => normalizeLines(logs), [logs]);
  const sources = useMemo(() => normalizeSources(logs), [logs]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((line) => {
      if (level !== "all" && line.level !== level) return false;
      if (sourceId !== "all" && line.sourceId !== sourceId) return false;
      if (!q) return true;
      return `${line.message || ""} ${line.sourceName || ""} ${line.kind || ""}`.toLowerCase().includes(q);
    });
  }, [lines, level, sourceId, query]);

  const summary = !logs || Array.isArray(logs) || typeof logs === "string" ? null : logs.summary;
  const latestAt = summary?.latestAt || filtered[0]?.time || "";

  return (
    <main className="pageStack x-page logsPage">
      <PageTitle
        group="系统"
        title="系统日志"
        desc="查看本地 API、微信 Bridge、情报晨报和发布预填相关日志。"
        right={<span className="logsUpdated"><Clock3 size={15} />{formatDate(!logs || Array.isArray(logs) || typeof logs === "string" ? "" : logs.updatedAt)}</span>}
      />

      <section className="logsMetricGrid" aria-label="日志概览">
        <div className="logsMetric"><Server size={18} /><span>活跃来源</span><strong>{summary?.activeSources ?? sources.filter((item) => item.exists && item.size).length}</strong></div>
        <div className="logsMetric"><FileText size={18} /><span>日志行数</span><strong>{summary?.totalLines ?? lines.length}</strong></div>
        <div className="logsMetric logsMetricWarn"><AlertTriangle size={18} /><span>警告</span><strong>{summary?.warnings ?? lines.filter((item) => item.level === "warn").length}</strong></div>
        <div className="logsMetric logsMetricError"><Bug size={18} /><span>错误</span><strong>{summary?.errors ?? lines.filter((item) => item.level === "error").length}</strong></div>
      </section>

      <section className="logsSourcePanel x-panel">
        <div className="logsSectionHead">
          <span><ShieldCheck size={16} />日志来源</span>
          <p>只读取关键运行日志和最近片段，不扫描浏览器缓存日志。</p>
        </div>
        <div className="logsSourceGrid">
          {sources.length ? sources.map((source) => (
            <button
              className={cx("logsSourceCard", sourceId === source.id && "selected")}
              key={source.id || source.path}
              onClick={() => setSourceId(sourceId === source.id ? "all" : String(source.id || "all"))}
              type="button"
            >
              <span>{source.name}</span>
              <strong>{source.exists ? formatBytes(source.size) : "未找到"}</strong>
              <small>{source.exists ? `已载入 ${source.loadedLineCount ?? 0} 行 · ${formatDate(source.updatedAt)}` : source.path}</small>
            </button>
          )) : <p className="logsEmptyText">暂无日志来源。</p>}
        </div>
      </section>

      <section className="logsToolbar x-panel">
        <div className="logsSearch">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志内容、来源或关键字" />
        </div>
        <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="日志级别">
          <option value="all">全部级别</option>
          <option value="error">错误</option>
          <option value="warn">警告</option>
          <option value="info">信息</option>
          <option value="debug">调试</option>
          <option value="default">普通</option>
        </select>
        <button className="x-secondary" type="button" onClick={() => setRawMode((value) => !value)}>
          <RefreshCcw size={15} />
          {rawMode ? "结构视图" : "原始视图"}
        </button>
      </section>

      <section className="logsBody x-panel">
        <div className="logsBodyHead">
          <span><Activity size={16} />匹配日志 {filtered.length} 行</span>
          <small>最近时间：{formatDate(latestAt)}</small>
        </div>
        {rawMode ? (
          <pre className="logsRaw">{rawMessage(filtered) || "暂无日志"}</pre>
        ) : filtered.length ? (
          <div className="logsList">
            {filtered.map((line, index) => (
              <article className={cx("logRow", `logRow-${line.level || "default"}`)} key={line.id || `${line.sourceId}-${index}`}>
                <div>
                  <span>{line.sourceName || "系统"}</span>
                  <strong>{levelLabel(line.level)}</strong>
                </div>
                <p>{line.message}</p>
                <time>{formatDate(line.time)}</time>
              </article>
            ))}
          </div>
        ) : (
          <p className="logsEmptyText">没有符合当前筛选条件的日志。</p>
        )}
      </section>
    </main>
  );
}
