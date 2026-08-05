import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from
  "node:http";
import { createServer as createNetServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import pg, { type PoolClient } from "pg";

import {
  buildAtomicMigrationSql,
  loadPostgresMigrations,
} from "./postgres-migration.ts";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const migrationsDirectory = new URL("../drizzle-postgres/", import.meta.url);
const webUiDirectory = new URL("../", import.meta.url);
const fixed = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  issuer: "https://p12-issuer.example.invalid",
  clientId: "p12-browser-client",
  subject: "p12-approver",
  releaseGoalId: "00000000-0000-4000-8000-0000000000a1",
  releaseSpecId: "00000000-0000-4000-8000-0000000000a2",
  releaseIssuePlanId: "00000000-0000-4000-8000-0000000000a3",
  releaseVerificationPlanId: "00000000-0000-4000-8000-0000000000a4",
  releaseVerificationId: "00000000-0000-4000-8000-0000000000a5",
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("P12 fake AutoDev port allocation failed"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function encodeBridgeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return { __p12Type: "date", value: value.toISOString() };
  }
  if (Buffer.isBuffer(value)) {
    return { __p12Type: "bytes", value: value.toString("base64") };
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(encodeBridgeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, encodeBridgeValue(item)]));
  }
  return value;
}

async function startPostgresBridge(
  pool: InstanceType<typeof Pool>,
): Promise<{
  url: string;
  token: string;
  cleanup(): Promise<void>;
}> {
  const port = await freePort();
  const token = randomUUID();
  const sessions = new Map<string, PoolClient>();
  let transientFailures = 0;
  const server: HttpServer = createHttpServer((request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      if (request.method !== "POST" || request.url !== "/query" ||
        request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > 2_000_000) throw new Error("P12 bridge request is too large");
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        operation?: unknown;
        sessionId?: unknown;
        text?: unknown;
        values?: unknown;
      };
      if (body.operation === "connect") {
        const sessionId = randomUUID();
        sessions.set(sessionId, await pool.connect());
        response.end(JSON.stringify({ result: { sessionId } }));
        return;
      }
      if (body.operation === "fail_next_query") {
        transientFailures += 1;
        response.end(JSON.stringify({ result: { pending: transientFailures } }));
        return;
      }
      if (body.operation === "release" && typeof body.sessionId === "string") {
        const client = sessions.get(body.sessionId);
        if (client) {
          sessions.delete(body.sessionId);
          client.release();
        }
        response.end(JSON.stringify({ result: null }));
        return;
      }
      if (body.operation === "query" && typeof body.text === "string" &&
        Array.isArray(body.values)) {
        if (transientFailures > 0) {
          transientFailures -= 1;
          response.writeHead(503).end(JSON.stringify({
            error: "simulated transient database failure",
          }));
          return;
        }
        const executor = typeof body.sessionId === "string"
          ? sessions.get(body.sessionId)
          : pool;
        if (!executor) throw new Error("P12 bridge session is unavailable");
        const result = await executor.query(body.text, body.values);
        response.end(JSON.stringify({
          result: encodeBridgeValue({
            rows: result.rows,
            rowCount: result.rowCount,
          }),
        }));
        return;
      }
      response.writeHead(400).end(JSON.stringify({ error: "invalid_request" }));
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "query_failed";
      console.error(`P12 PostgreSQL bridge query failed: ${message}`);
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ error: message }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}/query`,
    token,
    async cleanup() {
      for (const client of sessions.values()) client.release(true);
      sessions.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function startAutoDevFake(): Promise<{
  url: string;
  token: string;
  imports: Array<Record<string, unknown>>;
  cleanup(): Promise<void>;
}> {
  const port = await freePort();
  const token = randomUUID();
  const imports: Array<Record<string, unknown>> = [];
  const server = createHttpServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/api/v1/queue/import" ||
        request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        planDigest: string;
        tasks: Array<{ issueKey: string }>;
      };
      imports.push(body as unknown as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        importId: "p12-import-1",
        atomic: true,
        planDigest: body.planDigest,
        tasks: body.tasks.map((task, index) => ({
          issueKey: task.issueKey,
          externalTaskId: `H-${String(index + 1).padStart(3, "0")}`,
        })),
      }));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}/api/v1/queue/import`,
    token,
    imports,
    async cleanup() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function startPostgres(): Promise<{
  adminUrl: string;
  dataDirectory: string;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "ai-dev-harness-p12-pg-"));
  const port = await freePort();
  try {
    await execFileAsync("initdb", [
      "-D", dataDirectory,
      "--username=postgres",
      "--auth=trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    await execFileAsync("pg_ctl", [
      "-D", dataDirectory,
      "-l", join(dataDirectory, "postgres.log"),
      "-o", `-h 127.0.0.1 -p ${port}`,
      "-w", "start",
    ]);
    return {
      adminUrl: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      dataDirectory,
    };
  } catch (error) {
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function stopPostgres(dataDirectory: string): Promise<void> {
  await execFileAsync("pg_ctl", [
    "-D", dataDirectory,
    "-m", "fast",
    "-w", "stop",
  ]);
  if (dirname(dataDirectory) !== tmpdir() ||
    !basename(dataDirectory).startsWith("ai-dev-harness-p12-pg-")) {
    throw new Error("Refusing to remove an unexpected P12 PostgreSQL directory");
  }
  await rm(dataDirectory, { recursive: true, force: true });
}

async function startDockerPostgres(): Promise<{
  adminUrl: string;
  cleanup(): Promise<void>;
}> {
  const port = await freePort();
  const containerName = `ai-dev-harness-p12-pg-${process.pid}-${Date.now()}`;
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(containerName)) {
    throw new Error("P12 PostgreSQL container identity is invalid");
  }
  await execFileAsync("docker", [
    "run", "--rm", "--detach",
    "--name", containerName,
    "--publish", `127.0.0.1:${port}:5432`,
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:16",
  ]);
  const adminUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const readiness = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    let connected = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await readiness.query("SELECT 1");
        connected = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!connected) throw new Error("P12 PostgreSQL container did not become ready");
  } catch (error) {
    await execFileAsync("docker", ["stop", containerName]).catch(() => undefined);
    throw error;
  } finally {
    await readiness.end();
  }
  return {
    adminUrl,
    async cleanup() {
      await execFileAsync("docker", ["stop", containerName]);
    },
  };
}

async function startPostgresRuntime(): Promise<{
  adminUrl: string;
  cleanup(): Promise<void>;
}> {
  const configured = process.env.POSTGRES_TEST_ADMIN_URL?.trim();
  if (configured) return { adminUrl: configured, async cleanup() {} };
  try {
    const local = await startPostgres();
    return {
      adminUrl: local.adminUrl,
      async cleanup() { await stopPostgres(local.dataDirectory); },
    };
  } catch {
    return await startDockerPostgres();
  }
}

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("P12 temporary PostgreSQL identifier is invalid");
  }
  return `"${value}"`;
}

function actorId(): string {
  return `oidc_${createHash("sha256")
    .update(`${fixed.issuer}\0${fixed.subject}`)
    .digest("hex")}`;
}

async function seed(pool: InstanceType<typeof Pool>): Promise<void> {
  const generatedAt = new Date();
  const commitSha = "b".repeat(40);
  const task = {
    id: "P12-EXEC-01",
    version: 1,
    goalId: "P12-E2E",
    title: "P12 external fake delivery",
    kind: "issue",
    priority: "P1",
    stage: "review",
    status: { code: "review", label: "Review", tone: "warning" },
    progress: { percent: 100, updatedAt: generatedAt.toISOString() },
    attention: {
      required: false,
      count: 0,
      severity: "none",
      headline: "Contract execution completed",
      rankingReason: "Independent review approved",
      impact: "Ready for Goal verification",
    },
    execution: {
      actorType: "worker",
      actorId: "p12-worker",
      actorLabel: "P12 fake AutoDev",
      elapsedSeconds: 12,
      nextCheckpoint: "Goal verification",
    },
    action: {
      id: "inspect_run",
      label: "查看执行",
      available: true,
      requiredRole: "Viewer",
      targetView: "run",
    },
    detail: {
      dependency: "Approved Issue Plan",
      evidence: "Artifact, Review, Commit and PR recorded",
      workspace: "isolated/p12/H-001",
    },
    deliveryEvidence: {
      artifacts: [{
        id: "00000000-0000-4000-8000-000000000091",
        kind: "test_output",
        digest: "a".repeat(64),
        mediaType: "text/plain",
        sizeBytes: 128,
        createdAt: generatedAt.toISOString(),
      }],
      latestReview: {
        verdict: "approved",
        reviewerType: "model",
        reviewerVersion: "p12-contract-reviewer.v1",
        targetCommitSha: commitSha,
        reviewedAt: generatedAt.toISOString(),
      },
      commitSha,
      push: {
        remoteBranch: "autodev/p12/H-001",
        commitSha,
        pushedAt: generatedAt.toISOString(),
      },
      pullRequest: {
        externalId: "12",
        url: "https://github.example.invalid/acme/p12/pull/12",
        status: "open",
      },
    },
  };
  const summary = {
    metrics: [],
    taskCounts: {
      all: 1,
      attention: 0,
      running: 0,
      review: 1,
      blocked: 0,
      waiting: 0,
    },
  };
  await pool.query(
    `INSERT INTO organizations (id, slug, name)
     VALUES ($1, 'p12-e2e', 'P12 E2E organization')`,
    [fixed.organizationId],
  );
  await pool.query(
    `INSERT INTO projects (id, organization_id, slug, name)
     VALUES ($1, $2, 'p12-e2e', 'P12 E2E project')`,
    [fixed.projectId, fixed.organizationId],
  );
  await pool.query(
    `INSERT INTO role_bindings
       (id, organization_id, actor_id, role, assigned_by_actor_id,
        reason, request_id)
     VALUES ($1, $2, $3, 'organization_owner', 'p12-bootstrap',
             'Authorize the isolated P12 browser owner', 'p12-bootstrap')`,
    [crypto.randomUUID(), fixed.organizationId, actorId()],
  );
  for (const [subject, role] of [
    ["p12-operations", "operator"],
    ["p12-product", "approver"],
    ["p12-project-owner", "project_admin"],
  ]) {
    await pool.query(
      `INSERT INTO role_bindings
         (id,organization_id,project_id,actor_id,role,assigned_by_actor_id,
          reason,request_id)
       VALUES ($1,$2,$3,$4,$5,'p12-bootstrap',
               'Authorize the isolated P12 release role','p12-release-bootstrap')`,
      [
        crypto.randomUUID(),
        fixed.organizationId,
        fixed.projectId,
        `oidc_${createHash("sha256")
          .update(`${fixed.issuer}\0${subject}`)
          .digest("hex")}`,
        role,
      ],
    );
  }
  await pool.query(
    `INSERT INTO goals
       (id,organization_id,project_id,title,problem_statement,desired_outcome,
        status,created_at,updated_at)
     VALUES ($1,$2,$3,'P12 Release Center Canary',
             'Prove the release center through a real browser and PostgreSQL',
             'A digest-bound Production V1 approval','completed',$4,$4)`,
    [fixed.releaseGoalId, fixed.organizationId, fixed.projectId, generatedAt],
  );
  await pool.query(
    `INSERT INTO spec_revisions
       (id,organization_id,project_id,goal_id,revision,status,
        source_goal_version,artifact_ref,artifact_digest,generated_at,
        created_at,updated_at)
     VALUES ($1,$2,$3,$4,1,'approved',1,'artifact://p12-release-spec',$5,$6,$6,$6)`,
    [
      fixed.releaseSpecId,
      fixed.organizationId,
      fixed.projectId,
      fixed.releaseGoalId,
      "1".repeat(64),
      generatedAt,
    ],
  );
  await pool.query(
    `INSERT INTO issue_plan_revisions
       (id,organization_id,project_id,goal_id,spec_revision_id,revision,status,
        source_spec_version,source_spec_digest,plan_data,digest,planner_run_id,
        planner_configuration,compiler_policy_revision,conflict_policy_revision,
        model_router_policy_revision,generated_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,1,'approved',1,$6,'{}'::jsonb,$7,
             'p12-release-planner','{}'::jsonb,'p12-compiler.v1',
             'p12-conflict.v1','p12-router.v1',$8,$8,$8)`,
    [
      fixed.releaseIssuePlanId,
      fixed.organizationId,
      fixed.projectId,
      fixed.releaseGoalId,
      fixed.releaseSpecId,
      "1".repeat(64),
      "2".repeat(64),
      generatedAt,
    ],
  );
  const verificationEntries = [{
    id: "p12-release-entry",
    criterionRef: "criterion:p12-release",
    environment: "test",
    strategy: { type: "artifact", reference: "artifact:p12-release" },
    successCondition: "Release center browser proof passes",
    timeoutMs: 60_000,
    responsibleParty: "p12-release-owner",
  }];
  await pool.query(
    `INSERT INTO acceptance_verification_plans
       (id,organization_id,project_id,goal_id,goal_version,issue_plan_id,
        issue_plan_version,revision,entries,compilation,digest,compiled_at,
        created_at)
     VALUES ($1,$2,$3,$4,1,$5,1,1,$6::jsonb,$7::jsonb,$8,$9,$9)`,
    [
      fixed.releaseVerificationPlanId,
      fixed.organizationId,
      fixed.projectId,
      fixed.releaseGoalId,
      fixed.releaseIssuePlanId,
      JSON.stringify(verificationEntries),
      JSON.stringify({
        valid: true,
        coveredCriterionRefs: ["criterion:p12-release"],
      }),
      "3".repeat(64),
      generatedAt,
    ],
  );
  await pool.query(
    `INSERT INTO goal_verifications
       (id,organization_id,project_id,goal_id,verification_plan_id,
        issue_plan_id,revision,goal_version,verdict,deterministic_results,
        verifier_output,verifier_identity,verifier_version,session_id,
        verified_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,1,'passed',$7::jsonb,$8::jsonb,
             'p12-release-verifier','p12-release-verifier.v1',
             'p12-release-session',$9,$9)`,
    [
      fixed.releaseVerificationId,
      fixed.organizationId,
      fixed.projectId,
      fixed.releaseGoalId,
      fixed.releaseVerificationPlanId,
      fixed.releaseIssuePlanId,
      JSON.stringify([{
        entryId: "p12-release-entry",
        criterionRef: "criterion:p12-release",
        status: "passed",
        evidenceRefs: ["artifact:p12-release"],
        summary: "P12 release fixture passed",
        durationMs: 1,
      }]),
      JSON.stringify({
        schemaVersion: "goal-verifier-output.v1",
        overallVerdict: "passed",
        criteria: [{
          criterionRef: "criterion:p12-release",
          verdict: "passed",
          evidenceRefs: ["artifact:p12-release"],
          rationale: "P12 release fixture passed",
        }],
        nonGoals: [],
        constraints: [],
        regressionRisks: [],
      }),
      generatedAt,
    ],
  );
  await pool.query(
    `INSERT INTO workbench_snapshots
       (scope_id, organization_id, project_id, revision, generated_at, summary)
     VALUES ('p12_e2e', $1, $2, 1, $3, $4::jsonb)`,
    [fixed.organizationId, fixed.projectId, generatedAt, JSON.stringify(summary)],
  );
  await pool.query(
    `INSERT INTO workbench_tasks
       (scope_id, organization_id, project_id, task_id, goal_id, priority,
        stage, attention_required, rank, payload)
     VALUES ('p12_e2e', $1, $2, $3, $4, 'P1', 'review', false, 1, $5::jsonb)`,
    [
      fixed.organizationId,
      fixed.projectId,
      task.id,
      task.goalId,
      JSON.stringify(task),
    ],
  );
}

async function runPlaywright(environment: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(new URL("../", import.meta.url).pathname,
          "node_modules/@playwright/test/cli.js"),
        "test",
        "--config=playwright.p12.config.ts",
      ],
      {
        cwd: webUiDirectory,
        env: environment,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error("P12 browser E2E was interrupted"));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  let phase = "startup";
  let postgresCleanup: (() => Promise<void>) | undefined;
  let adminPool: InstanceType<typeof Pool> | undefined;
  let testPool: InstanceType<typeof Pool> | undefined;
  let databaseName: string | undefined;
  let bridgeCleanup: (() => Promise<void>) | undefined;
  let autoDevCleanup: (() => Promise<void>) | undefined;
  let passed = false;
  let cleanupFailed = false;
  try {
    phase = "local_postgres_start";
    const postgresRuntime = await startPostgresRuntime();
    postgresCleanup = postgresRuntime.cleanup;
    databaseName = `p12_02_${process.pid}_${Date.now()}`;
    adminPool = new Pool({ connectionString: postgresRuntime.adminUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE ${safeIdentifier(databaseName)}`);
    const url = databaseUrl(postgresRuntime.adminUrl, databaseName);
    testPool = new Pool({ connectionString: url, max: 2 });
    phase = "schema_migration";
    await testPool.query("CREATE SCHEMA drizzle");
    await testPool.query(`CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
    await testPool.query(buildAtomicMigrationSql(
      loadPostgresMigrations(migrationsDirectory),
    ));
    phase = "fixture_seed";
    await seed(testPool);
    const bridge = await startPostgresBridge(testPool);
    bridgeCleanup = bridge.cleanup;
    const autoDev = await startAutoDevFake();
    autoDevCleanup = autoDev.cleanup;
    phase = "browser_e2e";
    const status = await runPlaywright({
      ...process.env,
      WORKBENCH_DATA_SOURCE: "postgres",
      WORKBENCH_SCOPE_ID: "p12_e2e",
      DATABASE_URL: url,
      P12_E2E_DATABASE_URL: url,
      HARNESS_P12_CONTRACT_ADAPTERS: "enabled",
      AUTODEV_QUEUE_IMPORT_URL: autoDev.url,
      AUTODEV_QUEUE_IMPORT_TOKEN: autoDev.token,
      P12_POSTGRES_BRIDGE_URL: bridge.url,
      P12_POSTGRES_BRIDGE_TOKEN: bridge.token,
      OIDC_ISSUER: fixed.issuer,
      OIDC_CLIENT_ID: fixed.clientId,
      OIDC_COOKIE_SECRET: Buffer.alloc(32, 12).toString("base64url"),
      OIDC_ALLOWED_RETURN_TO_PATHS: "/,/releases",
    });
    if (status !== 0) throw new Error("P12 browser E2E failed");
    if (autoDev.imports.length !== 1) {
      throw new Error("P12 AutoDev fake did not receive exactly one atomic import");
    }
    passed = true;
    phase = "complete";
  } catch {
    console.error(`P12 browser E2E failed at ${phase}; connection details were suppressed`);
  } finally {
    if (autoDevCleanup) await autoDevCleanup().catch(() => { cleanupFailed = true; });
    if (bridgeCleanup) await bridgeCleanup().catch(() => { cleanupFailed = true; });
    if (testPool) await testPool.end().catch(() => { cleanupFailed = true; });
    if (adminPool && databaseName) {
      try {
        await adminPool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
          [databaseName],
        );
        await adminPool.query(`DROP DATABASE ${safeIdentifier(databaseName)}`);
      } catch {
        cleanupFailed = true;
      }
    }
    if (adminPool) await adminPool.end().catch(() => { cleanupFailed = true; });
    if (postgresCleanup) {
      await postgresCleanup().catch(() => { cleanupFailed = true; });
    }
  }
  if (!passed || cleanupFailed) {
    if (cleanupFailed) console.error("P12 browser E2E cleanup failed");
    return 1;
  }
  console.log(
    "P12 real app/browser/PostgreSQL/external-fake main path passed and all fixtures were destroyed",
  );
  return 0;
}

process.exitCode = await main();
