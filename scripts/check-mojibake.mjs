import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TARGETS = ["apps/web/src", "apps/api", "apps/hermes-worker", "packages"];
const EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx", ".css", ".json"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", "backups"]);
const PATTERNS = [
  /�/,
  /锟/,
  /拷/,
  /鍙|浠|杩|涓|鐨|绛|鏂|鏍|熻|鎴|瀹|姝|寰|傛|唴|悗|叆|彂|竴|満|妯/,
  /\?{5,}/,
];

async function walk(dir, files = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(path.join(dir, entry.name));
  }
  return files;
}

const files = [];
for (const target of TARGETS) {
  await walk(path.join(ROOT, target), files);
}

const findings = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (PATTERNS.some((pattern) => pattern.test(line))) {
      findings.push({ file: path.relative(ROOT, file), line: index + 1, text: line.trim().slice(0, 220) });
    }
  });
}

if (findings.length) {
  console.error(`Mojibake check failed: ${findings.length} suspicious line(s).`);
  for (const item of findings.slice(0, 80)) {
    console.error(`${item.file}:${item.line} ${item.text}`);
  }
  if (findings.length > 80) console.error(`...and ${findings.length - 80} more`);
  process.exit(1);
}

console.log("Mojibake check passed.");
