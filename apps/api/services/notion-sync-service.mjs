import { syncIntelFromNotion } from "./intel-service.mjs";
import { syncPackageIndex, syncPackagesToNotion } from "./package-service.mjs";

async function capture(step, task) {
  try {
    return {
      step,
      ok: true,
      result: await task(),
    };
  } catch (error) {
    return {
      step,
      ok: false,
      error: error.message || String(error),
    };
  }
}

export async function syncNotionAll({ intelLimit = 100, packageLimit = 20 } = {}) {
  const intel = await capture("intel_from_notion", () => syncIntelFromNotion({ limit: intelLimit }));
  const indexBefore = await capture("package_index_before", () => syncPackageIndex());
  const packages = await capture("packages_to_notion", () => syncPackagesToNotion({ limit: packageLimit }));
  const indexAfter = await capture("package_index_after", () => syncPackageIndex());

  return {
    ok: [intel, indexBefore, packages, indexAfter].some((item) => item.ok),
    steps: {
      intel,
      indexBefore,
      packages,
      indexAfter,
    },
    summary: {
      intelSynced: intel.ok ? Number(intel.result?.synced || 0) : 0,
      packageWritten: packages.ok ? Number(packages.result?.written || 0) : 0,
      packageFailed: packages.ok ? Number(packages.result?.failed || 0) : 0,
      packageScanned: packages.ok ? Number(packages.result?.scanned || 0) : 0,
      hasError: [intel, indexBefore, packages, indexAfter].some((item) => !item.ok),
    },
  };
}
