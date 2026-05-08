import {
  ArrowRight,
  CheckCircle2,
  GitBranch,
  Image as ImageIcon,
  Layers3,
  PackageCheck,
  Route,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ViewId } from "../types";
import { PageTitle } from "../components/common";

const WORKFLOW_STEPS = [
  {
    title: "接收任务",
    desc: "从后台、情报或入口助手接收主题、素材和业务要求。",
    input: "原始需求",
    output: "任务记录",
  },
  {
    title: "需求结构化",
    desc: "整理主题、人群、目标、约束和缺失信息，减少后续生成偏航。",
    input: "自由文本",
    output: "结构化 brief",
  },
  {
    title: "研究增强",
    desc: "优先接入 Hermes Worker 做外部研究，失败时回落到本地稳定判断。",
    input: "内容 brief",
    output: "研究要点",
  },
  {
    title: "方案设计",
    desc: "确定角度、正文结构、封面方向和图片规划。",
    input: "研究要点",
    output: "内容方案",
  },
  {
    title: "发布包生成",
    desc: "生成标题、正文、话题标签、封面文案和图片提示词。",
    input: "内容方案",
    output: "发布包草稿",
  },
  {
    title: "质量检查",
    desc: "检查真实感、交付门槛、平台风险和 AI 味边界。",
    input: "发布包草稿",
    output: "质检结果",
  },
  {
    title: "保存素材",
    desc: "保存发布包；图片作为独立素材任务，进入详情页后按需生成。",
    input: "通过质检的发布包",
    output: "本地发布包",
  },
  {
    title: "索引更新",
    desc: "写入本地数据库，后续可按需同步 Notion 或继续发布处理。",
    input: "本地发布包",
    output: "可检索资产",
  },
];

const EDITOR_CARDS = [
  {
    icon: GitBranch,
    tag: "当前启用",
    meta: "8 个节点",
    title: "内容发布包生成",
    desc: "覆盖任务接收、结构化、研究增强、内容方案、发布包生成、质量检查、保存和本地索引更新。",
  },
  {
    icon: ImageIcon,
    tag: "素材任务",
    meta: "按需生成",
    title: "发布包配图生成",
    desc: "工作流默认只生成图片提示词，进入发布包详情后可以修改提示词，并单独生成封面图或正文图。",
  },
  {
    icon: ShieldCheck,
    tag: "质量门",
    meta: "交付前检查",
    title: "内容质检与风险拦截",
    desc: "在保存前集中检查内容完整度、平台风险、真实感和可交付性，避免低质量草稿沉淀到资产库。",
  },
];

export function WorkflowView({ onNavigate }: { onNavigate: (id: ViewId) => void }) {
  return (
    <main className="pageStack x-page workflowsPage">
      <PageTitle
        group="工作台"
        title="工作流"
        desc="当前启用的内容发布包生成流程，展示真实可运行的业务节点。"
        right={
          <button className="primary x-primary" onClick={() => onNavigate("tasks")}>
            <Sparkles size={16} />
            创建任务
          </button>
        }
      />

      <section className="workflowHeroPanel x-panel">
        <div>
          <span className="workflowKicker">
            <Route size={14} />
            本地 AI 工作流
          </span>
          <h2>从一个想法到可交付发布包</h2>
          <p>流程保持线性可追踪：每个节点都有明确输入、输出和失败定位，任务中心只负责执行状态，不被这里的样式影响。</p>
        </div>
        <div className="workflowHeroStats" aria-label="工作流概览">
          <strong>{WORKFLOW_STEPS.length}</strong>
          <span>稳定节点</span>
        </div>
      </section>

      <section className="workflowTimelinePanel x-panel">
        {WORKFLOW_STEPS.map((step, index) => (
          <article className="workflowStepCard" key={step.title}>
            <div className="workflowStepIndex">{String(index + 1).padStart(2, "0")}</div>
            <div className="workflowStepBody">
              <h3>{step.title}</h3>
              <p>{step.desc}</p>
            </div>
            <div className="workflowStepIO">
              <span>{step.input}</span>
              <ArrowRight size={14} />
              <strong>{step.output}</strong>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

export function FlowEditorView({ onNavigate }: { onNavigate: (id: ViewId) => void }) {
  return (
    <main className="pageStack x-page workflowsPage">
      <PageTitle
        group="流程自动化"
        title="流程编排"
        desc="维护业务流程节点、执行顺序和后续可配置的 Skill 能力。"
        right={
          <button className="primary x-primary" onClick={() => onNavigate("workflowCatalog")}>
            <GitBranch size={16} />
            查看工作流
          </button>
        }
      />

      <section className="workflowEditorGrid">
        {EDITOR_CARDS.map(({ icon: Icon, tag, meta, title, desc }) => (
          <article className="workflowEditorCard x-card" key={title}>
            <div className="workflowEditorHead">
              <span className="workflowEditorIcon">
                <Icon size={18} />
              </span>
              <div className="x-tags">
                <span>{tag}</span>
                <span>{meta}</span>
              </div>
            </div>
            <h3>{title}</h3>
            <p>{desc}</p>
          </article>
        ))}
      </section>

      <section className="workflowEditorSurface x-panel">
        <div className="workflowEditorSummary">
          <span>
            <Layers3 size={15} />
            编排能力
          </span>
          <h2>先沉淀稳定模板，再开放节点级配置</h2>
          <p>当前页面聚焦展示已启用流程和规划中的编排面板，后续可以在这里接入节点开关、模型策略和 Skill 选择。</p>
        </div>
        <div className="workflowEditorChecks">
          <span><CheckCircle2 size={15} /> 不删除发布包资产</span>
          <span><CheckCircle2 size={15} /> 图片任务独立触发</span>
          <span><PackageCheck size={15} /> 发布包可回看</span>
        </div>
      </section>
    </main>
  );
}
