import { workbenchSnapshot } from "../app/workbench/server/demo-workbench-snapshot.ts";
import {
  createNeonWorkbenchDatabase,
} from "../app/workbench/server/neon-workbench-store.ts";
import { NeonWorkbenchProjectionWriter } from "../app/workbench/server/neon-workbench-projection-writer.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed PostgreSQL");
}

const scopeId = process.env.WORKBENCH_SCOPE_ID?.trim() || "default";
const organizationId = process.env.WORKBENCH_ORGANIZATION_ID?.trim();
const projectId = process.env.WORKBENCH_PROJECT_ID?.trim();
if (!organizationId || !projectId) {
  throw new Error(
    "WORKBENCH_ORGANIZATION_ID and WORKBENCH_PROJECT_ID are required",
  );
}
const database = createNeonWorkbenchDatabase(databaseUrl);
const writer = new NeonWorkbenchProjectionWriter(database);

await writer.replaceProjection(
  { scopeId, organizationId, projectId },
  workbenchSnapshot,
);
console.log(
  `Seeded workbench.v1 revision ${workbenchSnapshot.revision} for scope ${scopeId}`,
);
