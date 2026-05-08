const CONSOLE_BASE_URL = process.env.XIAOLONGXIA_CONSOLE_BASE_URL || "http://127.0.0.1:3100";

async function postConsole(path, body) {
  const response = await fetch(`${CONSOLE_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Console request failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

export function getViralServiceInfo() {
  return {
    mode: "console-adapter",
    consoleBaseUrl: CONSOLE_BASE_URL,
  };
}

export async function parseXhsReference(input) {
  return postConsole("/api/xhs-parse", input);
}

export async function runViralAnalysis(input) {
  return postConsole("/api/viral-analysis", input);
}
