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

  assert.equal(migrations.length, 21);
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
  assert.equal(migrations[6].tag, "0006_absurd_thena");
  assert.equal(migrations[6].createdAt, 1785833472467);
  assert.equal(
    migrations[6].hash,
    "a0cb472a5d8bc1d625dd997b6c7523359afb09e106ceed2b9c1cbbd3a31eee74",
  );
  assert.equal(migrations[6].statements.length, 18);
  assert.equal(migrations[7].tag, "0007_slippery_loners");
  assert.equal(migrations[7].createdAt, 1785839587777);
  assert.equal(
    migrations[7].hash,
    "ab24c8ae876e677733635b9c7c042732e1142d0d3ff5a60696493f4377e3dfbb",
  );
  assert.equal(migrations[7].statements.length, 3);
  assert.equal(migrations[14].tag, "0014_goofy_the_spike");
  assert.equal(migrations[14].createdAt, 1785852376450);
  assert.equal(
    migrations[14].hash,
    "9c223636db573636d87876c8493cba16390d5240e05128a35c7a289464c526b4",
  );
  assert.equal(migrations[14].statements.length, 14);
  assert.equal(migrations[10].tag, "0010_long_blue_blade");
  assert.equal(migrations[10].createdAt, 1785843118262);
  assert.equal(
    migrations[10].hash,
    "f1da3d21de94fdf2bbe07b8e375957ef750d6e9dfc8de837e48aec58fc62cb0e",
  );
  assert.equal(migrations[10].statements.length, 8);
  assert.equal(migrations[11].tag, "0011_tricky_king_cobra");
  assert.equal(migrations[11].createdAt, 1785843589977);
  assert.equal(
    migrations[11].hash,
    "64ee3776068d8a19b0d64e0267517e6bd5e7ca12f70918281f1133a9588b1777",
  );
  assert.equal(migrations[11].statements.length, 4);
  assert.equal(migrations[12].tag, "0012_careless_susan_delgado");
  assert.equal(migrations[12].createdAt, 1785845539023);
  assert.equal(
    migrations[12].hash,
    "4df763d47550c42a4d8503d87373520a6f749d9fefe5b930c9b848a42b47afbe",
  );
  assert.equal(migrations[12].statements.length, 6);
  assert.equal(migrations[13].tag, "0013_acoustic_spitfire");
  assert.equal(migrations[13].createdAt, 1785846088338);
  assert.equal(
    migrations[13].hash,
    "c1e7e565cd7290fa6bdcc9b4f4ce75c347b682d1940ae6dc84301e2e6621837d",
  );
  assert.equal(migrations[13].statements.length, 3);
  assert.equal(migrations[15].tag, "0015_robust_master_chief");
  assert.equal(migrations[15].statements.length, 27);
  assert.equal(migrations[16].tag, "0016_tidy_felicia_hardy");
  assert.equal(migrations[16].statements.length, 2);
  assert.equal(migrations[17].tag, "0017_superb_cannonball");
  assert.equal(migrations[17].statements.length, 6);
  assert.equal(migrations[18].tag, "0018_pale_big_bertha");
  assert.equal(migrations[18].createdAt, 1785885264537);
  assert.equal(
    migrations[18].hash,
    "8fa28ccb1faec22af306053b94cae7b8c63b654884bf302c40aa2572f1396946",
  );
  assert.equal(migrations[18].statements.length, 43);
  assert.equal(migrations[19].tag, "0019_small_phantom_reporter");
  assert.equal(migrations[19].createdAt, 1785891076318);
  assert.equal(
    migrations[19].hash,
    "8f8a0e3e4b1bdae7c1bd0cdcd186613a72f6582d6fe2da0a8f8c552b5361ad3e",
  );
  assert.equal(migrations[19].statements.length, 30);
  assert.equal(migrations[20].tag, "0020_wild_matthew_murdock");
  assert.equal(migrations[20].statements.length, 25);
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
