import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertDevelopmentMigrationState,
  buildAtomicMigrationSql,
  loadPostgresMigrations,
  validateMigrationReceipt,
} from "../scripts/postgres-migration.ts";

const migrationsDirectory = new URL("../drizzle-postgres/", import.meta.url);
const receiptUrl = new URL(
  "../migration-receipts/development/0000_tan_mikhail_rasputin.json",
  import.meta.url,
);

const expectedHash =
  "43239da5baa413cb0475b5285ed5ded7a932f89dc5014eae2ff9fd79e82f92a0";

function validObservation() {
  return {
    ledger: [{ createdAt: 1785742303861, hash: expectedHash }],
    columnSignatures: [
      "workbench_snapshots|1|scope_id|text|NO|",
      "workbench_snapshots|2|revision|bigint|NO|",
      "workbench_snapshots|3|generated_at|timestamp with time zone|NO|",
      "workbench_snapshots|4|summary|jsonb|NO|",
      "workbench_snapshots|5|updated_at|timestamp with time zone|NO|now()",
      "workbench_tasks|1|scope_id|text|NO|",
      "workbench_tasks|2|task_id|text|NO|",
      "workbench_tasks|3|goal_id|text|NO|",
      "workbench_tasks|4|priority|text|NO|",
      "workbench_tasks|5|stage|text|NO|",
      "workbench_tasks|6|attention_required|boolean|NO|",
      "workbench_tasks|7|rank|integer|NO|",
      "workbench_tasks|8|payload|jsonb|NO|",
      "workbench_tasks|9|updated_at|timestamp with time zone|NO|now()",
    ],
    indexSignatures: [
      "workbench_snapshots_pkey|CREATE UNIQUE INDEX workbench_snapshots_pkey ON public.workbench_snapshots USING btree (scope_id)",
      "workbench_tasks_scope_attention_idx|CREATE INDEX workbench_tasks_scope_attention_idx ON public.workbench_tasks USING btree (scope_id, attention_required)",
      "workbench_tasks_scope_goal_idx|CREATE INDEX workbench_tasks_scope_goal_idx ON public.workbench_tasks USING btree (scope_id, goal_id)",
      "workbench_tasks_scope_id_task_id_pk|CREATE UNIQUE INDEX workbench_tasks_scope_id_task_id_pk ON public.workbench_tasks USING btree (scope_id, task_id)",
      "workbench_tasks_scope_rank_idx|CREATE INDEX workbench_tasks_scope_rank_idx ON public.workbench_tasks USING btree (scope_id, rank)",
      "workbench_tasks_scope_stage_idx|CREATE INDEX workbench_tasks_scope_stage_idx ON public.workbench_tasks USING btree (scope_id, stage)",
    ],
    tableOwners: {
      workbench_snapshots: "ai_dev_harness_development_migrator",
      workbench_tasks: "ai_dev_harness_development_migrator",
    },
    appCanReadWrite: true,
    appCanCreateInPublic: false,
    migratorCanCreateInPublic: true,
    migratorCanCreateInDatabase: false,
    failedProbeRecorded: false,
    failedProbeTableExists: false,
  };
}

test("loads the committed Drizzle migration and hashes its exact bytes", () => {
  const migrations = loadPostgresMigrations(migrationsDirectory);

  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].tag, "0000_tan_mikhail_rasputin");
  assert.equal(migrations[0].createdAt, 1785742303861);
  assert.equal(migrations[0].hash, expectedHash);
  assert.equal(migrations[0].statements.length, 6);
});

test("builds an atomic, locked, idempotent migration batch", () => {
  const sql = buildAtomicMigrationSql(
    loadPostgresMigrations(migrationsDirectory),
  );

  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /drizzle\.__drizzle_migrations/);
  assert.match(sql, /recorded_hash IS NULL/);
  assert.match(sql, /migration hash mismatch/);
  assert.match(sql, new RegExp(expectedHash));
  assert.doesNotMatch(sql, /CREATE SCHEMA/);
  assert.doesNotMatch(sql, /postgres(?:ql)?:\/\//);
});

test("validates the committed receipt against the migration bytes", () => {
  const migrations = loadPostgresMigrations(migrationsDirectory);
  const contents = readFileSync(receiptUrl, "utf8");
  const receipt = JSON.parse(contents);

  assert.doesNotMatch(contents, /postgres(?:ql)?:\/\/|password|secret/i);
  assert.doesNotThrow(() => validateMigrationReceipt(receipt, migrations));
  assert.throws(
    () => validateMigrationReceipt({ ...receipt, result: "failed" }, migrations),
    /successful migration/,
  );
  assert.throws(
    () =>
      validateMigrationReceipt(
        { ...receipt, migrationSha256: "0".repeat(64) },
        migrations,
      ),
    /hash/,
  );
  assert.throws(
    () =>
      validateMigrationReceipt(
        { ...receipt, connectionUrl: "not-allowed" },
        migrations,
      ),
    /unknown or missing fields/,
  );
});

test("accepts the exact live schema and least-privilege observation", () => {
  const migrations = loadPostgresMigrations(migrationsDirectory);
  assert.doesNotThrow(() =>
    assertDevelopmentMigrationState(validObservation(), migrations),
  );
});

test("fails closed on drift or a failed transaction recorded as successful", () => {
  const migrations = loadPostgresMigrations(migrationsDirectory);
  const drifted = validObservation();
  drifted.indexSignatures = drifted.indexSignatures.slice(1);
  assert.throws(
    () => assertDevelopmentMigrationState(drifted, migrations),
    /index drift/,
  );

  const falseSuccess = validObservation();
  falseSuccess.failedProbeRecorded = true;
  assert.throws(
    () => assertDevelopmentMigrationState(falseSuccess, migrations),
    /failed migration probe/,
  );
});

test("migration commands fail closed without a migrator Secret", () => {
  const environment = { ...process.env };
  delete environment.HARNESS_DEPLOYMENT_ENV;
  delete environment.HARNESS_POSTGRES_ENDPOINT_ID;
  delete environment.MIGRATION_DATABASE_URL;

  for (const script of [
    "../scripts/run-postgres-migrations.ts",
    "../scripts/check-postgres-migration.ts",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", new URL(script, import.meta.url).pathname],
      { encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /connection details were suppressed/);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /postgres(?:ql)?:\/\//,
    );
  }
});
