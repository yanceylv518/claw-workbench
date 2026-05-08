import { loadTarget, sendWechatText } from "./wechat-proactive-client.mjs";

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  throw new Error("Usage: node send-wechat-proactive-message.mjs \"message text\"");
}

const target = loadTarget();
await sendWechatText(target, text, "manual");
console.log(JSON.stringify({ ok: true, toUserId: target.toUserId }, null, 2));
