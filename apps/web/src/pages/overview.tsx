import type React from "react";
import { Activity, AlertTriangle, BookOpen, Brain, CheckCircle2, Clock3, Database, Eye, PackageCheck, RadioTower, Zap } from "lucide-react";
import type { KnowledgeItem, LocalIntelItem, LocalPackageItem, LocalTaskItem, StatusPayload, ViewId } from "../types";
import { cleanText, compactText, formatDate } from "../lib/utils";
import { PageTitle, StatusPill } from "../components/common";

function OverviewMetricButton({ icon: Icon, label, value, desc, onClick }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string | number; desc: string; onClick: () => void }) {
  return (
    <button className="metric x-card x-metric-card overviewMetricButton" type="button" onClick={onClick}>
      <Icon size={22} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{desc}</p>
      </div>
    </button>
  );
}

export function OverviewView({ status, tasks, packages, intel, knowledge, onNavigate }: { status: StatusPayload | null; tasks: LocalTaskItem[]; packages: LocalPackageItem[]; intel: LocalIntelItem[]; knowledge: KnowledgeItem[]; onNavigate: (id: ViewId) => void }) {
  const runningTasks = tasks.filter((task) => ["running", "processing", "queued"].includes(String(task.status).toLowerCase()));
  const failedTasks = tasks.filter((task) => ["failed", "error"].includes(String(task.status).toLowerCase()));
  const latestIntel = intel[0];
  const latestPackage = packages[0];
  const enabledEntries = status?.entryConfig?.entries?.filter((entry) => entry.enabled).length || 0;
  const latestIntelTitle = cleanText(latestIntel?.title, "先处理可用情报，再生成发布包");
  const latestIntelSummary = compactText(latestIntel?.summary, 118) || "从情报进入任务，生成可检查、可保存、可复用的内容发布包。";
  const latestPackageTitle = cleanText(latestPackage?.title, "暂无发布包");
  const latestPackageTime = formatDate(latestPackage?.generatedAt || latestPackage?.updatedAt);
  const latestTask = tasks[0];
  const latestTaskTitle = cleanText(latestTask?.title || latestTask?.workflowName || latestTask?.inputText, "暂无任务记录");
  const latestTaskTime = formatDate(latestTask?.updatedAt || latestTask?.createdAt);
  const systemReady = Boolean(status?.ok && status?.model?.configured);
  const notionReady = Boolean(status?.notion?.intelConfigured || status?.notion?.contentConfigured);
  const hermesEnabled = Boolean(status?.hermes?.enabled);

  return (
    <main className="pageStack x-page overviewPage">
      <PageTitle group="工作台" title="总览" desc="按本地内容工作流的真实顺序，查看当前要处理的任务和资产。" />

      <section className="metrics x-metric-grid overviewMetrics" aria-label="关键状态">
        <OverviewMetricButton icon={Activity} label="运行任务" value={runningTasks.length} desc={failedTasks.length ? `${failedTasks.length} 个异常任务待复核` : "当前正在排队或执行"} onClick={() => onNavigate("tasks")} />
        <OverviewMetricButton icon={BookOpen} label="可用情报" value={intel.length} desc="本地情报池记录" onClick={() => onNavigate("intel")} />
        <OverviewMetricButton icon={PackageCheck} label="发布包" value={packages.length} desc="本地已生成内容包" onClick={() => onNavigate("packages")} />
        <OverviewMetricButton icon={Brain} label="知识资产" value={knowledge.length} desc="可复用经验与规则" onClick={() => onNavigate("knowledge")} />
      </section>

      <section className="overviewWorkGrid">
        <div className="overviewHero panel x-panel">
          <div className="overviewHeroIcon"><BookOpen size={28} /></div>
          <div className="overviewHeroCopy">
            <span>建议从这里开始</span>
            <h1>{failedTasks.length ? "先复核异常任务，再继续生成内容" : latestIntelTitle}</h1>
            <p>{failedTasks.length ? "有任务执行失败，先查看原因可以避免后续发布包继续堆积问题。" : latestIntelSummary}</p>
          </div>
          <div className="overviewHeroActions">
            <button className="x-primary" onClick={() => onNavigate(failedTasks.length ? "tasks" : "intel")}><Zap size={16} />{failedTasks.length ? "查看异常" : "处理情报"}</button>
            <button className="x-secondary" onClick={() => onNavigate("packages")}><Eye size={16} />查看发布包</button>
          </div>
        </div>

        <div className="overviewSignal panel x-panel">
          <span>{systemReady ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}{systemReady ? "生成链路可用" : "生成链路待确认"}</span>
          <strong>{failedTasks.length ? `${failedTasks.length} 个异常` : runningTasks.length ? `${runningTasks.length} 个运行中` : "暂无阻塞"}</strong>
          <p>{enabledEntries} 个入口启用，最近任务：{latestTaskTitle}</p>
        </div>
      </section>

      <section className="grid two x-two-col overviewTwoCol">
        <div className="panel x-panel overviewActionPanel">
          <div className="panelHead x-panel-head">
            <div>
              <h2>下一步工作</h2>
              <p>按业务链路推进，先处理输入，再检查产出。</p>
            </div>
          </div>
          <div className="actionList x-action-list overviewActionList">
            <button onClick={() => onNavigate("intel")}><b>01</b><span><strong>把情报转成任务</strong><small>{latestIntelTitle}</small></span><Zap size={16} /></button>
            <button onClick={() => onNavigate("tasks")}><b>02</b><span><strong>查看执行进度</strong><small>{runningTasks.length ? `${runningTasks.length} 个任务需要关注` : "当前没有运行任务"}</small></span><Activity size={16} /></button>
            <button onClick={() => onNavigate("packages")}><b>03</b><span><strong>检查发布包与素材</strong><small>{latestPackageTitle}</small></span><PackageCheck size={16} /></button>
          </div>
        </div>

        <div className="panel x-panel overviewStatusPanel">
          <div className="panelHead x-panel-head">
            <div>
              <h2>连接状态</h2>
              <p>只显示会影响本地流程的入口。</p>
            </div>
          </div>
          <div className="healthList x-status-list overviewStatusList">
            <div><span><RadioTower size={15} />本地 API</span><StatusPill status={status?.ok ? "online" : "failed"} /></div>
            <div><span><Activity size={15} />Hermes Worker</span><StatusPill status={hermesEnabled ? "available" : "pending"} /></div>
            <div><span><Database size={15} />Notion</span><StatusPill status={notionReady ? "configured" : "pending"} /></div>
            <div><span><CheckCircle2 size={15} />启用入口</span><b>{enabledEntries}</b></div>
          </div>
          <div className="overviewLatest">
            <Clock3 size={16} />
            <span>最近发布包</span>
            <strong>{latestPackageTitle}</strong>
            <small>{latestPackage ? latestPackageTime : "生成后会在这里显示"}</small>
          </div>
          <div className="overviewLatest">
            <Activity size={16} />
            <span>最近任务</span>
            <strong>{latestTaskTitle}</strong>
            <small>{latestTask ? latestTaskTime : "创建后会在这里显示"}</small>
          </div>
        </div>
      </section>
    </main>
  );
}
