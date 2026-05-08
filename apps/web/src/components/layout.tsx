import { Bot, MessageCircle, RefreshCw, Search, Send, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NAV_GROUPS } from "../navigation";
import type { KnowledgeItem, LocalIntelItem, LocalPackageItem, LocalTaskItem, LogsPayload, SettingsPayload, StatusPayload, ViewId } from "../types";
import { postJson } from "../lib/api";
import { secretLabel, cx } from "../lib/utils";

export type GlobalSearchResult = {
  id: string;
  view: ViewId;
  type: string;
  title: string;
  meta?: string;
};

const SEARCH_VIEW_LABELS: Partial<Record<ViewId, string>> = {
  tasks: "任务中心",
  packages: "发布包",
  intel: "情报库",
  knowledge: "知识库",
};

export function Header({
  active,
  onRefresh,
  refreshing,
  onSettings,
  status,
  searchResults,
  onSearchSelect,
}: {
  active: ViewId;
  onRefresh: () => void;
  refreshing: boolean;
  onSettings: () => void;
  status: StatusPayload | null;
  searchResults: GlobalSearchResult[];
  onSearchSelect: (result: GlobalSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const navItem = NAV_GROUPS.flatMap((group) => group.items).find((item) => item.id === active);
  const wrongRunDir = Boolean(status?.runtime?.wrongRunDir);
  const modelReady = Boolean(status?.model?.configured) && !wrongRunDir;
  const displayStatusText = wrongRunDir ? "运行目录错误" : undefined;
  const statusText = modelReady ? "模型已配置" : "模型未配置";
  const keyword = query.trim().toLowerCase();
  const visibleResults = keyword
    ? searchResults.filter((item) => `${item.title} ${item.meta || ""} ${item.type}`.toLowerCase().includes(keyword)).slice(0, 8)
    : [];
  return (
    <header className="globalToolbar x-topbar">
      <div className="searchBox x-search">
        <Search size={18} />
        <input
          value={query}
          placeholder="搜索任务、发布包、情报、知识库..."
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setFocused(true)}
        />
        {focused && keyword ? (
          <div className="globalSearchPanel">
            {visibleResults.length ? visibleResults.map((item) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSearchSelect(item);
                  setQuery("");
                  setFocused(false);
                }}
              >
                <span>
                  <b>{SEARCH_VIEW_LABELS[item.view] || item.type}</b>
                  <i>{item.type}</i>
                </span>
                <strong>{item.title}</strong>
                {item.meta ? <small>{item.meta}</small> : null}
              </button>
            )) : <div className="globalSearchEmpty">没有匹配结果</div>}
          </div>
        ) : null}
      </div>
      <div className="toolbarActions x-toolbar-actions">
        <button className="iconButton x-icon-button" onClick={onRefresh} disabled={refreshing} title="刷新当前数据">
          <RefreshCw size={17} className={refreshing ? "x-spin" : ""} />
          {refreshing ? "刷新中" : "刷新"}
        </button>
        <button className="iconButton x-icon-button" onClick={onSettings} title="设置中心">
          <Settings size={17} />
          设置
        </button>
        <span className={cx("serviceStatus x-health-dot", modelReady ? "online" : "warning")} title={modelReady ? "本地 API 已启动，任务模型配置已填写；实际调用会在保存配置和运行任务时校验。" : "本地 API 已启动，但还没有配置可用的模型 API"}>
          {displayStatusText || statusText}
        </span>
        <span className="x-current-page">{navItem?.label}</span>
      </div>
    </header>
  );
}

export function Sidebar({ active, onChange }: { active: ViewId; onChange: (id: ViewId) => void }) {
  return (
    <aside className="sidebar x-sidebar">
      <div className="brand x-brand">
        <div className="mark x-mark">龙</div>
        <div>
          <strong>小龙虾后台</strong>
          <span>本地 AI 工作流</span>
        </div>
      </div>
      <nav className="x-nav">
        {NAV_GROUPS.map((group) => (
          <section className="navGroup" key={group.title}>
            <p>{group.title}</p>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={cx(active === item.id && "selected")} onClick={() => onChange(item.id)}>
                  <Icon size={18} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.desc}</small>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </nav>
    </aside>
  );
}

type AssistantMessage = {
  role: "assistant" | "user";
  text: string;
};

type AssistantApiResponse = {
  ok?: boolean;
  text?: string;
  fallback?: boolean;
  reason?: string;
};

type AssistantContext = {
  active: ViewId;
  loadState: string;
  error: string;
  status: StatusPayload | null;
  settings: SettingsPayload | null;
  tasks: LocalTaskItem[];
  packages: LocalPackageItem[];
  intel: LocalIntelItem[];
  knowledge: KnowledgeItem[];
  logs: LogsPayload | null;
};

const ASSISTANT_VIEW_LABELS: Partial<Record<ViewId, string>> = {
  overview: "总览",
  tasks: "任务中心",
  workflowCatalog: "工作流",
  viral: "爆款拆解",
  intel: "情报库",
  knowledge: "知识库",
  packages: "发布包",
  workflows: "流程编排",
  entries: "入口助手",
  moduleSettings: "模块与插件",
  logs: "系统日志",
};

const ASSISTANT_INTRO = [
  "你好，我是小龙虾后台助手。",
  "这个系统主要用来把行业话题、情报、知识库和任务流程串起来，生成可落地的小红书内容发布包。",
  "你可以问我：怎么创建任务、情报库怎么获取话题、知识库怎么写、发布包在哪里看、入口助手怎么连接微信。",
].join("\n");

function countByStatus(items: Array<{ status?: string }>, status: string) {
  return items.filter((item) => item.status === status).length;
}

function buildSystemStatusReply(context: AssistantContext) {
  const modelReady = Boolean(context.status?.model?.configured);
  const apiReady = Boolean(context.status?.ok);
  const running = context.status?.workflows?.running ?? countByStatus(context.tasks, "running");
  const queued = context.status?.workflows?.queued ?? countByStatus(context.tasks, "queued");
  const failed = context.status?.workflows?.failed ?? countByStatus(context.tasks, "failed");
  const completed = context.status?.workflows?.completed ?? countByStatus(context.tasks, "completed");
  const notionIntel = Boolean(context.status?.notion?.intelConfigured);
  const notionContent = Boolean(context.status?.notion?.contentConfigured);
  const assistantEnhanced = Boolean(context.settings?.assistantApi?.enabled);
  const lines = [
    `当前页面：${ASSISTANT_VIEW_LABELS[context.active] || context.active}`,
    `本地 API：${apiReady ? "正常" : "异常或未读取到健康状态"}`,
    `任务模型：${modelReady ? `已配置（${context.status?.model?.providerId || "未命名服务"} / ${context.status?.model?.model || "未显示模型"}）` : "未配置，任务会无法调用模型"}`,
    `任务队列：运行中 ${running}，排队 ${queued}，失败 ${failed}，已完成 ${completed}`,
    `本地数据：任务 ${context.tasks.length}，情报 ${context.intel.length}，发布包 ${context.packages.length}，知识 ${context.knowledge.length}`,
    `Notion：情报库${notionIntel ? "已接入" : "未接入"}，发布包${notionContent ? "已接入" : "未接入"}`,
    `小助手模型增强：${assistantEnhanced ? "已开启" : "未开启，当前使用本地规则回答"}`,
  ];
  if (context.error) lines.push(`页面提示：${context.error}`);
  return `我看到的当前系统状态：\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function getTaskTime(task: LocalTaskItem) {
  return task.updatedAt || task.completedAt || task.startedAt || task.createdAt || "";
}

function buildRecentTaskDiagnosisReply(context: AssistantContext) {
  const sortedTasks = [...context.tasks]
    .sort((a, b) => getTaskTime(b).localeCompare(getTaskTime(a)))
    .slice(0, 5);
  const failedTasks = context.tasks.filter((task) => task.status === "failed" || task.error).slice(0, 3);
  const runningTasks = context.tasks.filter((task) => task.status === "running" || task.status === "queued").slice(0, 3);
  const logSummary = typeof context.logs === "object" && context.logs && !Array.isArray(context.logs) ? context.logs.summary : undefined;
  const lines = [
    `最近任务：${sortedTasks.length ? sortedTasks.map((task) => `${task.title || task.workflowName || task.id}（${task.status || "未知"}）`).join("；") : "当前前端还没有加载到任务列表"}`,
    `运行/排队：${runningTasks.length ? runningTasks.map((task) => task.title || task.workflowName || task.id).join("；") : "暂无"}`,
    `失败线索：${failedTasks.length ? failedTasks.map((task) => `${task.title || task.id}：${task.error || task.currentStep || "未记录具体错误"}`).join("；") : "暂无失败任务"}`,
  ];
  if (logSummary) {
    lines.push(`日志摘要：错误 ${logSummary.errors || 0}，警告 ${logSummary.warnings || 0}，最近时间 ${logSummary.latestAt || "未记录"}`);
  } else {
    lines.push("日志摘要：当前还没有加载系统日志页数据；需要更细诊断时，可以先进入“系统日志”页刷新一次。");
  }
  if (context.error) lines.push(`页面错误：${context.error}`);
  const suggestion = failedTasks.length
    ? "建议先打开失败任务的步骤详情，看最后一个失败步骤的输入、输出和模型调用记录；如果是本地 API 或配置错误，再去设置中心和系统日志交叉确认。"
    : "目前从已加载数据看不到明确失败任务；如果页面仍异常，优先刷新当前页，再查看系统日志。";
  return `最近任务/日志诊断：\n${lines.map((line) => `- ${line}`).join("\n")}\n${suggestion}`;
}

function compactAssistantContext(context: AssistantContext) {
  const logSummary = typeof context.logs === "object" && context.logs && !Array.isArray(context.logs) ? context.logs.summary : undefined;
  return {
    active: context.active,
    activeLabel: ASSISTANT_VIEW_LABELS[context.active] || context.active,
    loadState: context.loadState,
    pageError: context.error || "",
    status: {
      apiOk: Boolean(context.status?.ok),
      model: context.status?.model || {},
      notion: context.status?.notion || {},
      workflows: context.status?.workflows || {},
      packages: context.status?.packages || {},
      entryConfig: context.status?.entryConfig || {},
    },
    assistantApiEnabled: Boolean(context.settings?.assistantApi?.enabled),
    tasks: context.tasks.slice(0, 8).map((task) => ({
      id: task.id,
      title: task.title || task.workflowName || task.inputText || task.id,
      status: task.status,
      currentStep: task.currentStep,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      usage: task.modelUsage,
    })),
    packages: context.packages.slice(0, 6).map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      notionStatus: item.notionStatus,
      imageCount: item.imageCount,
      qualityScore: item.qualityScore,
    })),
    intel: context.intel.slice(0, 6).map((item) => ({
      id: item.id,
      title: item.title,
      source: item.source,
      evaluationStatus: item.evaluationStatus,
      processingStatus: item.processingStatus,
      valueScore: item.valueScore,
    })),
    knowledgeCount: context.knowledge.length,
    logSummary: logSummary || null,
  };
}

function assistantReply(input: string, context: AssistantContext) {
  const text = input.trim().toLowerCase();
  if (/状态|当前|健康|正常|可用|配置好|配置好了|系统怎么样|现在怎么样|api.*情况|服务.*情况/.test(text)) {
    return buildSystemStatusReply(context);
  }
  if (/最近|诊断|排查|失败|报错|错误|日志|任务.*情况|任务.*怎么样/.test(text)) {
    return buildRecentTaskDiagnosisReply(context);
  }
  if (!text) return "可以直接问我一个问题，例如：任务怎么创建，或者情报库怎么用。";
  if (/介绍|是什么|能做什么|系统|小龙虾/.test(text)) {
    return [
      "小龙虾后台是一个本地 AI 内容工作台。",
      "核心模块包括：总览、任务中心、情报库、知识库、发布包、入口助手、模块与插件、系统日志。",
      "典型流程是：先配置模型 API，再从情报库获取话题或手动输入需求，任务中心执行内容工作流，最后在发布包查看正文、标题、图片提示词和本地素材。",
    ].join("\n");
  }
  if (/任务|创建|生成|工作流/.test(text)) {
    return "创建任务有两种方式：在任务中心直接输入需求并创建，或者在情报库选中可行动情报后生成任务。任务会进入本地工作流，依次完成需求结构化、策略判断、内容方案、发布包生成、质量检查和本地索引更新。";
  }
  if (/情报|话题|热点|获取/.test(text)) {
    return "情报库用于沉淀外部话题和行业素材。你需要先输入行业或话题关键词，再点击“获取话题”。系统会从默认情报源中筛选可转化为内容的素材；可行动的情报可以进一步生成任务。";
  }
  if (/知识|知识库|规则|方法/.test(text)) {
    return "知识库用于保存长期复用的规则、方法、客户偏好和禁忌。标题和内容是必填项，平台、场景、项目、标签、禁用说明是选填项。启用并允许工作流调用后，任务会按输入主题匹配相关知识。";
  }
  if (/发布包|素材|图片|正文/.test(text)) {
    return "发布包页面用于查看任务生成的内容结果，包括标题、正文、标签、图片提示词、图片素材和质量分。生成完成后可以在发布包中心查看详情，必要时手动处理或同步到外部工具。";
  }
  if (/微信|入口|助手|连接|扫码/.test(text)) {
    return "入口助手用于连接微信消息入口。默认未连接，点击连接后会显示二维码，扫码成功后微信消息可以进入本地任务体系。断开或重新连接时也应重新扫码确认。";
  }
  if (/设置|api|模型|key|配置/.test(text)) {
    return "设置中心用于配置模型 Provider、模型名、Base URL、API Key 和微信默认城市。保存配置时会做接口校验；没有配置模型时任务无法正常调用模型。";
  }
  if (/notion/.test(text)) {
    return "Notion 是可选接入。未启用 Notion 时，情报库和发布包不会显示同步按钮；启用并配置数据库后，才会出现对应同步操作。";
  }
  if (/日志|报错|错误|排查/.test(text)) {
    return "系统日志页面用于查看本地 API、微信 Bridge、任务工作流和发布预填相关日志。如果页面提示 API 不可用、任务失败或微信未回复，可以先到系统日志查看最近错误。";
  }
  return "我可以回答小龙虾后台的使用问题。你可以问：系统能做什么、任务怎么创建、情报库怎么获取话题、知识库怎么写、发布包在哪里看、微信入口怎么连接、模型 API 怎么配置。";
}

export function SystemAssistant({
  hidden = false,
  context,
  onNavigate,
}: {
  hidden?: boolean;
  context: AssistantContext;
  onNavigate: (view: ViewId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const assistantEnhanced = Boolean(context.settings?.assistantApi?.enabled);
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { role: "assistant", text: ASSISTANT_INTRO },
  ]);

  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, asking]);

  if (hidden) return null;

  async function ask(text: string) {
    const value = text.trim();
    if (!value) return;
    setMessages((current) => [...current, { role: "user", text: value }]);
    setInput("");
    const fallback = assistantReply(value, context);
    if (!context.settings?.assistantApi?.enabled) {
      setMessages((current) => [...current, { role: "assistant", text: fallback }]);
      return;
    }
    setAsking(true);
    try {
      const result = await postJson<AssistantApiResponse>("/api/local/assistant/chat", {
        message: value,
        context: compactAssistantContext(context),
      });
      const answer = result.ok && result.text
        ? result.text
        : `${fallback}\n\n（已使用本地诊断兜底：${result.reason || "未返回增强回答"}）`;
      setMessages((current) => [...current, { role: "assistant", text: answer }]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { role: "assistant", text: `${fallback}\n\n（已使用本地诊断兜底：${reason}）` }]);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="systemAssistant">
      {open ? (
        <section className="systemAssistantPanel" role="dialog" aria-label="小龙虾助手">
          <header>
            <div>
              <Bot size={18} />
              <strong>小龙虾助手</strong>
              <span className={cx("systemAssistantMode", assistantEnhanced ? "is-enhanced" : "is-local")}>
                {assistantEnhanced ? "模型增强" : "本地规则"}
              </span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭助手"><X size={16} /></button>
          </header>
          <div className="systemAssistantQuick">
            {[
              ["当前状态", "当前系统状态怎么样"],
              ["任务诊断", "最近任务和日志诊断"],
              ["系统介绍", "介绍一下这个系统"],
              ["创建任务", "任务怎么创建"],
              ["情报库", "情报库怎么获取话题"],
              ["知识库", "知识库怎么写"],
              ["任务中心", "打开任务中心"],
              ["发布包", "打开发布包"],
            ].map(([label, text]) => (
              <button
                key={label}
                type="button"
                disabled={asking}
                onClick={() => {
                  if (label === "任务中心") onNavigate("tasks");
                  else if (label === "情报库") onNavigate("intel");
                  else if (label === "知识库") onNavigate("knowledge");
                  else if (label === "发布包") onNavigate("packages");
                  else void ask(text);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="systemAssistantMessages" ref={messagesRef}>
            {messages.map((message, index) => (
              <div className={`systemAssistantMessage is-${message.role}`} key={`${message.role}-${index}`}>
                {message.text}
              </div>
            ))}
            {asking ? <div className="systemAssistantThinking">小助手正在结合当前系统状态分析...</div> : null}
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void ask(input); }}>
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder={asking ? "小助手正在思考..." : "问我如何使用小龙虾后台"} />
            <button type="submit" disabled={!input.trim() || asking}><Send size={15} /></button>
          </form>
        </section>
      ) : null}
      <button className="systemAssistantToggle" type="button" onClick={() => setOpen((value) => !value)}>
        <MessageCircle size={18} />
        助手
      </button>
    </div>
  );
}

export function SettingsModal({
  settings,
  onClose,
  onSaved,
}: {
  settings: SettingsPayload | null;
  onClose: () => void;
  onSaved: (settings: SettingsPayload) => void;
}) {
  const [form, setForm] = useState<SettingsPayload>(settings || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setForm(settings || {});
    setError("");
  }, [settings]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const next = await postJson<SettingsPayload>("/api/local/settings", form);
      onSaved(next);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  }

  const update = <K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]) => setForm({ ...form, [key]: value });

  return (
    <div className="modalBackdrop x-modal-backdrop">
      <div className="modalPanel x-modal x-settings-modal">
        <button className="iconButton x-close" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
        <header>
          <h2>设置中心</h2>
          <p>配置模型 API 后即可运行任务；保存时会校验接口、密钥和模型名。</p>
        </header>
        <div className="x-form-grid">
          <div className="x-settings-group-title x-wide">
            <strong>任务模型 API</strong>
            <small>用于任务中心、工作流和内容生成，是运行任务的主模型配置。</small>
          </div>
          <label>
            <span>Provider ID</span>
            <input
              value={form.modelProvider?.providerId || ""}
              placeholder="例如：openai、deepseek、pinduyun"
              onChange={(event) => update("modelProvider", { ...form.modelProvider, providerId: event.target.value })}
            />
            <small className="x-field-hint">用于区分不同模型服务商，建议使用英文或拼音，不要留空。</small>
          </label>
          <label>
            <span>模型</span>
            <input
              value={form.modelProvider?.model || ""}
              placeholder="例如：gpt-5.4、deepseek-chat"
              onChange={(event) => update("modelProvider", { ...form.modelProvider, model: event.target.value })}
            />
            <small className="x-field-hint">必须填写接口实际支持的模型名，任务运行会使用这里的模型。</small>
          </label>
          <label className="x-wide">
            <span>Base URL</span>
            <input
              value={form.modelProvider?.baseUrl || ""}
              placeholder="例如：https://api.example.com/v1"
              onChange={(event) => update("modelProvider", { ...form.modelProvider, baseUrl: event.target.value })}
            />
            <small className="x-field-hint">填写 OpenAI 兼容接口地址，系统会用它访问 /models 进行验证。</small>
          </label>
          <label>
            <span>API Key</span>
            <input
              type="password"
              placeholder={secretLabel(form.modelProvider?.apiKey) || "填写你的 API Key"}
              onChange={(event) => update("modelProvider", { ...form.modelProvider, apiKey: event.target.value || form.modelProvider?.apiKey })}
            />
            <small className="x-field-hint">新用户必须填写；已配置时可留空，系统会保留原密钥。</small>
          </label>
          <div className="x-settings-group-title x-wide">
            <strong>小助手 API</strong>
            <small>选填。只用于右下角小助手，和任务模型 API 分开保存。</small>
          </div>
          <div className="x-settings-section x-wide">
            <div>
              <strong>模型增强</strong>
              <small>不启用时，小助手仍使用本地规则回答；启用后才需要填写下面的模型配置。</small>
            </div>
            <label className="x-inline-check">
              <input
                type="checkbox"
                checked={Boolean(form.assistantApi?.enabled)}
                onChange={(event) => update("assistantApi", { ...form.assistantApi, enabled: event.target.checked })}
              />
              <span>启用模型增强</span>
            </label>
          </div>
          {form.assistantApi?.enabled ? (
            <>
              <label>
                <span>小助手 Provider ID</span>
                <input
                  value={form.assistantApi?.providerId || ""}
                  placeholder="例如：assistant、openai、pinduyun"
                  onChange={(event) => update("assistantApi", { ...form.assistantApi, providerId: event.target.value })}
                />
                <small className="x-field-hint">只用于标记小助手使用的服务商，可与主模型不同。</small>
              </label>
              <label>
                <span>小助手模型</span>
                <input
                  value={form.assistantApi?.model || ""}
                  placeholder="例如：gpt-5.4-mini、deepseek-chat"
                  onChange={(event) => update("assistantApi", { ...form.assistantApi, model: event.target.value })}
                />
                <small className="x-field-hint">仅小助手启用模型增强时使用。</small>
              </label>
              <label className="x-wide">
                <span>小助手 Base URL</span>
                <input
                  value={form.assistantApi?.baseUrl || ""}
                  placeholder="例如：https://api.example.com/v1"
                  onChange={(event) => update("assistantApi", { ...form.assistantApi, baseUrl: event.target.value })}
                />
                <small className="x-field-hint">填写 OpenAI 兼容接口地址，保存时会验证 /models。</small>
              </label>
              <label>
                <span>小助手 API Key</span>
                <input
                  type="password"
                  placeholder={secretLabel(form.assistantApi?.apiKey) || "填写小助手 API Key"}
                  onChange={(event) => update("assistantApi", { ...form.assistantApi, apiKey: event.target.value || form.assistantApi?.apiKey })}
                />
                <small className="x-field-hint">与主模型 API Key 独立保存；已配置时留空会保留原密钥。</small>
              </label>
            </>
          ) : null}
          <div className="x-settings-group-title x-wide">
            <strong>微信助手</strong>
            <small>用于微信入口消息处理，不影响任务模型和小助手模型配置。</small>
          </div>
          <label>
            <span>微信默认城市</span>
            <input
              value={form.wechatAssistant?.defaultCity || ""}
              placeholder="例如：杭州"
              onChange={(event) => update("wechatAssistant", { ...form.wechatAssistant, defaultCity: event.target.value })}
            />
            <small className="x-field-hint">入口助手处理天气类问题时会优先使用这个城市。</small>
          </label>
          {error && <div className="x-settings-error x-wide">{error}</div>}
          <div className="formActions x-form-actions">
            <button className="ghost x-secondary" onClick={onClose}>
              取消
            </button>
            <button className="primary x-primary" disabled={busy} onClick={save}>
              {busy ? "正在验证" : "保存设置"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
