import fs from "node:fs";
import path from "node:path";
import { loadTarget, sendWechatFile, sendWechatText } from "./wechat-proactive-client.mjs";

const OUTPUT_DIR = path.join(process.cwd(), ".wechat-direct-bridge", "test-images");
const CONFIG_PATH = path.join(process.cwd(), "notion-ai-intel.config.json");

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeImageFromResponse(item, targetPath) {
  if (typeof item === "string" && item.startsWith("data:image/")) {
    const [, base64] = item.split(",", 2);
    if (!base64) throw new Error("Image data URI is missing base64 payload");
    fs.writeFileSync(targetPath, Buffer.from(base64, "base64"));
    return;
  }

  if (item?.b64_json) {
    fs.writeFileSync(targetPath, Buffer.from(item.b64_json, "base64"));
    return;
  }

  if (item?.image_base64) {
    fs.writeFileSync(targetPath, Buffer.from(item.image_base64, "base64"));
    return;
  }

  if (item?.image_url?.url) {
    const response = await fetch(item.image_url.url);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(targetPath, buffer);
    return;
  }

  if (item?.url) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(targetPath, buffer);
    return;
  }

  throw new Error("Image generation returned no image payload");
}

async function main() {
  const prompt =
    process.argv.slice(2).join(" ").trim() ||
    "一只穿着宇航服的猫咪在太空中漂浮，背景是星空和行星，高清，构图完整";
  const config = readJson(CONFIG_PATH, {});
  const imageConfig = config?.image_generation || {};
  if (!imageConfig.api_key || !imageConfig.base_url || !imageConfig.model) {
    throw new Error("Missing image_generation config");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(OUTPUT_DIR, `${stamp}-gpt-image-2-test.png`);

  const body = {
    model: imageConfig.model,
    prompt,
    size: imageConfig.size || "1024x1024",
    quality: imageConfig.quality || "high",
    response_format: imageConfig.response_format || "b64_json",
    output_format: "png",
  };

  const response = await fetch(new URL("images/generations", imageConfig.base_url).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${imageConfig.api_key}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Image generation failed: ${response.status} ${text}`);
  }

  const data = JSON.parse(text);
  const item = data?.data?.[0];
  await writeImageFromResponse(item, filePath);

  const target = loadTarget();
  await sendWechatText(target, "gpt-image-2 生图测试完成，下面给你发图片文件。", "image-test");
  await sendWechatFile(target, filePath, path.basename(filePath), "image-test-file");

  console.log(JSON.stringify({ ok: true, filePath, prompt }, null, 2));
}

await main();
