import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { validateP12ProductionReleaseGate } from
  "../app/reliability/p12-production-release-gate.ts";

function releasePath(): string {
  const index = process.argv.indexOf("--release");
  const path = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!path || !isAbsolute(path) || !path.endsWith(".json")) {
    throw new Error("--release must be an absolute JSON path");
  }
  return path;
}

async function main(): Promise<void> {
  const release = JSON.parse(await readFile(releasePath(), "utf8"));
  const result = validateP12ProductionReleaseGate(release);
  console.log(JSON.stringify({
    schemaVersion: release.schemaVersion,
    releaseId: release.releaseId,
    candidateCommit: release.candidateCommit,
    gateCount: result.gateCount,
    signatureCount: result.signatureCount,
    attestationDigest: result.attestationDigest,
    result: release.result,
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Release validation failed";
  console.error(message.replace(/\/(?:Users|home|private|tmp)\/[^\s]+/g, "[REDACTED_PATH]"));
  process.exitCode = 1;
});
