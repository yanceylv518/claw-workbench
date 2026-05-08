import crypto from "node:crypto";
import { syncPackageIndex } from "./package-service.mjs";
import { updateTaskStep } from "./task-service.mjs";
import { runWorkflowStep } from "./workflow-step-executor.mjs";

function compactStepValue(value) {
  if (value === null || value === undefined || value === "") return "无";
  if (typeof value === "string") return value.trim() || "无";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stepBlock(title, value) {
  return `【${title}】\n${compactStepValue(value)}`;
}

function joinStepBlocks(blocks) {
  return blocks.filter(Boolean).join("\n\n");
}

function idForPackageDir(packageDir) {
  return packageDir ? crypto.createHash("sha1").update(String(packageDir)).digest("hex") : "";
}

function writeCompletedStep(runId, stepKey, data) {
  updateTaskStep(runId, stepKey, {
    status: "completed",
    ...data,
  });
}

export async function runReceiveTaskStep(context) {
  const { runId, task } = context;
  return runWorkflowStep(runId, "receive", {
    inputSummary: joinStepBlocks([
      stepBlock("原始输入", task.inputText),
    ]),
    outputSummary: "正在创建本地任务记录",
  }, async () => ({
    step: {
      outputSummary: joinStepBlocks([
        stepBlock("任务记录", {
          taskId: runId,
          workflowId: task.workflowId,
          workflowName: task.workflowName,
          entryType: task.entryType,
          status: "running",
        }),
      ]),
    },
  }));
}

export async function runSyncPackageIndexStep(context, savedPackage) {
  const { runId } = context;
  return runWorkflowStep(runId, "sync", {
    inputSummary: joinStepBlocks([
      stepBlock("已保存发布包", savedPackage || null),
    ]),
    outputSummary: "正在刷新本地发布包索引",
  }, async () => {
    const syncResult = await syncPackageIndex();
    const packageId = idForPackageDir(savedPackage?.packageDir);
    return {
      value: { packageId, indexSynced: syncResult.ok },
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("本地索引结果", {
            packageId,
            packageDir: savedPackage?.packageDir || "",
            jsonPath: savedPackage?.jsonPath || "",
            mdPath: savedPackage?.mdPath || "",
            status: syncResult.ok ? "synced" : "skipped",
            error: syncResult.ok ? "" : syncResult.error,
            stderr: syncResult.ok ? "" : syncResult.stderr,
          }),
        ]),
      },
    };
  });
}

export async function runStructureWritebackStep(context, { originalInput, requirementResult }) {
  const { runId } = context;
  return runWorkflowStep(runId, "structure", {
    inputSummary: joinStepBlocks([
      stepBlock("原始需求", originalInput),
    ]),
    outputSummary: "正在写入结构化需求结果",
  }, async () => ({
    step: {
      outputSummary: joinStepBlocks([
        stepBlock("结构化需求结果", requirementResult),
      ]),
    },
  }));
}

export async function runRequirementStructuringStep(context, { workflowInput, topicLabel, skillRunner }) {
  const { runId, llm, runtimeConfig, logger } = context;
  return runWorkflowStep(runId, "structure", {
    inputSummary: joinStepBlocks([
      stepBlock("原始需求", workflowInput),
    ]),
    outputSummary: "正在提取主题、人群、目标、约束和缺失信息",
  }, async () => {
    const requirementResult = await skillRunner({
      llm,
      userText: workflowInput,
      topicLabel,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      skillConfig: runtimeConfig.skills?.requirement,
      logger,
    });
    return {
      value: requirementResult,
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("结构化需求结果", requirementResult),
        ]),
      },
    };
  });
}

export async function runStrategyWritebackStep(context, { requirementResult, hermesResearch, knowledgeContext, strategyResult }) {
  const { runId } = context;
  return runWorkflowStep(runId, "strategy", {
    inputSummary: joinStepBlocks([
      stepBlock("结构化需求", requirementResult),
      stepBlock("研究增强结果", hermesResearch || null),
      stepBlock("候选情报/素材", knowledgeContext || []),
    ]),
    outputSummary: "正在写入研究增强与策略判断结果",
  }, async () => ({
    step: {
      outputSummary: joinStepBlocks([
        stepBlock("策略判断结果", strategyResult),
      ]),
    },
  }));
}

export async function runContentStrategyStep(context, {
  workflowInput,
  topicLabel,
  requirementResult,
  intelItems,
  hermesResearch,
  draft = null,
  businessFlow = null,
  skillRunner,
}) {
  const { runId, llm, runtimeConfig, logger } = context;
  return runWorkflowStep(runId, "strategy", {
    inputSummary: joinStepBlocks([
      stepBlock("结构化需求", requirementResult),
      stepBlock("研究增强结果", hermesResearch || null),
      stepBlock("候选情报/素材", intelItems || []),
    ]),
    outputSummary: "正在判断内容类型、结构方向、图片策略和风险边界",
  }, async () => {
    const strategyResult = await skillRunner({
      llm,
      userText: workflowInput,
      topicLabel,
      requirement: requirementResult,
      intelItems,
      hermesResearch,
      draft,
      businessFlow,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      skillConfig: runtimeConfig.skills?.strategy,
      logger,
    });
    return {
      value: strategyResult,
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("策略判断结果", strategyResult),
        ]),
      },
    };
  });
}

export async function runResearchPreparationStep(context, {
  workflowInput,
  topicLabel,
  intelItems,
  hermesConfig,
  researchRunner,
  opportunityScorer,
  intelSelector,
}) {
  const { runId, llm, runtimeConfig, logger } = context;
  return runWorkflowStep(runId, "strategy", {
    inputSummary: joinStepBlocks([
      stepBlock("结构化后需求", workflowInput),
      stepBlock("候选情报", intelItems || []),
      stepBlock("Hermes 配置", {
        enabled: Boolean(hermesConfig?.enabled),
        provider: hermesConfig?.provider || "",
        mode: hermesConfig?.mode || "",
      }),
    ]),
    outputSummary: "正在准备研究增强、机会评分和候选素材",
  }, async () => {
    const hermesResearch = await researchRunner({
      hermesConfig,
      llm,
      userText: workflowInput,
      topicLabel,
      intelItems,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      logger,
    });
    const opportunityScore = await opportunityScorer({
      llm,
      userText: workflowInput,
      topicLabel,
      intelItems,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      logger,
    });
    const selectedIntelItems = intelSelector(intelItems, opportunityScore);
    return {
      value: {
        hermesResearch,
        opportunityScore,
        selectedIntelItems,
      },
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("研究增强结果", hermesResearch),
          stepBlock("机会评分", opportunityScore),
          stepBlock("选中素材", selectedIntelItems),
        ]),
      },
    };
  });
}

export async function runResearchAndStrategyStep(context, {
  workflowInput,
  topicLabel,
  requirementResult,
  intelItems,
  hermesConfig,
  researchRunner,
  opportunityScorer,
  intelSelector,
  strategyRunner,
  directIntelMode = false,
}) {
  const { runId, llm, runtimeConfig, logger } = context;
  return runWorkflowStep(runId, "strategy", {
    inputSummary: joinStepBlocks([
      stepBlock("结构化需求", requirementResult),
      stepBlock("候选情报/素材", intelItems || []),
      stepBlock("研究增强配置", {
        enabled: Boolean(hermesConfig?.enabled),
        provider: hermesConfig?.provider || "",
        mode: hermesConfig?.mode || "",
      }),
    ]),
    outputSummary: directIntelMode ? "正在基于指定情报判断内容策略" : "正在筛选素材、评估机会并判断内容策略",
  }, async () => {
    const hermesResearch = await researchRunner({
      hermesConfig,
      llm,
      userText: workflowInput,
      topicLabel,
      intelItems,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      logger,
    });
    const opportunityScore = await opportunityScorer({
      llm,
      userText: workflowInput,
      topicLabel,
      intelItems,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      logger,
    });
    const selectedIntelItems = intelSelector(intelItems, opportunityScore);
    const strategyResult = await strategyRunner({
      llm,
      userText: workflowInput,
      topicLabel,
      requirement: requirementResult,
      intelItems: selectedIntelItems,
      hermesResearch,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      skillConfig: runtimeConfig.skills?.strategy,
      logger,
    });
    return {
      value: {
        hermesResearch,
        opportunityScore,
        selectedIntelItems,
        strategyResult,
      },
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("研究增强结果", hermesResearch),
          stepBlock("机会评分", opportunityScore),
          stepBlock("选中素材", selectedIntelItems),
          stepBlock("策略判断结果", strategyResult),
        ]),
      },
    };
  });
}

export async function runPlanWritebackStep(context, { strategyResult, knowledgeContext, contentPlanResult }) {
  const { runId } = context;
  writeCompletedStep(runId, "plan", {
    inputSummary: joinStepBlocks([
      stepBlock("策略判断结果", strategyResult),
      stepBlock("可用素材", knowledgeContext || []),
    ]),
    outputSummary: joinStepBlocks([
      stepBlock("内容方案", contentPlanResult),
    ]),
  });
}

export async function runContentPlanStep(context, {
  workflowInput,
  topicLabel,
  requirementResult,
  strategyResult,
  intelItems,
  hermesResearch,
  skillRunner,
}) {
  const { runId, llm, runtimeConfig, logger } = context;
  return runWorkflowStep(runId, "plan", {
    inputSummary: joinStepBlocks([
      stepBlock("结构化需求", requirementResult),
      stepBlock("策略判断结果", strategyResult),
      stepBlock("可用素材", intelItems || []),
      stepBlock("研究增强结果", hermesResearch || null),
    ]),
    outputSummary: "正在设计正文结构、真实场景、图片规划和人工确认项",
  }, async () => {
    const contentPlanResult = await skillRunner({
      llm,
      userText: workflowInput,
      topicLabel,
      requirement: requirementResult,
      strategy: strategyResult,
      intelItems,
      hermesResearch,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      skillConfig: runtimeConfig.skills?.plan,
      logger,
    });
    return {
      value: contentPlanResult,
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("内容方案", contentPlanResult),
        ]),
      },
    };
  });
}

export async function runGenerateWritebackStep(context, { requirementResult, strategyResult, contentPlanResult, draftResult }) {
  const { runId } = context;
  writeCompletedStep(runId, "generate", {
    inputSummary: joinStepBlocks([
      stepBlock("结构化需求", requirementResult),
      stepBlock("策略判断结果", strategyResult),
      stepBlock("内容方案", contentPlanResult),
    ]),
    outputSummary: joinStepBlocks([
      stepBlock("发布包内容", draftResult),
    ]),
  });
}

export async function runDraftGenerationStep(context, {
  workflowInput,
  topicLabel,
  requirementResult,
  strategyResult,
  contentPlanResult,
  intelItems,
  hermesResearch,
  skillRunner,
}) {
  const { runId, llm, runtimeConfig, logger } = context;
  return runWorkflowStep(runId, "generate", {
    inputSummary: joinStepBlocks([
      stepBlock("结构化需求", requirementResult),
      stepBlock("策略判断结果", strategyResult),
      stepBlock("内容方案", contentPlanResult),
      stepBlock("选中素材", intelItems || []),
    ]),
    outputSummary: "正在生成标题、正文、话题标签、封面大字和配图提示词",
  }, async () => {
    const result = await skillRunner({
      llm,
      userText: workflowInput,
      topicLabel,
      intelItems,
      hermesResearch,
      requirement: requirementResult,
      strategy: strategyResult,
      contentPlan: contentPlanResult,
      imageMode: "auto",
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      logger,
    });
    return {
      value: result,
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("发布包内容", result?.draft || null),
          stepBlock("规则修正", result?.repairResult || null),
        ]),
      },
    };
  });
}

export async function runReviewWritebackStep(context, { draftResult, qualityResult }) {
  const { runId } = context;
  writeCompletedStep(runId, "review", {
    inputSummary: joinStepBlocks([
      stepBlock("待检查发布包", draftResult),
    ]),
    outputSummary: joinStepBlocks([
      stepBlock("质量检查结果", qualityResult),
    ]),
  });
}

export async function runQualityCheckStep(context, {
  workflowInput,
  topicLabel,
  requirementResult,
  strategyResult,
  contentPlanResult,
  draftResult,
  selectedIntelItems,
  opportunityScore,
  repairResult,
  humanEditorRules,
  skillRunner,
}) {
  const { runId, llm, runtimeConfig, logger } = context;
  return runWorkflowStep(runId, "review", {
    inputSummary: joinStepBlocks([
      stepBlock("待检查发布包", draftResult),
      stepBlock("内容策略", strategyResult),
      stepBlock("内容方案", contentPlanResult),
    ]),
    outputSummary: "正在检查真实感、AI 味、软广风险、图片匹配和可交付性",
  }, async () => {
    const result = await skillRunner({
      llm,
      userText: workflowInput,
      topicLabel,
      requirement: requirementResult,
      strategy: strategyResult,
      contentPlan: contentPlanResult,
      draft: draftResult,
      selectedIntelItems,
      scoredOpportunities: opportunityScore,
      repairResult,
      humanEditorRules,
      modelTimeoutMs: runtimeConfig.modelTimeoutMs,
      skillConfig: runtimeConfig.skills?.deliveryGate,
      logger,
    });
    return {
      value: result,
      step: {
        outputSummary: joinStepBlocks([
          stepBlock("去 AI 味复核", result?.humanEditorReview || null),
          stepBlock("内容质检", result?.qualityReview || null),
          stepBlock("交付门禁", result?.deliveryGate || null),
          stepBlock("修正后发布包", result?.draft || null),
        ]),
      },
    };
  });
}

export async function runPackageWritebackStep(context, { draftResult, qualityResult, packageResult }) {
  const { runId } = context;
  writeCompletedStep(runId, "package", {
    inputSummary: joinStepBlocks([
      stepBlock("发布包内容", draftResult),
      stepBlock("质量检查结果", qualityResult),
    ]),
    outputSummary: joinStepBlocks([
      stepBlock("保存与素材处理结果", packageResult),
    ]),
  });
}
