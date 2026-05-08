export const XIAOHONGSHU_WORKFLOW_ID = "xiaohongshu_publish_package";
export const XIAOHONGSHU_WORKFLOW_NAME = "小红书发布包生成";

export const XIAOHONGSHU_WORKFLOW_STEPS = [
  {
    key: "receive",
    name: "接收任务",
    description: "接收来自后台、入口助手或定时任务的主题、素材和业务需求。",
    input: "主题、素材、情报或业务需求",
    output: "本地任务记录",
    executor: "task-executor",
  },
  {
    key: "structure",
    name: "需求结构化",
    description: "把自由输入整理成主题、人群、目标、约束和缺失信息。",
    input: "原始任务需求",
    output: "结构化需求",
    executor: "workflow-step",
  },
  {
    key: "strategy",
    name: "素材筛选与策略判断",
    description: "结合本地情报、知识资产和可选研究增强结果，判断内容类型、表达方式、标题方向和风险边界。",
    input: "结构化需求、情报线索、知识资产、可选外部研究结果",
    output: "内容策略、正文结构、图片策略、风险约束",
    executor: "workflow-step",
  },
  {
    key: "plan",
    name: "内容方案设计",
    description: "把策略拆成可执行的正文结构、场景设计、图片规划和人工确认点。",
    input: "内容策略和可用素材",
    output: "内容方案",
    executor: "workflow-step",
  },
  {
    key: "generate",
    name: "发布包生成",
    description: "生成标题、正文、话题标签、封面大字、图片提示词和发布检查项。",
    input: "结构化需求、内容策略、内容方案",
    output: "完整发布包内容",
    executor: "workflow-step",
  },
  {
    key: "review",
    name: "质量检查",
    description: "检查真实感、AI 味、软广风险、图片正文匹配和可交付性。",
    input: "待检查发布包",
    output: "质量检查结果",
    executor: "workflow-step",
  },
  {
    key: "package",
    name: "保存与素材处理",
    description: "保存发布包，处理封面图、正文图、提示词和本地文件。",
    input: "发布包内容和质量检查结果",
    output: "本地发布包文件和素材",
    executor: "workflow-step",
  },
  {
    key: "sync",
    name: "本地索引更新",
    description: "把已保存发布包写入本地数据库索引，供发布包中心查询。",
    input: "已保存发布包",
    output: "本地索引记录",
    executor: "workflow-step",
  },
];

export function getXiaohongshuWorkflowDefinition() {
  return {
    id: XIAOHONGSHU_WORKFLOW_ID,
    name: XIAOHONGSHU_WORKFLOW_NAME,
    slogan: "从主题、素材、情报或返工意见生成本地小红书发布包。",
    description: "从一个输入开始，依次完成需求结构化、素材筛选、策略判断、内容方案、发布包生成、质量检查和本地保存。",
    status: "active",
    input: "主题、素材、情报或业务需求",
    output: "发布包、图片提示词、本地素材和任务记录",
    steps: XIAOHONGSHU_WORKFLOW_STEPS,
  };
}

export function listWorkflowDefinitions() {
  return [getXiaohongshuWorkflowDefinition()];
}

export function getWorkflowSteps(workflowId) {
  if (workflowId !== XIAOHONGSHU_WORKFLOW_ID) return [];
  return XIAOHONGSHU_WORKFLOW_STEPS;
}
