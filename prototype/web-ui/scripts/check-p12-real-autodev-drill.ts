import { readFile } from "node:fs/promises";

import { validateP12RealAutoDevDrillReport } from
  "../app/reliability/p12-real-autodev-drill.ts";

const reportUrl = new URL(
  "../../../docs/evidence/p12-real-autodev-drill-2026-08-05.json",
  import.meta.url,
);

async function main(): Promise<void> {
  const report = JSON.parse(await readFile(reportUrl, "utf8"));
  const result = validateP12RealAutoDevDrillReport(report);
  console.log(JSON.stringify({
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    issueCount: result.issueCount,
    assertionCount: result.assertionCount,
    result: report.result,
  }));
}

main().catch(() => {
  console.error("P12 real AutoDev/Codex drill evidence validation failed");
  process.exitCode = 1;
});
