import { readFile } from "node:fs/promises";

import {
  type RunbookManifest,
  validateRunbookDocument,
  validateRunbookManifest,
} from "../app/reliability/runbook-catalog.ts";

const manifestUrl = new URL(
  "../../../ops/production/runbook-manifest.json",
  import.meta.url,
);

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  validateRunbookManifest(manifest);
  let commandBlocks = 0;
  for (const runbook of (manifest as RunbookManifest).runbooks) {
    const document = await readFile(new URL(`../../../${runbook.path}`, import.meta.url),
      "utf8");
    commandBlocks += validateRunbookDocument(
      runbook,
      document,
      manifest.requiredSections,
    ).commandBlocks;
  }
  console.log(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    runbookCount: manifest.runbooks.length,
    commandBlocks,
    secretLiteralCount: 0,
    result: "passed",
  }));
}

main().catch(() => {
  console.error("P11 Runbook validation failed; document details were suppressed");
  process.exitCode = 1;
});
