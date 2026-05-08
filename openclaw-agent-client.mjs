import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const OPENCLAW_CMD =
  process.env.OPENCLAW_CMD ||
  path.join(process.env.APPDATA || "", "npm", "openclaw.cmd");
const INVOKE_OPENCLAW_PS1 = path.join(process.cwd(), "invoke-openclaw.ps1");

function extractLastJsonObject(text) {
  const input = String(text || "");
  for (const marker of ['"payloads"', '"runId"']) {
    const markerIndex = input.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const start = input.lastIndexOf("{", markerIndex);
      if (start >= 0) {
        const candidate = input.slice(start).trim();
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // Fall through to generic scan.
        }
      }
    }
  }

  const starts = [];
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === "{") starts.push(i);
  }
  if (starts.length === 0) {
    throw new Error(`No JSON object found in output: ${input.slice(0, 200)}`);
  }

  for (let s = starts.length - 1; s >= 0; s -= 1) {
    const start = starts[s];
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < input.length; i += 1) {
      const ch = input[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = input.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error(`Incomplete JSON object in output: ${input.slice(0, 200)}`);
}

function runOpenClawCommand(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      INVOKE_OPENCLAW_PS1,
      ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_CMD },
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OpenClaw command timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = stdout || stderr;
      if (code !== 0 && !combined.includes("{")) {
        reject(new Error(`OpenClaw command failed (${code}): ${combined}`));
        return;
      }
      resolve(combined);
    });
  });
}

export function buildWechatSessionId(prefix, key) {
  const digest = crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

export async function runOpenClawAgent({
  message,
  sessionId,
  timeoutSeconds = 120,
  thinking = "low",
}) {
  const args = [
    "agent",
    "--json",
    "--session-id",
    sessionId,
    "--message",
    message,
    "--timeout",
    String(timeoutSeconds),
    "--thinking",
    thinking,
  ];
  const stdout = await runOpenClawCommand(args, timeoutSeconds * 1000 + 5000);
  const payload = JSON.parse(extractLastJsonObject(stdout));
  const resultBody = payload?.result || payload;
  const text = resultBody?.payloads?.map((entry) => entry?.text || "").filter(Boolean).join("\n").trim() || "";
  return {
    raw: payload,
    text,
    meta: resultBody?.meta?.agentMeta || null,
  };
}
