import { count, eq } from "drizzle-orm";

import type { WorkbenchResponse } from
  "../app/workbench/contracts.ts";
import { workbenchSnapshot } from
  "../app/workbench/server/demo-workbench-snapshot.ts";
import {
  createNeonWorkbenchDatabase,
} from "../app/workbench/server/neon-workbench-store.ts";
import { NeonWorkbenchProjectionWriter } from
  "../app/workbench/server/neon-workbench-projection-writer.ts";
import { resolvePostgresConnection } from
  "../app/workbench/server/postgres-environment.ts";
import {
  workbenchSnapshots,
  workbenchTasks,
} from "../db/postgres-schema.ts";
import {
  validateDevelopmentPostgresEvidence,
  type DevelopmentPostgresEvidence,
} from "./development-postgres-workbench.ts";

const revision = 103;
const marker = `P1-03 PostgreSQL SSR revision ${revision}`;

interface WorkerModule {
  default: {
    fetch(
      request: Request,
      environment: Record<string, unknown>,
      context: Record<string, unknown>,
    ): Promise<Response>;
  };
}

function verificationSnapshot() {
  return {
    ...workbenchSnapshot,
    revision,
    generatedAt: "2026-08-04T05:00:00.000Z",
    tasks: workbenchSnapshot.tasks.map((task, index) =>
      index === 0 ? { ...task, title: marker } : task,
    ),
  };
}

async function loadWorker(): Promise<WorkerModule["default"]> {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "p1-03",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const loaded = await import(workerUrl.href) as WorkerModule;
  return loaded.default;
}

async function fetchWorker(
  worker: WorkerModule["default"],
  path: string,
  headers: HeadersInit = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function readJson(response: Response): Promise<WorkbenchResponse> {
  if (response.status !== 200) {
    throw new Error("P1-03 API request failed");
  }
  return await response.json() as WorkbenchResponse;
}

async function main(): Promise<number> {
  const originalDeploymentEnvironment = process.env.HARNESS_DEPLOYMENT_ENV;
  const originalDataSource = process.env.WORKBENCH_DATA_SOURCE;
  const originalScopeId = process.env.WORKBENCH_SCOPE_ID;
  let database: ReturnType<typeof createNeonWorkbenchDatabase> | undefined;
  let scopeId: string | undefined;
  let cleanupSnapshotCount = -1;
  let cleanupTaskCount = -1;
  let phase = "configuration";
  let evidence: Omit<
    DevelopmentPostgresEvidence,
    "cleanupSnapshotCount" | "cleanupTaskCount"
  > | undefined;

  try {
    const connection = resolvePostgresConnection(process.env, "app");
    if (connection.environment !== "development") {
      throw new Error("P1-03 requires the development database");
    }
    database = createNeonWorkbenchDatabase(connection.databaseUrl);
    scopeId = `p1_03_${crypto.randomUUID().replaceAll("-", "")}`;
    const writer = new NeonWorkbenchProjectionWriter(database);
    phase = "seed";
    await writer.replaceProjection(scopeId, verificationSnapshot());

    delete process.env.HARNESS_DEPLOYMENT_ENV;
    process.env.WORKBENCH_DATA_SOURCE = "postgres";
    process.env.WORKBENCH_SCOPE_ID = scopeId;
    phase = "worker-load";
    const worker = await loadWorker();

    phase = "ssr";
    const ssrResponse = await fetchWorker(worker, "/", {
      accept: "text/html",
    });
    if (ssrResponse.status !== 200) {
      throw new Error("P1-03 SSR request failed");
    }
    const html = await ssrResponse.text();
    if (!html.includes(marker)) {
      throw new Error("P1-03 SSR did not render the PostgreSQL projection");
    }

    phase = "api";
    const allResponse = await fetchWorker(worker, "/api/v1/workbench");
    const all = await readJson(allResponse);
    const firstAttentionResponse = await fetchWorker(
      worker,
      "/api/v1/workbench?filter=attention&limit=2",
    );
    const firstAttention = await readJson(firstAttentionResponse);
    const cursor = String(firstAttention.page?.nextCursor ?? "");
    if (!cursor) {
      throw new Error("P1-03 first attention page has no cursor");
    }
    const secondAttention = await readJson(
      await fetchWorker(
        worker,
        `/api/v1/workbench?filter=attention&limit=2&cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    const goal = await readJson(
      await fetchWorker(
        worker,
        "/api/v1/workbench?goalId=GOAL-2407",
      ),
    );
    const running = await readJson(
      await fetchWorker(worker, "/api/v1/workbench?filter=running"),
    );
    const etag = allResponse.headers.get("etag");
    const notModified = await fetchWorker(worker, "/api/v1/workbench", {
      "if-none-match": etag ?? "",
    });
    const readinessResponse = await fetchWorker(worker, "/health/ready");
    const readiness = await readinessResponse.json() as {
      source?: string;
      checks?: { configuration?: string; database?: string };
    };

    evidence = {
      source: allResponse.headers.get("x-workbench-source") ?? "",
      revision: Number(all.data?.revision),
      ssrRevision: revision,
      taskCounts: all.data?.summary?.taskCounts ?? {},
      attentionPageSizes: [
        firstAttention.data?.tasks?.length ?? -1,
        secondAttention.data?.tasks?.length ?? -1,
      ],
      attentionTotal: Number(firstAttention.page?.total),
      goalTotal: Number(goal.page?.total),
      runningTotal: Number(running.page?.total),
      etagReturned: Boolean(etag),
      notModifiedStatus: notModified.status,
      readinessStatus: readinessResponse.status,
      readinessSource: readiness.source ?? "",
      readinessConfiguration: readiness.checks?.configuration ?? "",
      readinessDatabase: readiness.checks?.database ?? "",
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.message.startsWith("P1-03")
        ? `: ${error.message}`
        : "";
    console.error(
      `P1-03 verification failed at ${phase}${reason}; database and connection details were suppressed`,
    );
    return 1;
  } finally {
    if (database && scopeId) {
      try {
        await database.batch([
          database
            .delete(workbenchTasks)
            .where(eq(workbenchTasks.scopeId, scopeId)),
          database
            .delete(workbenchSnapshots)
            .where(eq(workbenchSnapshots.scopeId, scopeId)),
        ]);
        const [snapshots, tasks] = await database.batch([
          database
            .select({ value: count() })
            .from(workbenchSnapshots)
            .where(eq(workbenchSnapshots.scopeId, scopeId)),
          database
            .select({ value: count() })
            .from(workbenchTasks)
            .where(eq(workbenchTasks.scopeId, scopeId)),
        ]);
        cleanupSnapshotCount = Number(snapshots[0]?.value ?? -1);
        cleanupTaskCount = Number(tasks[0]?.value ?? -1);
      } catch {
        cleanupSnapshotCount = -1;
        cleanupTaskCount = -1;
      }
    }
    if (originalDeploymentEnvironment === undefined) {
      delete process.env.HARNESS_DEPLOYMENT_ENV;
    } else {
      process.env.HARNESS_DEPLOYMENT_ENV = originalDeploymentEnvironment;
    }
    if (originalDataSource === undefined) {
      delete process.env.WORKBENCH_DATA_SOURCE;
    } else {
      process.env.WORKBENCH_DATA_SOURCE = originalDataSource;
    }
    if (originalScopeId === undefined) {
      delete process.env.WORKBENCH_SCOPE_ID;
    } else {
      process.env.WORKBENCH_SCOPE_ID = originalScopeId;
    }
  }

  try {
    phase = "evidence";
    if (!evidence) throw new Error("P1-03 evidence is missing");
    validateDevelopmentPostgresEvidence({
      ...evidence,
      cleanupSnapshotCount,
      cleanupTaskCount,
    });
    console.log(
      "P1-03 development PostgreSQL SSR/API verification passed; isolated scope cleaned",
    );
    return 0;
  } catch (error) {
    const reason =
      error instanceof Error && error.message.startsWith("P1-03")
        ? `: ${error.message}`
        : "";
    console.error(
      `P1-03 verification failed at ${phase}${reason}; database and connection details were suppressed`,
    );
    return 1;
  }
}

process.exitCode = await main();
