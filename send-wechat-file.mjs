import path from "node:path";
import { loadTarget, sendWechatFile, sendWechatText } from "./wechat-proactive-client.mjs";

const filePath = process.argv[2] ? path.resolve(process.argv[2]) : "";
const note = process.argv.slice(3).join(" ").trim();

if (!filePath) {
  throw new Error("Usage: node send-wechat-file.mjs <file-path> [note]");
}

const target = loadTarget();
if (note) {
  await sendWechatText(target, note, "manual-file-note");
}
await sendWechatFile(target, filePath, path.basename(filePath), "manual-file");
console.log(JSON.stringify({ ok: true, filePath, toUserId: target.toUserId }, null, 2));
