import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import pg from "pg";

import {
  evaluateMigrationGate,
  type MigrationDrillReceipt,
  validateMigrationDrillReceipt,
} from "../app/reliability/migration-release.ts";

const { Pool } = pg;
const SAFE_DATABASE = /^harness_recovery_source_[a-z0-9_]{1,40}$/;
const SAFE_TABLE = /^p11_migration_drill_[a-z0-9_]{1,40}$/;
let phase = "startup";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(statements: readonly string[]): string {
  return createHash("sha256").update(statements.join("\n")).digest("hex");
}

function databaseName(value: string): string {
  const name = decodeURIComponent(new URL(value).pathname.replace(/^\//, ""));
  if (!SAFE_DATABASE.test(name)) throw new Error("Migration drill database is unsafe");
  return name;
}

function tableName(value: string): string {
  if (!SAFE_TABLE.test(value)) throw new Error("Migration drill table is unsafe");
  return `"${value}"`;
}

async function main(): Promise<void> {
  phase = "configuration";
  const started = new Date();
  const databaseUrl = required("MIGRATION_DRILL_DATABASE_URL");
  const database = databaseName(databaseUrl);
  const rawTable = required("MIGRATION_DRILL_TABLE");
  const table = tableName(rawTable);
  const receiptPath = required("MIGRATION_DRILL_RECEIPT_PATH");
  if (!isAbsolute(receiptPath) || !receiptPath.endsWith(".json")) {
    throw new Error("MIGRATION_DRILL_RECEIPT_PATH must be an absolute JSON path");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let tableCreated = false;
  const expandStatements = [
    `ALTER TABLE ${rawTable} ADD COLUMN payload_v2 jsonb`,
  ];
  const migrateStatements = [
    `UPDATE ${rawTable} SET payload_v2=jsonb_build_object('value',payload_v1) WHERE payload_v2 IS NULL`,
  ];
  const rollbackStatements = [
    `INSERT INTO ${rawTable} (id,payload_v1) VALUES ($1,$2)`,
    `SELECT payload_v1 FROM ${rawTable} ORDER BY id`,
  ];
  try {
    phase = "preflight";
    const exists = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${rawTable}`],
    );
    if (exists.rows[0]?.exists) throw new Error("Migration drill table already exists");

    phase = "baseline";
    await pool.query(`CREATE TABLE ${table} (
      id uuid PRIMARY KEY,
      payload_v1 text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    tableCreated = true;
    await pool.query(
      `INSERT INTO ${table} (id,payload_v1) VALUES ($1,$2)`,
      ["12000000-0000-4000-8000-000000000001", "baseline-v1"],
    );
    const baseline = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table}`,
    );

    phase = "expand";
    const expandGate = evaluateMigrationGate({
      migrationId: "p11-payload-v2",
      phase: "expand",
      now: new Date().toISOString(),
      statements: expandStatements,
      expandApplied: false,
      dualReadWriteVerified: false,
      idempotentBackfill: false,
      backfillComplete: false,
      remainingRows: baseline.rows[0]?.count ?? 0,
      verificationDigest: "0".repeat(64),
      compatibilityWindowEndsAt: new Date().toISOString(),
      previousAppVersion: "v1",
      candidateAppVersion: "v2",
      activeAppVersions: ["v1"],
      previousAppRollbackVerified: false,
      incompatibleRunningRuns: 1,
      backupReceiptId: "drill-only",
      backupAgeMinutes: 0,
    });
    if (!expandGate.allowed) throw new Error("Migration expand gate rejected drill");
    await pool.query(`ALTER TABLE ${table} ADD COLUMN payload_v2 jsonb`);
    const oldAfterExpand = await pool.query<{ payload_v1: string }>(
      `SELECT payload_v1 FROM ${table} ORDER BY id`,
    );

    phase = "candidate_dual_write";
    await pool.query(
      `INSERT INTO ${table} (id,payload_v1,payload_v2)
       VALUES ($1,$2,$3::jsonb)`,
      ["12000000-0000-4000-8000-000000000002", "candidate-v2",
        JSON.stringify({ value: "candidate-v2" })],
    );
    const afterCandidate = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table}`,
    );
    const oldCandidateRows = await pool.query<{ payload_v1: string }>(
      `SELECT payload_v1 FROM ${table} ORDER BY id`,
    );

    phase = "app_rollback";
    await pool.query(
      `INSERT INTO ${table} (id,payload_v1) VALUES ($1,$2)`,
      ["12000000-0000-4000-8000-000000000003", "rollback-v1"],
    );
    const oldWrite = await pool.query<{ payload_v1: string }>(
      `SELECT payload_v1 FROM ${table} WHERE id=$1`,
      ["12000000-0000-4000-8000-000000000003"],
    );

    phase = "migrate";
    const verificationDigest = sha256(migrateStatements);
    const migrateGate = evaluateMigrationGate({
      migrationId: "p11-payload-v2",
      phase: "migrate",
      now: new Date().toISOString(),
      statements: [],
      expandApplied: true,
      dualReadWriteVerified: oldCandidateRows.rows.length === 2,
      idempotentBackfill: true,
      backfillComplete: false,
      remainingRows: 1,
      verificationDigest,
      compatibilityWindowEndsAt: new Date().toISOString(),
      previousAppVersion: "v1",
      candidateAppVersion: "v2",
      activeAppVersions: ["v1", "v2"],
      previousAppRollbackVerified: true,
      incompatibleRunningRuns: 1,
      backupReceiptId: "drill-only",
      backupAgeMinutes: 0,
    });
    if (!migrateGate.allowed) throw new Error("Migration backfill gate rejected drill");
    await pool.query(
      `UPDATE ${table}
          SET payload_v2=jsonb_build_object('value',payload_v1)
        WHERE payload_v2 IS NULL`,
    );
    await pool.query(
      `UPDATE ${table}
          SET payload_v2=jsonb_build_object('value',payload_v1)
        WHERE payload_v2 IS NULL`,
    );
    const backfill = await pool.query<{ count: number; remaining: number }>(
      `SELECT count(*)::int AS count,
              count(*) FILTER (WHERE payload_v2 IS NULL)::int AS remaining
         FROM ${table}`,
    );
    const newRead = await pool.query<{ payload: string }>(
      `SELECT COALESCE(payload_v2->>'value',payload_v1) AS payload
         FROM ${table} ORDER BY id`,
    );

    phase = "contract_gate";
    const blockedContract = evaluateMigrationGate({
      migrationId: "p11-payload-v2",
      phase: "contract",
      now: new Date().toISOString(),
      statements: [`ALTER TABLE ${rawTable} DROP COLUMN payload_v1`],
      expandApplied: true,
      dualReadWriteVerified: true,
      idempotentBackfill: true,
      backfillComplete: true,
      remainingRows: 0,
      verificationDigest,
      compatibilityWindowEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000)
        .toISOString(),
      previousAppVersion: "v1",
      candidateAppVersion: "v2",
      activeAppVersions: ["v1", "v2"],
      previousAppRollbackVerified: true,
      incompatibleRunningRuns: 1,
      backupReceiptId: "drill-only",
      backupAgeMinutes: 0,
    });
    const baselineRows = baseline.rows[0]?.count ?? 0;
    const afterCandidateRows = afterCandidate.rows[0]?.count ?? 0;
    const afterBackfillRows = backfill.rows[0]?.count ?? 0;
    const remainingNulls = backfill.rows[0]?.remaining ?? -1;
    if (baselineRows !== 1 || afterCandidateRows !== 2 ||
      afterBackfillRows !== 3 || remainingNulls !== 0 ||
      oldAfterExpand.rows[0]?.payload_v1 !== "baseline-v1" ||
      !oldCandidateRows.rows.some((row) => row.payload_v1 === "candidate-v2") ||
      oldWrite.rows[0]?.payload_v1 !== "rollback-v1" ||
      !newRead.rows.some((row) => row.payload === "rollback-v1") ||
      blockedContract.allowed) {
      throw new Error("Migration compatibility or rollback facts failed");
    }
    const completed = new Date();
    const receipt: MigrationDrillReceipt = {
      schemaVersion: "harness.migration-rollback-drill.v1",
      drillId: required("MIGRATION_DRILL_ID"),
      migrationId: "p11-payload-v2",
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationSeconds: Number(((completed.getTime() - started.getTime()) / 1_000)
        .toFixed(3)),
      database,
      table: rawTable,
      phases: [
        { phase: "expand", result: "passed", statementsSha256: sha256(expandStatements) },
        { phase: "migrate", result: "passed", statementsSha256: verificationDigest },
        { phase: "app_rollback", result: "passed", statementsSha256: sha256(rollbackStatements) },
      ],
      previousAppVersion: "v1",
      candidateAppVersion: "v2",
      facts: {
        baselineRows,
        afterCandidateRows,
        afterBackfillRows,
        remainingNulls: 0,
        oldAppReadAfterExpand: true,
        oldAppReadCandidateRows: true,
        oldAppWriteAfterExpand: true,
        newAppReadAfterRollback: true,
        contractBlockedWithOldVersion: true,
      },
      noDestructiveReset: true,
      result: "passed",
      gaps: [],
    };
    validateMigrationDrillReceipt(receipt);
    phase = "receipt_write";
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx", mode: 0o600,
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
    if (tableCreated && process.env.MIGRATION_DRILL_CLEANUP === "true") {
      await pool.query(`DROP TABLE ${table}`);
    }
    await pool.end();
  }
}

main().catch(() => {
  console.error(`Migration rollback drill failed at ${phase}; connection details were suppressed`);
  process.exitCode = 1;
});
