import type { LocalTaskItem, TaskStep } from "../types";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function cleanText(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const replacementPattern = /[\uFFFD\u951F\u62F7]/;
  const mojibakePattern = /[\u9359\u6D60\u6769\u4E36\u9428\u7EDB\u93C2\u93CD\u7199\u8FBB\u93B4\u7039\u59DD\u5BF0\u53C6\u5F42\u7AF4]/;
  if (replacementPattern.test(text) || mojibakePattern.test(text) || /\?{5,}/.test(text)) return fallback;
  return text;
}

export function formatDate(value?: string) {
  const text = cleanText(value);
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatDuration(ms?: number) {
  if (!ms || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function elapsedMs(start?: string, end?: string) {
  if (!start) return undefined;
  const startTime = Date.parse(start);
  const endTime = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return undefined;
  return endTime - startTime;
}

export function compact(value: unknown, fallback = "暂无内容") {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") return cleanText(value, fallback);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

export function compactText(value?: string, max = 130) {
  const text = cleanText(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
}

export function statusText(status?: string) {
  const raw = String(status || "").toLowerCase();
  const map: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    processing: "处理中",
    completed: "已完成",
    done: "已完成",
    succeeded: "已完成",
    failed: "失败",
    error: "失败",
    canceled: "已取消",
    cancelled: "已取消",
    review: "待检查",
    pending: "等待中",
    archived: "已归档",
    disabled: "已停用",
    enabled: "已启用",
    online: "在线",
    available: "可用",
    configured: "已配置",
  };
  return map[raw] || cleanText(status, "未标记");
}

export function taskTitle(task: LocalTaskItem) {
  return contentWorkflowName(task.workflowName) || cleanText(task.title) || "内容发布包生成";
}

export function taskInputText(task: LocalTaskItem) {
  return cleanText(task.inputText) || compact(task.input, "");
}

export function taskDisplayTitle(task: LocalTaskItem) {
  const input = taskInputText(task);
  const titleMatch = input.match(/标题[:：]\s*([^\n]+)/);
  if (task.entryType === "rework") return titleMatch?.[1] ? `复核返工：${titleMatch[1].slice(0, 34)}` : "复核返工任务";
  return cleanText(titleMatch?.[1]) || cleanText(task.title) || contentWorkflowName(task.workflowName) || "内容发布包生成";
}

export function contentWorkflowName(value?: string) {
  const text = cleanText(value);
  if (!text) return "";
  return text
    .replace(/小红书发布包/g, "内容发布包")
    .replace(/小红书内容任务/g, "内容任务")
    .replace(/小红书内容/g, "内容");
}

export function taskEntryLabel(task: LocalTaskItem) {
  const labels: Record<string, string> = {
    web: "后台",
    rework: "返工",
    wechat: "微信",
    scheduled: "定时",
    pressure_test: "压测",
    "pressure-test": "压测",
  };
  return labels[String(task.entryType || task.source || "")] || cleanText(task.entryType || task.source, "本地");
}

export function taskStatusClass(status?: string) {
  const raw = String(status || "").toLowerCase();
  if (raw === "completed" || raw === "done" || raw === "succeeded") return "succeeded";
  if (raw === "processing") return "running";
  if (raw === "error") return "failed";
  return raw || "pending";
}

export function stepName(step: TaskStep, index?: number) {
  const names: Record<string, string> = {
    receive: "接收任务",
    structure: "需求结构化",
    strategy: "素材筛选与策略判断",
    plan: "内容方案设计",
    generate: "发布包生成",
    quality: "质量检查",
    save: "保存与素材处理",
    sync: "本地索引更新",
  };
  const key = String(step.stepKey || step.key || "");
  return names[key] || cleanText(step.stepName || step.title || step.name) || `步骤 ${(index ?? 0) + 1}`;
}

export function stepInput(step: TaskStep, task?: LocalTaskItem) {
  return cleanText(step.inputSummary) || compact(step.input, "") || (step.stepKey === "receive" ? taskInputText(task || ({} as LocalTaskItem)) : "等待上一环节输出");
}

export function stepOutput(step: TaskStep) {
  return cleanText(step.outputSummary) || cleanText(step.summary) || cleanText(step.message) || compact(step.output, "") || "";
}

export function stepDuration(step: TaskStep) {
  return step.durationMs ?? elapsedMs(step.startedAt, step.completedAt);
}

export function taskStepMetaText(step: TaskStep) {
  const status = String(step.status || "").toLowerCase();
  if (status === "running" || status === "processing") return `已用 ${formatDuration(stepDuration(step)) || "0s"}`;
  if (status === "failed" || status === "error") return "失败";
  if (status === "canceled" || status === "cancelled") return "已取消";
  return formatDuration(stepDuration(step)) || statusText(step.status);
}

export function readableStepMessage(step: TaskStep, task?: LocalTaskItem) {
  const key = String(step.stepKey || step.key || "");
  if (step.error) return cleanText(step.error, "该步骤执行失败，请打开详情查看错误信息。");
  const status = String(step.status || "").toLowerCase();
  if (status === "pending") return "等待上一环节完成";
  if (status === "running" || status === "processing") return "正在处理当前环节";

  const businessMessages: Record<string, string> = {
    receive: "任务已进入本地执行器",
    structure: "已整理主题、人群、目标和约束",
    strategy: "已完成素材筛选与内容策略判断",
    plan: "已完成角度、结构、封面和图片规划",
    generate: "已生成标题、正文、话题标签和图片提示词",
    quality: "已完成真实感、交付门槛和风险检查",
    save: "发布包已保存到本地，素材按需生成",
    sync: "本地索引已更新",
  };

  const raw = stepOutput(step) || stepInput(step, task);
  const text = cleanText(raw);
  if (!text) return businessMessages[key] || statusText(step.status);
  if (/^[A-Z]:\\|^\\\\/.test(text)) return businessMessages[key] || "本地文件已处理";
  if (/^[{[]/.test(text) || text.includes('{"') || text.includes('":')) return businessMessages[key] || "该步骤已完成";
  return compactText(text, 150) || businessMessages[key] || statusText(step.status);
}

export function secretLabel(value: string | { configured?: boolean; masked?: string } | undefined) {
  if (!value) return "未配置";
  if (typeof value === "string") return value ? "待保存新密钥" : "未配置";
  return value.configured ? `已配置：${value.masked || "******"}` : "未配置";
}
