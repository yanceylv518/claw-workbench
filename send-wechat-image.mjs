import path from "node:path";
import { loadTarget, sendWechatImage, sendWechatText } from "./wechat-proactive-client.mjs";

const filePath = process.argv[2] ? path.resolve(process.argv[2]) : "";
const note = process.argv.slice(3).join(" ").trim();

if (!filePath) {
  throw new Error("Usage: node send-wechat-image.mjs <image-path> [note]");
}

const target = loadTarget();
if (note) {
  await sendWechatText(target, note, "manual-image-note");
}
await sendWechatImage(target, filePath, "manual-image");
console.log(JSON.stringify({ ok: true, filePath, toUserId: target.toUserId }, null, 2));
