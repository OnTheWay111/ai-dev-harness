import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";

import {
  type RecoveryDrillReceipt,
  type RecoveryEntityCheck,
  validateRecoveryReceipt,
} from "../app/reliability/recovery-policy.ts";

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const SAFE_DATABASE = /^harness_recovery_(?:source|target)_[a-z0-9_]{1,40}$/;
const REQUIRED_TABLES = [
  "artifact_objects", "audit_events", "goals", "issues", "runs",
] as const;
let phase = "startup";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeDatabase(value: string): string {
  if (!SAFE_DATABASE.test(value)) throw new Error("Recovery database name is unsafe");
  return value;
}

function quotedIdentifier(value: string): string {
  return `"${safeDatabase(value)}"`;
}

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function postgresEnvironment(urlValue: string): NodeJS.ProcessEnv {
  const url = new URL(urlValue);
  const sslMode = url.searchParams.get("sslmode");
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    ...(sslMode ? { PGSSLMODE: sslMode } : {}),
  };
}

function binary(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!(isAbsolute(value) || /^[a-z][a-z0-9_-]{1,40}$/.test(value))) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function rowsSha256(rows: readonly Record<string, unknown>[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const ENTITY_QUERIES: Readonly<Record<string, string>> = {
  goal: `SELECT id,version,status,updated_at FROM goals ORDER BY id`,
  issue: `SELECT id,version,status,body_digest,updated_at FROM issues ORDER BY id`,
  run: `SELECT id,version,status,request_id,updated_at FROM runs ORDER BY id`,
  audit: `SELECT id,entity_id,entity_version,request_id,created_at
    FROM audit_events ORDER BY id`,
  artifact_digest: `SELECT id,object_key,digest,size_bytes,retention_policy,
    retention_until,created_at FROM artifact_objects ORDER BY id`,
};

async function facts(pool: InstanceType<typeof Pool>): Promise<{
  checks: Map<string, { count: number; sha256: string }>;
  migrationLedgerSha256: string;
  schemaTables: string[];
  artifactRetentionVerified: boolean;
}> {
  const schema = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name=ANY($1::text[])
      ORDER BY table_name`,
    [REQUIRED_TABLES],
  );
  const schemaTables = schema.rows.map((row) => row.table_name);
  if (schemaTables.length !== REQUIRED_TABLES.length) {
    throw new Error("Recovery schema is incomplete");
  }
  const ledger = await pool.query<Record<string, unknown>>(
    `SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
  );
  if (ledger.rows.length < 1) throw new Error("Recovery migration ledger is empty");
  const checks = new Map<string, { count: number; sha256: string }>();
  for (const [entity, sql] of Object.entries(ENTITY_QUERIES)) {
    const result = await pool.query<Record<string, unknown>>(sql);
    if (result.rows.length < 1) throw new Error(`Recovery ${entity} fixture is empty`);
    checks.set(entity, {
      count: result.rows.length,
      sha256: rowsSha256(result.rows),
    });
  }
  const retention = await pool.query<{ valid: boolean }>(
    `SELECT bool_and(retention_policy IN
       ('standard_180d','extended_365d','legal_hold')
       AND retention_until > created_at
       AND digest ~ '^[0-9a-f]{64}$') AS valid
     FROM artifact_objects`,
  );
  return {
    checks,
    migrationLedgerSha256: rowsSha256(ledger.rows),
    schemaTables,
    artifactRetentionVerified: retention.rows[0]?.valid === true,
  };
}

async function dropTarget(
  admin: InstanceType<typeof Pool>,
  targetDatabase: string,
): Promise<void> {
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [targetDatabase],
  );
  await admin.query(`DROP DATABASE ${quotedIdentifier(targetDatabase)}`);
}

async function main(): Promise<void> {
  phase = "configuration";
  if (process.env.RECOVERY_SOURCE_QUIESCED !== "true") {
    throw new Error("RECOVERY_SOURCE_QUIESCED=true is required for comparable facts");
  }
  const started = new Date();
  const drillId = required("RECOVERY_DRILL_ID");
  const adminUrl = required("RECOVERY_ADMIN_DATABASE_URL");
  const sourceUrl = required("RECOVERY_SOURCE_DATABASE_URL");
  const sourceDatabase = safeDatabase(databaseName(sourceUrl));
  const targetDatabase = safeDatabase(required("RECOVERY_TARGET_DATABASE"));
  if (sourceDatabase === targetDatabase) throw new Error("Recovery target must be isolated");
  const receiptPath = required("RECOVERY_RECEIPT_PATH");
  if (!isAbsolute(receiptPath) || !receiptPath.endsWith(".json")) {
    throw new Error("RECOVERY_RECEIPT_PATH must be an absolute JSON path");
  }
  const temporary = await mkdtemp(join(tmpdir(), "harness-recovery-drill-"));
  const backupPath = join(temporary, "database.dump");
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const source = new Pool({ connectionString: sourceUrl, max: 1 });
  let target: InstanceType<typeof Pool> | undefined;
  let targetCreated = false;
  try {
    phase = "target_preflight";
    const exists = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists",
      [targetDatabase],
    );
    if (exists.rows[0]?.exists) throw new Error("Recovery target already exists");
    phase = "source_verification";
    const sourceFacts = await facts(source);
    const checkpoint = await source.query<{ recovery_point: Date }>(
      "SELECT CURRENT_TIMESTAMP AS recovery_point",
    );
    phase = "backup";
    await execFileAsync(binary("RECOVERY_PG_DUMP_BIN", "pg_dump"), [
      "--format=custom", "--no-owner", "--no-privileges", "--file", backupPath,
    ], { env: postgresEnvironment(sourceUrl), maxBuffer: 1024 * 1024 });
    await chmod(backupPath, 0o600);

    phase = "isolated_target_create";
    await admin.query(`CREATE DATABASE ${quotedIdentifier(targetDatabase)}`);
    targetCreated = true;
    const targetUrl = databaseUrl(adminUrl, targetDatabase);
    phase = "restore";
    await execFileAsync(binary("RECOVERY_PG_RESTORE_BIN", "pg_restore"), [
      "--exit-on-error", "--no-owner", "--no-privileges",
      "--dbname", targetDatabase, backupPath,
    ], { env: postgresEnvironment(targetUrl), maxBuffer: 1024 * 1024 });
    target = new Pool({ connectionString: targetUrl, max: 1 });
    phase = "target_verification";
    const targetFacts = await facts(target);
    const entityChecks: RecoveryEntityCheck[] = [];
    for (const entity of Object.keys(ENTITY_QUERIES)) {
      const sourceCheck = sourceFacts.checks.get(entity);
      const targetCheck = targetFacts.checks.get(entity);
      if (!sourceCheck || !targetCheck) throw new Error("Recovery entity check missing");
      entityChecks.push({
        entity,
        sourceCount: sourceCheck.count,
        targetCount: targetCheck.count,
        sourceSha256: sourceCheck.sha256,
        targetSha256: targetCheck.sha256,
        matched: sourceCheck.count === targetCheck.count &&
          sourceCheck.sha256 === targetCheck.sha256,
      });
    }
    if (entityChecks.some((check) => !check.matched) ||
      sourceFacts.migrationLedgerSha256 !== targetFacts.migrationLedgerSha256 ||
      !targetFacts.artifactRetentionVerified) {
      throw new Error("Recovery fact verification failed");
    }
    const completed = new Date();
    const recoveryPoint = checkpoint.rows[0]?.recovery_point;
    if (!recoveryPoint) throw new Error("Recovery point was not recorded");
    const receipt: RecoveryDrillReceipt = {
      schemaVersion: "harness.recovery-drill.v1",
      drillId,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationSeconds: Number(((completed.getTime() - started.getTime()) / 1_000)
        .toFixed(3)),
      rpoMinutes: 15,
      rtoMinutes: 240,
      observedRecoveryPointAgeMinutes: Number(
        ((completed.getTime() - recoveryPoint.getTime()) / 60_000).toFixed(3),
      ),
      sourceDatabase,
      targetDatabase,
      isolatedTarget: true,
      backupArtifactSha256: await fileSha256(backupPath),
      migrationLedgerSha256: targetFacts.migrationLedgerSha256,
      schemaTables: targetFacts.schemaTables,
      entityChecks,
      artifactRetentionVerified: true,
      result: "passed",
      gaps: [],
    };
    phase = "receipt_validation";
    validateRecoveryReceipt(receipt);
    phase = "receipt_write";
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    phase = "complete";
    console.log(JSON.stringify({
      schemaVersion: receipt.schemaVersion,
      drillId: receipt.drillId,
      result: receipt.result,
      durationSeconds: receipt.durationSeconds,
      receiptPath,
    }));
  } finally {
    await target?.end();
    await source.end();
    if (targetCreated && process.env.RECOVERY_CLEANUP_TARGET === "true") {
      await dropTarget(admin, targetDatabase);
    }
    await admin.end();
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error(
    `Recovery drill failed at ${phase}; database and credential details were suppressed`,
  );
  process.exitCode = 1;
});
