import { Pool } from "pg";

import {
  PostgresWorkbenchProjectionPublisher,
  PostgresWorkbenchProjectionSource,
} from "../app/workbench/projection/postgres-workbench-projector.ts";
import { WorkbenchProjectionRunner } from
  "../app/workbench/projection/workbench-projection-runner.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("Workbench projector requires its database Secret");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const source = new PostgresWorkbenchProjectionSource({
  pool,
  scopeId: process.env.WORKBENCH_SCOPE_ID?.trim() || "default",
});
const runner = new WorkbenchProjectionRunner({
  source,
  publisher: new PostgresWorkbenchProjectionPublisher(pool),
});
const once = process.env.WORKBENCH_PROJECTOR_ONCE === "true";
const replay = process.env.WORKBENCH_PROJECTOR_REPLAY === "true";
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

try {
  do {
    try {
      if (replay) {
        await Promise.all(
          (await source.listScopes()).map((scope) => runner.replay(scope)),
        );
      } else {
        await runner.runOnce();
      }
    } catch {
      // Keep the last successful projection and retry. Never print database
      // errors because driver messages may contain sensitive connection data.
      process.stderr.write("Workbench projector tick failed; retaining last successful projection\n");
    }
    if (!once && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } while (!once && !replay && !stopping);
} finally {
  await pool.end();
}
