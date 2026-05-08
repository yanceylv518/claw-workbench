import fs from "node:fs";
import path from "node:path";
import { loadTarget, sendWechatText } from "./wechat-proactive-client.mjs";

const TEMPLATE_PATH = path.join(process.cwd(), "wechat-proactive-templates.json");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function buildTemplateMessage(name, template) {
  const lines = [];
  if (template.title) lines.push(template.title);
  if (template.title) lines.push("");
  for (const line of template.body || []) lines.push(line);
  if (template.close) {
    lines.push("");
    lines.push(template.close);
  }
  return lines.join("\n");
}

const templateName = String(process.argv[2] || "").trim();
if (!templateName) {
  throw new Error("Usage: node send-wechat-template-message.mjs <template-name>");
}

const config = readJson(TEMPLATE_PATH, {});
const template = config?.templates?.[templateName];
if (!template) {
  const available = Object.keys(config?.templates || {}).join(", ");
  throw new Error(`Unknown template: ${templateName}. Available: ${available}`);
}

const target = loadTarget();
const text = buildTemplateMessage(templateName, template);
await sendWechatText(target, text, `template-${templateName}`);
console.log(JSON.stringify({ ok: true, template: templateName, toUserId: target.toUserId }, null, 2));
