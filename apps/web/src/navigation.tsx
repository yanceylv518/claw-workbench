import type React from "react";
import { Activity, BookOpen, Bot, Brain, Flame, GitBranch, LayoutDashboard, PackageCheck, Settings, TerminalSquare } from "lucide-react";
import type { ViewId } from "./types";

export const NAV_GROUPS: Array<{ title: string; items: Array<{ id: ViewId; label: string; desc: string; icon: React.ComponentType<{ size?: number }> }> }> = [
  {
    title: "工作台",
    items: [
      { id: "overview", label: "总览", desc: "今天要处理什么", icon: LayoutDashboard },
      { id: "tasks", label: "任务中心", desc: "创建、执行、记录", icon: Activity },
      { id: "workflowCatalog", label: "工作流", desc: "当前可用业务流", icon: GitBranch },
      { id: "viral", label: "爆款拆解", desc: "对标、迁移、沉淀", icon: Flame },
    ],
  },
  {
    title: "资产中心",
    items: [
      { id: "intel", label: "情报库", desc: "热点、话题、素材", icon: BookOpen },
      { id: "knowledge", label: "知识库", desc: "知识、方法、规则", icon: Brain },
      { id: "packages", label: "发布包", desc: "内容包与素材", icon: PackageCheck },
    ],
  },
  {
    title: "连接与系统",
    items: [
      { id: "entries", label: "入口助手", desc: "微信与消息入口", icon: Bot },
      { id: "moduleSettings", label: "模块与插件", desc: "Skill、Notion、增强项", icon: Settings },
      { id: "logs", label: "系统日志", desc: "运行日志与诊断", icon: TerminalSquare },
    ],
  },
];
