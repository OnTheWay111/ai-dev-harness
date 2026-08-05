import { readFile } from "node:fs/promises";

import { validateMigrationPolicy } from
  "../app/reliability/migration-release.ts";

async function main(): Promise<void> {
  const path = new URL(
    "../../../ops/production/migration-policy.json",
    import.meta.url,
  );
  validateMigrationPolicy(JSON.parse(await readFile(path, "utf8")));
  console.log("P11 expand/migrate/contract policy passed");
}

main().catch(() => {
  console.error("P11 migration policy check failed");
  process.exitCode = 1;
});
