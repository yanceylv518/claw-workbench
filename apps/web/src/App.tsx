import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiList, KnowledgeItem, LoadState, LocalIntelItem, LocalPackageItem, LocalTaskItem, LogsPayload, SettingsPayload, StatusPayload, ViewId } from "./types";
import { extractItems, getJson, postJson } from "./lib/api";
import { Header, SettingsModal, Sidebar, SystemAssistant, type GlobalSearchResult } from "./components/layout";
import { OverviewView } from "./pages/overview";
import { TasksView } from "./pages/tasks";
import { WorkflowView, FlowEditorView } from "./pages/workflows";
import { ViralView } from "./pages/viral";
import { IntelView } from "./pages/intel";
import { KnowledgeView } from "./pages/knowledge";
import { PackagesView } from "./pages/packages";
import { EntriesView } from "./pages/entries";
import { ModuleSettingsView } from "./pages/modules";
import { LogsView } from "./pages/logs";

type ReloadScope = ViewId | "settings";

export default function App() {
  const [active, setActive] = useState<ViewId>("overview");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [tasks, setTasks] = useState<LocalTaskItem[]>([]);
  const [packages, setPackages] = useState<LocalPackageItem[]>([]);
  const [intel, setIntel] = useState<LocalIntelItem[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [logs, setLogs] = useState<LogsPayload | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [taskHandoffNotice, setTaskHandoffNotice] = useState("");

  const notionIntelConfigured = useMemo(() => Boolean(status?.notion?.intelConfigured), [status]);
  const notionContentConfigured = useMemo(() => Boolean(status?.notion?.contentConfigured), [status]);
  const modelConfigured = useMemo(() => Boolean(status?.model?.configured), [status]);
  const globalSearchResults = useMemo<GlobalSearchResult[]>(() => [
    ...tasks.map((item) => ({
      id: `task:${item.id}`,
      view: "tasks" as const,
      type: "任务",
      title: item.title || item.inputText || item.workflowName || item.id,
      meta: [item.workflowName, item.status, item.inputText].filter(Boolean).join(" · "),
    })),
    ...packages.map((item) => ({
      id: `package:${item.id}`,
      view: "packages" as const,
      type: "发布包",
      title: item.title || item.id,
      meta: [item.status, item.notionStatus, item.packageDir].filter(Boolean).join(" · "),
    })),
    ...intel.map((item) => ({
      id: `intel:${item.id}`,
      view: "intel" as const,
      type: "情报",
      title: item.title || item.summary || item.id,
      meta: [item.category, item.source, item.summary].filter(Boolean).join(" · "),
    })),
    ...knowledge.map((item) => ({
      id: `knowledge:${item.id}`,
      view: "knowledge" as const,
      type: "知识",
      title: item.title || item.content || item.id,
      meta: [item.type, item.platform, item.scenario, item.content].filter(Boolean).join(" · "),
    })),
  ], [intel, knowledge, packages, tasks]);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  const reload = useCallback(async (scope: ReloadScope = active) => {
    setLoadState((state) => (state === "idle" ? "loading" : state));
    setError("");
    try {
      const requests: Array<Promise<unknown>> = [getJson<StatusPayload>("/api/local/health")];
      const labels: string[] = ["status"];

      const add = <T,>(label: string, request: Promise<T>) => {
        labels.push(label);
        requests.push(request);
      };

      if (scope === "overview") {
        add("tasks", getJson<ApiList<LocalTaskItem>>("/api/local/tasks?limit=20&summary=1"));
        add("packages", getJson<ApiList<LocalPackageItem>>("/api/local/packages?limit=20"));
        add("intel", getJson<ApiList<LocalIntelItem>>("/api/local/intel?limit=20"));
        add("knowledge", getJson<ApiList<KnowledgeItem>>("/api/local/knowledge?limit=20"));
      } else if (scope === "tasks") {
        add("tasks", getJson<ApiList<LocalTaskItem>>("/api/local/tasks?limit=100"));
      } else if (scope === "packages") {
        add("packages", getJson<ApiList<LocalPackageItem>>("/api/local/packages?limit=100"));
      } else if (scope === "intel") {
        add("intel", getJson<ApiList<LocalIntelItem>>("/api/local/intel?limit=100"));
      } else if (scope === "knowledge") {
        add("knowledge", getJson<ApiList<KnowledgeItem>>("/api/local/knowledge?limit=100"));
      } else if (scope === "logs") {
        add("logs", getJson<LogsPayload>("/api/logs"));
      } else if (scope === "moduleSettings" || scope === "settings") {
        add("settings", getJson<SettingsPayload>("/api/local/settings"));
      }

      const results = await Promise.allSettled(requests);
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const label = labels[index];
        if (label === "status") setStatus(result.value as StatusPayload);
        if (label === "tasks") setTasks(extractItems(result.value as ApiList<LocalTaskItem>));
        if (label === "packages") setPackages(extractItems(result.value as ApiList<LocalPackageItem>));
        if (label === "intel") setIntel(extractItems(result.value as ApiList<LocalIntelItem>));
        if (label === "knowledge") setKnowledge(extractItems(result.value as ApiList<KnowledgeItem>));
        if (label === "logs") setLogs(result.value as LogsPayload);
        if (label === "settings") setSettings(result.value as SettingsPayload);
      });

      const rejected = results.find((item, index) => item.status === "rejected" && labels[index] !== "status") as PromiseRejectedResult | undefined;
      if (rejected) setError(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason));
      setLoadState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadState("error");
    }
  }, [active]);

  async function createTaskFromText(
    text: string,
    sourceLabel = "后台入口",
    options: { entryType?: string; entryMessageId?: string } = {},
  ) {
    if (!modelConfigured) {
      setError("请先在设置中心配置任务模型 API，再创建内容任务。");
      return;
    }
    await postJson("/api/local/tasks", {
      inputText: text,
      entryType: options.entryType || "web",
      entryMessageId: options.entryMessageId || "",
    });
    await reload("tasks");
    setTaskHandoffNotice(`任务已从${sourceLabel}生成，正在进入执行队列`);
    setActive("tasks");
  }

  async function openSettings() {
    await reload("settings");
    setShowSettings(true);
  }

  useEffect(() => { void reload(active); }, [active, reload]);
  useEffect(() => {
    if (active === "logs" || active === "moduleSettings") return undefined;
    const timer = window.setInterval(() => { void reload(active); }, active === "tasks" ? 8000 : 15000);
    return () => window.clearInterval(timer);
  }, [active, reload]);

  return (
    <div className="shell x-shell">
      <Sidebar active={active} onChange={setActive} />
      <div className="content x-main">
        <Header
          active={active}
          status={status}
          onRefresh={() => void reload(active)}
          refreshing={loadState === "loading"}
          onSettings={() => void openSettings()}
          searchResults={globalSearchResults}
          onSearchSelect={(result) => setActive(result.view)}
        />
        {error ? <div className="x-api-error">本地 API 暂不可用：{error}</div> : null}
        {status?.runtime?.wrongRunDir ? (
          <div className="x-api-error">
            运行目录错误：当前打开的是覆盖升级包目录。请关闭当前服务，到原安装目录运行“启动小龙虾.bat”。
            {status.runtime.suggestedDir ? ` 建议目录：${status.runtime.suggestedDir}` : ""}
          </div>
        ) : null}
        {active === "overview" ? <OverviewView status={status} tasks={tasks} packages={packages} intel={intel} knowledge={knowledge} onNavigate={setActive} /> : null}
        {active === "tasks" ? (
          <TasksView
            tasks={tasks}
            onReload={() => reload("tasks")}
            onOpenPackages={() => setActive("packages")}
            modelConfigured={modelConfigured}
            handoffNotice={taskHandoffNotice}
            onHandoffNoticeConsumed={() => setTaskHandoffNotice("")}
          />
        ) : null}
        {active === "workflowCatalog" ? <WorkflowView onNavigate={setActive} /> : null}
        {active === "viral" ? <ViralView onCreateTask={createTaskFromText} /> : null}
        {active === "intel" ? <IntelView intel={intel} notionConfigured={notionIntelConfigured} onReload={() => reload("intel")} onCreateTask={createTaskFromText} /> : null}
        {active === "knowledge" ? <KnowledgeView knowledge={knowledge} onReload={() => reload("knowledge")} /> : null}
        {active === "packages" ? <PackagesView packages={packages} notionConfigured={notionContentConfigured} onReload={() => reload("packages")} /> : null}
        {active === "workflows" ? <FlowEditorView onNavigate={setActive} /> : null}
        {active === "entries" ? <EntriesView status={status} /> : null}
        {active === "moduleSettings" ? <ModuleSettingsView settings={settings} onSaved={setSettings} /> : null}
        {active === "logs" ? <LogsView logs={logs} /> : null}
      </div>
      {showSettings ? <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} /> : null}
      <SystemAssistant
        hidden={showSettings}
        context={{ active, loadState, error, status, settings, tasks, packages, intel, knowledge, logs }}
        onNavigate={setActive}
      />
    </div>
  );
}
