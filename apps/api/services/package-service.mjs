import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initLocalDb, openLocalDb, getDbPath } from "../../../packages/db/src/local-db.mjs";
import {
  generateXiaohongshuPackageImageAsset,
  replayXiaohongshuPackageToNotion,
  updateXiaohongshuPackageImagePrompt,
} from "../../../xiaohongshu-draft-workflow.mjs";
import { normalizeLimit } from "../utils/http.mjs";

const execFileAsync = promisify(execFile);
const TEXT = {
  unlabeled: "\u672a\u6807\u8bb0",
  unsynced: "\u672a\u540c\u6b65",
};
const PREFILL_STATUS_PATH = path.resolve(".wechat-direct-bridge", "xiaohongshu-prefill-status.json");
const PREFILL_LOG_PATH = path.resolve(".wechat-direct-bridge", "xiaohongshu-prefill-launch.log");
const ROOT_PATH = fileURLToPath(new URL("../../..", import.meta.url));

function resolvePrefillPython() {
  const candidates = [
    process.env.XIAOLONGXIA_PYTHON,
    path.join(ROOT_PATH, "runtime", "python", "python.exe"),
    "python",
  ].filter(Boolean);
  return candidates.find((candidate) => {
    if (candidate === "python") return true;
    return fs.existsSync(candidate);
  }) || "python";
}

const PACKAGE_STATUS_GROUPS = {
  review: ["", "review", "generated", "ready", "written", "draft", "xiaohongshu", "\u5df2\u751f\u6210", "\u5f85\u624b\u5de5\u53d1\u5e03", "\u8349\u7a3f\u5df2\u4fdd\u5b58", "\u672a\u6807\u8bb0"],
  processing: ["processing", "pending", "queued", "running", "\u5904\u7406\u4e2d", "\u751f\u6210\u4e2d", "\u6392\u961f\u4e2d"],
  completed: ["completed", "done", "published", "synced", "\u5df2\u5b8c\u6210", "\u5df2\u53d1\u5e03"],
  archived: ["archived", "disabled", "\u5df2\u5f52\u6863", "\u5df2\u505c\u7528"],
  failed: ["failed", "error", "\u5931\u8d25", "\u5f02\u5e38"],
};

function normalizePackageStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  for (const [status, aliases] of Object.entries(PACKAGE_STATUS_GROUPS)) {
    if (aliases.map((item) => item.toLowerCase()).includes(raw)) return status;
  }
  return "review";
}

const PACKAGE_STATUS_CASE = `
  CASE
    WHEN lower(COALESCE(status, '')) IN ('processing', 'pending', 'queued', 'running', '\u5904\u7406\u4e2d', '\u751f\u6210\u4e2d', '\u6392\u961f\u4e2d') THEN 'processing'
    WHEN lower(COALESCE(status, '')) IN ('completed', 'done', 'published', 'synced', '\u5df2\u5b8c\u6210', '\u5df2\u53d1\u5e03') THEN 'completed'
    WHEN lower(COALESCE(status, '')) IN ('archived', 'disabled', '\u5df2\u5f52\u6863', '\u5df2\u505c\u7528') THEN 'archived'
    WHEN lower(COALESCE(status, '')) IN ('failed', 'error', '\u5931\u8d25', '\u5f02\u5e38') THEN 'failed'
    ELSE 'review'
  END
`;

function buildPackageWhere(searchParams) {
  const where = [];
  const params = {};

  const q = String(searchParams.get("q") || "").trim();
  if (q) {
    where.push("(title LIKE @q OR status LIKE @q OR notion_status LIKE @q)");
    params.q = `%${q}%`;
  }

  const status = String(searchParams.get("status") || "").trim();
  if (status) {
    where.push(`${PACKAGE_STATUS_CASE} = @status`);
    params.status = normalizePackageStatus(status);
  }

  const notionStatus = String(searchParams.get("notionStatus") || "").trim();
  if (notionStatus) {
    where.push("COALESCE(NULLIF(notion_status, ''), '') = @notionStatus");
    params.notionStatus = notionStatus;
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function rowToPackage(row) {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    kind: row.kind,
    status: normalizePackageStatus(row.status),
    notionStatus: row.notion_status || "",
    notionPageId: row.notion_page_id || "",
    notionUrl: row.notion_url || "",
    qualityScore: row.quality_score,
    aiFlavorScore: row.ai_flavor_score,
    humanTraceScore: row.human_trace_score,
    imageCount: row.image_count,
    packageDir: row.package_dir,
    packageJsonPath: row.package_json_path,
    markdownPath: row.markdown_path,
    sourcePath: row.source_path,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
    indexedAt: row.indexed_at,
    rawSummary: row.raw_summary ? JSON.parse(row.raw_summary) : null,
  };
}

function readJsonFile(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function imageDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const ext = String(filePath).split(".").pop()?.toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function normalizeSections(draft) {
  if (Array.isArray(draft?.body_sections) && draft.body_sections.length) {
    return draft.body_sections
      .map((section, index) => ({
        title: String(section?.heading || `正文段落 ${index + 1}`).trim(),
        content: String(section?.content || "").trim(),
      }))
      .filter((section) => section.title || section.content);
  }

  const postText = String(draft?.post_text || "").trim();
  if (!postText) return [];
  return postText
    .split(/\n{2,}/)
    .map((content, index) => ({
      title: `正文段落 ${index + 1}`,
      content: content.trim(),
    }))
    .filter((section) => section.content);
}

function normalizeImageSlots(payload) {
  const draft = payload?.draft || {};
  const imagePlan = Array.isArray(draft.image_plan) ? draft.image_plan : [];
  const generatedFiles = Array.isArray(payload?.images?.files) ? payload.images.files : [];
  const promptBag = payload?.images?.prompts || {};
  const supportingPrompts = Array.isArray(promptBag.rawSupportingPrompts)
    ? promptBag.rawSupportingPrompts
    : Array.isArray(draft.supporting_image_prompts)
      ? draft.supporting_image_prompts
      : [];
  const maxCount = Math.max(1, imagePlan.length, generatedFiles.length, supportingPrompts.length + 1);

  return Array.from({ length: maxCount }).map((_, index) => {
    const isCover = index === 0;
    const plan = imagePlan[index] || {};
    const file = generatedFiles[index] || {};
    const filePath = String(file.path || file.filePath || "").trim();
    const prompt = String(
      (isCover ? promptBag.rawCoverPrompt || draft.cover_image_prompt : supportingPrompts[index - 1]) ||
      plan.prompt ||
      "",
    ).trim();

    return {
      id: `${isCover ? "cover" : "image"}-${index + 1}`,
      label: String(plan.position || (isCover ? "封面图" : `正文配图 ${index}`)).trim(),
      type: String(plan.image_type || file.kind || (isCover ? "封面" : "正文配图")).trim(),
      purpose: String(plan.purpose || "").trim(),
      visualFocus: String(plan.visual_focus || "").trim(),
      prompt,
      filePath,
      dataUrl: imageDataUrl(filePath),
      missing: !filePath || !fs.existsSync(filePath),
    };
  });
}

function resolveManualImageSlot(slotId) {
  const raw = String(slotId || "").trim();
  if (raw === "cover-1") return { kind: "cover", index: 0, supportIndex: 0 };
  const match = raw.match(/^image-(\d+)$/);
  if (match) {
    const slotIndex = Math.max(1, (Number(match[1]) || 1) - 1);
    return { kind: "support", index: slotIndex, supportIndex: Math.max(0, slotIndex - 1) };
  }
  return { kind: "support", index: 1, supportIndex: 0 };
}

function upsertManualImageFile(files, slot, nextFile) {
  const next = Array.isArray(files) ? [...files] : [];
  const foundIndex = next.findIndex((item) => {
    const kind = String(item?.kind || "").trim();
    if (slot.kind === "cover") return kind === "cover";
    return kind === "support" && Number(item?.index ?? item?.supportIndex ?? -1) === slot.supportIndex;
  });
  if (foundIndex >= 0) next[foundIndex] = { ...next[foundIndex], ...nextFile };
  else next[slot.index] = nextFile;
  return next.filter(Boolean);
}

function parseImageUploadDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Unsupported image upload");
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  return { ext, buffer: Buffer.from(match[2], "base64") };
}

function safeImageFileName(slot, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = slot.kind === "cover" ? "manual-cover" : `manual-support-${slot.supportIndex + 1}`;
  return `${base}-${stamp}.${ext}`;
}

function writePrefillStatus(payload) {
  fs.mkdirSync(path.dirname(PREFILL_STATUS_PATH), { recursive: true });
  fs.writeFileSync(PREFILL_STATUS_PATH, `${JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function getPackagePrefillStatus() {
  try {
    return JSON.parse(fs.readFileSync(PREFILL_STATUS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function normalizePackageWorkflow(payload, draft) {
  if (payload?.workflow && typeof payload.workflow === "object") return payload.workflow;
  const businessFlow = payload?.businessFlow || {};
  const qualityScore = businessFlow?.qualityReview?.score ?? null;
  const reviewIssues = Array.isArray(businessFlow?.qualityReview?.issues) ? businessFlow.qualityReview.issues : [];
  const passed = businessFlow?.qualityReview?.passed ?? null;
  const decision = passed === false ? "review" : "ready";
  return {
    version: "publish-package-workflow-v1",
    name: "小红书发布包生成",
    requirement: {
      topic: String(draft?.subtitle || draft?.title || "").trim(),
      platform: "小红书",
      contentGoal: "内容种草与经验分享",
      audience: "对该主题有实际需求的用户",
      productOrService: "未明确植入",
      constraints: ["避免硬广和夸大承诺", "避免明显 AI 口吻"],
      missingFields: [],
    },
    strategy: {
      type: "经验分享",
      reason: "历史发布包未保存独立策略记录，按默认内容策略展示。",
      structure: normalizeSections(draft).map((section) => section.title),
      imageStrategy: String(draft?.visual_direction || draft?.cover_style || "").trim(),
      riskNotes: [
        ...(businessFlow?.ruleValidation?.issues || []),
        ...(businessFlow?.qualityReview?.issues || []),
      ].filter(Boolean),
    },
    contentPlan: {
      angle: String(draft?.subtitle || draft?.hook || "").trim(),
      opening: String(draft?.hook || "").trim(),
      bodyStructure: normalizeSections(draft).map((section) => ({
        title: section.title,
        summary: section.content.slice(0, 90),
      })),
      coverDirection: String(draft?.cover_text || draft?.cover_style || "").trim(),
      imagePlan: normalizeImageSlots(payload).map((image) => ({
        label: image.label,
        purpose: image.purpose,
        prompt: image.prompt,
      })),
    },
    qualityGate: {
      decision,
      deliverable: decision !== "blocked",
      reviewRequired: decision !== "ready",
      passed,
      score: qualityScore,
      summary: decision === "ready" ? "历史发布包已通过基础质检。" : "历史发布包建议人工复核后交付。",
      humanTraceScore: businessFlow?.humanEditorReview?.human_trace_score ?? null,
      aiFlavorScore: businessFlow?.humanEditorReview?.ai_flavor_score ?? null,
      humanLike: businessFlow?.humanEditorReview?.human_trace_score ?? null,
      platformFit: qualityScore,
      structureComplete: qualityScore,
      imageMatch: null,
      marketingRestraint: businessFlow?.humanEditorReview?.ai_flavor_score != null ? Math.max(0, 100 - Number(businessFlow.humanEditorReview.ai_flavor_score)) : null,
      riskExpression: reviewIssues.length ? Math.max(45, 85 - reviewIssues.length * 8) : 85,
      mustFix: passed === false ? reviewIssues.slice(0, 5) : [],
      optionalFix: [],
      riskNotes: reviewIssues,
      operatorNotes: decision === "ready" ? ["可查看发布包详情，按正文和图片结构进入人工发布。"] : ["先处理质检问题，再确认是否交付。"],
      issues: reviewIssues,
      confidence: 55,
    },
  };
}

function buildPackageDetail(row) {
  const item = rowToPackage(row);
  const payload = readJsonFile(item.packageJsonPath);
  const draft = payload?.draft || {};
  const markdown = readTextFile(item.markdownPath);

  return {
    ...item,
    detail: {
      title: String(draft.title || item.title || "").trim(),
      subtitle: String(draft.subtitle || "").trim(),
      hook: String(draft.hook || "").trim(),
      coverText: String(draft.cover_text || "").trim(),
      coverStyle: String(draft.cover_style || "").trim(),
      visualDirection: String(draft.visual_direction || payload?.images?.prompts?.visualDirection || "").trim(),
      postText: String(draft.post_text || "").trim(),
      hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
      checklist: Array.isArray(draft.publish_checklist) ? draft.publish_checklist : [],
      materials: Array.isArray(draft.materials_summary) ? draft.materials_summary : [],
      sections: normalizeSections(draft),
      images: normalizeImageSlots(payload),
      sourceItems: Array.isArray(payload?.sourceItems) ? payload.sourceItems : [],
      workflow: normalizePackageWorkflow(payload, draft),
      manualReview: payload?.manualReview || null,
      reworkRecords: Array.isArray(payload?.reworkRecords) ? payload.reworkRecords : [],
      qualityReview: payload?.businessFlow?.qualityReview || null,
      humanEditorReview: payload?.businessFlow?.humanEditorReview || null,
      notion: payload?.notion || null,
      markdown,
      files: {
        packageDir: item.packageDir || "",
        packageJsonPath: item.packageJsonPath || "",
        markdownPath: item.markdownPath || "",
      },
    },
  };
}

function normalizeManualReviewStatus(value) {
  const status = String(value || "").trim();
  if (["approved", "needs_changes"].includes(status)) return status;
  return "";
}

export function updatePackageManualReview(id, input = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    if (!row) return null;
    const payload = readJsonFile(row.package_json_path);
    if (!payload || typeof payload !== "object") return null;
    const status = normalizeManualReviewStatus(input.status);
    if (!status) throw new Error("Invalid review status");
    const now = new Date().toISOString();
    const manualReview = {
      status,
      label: status === "approved" ? "复核通过" : "需要修改",
      note: String(input.note || "").trim(),
      reviewedAt: now,
      reviewer: String(input.reviewer || "本地后台").trim(),
    };
    const nextWorkflow = payload.workflow && typeof payload.workflow === "object"
      ? { ...payload.workflow }
      : null;
    if (nextWorkflow?.qualityGate) {
      nextWorkflow.qualityGate = {
        ...nextWorkflow.qualityGate,
        manualReview,
        decision: status === "approved" ? "ready" : "review",
        deliverable: status === "approved",
        reviewRequired: status !== "approved",
        passed: status === "approved",
        operatorNotes: [
          status === "approved" ? "人工复核已通过，可按发布包详情进入人工发布。" : "人工复核标记为需要修改，请先调整正文、图片提示词或风险表达。",
          ...(Array.isArray(nextWorkflow.qualityGate.operatorNotes) ? nextWorkflow.qualityGate.operatorNotes : []),
        ].slice(0, 5),
      };
    }
    fs.writeFileSync(
      row.package_json_path,
      `${JSON.stringify({
        ...payload,
        manualReview,
        workflow: nextWorkflow || payload.workflow,
        publishStatusUpdatedAt: now,
      }, null, 2)}\n`,
      "utf8",
    );
    db.prepare("UPDATE content_packages SET updated_at = ? WHERE id = ?").run(now, id);
    const updated = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    return buildPackageDetail(updated);
  } finally {
    db.close();
  }
}

function updatePackageImageRow(db, id, packageJsonPath) {
  const payload = readJsonFile(packageJsonPath);
  const imageCount = Array.isArray(payload?.images?.files)
    ? payload.images.files.filter((item) => item?.path && fs.existsSync(item.path)).length
    : 0;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE content_packages
    SET image_count = ?,
        updated_at = ?,
        indexed_at = ?
    WHERE id = ?
  `).run(imageCount, now, now, id);
}

export function updatePackageImagePrompt(id, input = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    if (!row) return null;
    updateXiaohongshuPackageImagePrompt({
      packagePath: row.package_json_path,
      slotId: input.slotId,
      prompt: input.prompt,
    });
    updatePackageImageRow(db, id, row.package_json_path);
    const updated = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    return buildPackageDetail(updated);
  } finally {
    db.close();
  }
}

export async function generatePackageImageAsset(id, input = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    if (!row) return null;
    const rootPath = fileURLToPath(new URL("../../..", import.meta.url));
    const result = await generateXiaohongshuPackageImageAsset({
      baseDir: rootPath,
      packagePath: row.package_json_path,
      slotId: input.slotId,
      prompt: input.prompt,
    });
    updatePackageImageRow(db, id, row.package_json_path);
    const updated = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    return {
      ...buildPackageDetail(updated),
      imageGeneration: result,
    };
  } finally {
    db.close();
  }
}

export function uploadPackageImageAsset(id, input = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    if (!row) return null;
    const payload = readJsonFile(row.package_json_path);
    if (!payload?.draft) throw new Error("Invalid package payload");
    const slot = resolveManualImageSlot(input.slotId);
    const { ext, buffer } = parseImageUploadDataUrl(input.dataUrl);
    if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error("Image upload is too large");
    const outputDir = String(payload?.images?.outputDir || path.join(path.dirname(row.package_json_path), "images"));
    fs.mkdirSync(outputDir, { recursive: true });
    const targetPath = path.join(outputDir, safeImageFileName(slot, ext));
    fs.writeFileSync(targetPath, buffer);

    const prompt = String(input.prompt || "").trim();
    const nextFile = {
      kind: slot.kind,
      index: slot.kind === "cover" ? 0 : slot.supportIndex,
      path: targetPath,
      prompt,
      rawPrompt: prompt,
      source: "manual-upload",
      uploadedAt: new Date().toISOString(),
    };
    payload.images = {
      ...(payload.images || {}),
      status: "generated",
      outputDir,
      error: null,
      files: upsertManualImageFile(payload.images?.files, slot, nextFile),
    };
    payload.updatedAt = new Date().toISOString();
    fs.writeFileSync(row.package_json_path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    updatePackageImageRow(db, id, row.package_json_path);
    const updated = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    return buildPackageDetail(updated);
  } finally {
    db.close();
  }
}

export function launchPackagePrefill(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    if (!row) return null;
    const packagePath = String(row.package_json_path || "").trim();
    if (!packagePath || !fs.existsSync(packagePath)) throw new Error("Package file not found");
    const scriptPath = [
      path.resolve("xiaohongshu-prefill-publish.py"),
      path.join(ROOT_PATH, "xiaohongshu-prefill-publish.py"),
    ].find((candidate) => fs.existsSync(candidate));
    if (!scriptPath) throw new Error("Prefill script not found");
    writePrefillStatus({
      ok: null,
      stage: "launching",
      packagePath,
      message: "正在启动小红书发布页预填",
      title: row.title || "",
    });
    fs.mkdirSync(path.dirname(PREFILL_LOG_PATH), { recursive: true });
    const logStream = fs.createWriteStream(PREFILL_LOG_PATH, { flags: "a" });
    logStream.write(`\n[${new Date().toISOString()}] Launch prefill: ${packagePath}\n`);
    const child = spawn(resolvePrefillPython(), [
      scriptPath,
      "--package",
      packagePath,
    ], {
      cwd: ROOT_PATH,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk) => logStream.write(chunk));
    child.stderr?.on("data", (chunk) => logStream.write(chunk));
    child.on("error", (error) => {
      writePrefillStatus({
        ok: false,
        stage: "failed",
        packagePath,
        message: `小红书预填启动失败：${error.message || String(error)}`,
        title: row.title || "",
      });
      logStream.end(`[${new Date().toISOString()}] Spawn error: ${error.message || String(error)}\n`);
    });
    child.on("exit", (code) => {
      logStream.end(`[${new Date().toISOString()}] Prefill process exited with code ${code}\n`);
      const current = getPackagePrefillStatus();
      if (current?.packagePath === packagePath && current?.stage === "launching") {
        writePrefillStatus({
          ok: false,
          stage: "failed",
          packagePath,
          message: `小红书预填脚本已退出，退出码 ${code}`,
          title: row.title || "",
        });
      }
    });
    child.unref();
    return { ok: true, launched: true, packagePath, pid: child.pid };
  } finally {
    db.close();
  }
}

export function appendPackageReworkRecord(id, input = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    if (!row) return null;
    const payload = readJsonFile(row.package_json_path);
    if (!payload || typeof payload !== "object") return null;
    const now = new Date().toISOString();
    const record = {
      id: String(input.id || `rework-${Date.now()}`).trim(),
      taskId: String(input.taskId || "").trim(),
      note: String(input.note || "").trim(),
      status: "created",
      createdAt: now,
      sourcePackageId: id,
    };
    const reworkRecords = [
      record,
      ...(Array.isArray(payload.reworkRecords) ? payload.reworkRecords : []),
    ].slice(0, 20);
    fs.writeFileSync(
      row.package_json_path,
      `${JSON.stringify({
        ...payload,
        reworkRecords,
        publishStatusUpdatedAt: now,
      }, null, 2)}\n`,
      "utf8",
    );
    db.prepare("UPDATE content_packages SET updated_at = ? WHERE id = ?").run(now, id);
    const updated = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    return buildPackageDetail(updated);
  } finally {
    db.close();
  }
}

export function listPackages(url) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const pageSize = normalizeLimit(url.searchParams.get("pageSize") || url.searchParams.get("limit"));
    const page = Math.max(1, Number.parseInt(String(url.searchParams.get("page") || "1"), 10) || 1);
    const offset = (page - 1) * pageSize;
    const { clause, params } = buildPackageWhere(url.searchParams);
    const rows = db.prepare(`
      SELECT *
      FROM content_packages
      ${clause}
      ORDER BY COALESCE(updated_at, generated_at, indexed_at) DESC
      LIMIT @pageSize OFFSET @offset
    `).all({ ...params, pageSize, offset });

    const total = db.prepare(`SELECT count(*) AS count FROM content_packages ${clause}`).get(params);
    const statuses = db.prepare(`
      SELECT ${PACKAGE_STATUS_CASE} AS status, count(*) AS count
      FROM content_packages
      GROUP BY ${PACKAGE_STATUS_CASE}
      ORDER BY count DESC
    `).all();
    const notionStatuses = db.prepare(`
      SELECT notion_status AS status, count(*) AS count
      FROM content_packages
      WHERE COALESCE(NULLIF(notion_status, ''), '') != ''
      GROUP BY notion_status
      ORDER BY count DESC
    `).all();

    return {
      items: rows.map(rowToPackage),
      total: total.count,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total.count / pageSize)),
      statuses,
      notionStatuses,
      dbPath: getDbPath(),
    };
  } finally {
    db.close();
  }
}

export function getPackage(id) {
  const db = openLocalDb();
  initLocalDb(db);
  try {
    const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
    return row ? buildPackageDetail(row) : null;
  } finally {
    db.close();
  }
}

export async function syncPackageIndex() {
  const scriptPath = fileURLToPath(new URL("../../../packages/db/scripts/sync-packages.mjs", import.meta.url));
  const rootPath = fileURLToPath(new URL("../../..", import.meta.url));
  let stdout = "";
  let stderr = "";
  let failed = null;
  try {
    const result = await execFileAsync(process.execPath, [scriptPath], {
      cwd: rootPath,
      windowsHide: true,
    });
    stdout = result.stdout || "";
    stderr = result.stderr || "";
  } catch (error) {
    stdout = error?.stdout || "";
    stderr = error?.stderr || "";
    failed = error;
  }
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  const jsonText = jsonStart >= 0 && jsonEnd > jsonStart ? stdout.slice(jsonStart, jsonEnd + 1) : "";

  if (failed) {
    return {
      ok: false,
      result: jsonText ? JSON.parse(jsonText) : null,
      error: failed.message || String(failed),
      stdout,
      stderr,
    };
  }

  return {
    ok: true,
    result: jsonText ? JSON.parse(jsonText) : null,
    stdout,
    stderr,
  };
}

function patchPackageNotionResult(packageJsonPath, notion) {
  if (!packageJsonPath || !fs.existsSync(packageJsonPath)) return false;
  const payload = readJsonFile(packageJsonPath);
  if (!payload || typeof payload !== "object") return false;
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify({
      ...payload,
      notion,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  return true;
}

function updatePackageNotionRow(db, row, notion) {
  db.prepare(`
    UPDATE content_packages
    SET notion_status = @status,
        notion_page_id = @pageId,
        notion_url = @url,
        updated_at = @updatedAt,
        indexed_at = @indexedAt
    WHERE id = @id
  `).run({
    id: row.id,
    status: notion.status || "",
    pageId: notion.pageId || "",
    url: notion.url || "",
    updatedAt: new Date().toISOString(),
    indexedAt: new Date().toISOString(),
  });
}

export async function syncPackagesToNotion({ limit = 20 } = {}) {
  const db = openLocalDb();
  initLocalDb(db);
  const rows = db.prepare(`
    SELECT *
    FROM content_packages
    WHERE COALESCE(NULLIF(notion_page_id, ''), '') = ''
      AND lower(COALESCE(notion_status, '')) NOT IN ('disabled', 'not_configured')
      AND COALESCE(NULLIF(package_json_path, ''), '') != ''
    ORDER BY COALESCE(updated_at, generated_at, indexed_at) DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(100, Number(limit) || 20)));
  db.close();

  const rootPath = fileURLToPath(new URL("../../..", import.meta.url));
  const results = [];
  for (const row of rows) {
    try {
      const page = await replayXiaohongshuPackageToNotion({
        baseDir: rootPath,
        packagePath: row.package_json_path,
      });
      const notion = {
        status: "written",
        pageId: page.pageId,
        url: page.url,
        target: page.target,
        relationCount: page.relationCount || 0,
        uploadedImageCount: page.uploadedImageCount || 0,
        warning: page.warning || null,
      };
      patchPackageNotionResult(row.package_json_path, notion);
      const writeDb = openLocalDb();
      initLocalDb(writeDb);
      try {
        updatePackageNotionRow(writeDb, row, notion);
      } finally {
        writeDb.close();
      }
      results.push({ id: row.id, title: row.title, status: "written", url: page.url || "" });
    } catch (error) {
      const notion = {
        status: "failed",
        pageId: null,
        url: null,
        error: error.message || String(error),
      };
      patchPackageNotionResult(row.package_json_path, notion);
      const writeDb = openLocalDb();
      initLocalDb(writeDb);
      try {
        updatePackageNotionRow(writeDb, row, notion);
      } finally {
        writeDb.close();
      }
      results.push({ id: row.id, title: row.title, status: "failed", error: notion.error });
    }
  }

  return {
    ok: true,
    scanned: rows.length,
    written: results.filter((item) => item.status === "written").length,
    failed: results.filter((item) => item.status === "failed").length,
    results,
  };
}

export async function syncPackageToNotion(id) {
  const db = openLocalDb();
  initLocalDb(db);
  const row = db.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
  db.close();
  if (!row) return null;

  if (String(row.notion_page_id || "").trim()) {
    return {
      ok: true,
      skipped: true,
      item: rowToPackage(row),
    };
  }

  try {
    const rootPath = fileURLToPath(new URL("../../..", import.meta.url));
    const page = await replayXiaohongshuPackageToNotion({
      baseDir: rootPath,
      packagePath: row.package_json_path,
    });
    const notion = {
      status: "written",
      pageId: page.pageId,
      url: page.url,
      target: page.target,
      relationCount: page.relationCount || 0,
      uploadedImageCount: page.uploadedImageCount || 0,
      warning: page.warning || null,
    };
    patchPackageNotionResult(row.package_json_path, notion);
    const writeDb = openLocalDb();
    initLocalDb(writeDb);
    try {
      updatePackageNotionRow(writeDb, row, notion);
      const nextRow = writeDb.prepare("SELECT * FROM content_packages WHERE id = ?").get(id);
      return { ok: true, item: rowToPackage(nextRow), notion };
    } finally {
      writeDb.close();
    }
  } catch (error) {
    const notion = {
      status: "failed",
      pageId: null,
      url: null,
      error: error.message || String(error),
    };
    patchPackageNotionResult(row.package_json_path, notion);
    const writeDb = openLocalDb();
    initLocalDb(writeDb);
    try {
      updatePackageNotionRow(writeDb, row, notion);
    } finally {
      writeDb.close();
    }
    throw error;
  }
}
