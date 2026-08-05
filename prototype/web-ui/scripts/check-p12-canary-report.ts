import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { validateP12CanaryReport } from "../app/reliability/p12-canary-gate.ts";

function reportPath(): string {
  const index = process.argv.indexOf("--report");
  const path = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!path || !isAbsolute(path) || !path.endsWith(".json")) {
    throw new Error("--report must be an absolute JSON path");
  }
  return path;
}

async function main(): Promise<void> {
  const report = JSON.parse(await readFile(reportPath(), "utf8"));
  const result = validateP12CanaryReport(report);
  console.log(JSON.stringify({
    schemaVersion: report.schemaVersion,
    canaryId: report.canaryId,
    durationHours: result.durationHours,
    windowCount: result.windowCount,
    p2Count: result.p2Count,
    result: report.result,
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Canary validation failed";
  console.error(message.replace(/\/(?:Users|home|private|tmp)\/[^\s]+/g, "[REDACTED_PATH]"));
  process.exitCode = 1;
});
