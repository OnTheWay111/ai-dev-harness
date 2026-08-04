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
const authoritativeSchemaHash =
  "4a02f956e011b984374624c410f5e5b3bd4f41d7aaddcac182861d669906c54f";
const planningSchemaHash =
  "2e8678e68b8c0ba131beec25f95a12f88ea98d1a5ba58fa6843c14fa5df777cc";
const reliabilitySchemaHash =
  "136ef382cdcd7c31813dbb660d38e519f452a1addd03b78288c04aa4c7fef2bf";
const stateMachineSchemaHash =
  "506a7abf0387a147d19d890bc9cb3a404ccfc6388d6f177da2b77204950efde0";

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

function receiptMigrations() {
  const receipt = JSON.parse(readFileSync(receiptUrl, "utf8"));
  return loadPostgresMigrations(migrationsDirectory).filter(
    (migration) => migration.createdAt <= receipt.migrationCreatedAt,
  );
}

test("loads the committed Drizzle migration and hashes its exact bytes", () => {
  const migrations = loadPostgresMigrations(migrationsDirectory);

  assert.equal(migrations.length, 6);
  assert.equal(migrations[0].tag, "0000_tan_mikhail_rasputin");
  assert.equal(migrations[0].createdAt, 1785742303861);
  assert.equal(migrations[0].hash, expectedHash);
  assert.equal(migrations[0].statements.length, 6);
  assert.equal(migrations[1].tag, "0001_thin_maginty");
  assert.equal(migrations[1].createdAt, 1785827465206);
  assert.equal(migrations[1].hash, authoritativeSchemaHash);
  assert.equal(migrations[1].statements.length, 15);
  assert.equal(migrations[2].tag, "0002_aspiring_cammi");
  assert.equal(migrations[2].createdAt, 1785828293991);
  assert.equal(migrations[2].hash, planningSchemaHash);
  assert.equal(migrations[2].statements.length, 23);
  assert.equal(migrations[3].tag, "0003_absurd_stark_industries");
  assert.equal(migrations[3].createdAt, 1785828695192);
  assert.equal(migrations[3].hash, reliabilitySchemaHash);
  assert.equal(migrations[3].statements.length, 24);
  assert.equal(migrations[4].tag, "0004_lethal_whizzer");
  assert.equal(migrations[4].createdAt, 1785829152925);
  assert.equal(migrations[4].hash, stateMachineSchemaHash);
  assert.equal(migrations[4].statements.length, 2);
  assert.equal(migrations[5].tag, "0005_previous_puppet_master");
  assert.equal(migrations[5].createdAt, 1785832369382);
  assert.equal(
    migrations[5].hash,
    "c3353d92cdf3f8740821658300d41337169d0babace28214ad366dfc29e48860",
  );
  assert.equal(migrations[5].statements.length, 6);
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
  assert.doesNotThrow(() =>
    validateMigrationReceipt(receipt, [
      ...migrations,
      {
        tag: "9999_future_migration",
        createdAt: receipt.migrationCreatedAt + 1,
        hash: "f".repeat(64),
        statements: ["SELECT 1"],
      },
    ]),
  );
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
  assert.doesNotThrow(() =>
    assertDevelopmentMigrationState(validObservation(), receiptMigrations()),
  );
});

test("fails closed on drift or a failed transaction recorded as successful", () => {
  const migrations = receiptMigrations();
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
