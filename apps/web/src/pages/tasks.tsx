import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Eye, Inbox, RotateCcw, Send, Trash2, X } from "lucide-react";
import type { LocalTaskItem, ModelCall, TaskStep } from "../types";
import { deleteJson, postJson } from "../lib/api";
import {
  cleanText,
  compactText,
  contentWorkflowName,
  cx,
  elapsedMs,
  formatDate,
  formatDuration,
  readableStepMessage,
  statusText,
  stepInput,
  stepName,
  stepOutput,
  taskDisplayTitle,
  taskEntryLabel,
  taskInputText,
  taskStatusClass,
  taskStepMetaText,
} from "../lib/utils";
import { EmptyState, PageTitle } from "../components/common";

type TaskAction = "retry" | "cancel" | "delete";
type TaskFilter = "all" | "active" | "failed" | "succeeded";
type SourceFilter = "all" | string;
type CallUsageSummary = {
  calls: number;
  textCalls: number;
  imageCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

const FINISHED = new Set(["succeeded", "completed", "done"]);
const ACTIVE = new Set(["queued", "running", "processing"]);
const FAILED = new Set(["failed", "error"]);
const FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "运行中" },
  { id: "failed", label: "失败" },
  { id: "succeeded", label: "已完成" },
];
const PAGE_SIZE = 8;

export function TasksView({
  tasks,
  onReload,
  onOpenPackages,
  modelConfigured,
  handoffNotice,
  onHandoffNoticeConsumed,
}: {
  tasks: LocalTaskItem[];
  onReload: () => Promise<void>;
  onOpenPackages: () => void;
  modelConfigured: boolean;
  handoffNotice?: string;
  onHandoffNoticeConsumed?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedStep, setSelectedStep] = useState<{ task: LocalTaskItem; step: TaskStep; index: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LocalTaskItem | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);

  const baseTasks = useMemo(
    () => tasks.filter((task) => !["canceled", "cancelled"].includes(String(task.status).toLowerCase())),
    [tasks],
  );

  const taskCounts = useMemo(() => {
    return baseTasks.reduce(
      (counts, task) => {
        const status = normalizeStatus(task.status);
        counts.all += 1;
        if (ACTIVE.has(status)) counts.active += 1;
        else if (FAILED.has(status)) counts.failed += 1;
        else if (FINISHED.has(status)) counts.succeeded += 1;
        return counts;
      },
      { all: 0, active: 0, failed: 0, succeeded: 0 } as Record<TaskFilter, number>,
    );
  }, [baseTasks]);

  const sourceOptions = useMemo(() => {
    const map = new Map<string, string>();
    baseTasks.forEach((task) => {
      const source = String(task.entryType || task.source || "local");
      map.set(source, taskEntryLabel(task));
    });
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [baseTasks]);

  const filteredTasks = useMemo(() => {
    return baseTasks.filter((task) => {
      const status = normalizeStatus(task.status);
      const source = String(task.entryType || task.source || "local");
      const statusMatched =
        statusFilter === "all" ||
        (statusFilter === "active" && ACTIVE.has(status)) ||
        (statusFilter === "failed" && FAILED.has(status)) ||
        (statusFilter === "succeeded" && FINISHED.has(status));
      const sourceMatched = sourceFilter === "all" || sourceFilter === source;
      return statusMatched && sourceMatched;
    });
  }, [baseTasks, sourceFilter, statusFilter]);
  const hasActiveTasks = useMemo(() => baseTasks.some((task) => ACTIVE.has(normalizeStatus(task.status))), [baseTasks]);

  const totalPages = Math.max(1, Math.ceil(filteredTasks.length / PAGE_SIZE));
  const visibleTasks = useMemo(() => {
    const safePage = Math.min(page, totalPages);
    return filteredTasks.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [filteredTasks, page, totalPages]);

  useEffect(() => {
    setPage(1);
  }, [sourceFilter, statusFilter]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!handoffNotice) return;
    setNotice(handoffNotice);
    onHandoffNoticeConsumed?.();
  }, [handoffNotice, onHandoffNoticeConsumed]);

  useEffect(() => {
    if (!hasActiveTasks) return;
    const timer = window.setInterval(() => {
      void onReload().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setOperationError(message || "任务状态刷新失败。");
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks, onReload]);

  async function createTask() {
    if (!draft.trim()) return;
    if (!modelConfigured) {
      setOperationError("请先在设置中心配置任务模型 API，再创建内容任务。");
      return;
    }
    setBusyId("new");
    setOperationError("");
    try {
      await postJson("/api/local/tasks", { inputText: draft.trim(), entryType: "web" });
      setDraft("");
      await onReload();
      setStatusFilter("active");
      setSourceFilter("all");
      setPage(1);
      setNotice("任务已创建，正在进入执行队列");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOperationError(message || "创建任务失败，请稍后重试。");
    } finally {
      setBusyId("");
    }
  }

  async function runAction(id: string, action: TaskAction) {
    setBusyId(`${action}:${id}`);
    if (action === "delete") setDeleteError("");
    else setOperationError("");
    try {
      if (action === "delete") await deleteJson(`/api/local/tasks/${encodeURIComponent(id)}`);
      else await postJson(`/api/local/tasks/${encodeURIComponent(id)}/${action}`);
      await onReload();
      if (action === "delete") {
        setDeleteTarget(null);
        setNotice("任务运行记录已删除");
      } else if (action === "cancel") {
        setNotice("任务已取消");
      } else if (action === "retry") {
        setNotice("任务已重新加入队列");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (action === "delete") setDeleteError(message || "删除失败，请稍后重试。");
      else setOperationError(message || "操作失败，请稍后重试。");
    } finally {
      setBusyId("");
    }
  }

  function toggleTask(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="pageStack tasksPage">
      <PageTitle group="工作台" title="任务中心" desc="创建和查看本地内容任务，跟踪执行进度、异常提示和生成结果。" />

      <section className="panel taskComposerPro">
        <div className="taskComposerHead">
          <div>
            <span>创建任务</span>
            <h2>生成一套内容发布包</h2>
          </div>
          <p>输入主题、素材或业务需求后，任务会进入本地流程，并在下方持续更新执行进度。</p>
        </div>
        {!modelConfigured ? (
          <div className="x-api-error">任务模型 API 未配置。请先打开右上角“设置”，填写任务模型 Provider、模型、Base URL 和 API Key。</div>
        ) : null}
        <div className="taskComposerBody">
          <label className="taskComposerInput">
            <span>任务需求</span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void createTask();
                }
              }}
              placeholder="例如：围绕某条情报生成一套内容发布包；或粘贴素材、选题、返工要求..."
            />
          </label>
          <div className="taskComposerAction">
            <button className="primary taskCreateButton" onClick={createTask} disabled={!modelConfigured || !draft.trim() || busyId === "new"}>
              <Send size={16} />
              创建任务
            </button>
            <small>Ctrl + Enter</small>
          </div>
        </div>
        <div className="taskComposerTips">
          <span>建议包含：主题 / 目标人群 / 内容方向 / 特殊要求</span>
          <span>{draft.trim().length ? `${draft.trim().length} 字` : "等待输入"}</span>
        </div>
      </section>

      <section className="taskFilterBar" aria-label="任务筛选">
        <div className="taskFilterMain">
          <span className="taskFilterTitle">任务列表</span>
          <div className="taskFilterGroup">
            {FILTERS.map((filter) => (
              <button
                className={cx("taskFilterButton", statusFilter === filter.id && "selected")}
                key={filter.id}
                onClick={() => {
                  setStatusFilter(filter.id);
                  setPage(1);
                }}
                type="button"
              >
                {filter.label}
                <span>{taskCounts[filter.id]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="taskSourceFilter">
          {hasActiveTasks ? <span className="taskLiveBadge">自动刷新中</span> : null}
          <span className="taskSourceLabel">来源</span>
          <select
            value={sourceFilter}
            onChange={(event) => {
              setSourceFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">全部来源</option>
            {sourceOptions.map((option) => (
              <option value={option.id} key={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="taskList">
        {visibleTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            busy={busyId.endsWith(task.id)}
            expanded={expandedIds.has(task.id)}
            onAction={runAction}
            onOpenPackages={onOpenPackages}
            onOpenStep={(step, index) => setSelectedStep({ task, step, index })}
            onRequestDelete={() => {
              setDeleteError("");
              setDeleteTarget(task);
            }}
            onToggle={() => toggleTask(task.id)}
          />
        ))}
        {!visibleTasks.length ? <TaskEmptyState filtered={filteredTasks.length !== baseTasks.length || statusFilter !== "all" || sourceFilter !== "all"} /> : null}
      </section>

      <section className="taskPagerBar" aria-label="任务分页">
        <span className="taskPagerSummary">
          显示 {visibleTasks.length} 条，筛选后 {filteredTasks.length} 条，共 {baseTasks.length} 条
          <small>每页 {PAGE_SIZE} 条</small>
        </span>
        <div className="taskPagerControls">
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
      </section>

      {selectedStep ? (
        <TaskStepModal task={selectedStep.task} step={selectedStep.step} index={selectedStep.index} onClose={() => setSelectedStep(null)} />
      ) : null}
      {deleteTarget ? (
        <DeleteTaskDialog
          busy={busyId === `delete:${deleteTarget.id}`}
          error={deleteError}
          task={deleteTarget}
          onCancel={() => {
            setDeleteError("");
            setDeleteTarget(null);
          }}
          onConfirm={() => runAction(deleteTarget.id, "delete")}
        />
      ) : null}
      {operationError ? <TaskErrorDialog message={operationError} onClose={() => setOperationError("")} /> : null}
      {notice ? (
        <div className="taskToast" role="status">
          {notice}
        </div>
      ) : null}
    </main>
  );
}

function normalizeStatus(status?: string) {
  return taskStatusClass(status);
}

function hasFinished(status?: string) {
  return FINISHED.has(normalizeStatus(status));
}

function taskDuration(task: LocalTaskItem) {
  const status = normalizeStatus(task.status);
  return (
    task.durationMs ??
    elapsedMs(task.startedAt || task.createdAt, task.completedAt || (ACTIVE.has(status) ? undefined : task.updatedAt))
  );
}

function formatTokenCount(value?: number) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  return Math.round(number).toLocaleString("zh-CN");
}

function callUsageLabel(call: ModelCall) {
  const total = Number(call.totalTokens || 0);
  if (total > 0) return `${formatTokenCount(total)} token`;
  return isImageModelCall(call) ? "图片调用" : "0 token";
}

function taskModelCalls(task: LocalTaskItem) {
  return Array.isArray(task.modelCalls) ? task.modelCalls : [];
}

function isImageModelCall(call: ModelCall) {
  if (call.callType === "image") return true;
  return /^\[image\]/i.test(String(call.purpose || ""));
}

function summarizeModelCallList(calls: ModelCall[]) {
  return calls.reduce<CallUsageSummary>(
    (summary, call) => {
      summary.calls += 1;
      if (isImageModelCall(call)) summary.imageCalls += 1;
      else summary.textCalls += 1;
      summary.promptTokens += Number(call.promptTokens || 0);
      summary.completionTokens += Number(call.completionTokens || 0);
      summary.totalTokens += Number(call.totalTokens || 0);
      return summary;
    },
    { calls: 0, textCalls: 0, imageCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}

function taskUsageSummary(task: LocalTaskItem) {
  const calls = taskModelCalls(task);
  const computed = summarizeModelCallList(calls);
  return {
    calls: Math.max(Number(task.modelUsage?.calls || 0), computed.calls),
    textCalls: Math.max(Number(task.modelUsage?.textCalls || 0), computed.textCalls),
    imageCalls: Math.max(Number(task.modelUsage?.imageCalls || 0), computed.imageCalls),
    promptTokens: Math.max(Number(task.modelUsage?.promptTokens || 0), computed.promptTokens),
    completionTokens: Math.max(Number(task.modelUsage?.completionTokens || 0), computed.completionTokens),
    totalTokens: Math.max(Number(task.modelUsage?.totalTokens || 0), computed.totalTokens),
  };
}

function usageBrief(calls: ModelCall[]) {
  const summary = summarizeModelCallList(calls);
  if (!summary.calls) return "";
  const parts = [];
  if (summary.textCalls) parts.push(`文字 ${summary.textCalls} 次`);
  if (summary.imageCalls) parts.push(`图片 ${summary.imageCalls} 次`);
  if (summary.totalTokens) parts.push(`${formatTokenCount(summary.totalTokens)} token`);
  return parts.join(" · ");
}

function modelCallsForStep(task: LocalTaskItem, step: TaskStep) {
  return taskModelCalls(task).filter((call) => {
    if (call.stepId && step.id && call.stepId === step.id) return true;
    if (call.stepId) return false;
    const purpose = String(call.purpose || "");
    const stepKey = String(step.stepKey || step.key || "");
    if (stepKey === "strategy" && /情报|素材|筛选|机会评分|策略/.test(purpose)) return true;
    if (stepKey === "structure" && /需求|结构化/.test(purpose)) return true;
    if (stepKey === "plan" && /方案|大纲|规划/.test(purpose)) return true;
    if (stepKey === "generate" && /生成|初稿|发布包/.test(purpose)) return true;
    if (stepKey === "review" && /质检|质量|门禁|检查|复核/.test(purpose)) return true;
    return false;
  });
}

function needsSummaryToggle(text: string) {
  const value = String(text || "");
  return value.length > 180 || value.split(/\r?\n/).length > 4;
}

function primaryStep(task: LocalTaskItem) {
  const steps = task.steps || [];
  return (
    steps.find((step) => FAILED.has(normalizeStatus(step.status))) ||
    steps.find((step) => ACTIVE.has(normalizeStatus(step.status))) ||
    [...steps].reverse().find((step) => hasFinished(step.status)) ||
    steps[0]
  );
}

export function TaskCard({
  task,
  busy,
  expanded,
  onAction,
  onRequestDelete,
  onOpenStep,
  onOpenPackages,
  onToggle,
}: {
  task: LocalTaskItem;
  busy: boolean;
  expanded: boolean;
  onAction: (id: string, action: TaskAction) => void;
  onRequestDelete: () => void;
  onOpenStep: (step: TaskStep, index: number) => void;
  onOpenPackages: () => void;
  onToggle: () => void;
}) {
  const steps = task.steps || [];
  const status = normalizeStatus(task.status);
  const canCancel = ACTIVE.has(status);
  const canRetry = FAILED.has(status);
  const duration = taskDuration(task);
  const input = taskInputText(task);
  const title = taskDisplayTitle(task);
  const highlightStep = primaryStep(task);
  const highlightIndex = highlightStep ? steps.indexOf(highlightStep) : -1;
  const completedCount = steps.filter((step) => hasFinished(step.status)).length;
  const progressText = steps.length ? `${completedCount}/${steps.length} 个步骤` : "等待执行";
  const statusLabel = statusText(task.status);
  const summary = highlightStep ? readableStepMessage(highlightStep, task) : compactText(input, 120) || "等待进入执行流程";
  const showResult = hasFinished(status) && task.packageId;
  const showProgress = expanded || !hasFinished(status) || FAILED.has(status);
  const showCurrentLine = expanded || !hasFinished(status) || !showResult;
  const currentTitle = FAILED.has(status) ? "异常环节" : hasFinished(status) ? "任务结果" : highlightStep ? "当前环节" : "任务状态";
  const showDelete = status !== "running";
  const isCanceling = busy && canCancel;
  const isRetrying = busy && canRetry;
  const visibleTraceSteps = steps.slice(0, 4);
  const remainingTraceSteps = steps.slice(4);
  const usage = taskUsageSummary(task);

  return (
    <article className={cx("taskCardPro", `taskCardPro-${status}`, expanded && "isExpanded", busy && "isBusy")}>
      <header className="taskCardProHeader">
        <button className="taskCardToggle" onClick={onToggle} type="button" aria-label={expanded ? "收起任务" : "展开任务"}>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="taskCardIdentity">
          <span className="taskTypeLabel">{task.entryType === "rework" ? "复核返工" : contentWorkflowName(task.workflowName) || "内容任务"}</span>
          <h3>{title}</h3>
          <p>{compactText(input, expanded ? 220 : 96) || "没有输入摘要"}</p>
          <div className="taskMetaLine">
            <span>{taskEntryLabel(task)}</span>
            <span>{formatDate(task.createdAt)}</span>
            {task.packageId ? <span>发布包 {task.packageId.slice(0, 10)}</span> : null}
          </div>
          {usage.calls ? (
            <div className="taskUsageLine" aria-label="任务消耗概览">
              <span>调用 <strong>{usage.calls}</strong> 次</span>
              <span>Token <strong>{formatTokenCount(usage.totalTokens)}</strong></span>
              <span>文字 <strong>{usage.textCalls}</strong> 次</span>
              <span>图片 <strong>{usage.imageCalls}</strong> 次</span>
            </div>
          ) : null}
        </div>

        <div className="taskCardSummary">
          <div className={cx("taskDurationBadge", status)}>
            <span>{statusLabel}</span>
            <strong>{formatDuration(duration)}</strong>
          </div>
          <div className="taskActionBar">
            {showResult && expanded ? (
              <button className="inlineAction" onClick={onOpenPackages}>
                <Eye size={14} />
                查看发布包
              </button>
            ) : null}
            {canCancel ? (
              <button className="inlineAction" disabled={busy} onClick={() => onAction(task.id, "cancel")}>
                {isCanceling ? "取消中" : "取消"}
              </button>
            ) : null}
            {canRetry ? (
              <button className="inlineAction" disabled={busy} onClick={() => onAction(task.id, "retry")}>
                <RotateCcw size={14} />
                {isRetrying ? "加入中" : "重新生成"}
              </button>
            ) : null}
            {showDelete ? (
              <button className="inlineAction dangerAction" disabled={busy} onClick={onRequestDelete}>
                <Trash2 size={14} />
                删除
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {showCurrentLine ? (
        <section className="taskCurrentLine">
          <span>{currentTitle}</span>
          <p>{summary}</p>
          <small>{progressText}</small>
        </section>
      ) : null}

      {showProgress ? <StepRail task={task} steps={steps} onOpenStep={onOpenStep} /> : null}

      {showResult && !expanded ? (
        <section className="taskResultLine">
          <span>发布包已生成，可在发布包中心查看。</span>
          <button className="inlineAction" onClick={onOpenPackages}>
            <Eye size={14} />
            查看发布包
          </button>
        </section>
      ) : null}

      {expanded ? (
        <section className="taskDetailArea">
          <div className="taskDetailHead">
            <div>
              <strong>执行明细</strong>
              <p>按业务步骤查看每一环的输入、输出和用时。</p>
            </div>
            {steps.length > 4 ? <span>共 {steps.length} 步</span> : null}
          </div>
          {steps.length ? (
            <div className="taskStepTrace">
              {visibleTraceSteps.map((step, index) => (
                <div className={cx("taskStepTraceRow", normalizeStatus(step.status))} key={`${step.id || step.key || index}-trace`}>
                  <span>
                    <button className="stepLink" onClick={() => onOpenStep(step, index)} type="button">
                      {stepName(step, index)}
                    </button>
                  </span>
                  <p>{readableStepMessage(step, task)}</p>
                  <small>{[taskStepMetaText(step), usageBrief(modelCallsForStep(task, step))].filter(Boolean).join(" · ")}</small>
                  <button className="taskStepDetailButton" onClick={() => onOpenStep(step, index)} type="button">
                    详情
                  </button>
                  <StepModelCallsInlineLite calls={modelCallsForStep(task, step)} />
                </div>
              ))}
              {remainingTraceSteps.length ? (
                <details className="taskTraceMore">
                  <summary>
                    <span className="traceMoreClosed">展开查看剩余 {remainingTraceSteps.length} 个步骤</span>
                    <span className="traceMoreOpen">收起剩余 {remainingTraceSteps.length} 个步骤</span>
                  </summary>
                  <div className="taskTraceMoreRows">
                    {remainingTraceSteps.map((step, offset) => {
                      const index = offset + visibleTraceSteps.length;
                      return (
                        <div className={cx("taskStepTraceRow", normalizeStatus(step.status))} key={`${step.id || step.key || index}-trace-more`}>
                          <span>
                            <button className="stepLink" onClick={() => onOpenStep(step, index)} type="button">
                              {stepName(step, index)}
                            </button>
                          </span>
                          <p>{readableStepMessage(step, task)}</p>
                          <small>{[taskStepMetaText(step), usageBrief(modelCallsForStep(task, step))].filter(Boolean).join(" · ")}</small>
                          <button className="taskStepDetailButton" onClick={() => onOpenStep(step, index)} type="button">
                            详情
                          </button>
                          <StepModelCallsInlineLite calls={modelCallsForStep(task, step)} />
                        </div>
                      );
                    })}
                  </div>
                </details>
              ) : null}
            </div>
          ) : (
            <EmptyState text="暂无执行步骤" />
          )}
        </section>
      ) : null}

      {task.error ? (
        <div className="taskErrorHint">
          <AlertTriangle size={16} />
          <div>
            <strong>任务执行失败</strong>
            <span>{cleanText(task.error, "任务执行失败，请查看步骤详情。")}</span>
          </div>
          {canRetry ? (
            <button className="inlineAction" disabled={busy} onClick={() => onAction(task.id, "retry")}>
              <RotateCcw size={14} />
              重新生成
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function StepRail({ task, steps, onOpenStep }: { task: LocalTaskItem; steps: TaskStep[]; onOpenStep: (step: TaskStep, index: number) => void }) {
  if (!steps.length) return null;
  return (
    <div className="taskProgressPro" aria-label="任务流程进度">
      {steps.map((step, index) => (
        <div key={step.id || step.key || index} className={cx("progressStepPro", normalizeStatus(step.status))}>
          <span className="progressDot">{index + 1}</span>
          <button className="stepLink" onClick={() => onOpenStep(step, index)} type="button">
            {stepName(step, index)}
          </button>
          <small title={readableStepMessage(step, task)}>{taskStepMetaText(step)}</small>
        </div>
      ))}
    </div>
  );
}

export function TaskEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="taskEmptyState">
      <span className="taskEmptyIcon">
        <Inbox size={20} />
      </span>
      <strong>{filtered ? "当前筛选下没有任务" : "还没有本地任务"}</strong>
      <p>{filtered ? "可以切换筛选条件，或回到全部任务查看历史记录。" : "从上方输入主题、素材或业务需求，也可以从情报库生成内容任务。"}</p>
    </div>
  );
}

export function StepModelCallsInlineLite({ calls }: { calls: ModelCall[] }) {
  if (!calls.length) return null;
  return (
    <div className="taskStepTokenLite">
      {calls.map((call) => (
        <span key={call.id || `${call.createdAt}-${call.purpose}`}>
          <strong>{callUsageLabel(call)}</strong>
          <em>{call.purpose || (isImageModelCall(call) ? "图片调用" : "文字调用")}</em>
          <small>{[call.model || "", formatDuration(call.durationMs || 0)].filter(Boolean).join(" / ")}</small>
        </span>
      ))}
    </div>
  );
}

export function StepModelCallsInline({ calls }: { calls: ModelCall[] }) {
  if (!calls.length) return null;
  const promptTokens = calls.reduce((total, call) => total + Number(call.promptTokens || 0), 0);
  const completionTokens = calls.reduce((total, call) => total + Number(call.completionTokens || 0), 0);
  const totalTokens = calls.reduce((total, call) => total + Number(call.totalTokens || 0), 0);
  return (
    <div className="taskStepTokenCalls">
      <div className="taskStepTokenSummary">
        <span>模型调用 {calls.length} 次</span>
        <strong>{formatTokenCount(totalTokens)} token</strong>
        <small>输入 {formatTokenCount(promptTokens)} / 输出 {formatTokenCount(completionTokens)}</small>
      </div>
      <div className="taskStepTokenRows">
        {calls.map((call) => (
          <div className="taskStepTokenRow" key={call.id || `${call.createdAt}-${call.purpose}`}>
            <span>{call.purpose || "模型调用"}</span>
            <small>{call.provider || "provider"} / {call.model || "model"} / {formatDuration(call.durationMs || 0)}</small>
            <strong>{callUsageLabel(call)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DeleteTaskDialog({
  task,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  task: LocalTaskItem;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modalBackdrop detailBackdrop" role="presentation" onMouseDown={onCancel}>
      <section className="modalPanel deleteTaskDialog" role="dialog" aria-modal="true" aria-label="删除任务记录" onMouseDown={(event) => event.stopPropagation()}>
        <div className="deleteTaskIcon">
          <Trash2 size={18} />
        </div>
        <div className="deleteTaskContent">
          <h2>删除任务运行记录</h2>
          <p>这只会从任务中心移除该任务的运行记录和步骤日志，不会删除已生成的发布包、本地文件、情报或知识库内容。</p>
          <div className="deleteTaskPreview">
            <span>{taskDisplayTitle(task)}</span>
            <small>{formatDate(task.createdAt)}</small>
          </div>
          {error ? <div className="deleteTaskError">{error}</div> : null}
        </div>
        <div className="deleteTaskActions">
          <button className="inlineAction" onClick={onCancel} disabled={busy} type="button">
            取消
          </button>
          <button className="inlineAction dangerAction deleteConfirmButton" onClick={onConfirm} disabled={busy} type="button">
            <Trash2 size={14} />
            {busy ? "删除中" : "确认删除"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function TaskErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="modalBackdrop detailBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="modalPanel taskErrorDialog" role="alertdialog" aria-modal="true" aria-label="任务操作失败" onMouseDown={(event) => event.stopPropagation()}>
        <div className="deleteTaskIcon taskErrorIcon">
          <X size={18} />
        </div>
        <div className="deleteTaskContent">
          <h2>操作失败</h2>
          <p>{message}</p>
        </div>
        <div className="deleteTaskActions">
          <button className="inlineAction" onClick={onClose} type="button">
            知道了
          </button>
        </div>
      </section>
    </div>
  );
}

export function TaskStepModal({ task, step, index, onClose }: { task: LocalTaskItem; step: TaskStep; index: number; onClose: () => void }) {
  const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set());
  const input = stepInput(step, task);
  const output = stepOutput(step);
  const rawStatus = String(step.status || "").toLowerCase();
  const inputFallback = rawStatus === "pending" ? "等待上一环节输出。" : "暂无输入记录。";
  const outputFallback = rawStatus === "pending" ? "等待执行。" : "暂无输出记录。";
  const inputText = input || inputFallback;
  const outputText = output || outputFallback;
  const durationText = taskStepMetaText(step);
  const startedAt = formatDate(step.startedAt);
  const completedAt = formatDate(step.completedAt);
  const stepModelCalls = taskModelCalls(task).filter((call) => call.stepId && step.id && call.stepId === step.id);
  const stepPromptTokens = stepModelCalls.reduce((total, call) => total + Number(call.promptTokens || 0), 0);
  const stepCompletionTokens = stepModelCalls.reduce((total, call) => total + Number(call.completionTokens || 0), 0);
  const stepTotalTokens = stepModelCalls.reduce((total, call) => total + Number(call.totalTokens || 0), 0);
  const metaText = [
    statusText(step.status),
    durationText,
    startedAt ? `开始 ${startedAt}` : "",
    completedAt ? `结束 ${completedAt}` : "",
  ].filter(Boolean).join(" / ");
  function toggleSummary(id: string) {
    setExpandedSummaries((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const inputExpanded = expandedSummaries.has("input");
  const outputExpanded = expandedSummaries.has("output");
  const inputCanExpand = needsSummaryToggle(inputText);
  const outputCanExpand = needsSummaryToggle(outputText);
  return (
    <div className="modalBackdrop detailBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="modalPanel taskStepDetailPanel" role="dialog" aria-modal="true" aria-label="步骤详情" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modalHead">
          <div>
            <h2>{stepName(step, index)}</h2>
            <p>{taskDisplayTitle(task)} / {metaText}</p>
          </div>
          <button className="iconButton" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="taskStepDetailBody">
          <div className="taskStepSummaryGrid">
            <div className="taskStepSummaryCard">
              <div className="taskStepSectionHead">
                <h3>输入摘要</h3>
                {inputCanExpand ? <button type="button" onClick={() => toggleSummary("input")}>{inputExpanded ? "收起" : "展开"}</button> : null}
              </div>
              <p className={cx(inputCanExpand && !inputExpanded && "isCollapsed", inputExpanded && "isExpanded")}>{cleanText(inputText, inputFallback)}</p>
            </div>
            <div className="taskStepSummaryCard">
              <div className="taskStepSectionHead">
                <h3>输出摘要</h3>
                {outputCanExpand ? <button type="button" onClick={() => toggleSummary("output")}>{outputExpanded ? "收起" : "展开"}</button> : null}
              </div>
              <p className={cx(outputCanExpand && !outputExpanded && "isCollapsed", outputExpanded && "isExpanded")}>{cleanText(outputText, outputFallback)}</p>
            </div>
          </div>
          {step.error ? (
            <div className="taskStepErrorCard">
              <h3>错误信息</h3>
              <p>{cleanText(step.error, "该步骤执行失败。")}</p>
            </div>
          ) : null}
          {stepModelCalls.length ? (
            <div className="taskTokenPanel">
              <div className="taskTokenPanelHead">
                <h3>模型消耗</h3>
                <span>
                  {stepModelCalls.length} 次 / 输入 {formatTokenCount(stepPromptTokens)} / 输出 {formatTokenCount(stepCompletionTokens)} / 合计 {formatTokenCount(stepTotalTokens)} token
                </span>
              </div>
              <div className="taskTokenCallList">
                {stepModelCalls.map((call) => (
                  <div className="taskTokenCall" key={call.id || `${call.createdAt}-${call.purpose}`}>
                    <span>{call.purpose || "模型调用"}</span>
                    <small>{call.provider || "provider"} / {call.model || "model"} / {formatDuration(call.durationMs || 0)}</small>
                    <strong>{callUsageLabel(call)}</strong>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
