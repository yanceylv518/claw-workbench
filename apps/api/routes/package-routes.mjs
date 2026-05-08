import {
  appendPackageReworkRecord,
  generatePackageImageAsset,
  getPackage,
  getPackagePrefillStatus,
  listPackages,
  launchPackagePrefill,
  syncPackageIndex,
  syncPackageToNotion,
  updatePackageImagePrompt,
  updatePackageManualReview,
  uploadPackageImageAsset,
} from "../services/package-service.mjs";
import { readJsonBody, sendJson } from "../utils/http.mjs";

export async function handlePackageRoute({ req, res, url }) {
  if (url.pathname === "/api/local/packages" && req.method === "GET") {
    sendJson(res, listPackages(url));
    return true;
  }

  if (url.pathname === "/api/local/packages/sync" && req.method === "POST") {
    sendJson(res, await syncPackageIndex());
    return true;
  }

  if (url.pathname === "/api/local/packages/prefill-status" && req.method === "GET") {
    sendJson(res, getPackagePrefillStatus() ?? { ok: false, stage: "idle", message: "暂无预填状态" });
    return true;
  }

  const packageSyncMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)\/sync-notion$/);
  if (packageSyncMatch && req.method === "POST") {
    const result = await syncPackageToNotion(decodeURIComponent(packageSyncMatch[1]));
    sendJson(res, result ?? { error: "Package not found" }, result ? 200 : 404);
    return true;
  }

  const packageReviewMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)\/manual-review$/);
  if (packageReviewMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = updatePackageManualReview(decodeURIComponent(packageReviewMatch[1]), body);
    sendJson(res, result ?? { error: "Package not found" }, result ? 200 : 404);
    return true;
  }

  const packageImagePromptMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)\/image-prompt$/);
  if (packageImagePromptMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = updatePackageImagePrompt(decodeURIComponent(packageImagePromptMatch[1]), body);
    sendJson(res, result ?? { error: "Package not found" }, result ? 200 : 404);
    return true;
  }

  const packageImageGenerateMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)\/generate-image$/);
  if (packageImageGenerateMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = await generatePackageImageAsset(decodeURIComponent(packageImageGenerateMatch[1]), body);
    sendJson(res, result ?? { error: "Package not found" }, result ? 200 : 404);
    return true;
  }

  const packageImageUploadMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)\/upload-image$/);
  if (packageImageUploadMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = uploadPackageImageAsset(decodeURIComponent(packageImageUploadMatch[1]), body);
    sendJson(res, result ?? { error: "Package not found" }, result ? 200 : 404);
    return true;
  }

  const packagePrefillMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)\/prefill-xhs$/);
  if (packagePrefillMatch && req.method === "POST") {
    const result = launchPackagePrefill(decodeURIComponent(packagePrefillMatch[1]));
    sendJson(res, result ?? { error: "Package not found" }, result ? 200 : 404);
    return true;
  }

  const packageReworkMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)\/rework-records$/);
  if (packageReworkMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = appendPackageReworkRecord(decodeURIComponent(packageReworkMatch[1]), body);
    sendJson(res, result ?? { error: "Package not found" }, result ? 200 : 404);
    return true;
  }

  const packageMatch = url.pathname.match(/^\/api\/local\/packages\/([^/]+)$/);
  if (packageMatch && req.method === "GET") {
    const item = getPackage(decodeURIComponent(packageMatch[1]));
    sendJson(res, item ?? { error: "Package not found" }, item ? 200 : 404);
    return true;
  }

  return false;
}
