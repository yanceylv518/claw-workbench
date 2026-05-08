import fs from "node:fs";
import path from "node:path";

const NOTION_VERSION = "2022-06-28";
const configPath = path.join(process.cwd(), "notion-ai-intel.config.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function inferCategory(text) {
  const normalized = String(text || "").trim();
  if (/自媒体|选题|内容|文案|写作|短视频|小红书|抖音/i.test(normalized)) {
    return "自媒体选题";
  }
  if (/行业|赛道|竞品|市场|企业|公司|产业|投融资/i.test(normalized)) {
    return "行业情报";
  }
  return "AI情报";
}

async function notionFetch(url, token, method = "GET", body = null) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion API ${method} ${url} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function getPlainText(property) {
  if (!property) return "";
  if (property.type === "title") return (property.title || []).map((v) => v?.plain_text || "").join("").trim();
  if (property.type === "rich_text") return (property.rich_text || []).map((v) => v?.plain_text || "").join("").trim();
  if (property.type === "url") return property.url || "";
  if (property.type === "select") return property.select?.name || "";
  return "";
}

async function ensureCategoryProperty(databaseId, token, propertyName) {
  const db = await notionFetch(`https://api.notion.com/v1/databases/${databaseId}`, token);
  if (db?.properties?.[propertyName]) return false;
  await notionFetch(`https://api.notion.com/v1/databases/${databaseId}`, token, "PATCH", {
    properties: {
      [propertyName]: {
        select: {
          options: [
            { name: "AI情报", color: "blue" },
            { name: "自媒体选题", color: "pink" },
            { name: "行业情报", color: "green" }
          ]
        }
      }
    }
  });
  return true;
}

async function queryAllPages(databaseId, token) {
  const pages = [];
  let startCursor = undefined;
  while (true) {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const data = await notionFetch(`https://api.notion.com/v1/databases/${databaseId}/query`, token, "POST", body);
    pages.push(...(data.results || []));
    if (!data.has_more) break;
    startCursor = data.next_cursor;
  }
  return pages;
}

async function updatePageCategory(pageId, token, propertyName, category) {
  await notionFetch(`https://api.notion.com/v1/pages/${pageId}`, token, "PATCH", {
    properties: {
      [propertyName]: {
        select: { name: category }
      }
    }
  });
}

async function main() {
  const config = readJson(configPath);
  const token = String(config?.notion?.token || "").trim();
  const databaseId = String(config?.notion?.database_id || "").trim();
  const propertyMap = config?.notion?.property_map || {};
  const categoryName = propertyMap.category || "分类";
  const titleName = propertyMap.title || "标题";
  const summaryName = propertyMap.summary || "总结";
  const usageName = propertyMap.usage || "用途";
  const linkName = propertyMap.link || "链接";

  if (!token || !databaseId) throw new Error("Missing Notion token or database id");

  const propertyCreated = await ensureCategoryProperty(databaseId, token, categoryName);
  const pages = await queryAllPages(databaseId, token);

  let updatedCount = 0;
  let skippedCount = 0;
  for (const page of pages) {
    const props = page.properties || {};
    if (props?.[categoryName]?.select?.name) {
      skippedCount += 1;
      continue;
    }
    const haystack = [
      getPlainText(props[titleName]),
      getPlainText(props[summaryName]),
      getPlainText(props[usageName]),
      getPlainText(props[linkName]),
    ].join(" ");
    const category = inferCategory(haystack);
    await updatePageCategory(page.id, token, categoryName, category);
    updatedCount += 1;
  }

  console.log(JSON.stringify({
    ok: true,
    propertyCreated,
    totalPages: pages.length,
    updatedCount,
    skippedCount,
    categoryName,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
});
