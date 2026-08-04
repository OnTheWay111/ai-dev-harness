import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface PostgresMigration {
  tag: string;
  createdAt: number;
  hash: string;
  statements: string[];
}

export interface MigrationReceipt {
  schemaVersion: "postgres-migration-receipt.v1";
  environment: "development";
  database: "ai_dev_harness_development";
  migrationVersion: string;
  migrationCreatedAt: number;
  migrationSha256: string;
  appliedAt: string;
  verifiedAt: string;
  result: "applied";
  checks: {
    emptyDatabaseBeforeApply: true;
    repeatExecution: "no-op";
    schemaDrift: "none";
    failedTransaction: "rolled-back";
  };
}

export interface DevelopmentMigrationObservation {
  ledger: Array<{ createdAt: number; hash: string }>;
  columnSignatures: string[];
  indexSignatures: string[];
  tableOwners: Record<string, string>;
  appCanReadWrite: boolean;
  appCanCreateInPublic: boolean;
  migratorCanCreateInPublic: boolean;
  migratorCanCreateInDatabase: boolean;
  failedProbeRecorded: boolean;
  failedProbeTableExists: boolean;
}

interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
  }>;
}

const EXPECTED_COLUMN_SIGNATURES = [
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
] as const;

const EXPECTED_INDEX_SIGNATURES = [
  "workbench_snapshots_pkey|CREATE UNIQUE INDEX workbench_snapshots_pkey ON public.workbench_snapshots USING btree (scope_id)",
  "workbench_tasks_scope_attention_idx|CREATE INDEX workbench_tasks_scope_attention_idx ON public.workbench_tasks USING btree (scope_id, attention_required)",
  "workbench_tasks_scope_goal_idx|CREATE INDEX workbench_tasks_scope_goal_idx ON public.workbench_tasks USING btree (scope_id, goal_id)",
  "workbench_tasks_scope_id_task_id_pk|CREATE UNIQUE INDEX workbench_tasks_scope_id_task_id_pk ON public.workbench_tasks USING btree (scope_id, task_id)",
  "workbench_tasks_scope_rank_idx|CREATE INDEX workbench_tasks_scope_rank_idx ON public.workbench_tasks USING btree (scope_id, rank)",
  "workbench_tasks_scope_stage_idx|CREATE INDEX workbench_tasks_scope_stage_idx ON public.workbench_tasks USING btree (scope_id, stage)",
] as const;

const EXPECTED_OWNERS = {
  workbench_snapshots: "ai_dev_harness_development_migrator",
  workbench_tasks: "ai_dev_harness_development_migrator",
} as const;

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function readJournal(migrationsDirectory: URL): DrizzleJournal {
  const value: unknown = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDirectory), "utf8"),
  );
  const journal = requireObject(value, "Drizzle migration journal");
  if (
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error("Drizzle PostgreSQL migration journal is invalid");
  }
  return journal as unknown as DrizzleJournal;
}

export function loadPostgresMigrations(
  migrationsDirectory: URL,
): PostgresMigration[] {
  const journal = readJournal(migrationsDirectory);
  let previousCreatedAt = -1;
  return journal.entries.map((entry, index) => {
    if (
      entry.idx !== index ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousCreatedAt ||
      !/^[a-zA-Z0-9_]+$/.test(entry.tag)
    ) {
      throw new Error("Drizzle migration journal order is invalid");
    }
    previousCreatedAt = entry.when;
    const contents = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDirectory),
      "utf8",
    );
    const statements = contents
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    if (statements.length === 0) {
      throw new Error(`Drizzle migration ${entry.tag} contains no statements`);
    }
    return {
      tag: entry.tag,
      createdAt: entry.when,
      hash: createHash("sha256").update(contents).digest("hex"),
      statements,
    };
  });
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function dollarQuote(statement: string, index: number, hash: string): string {
  let suffix = 0;
  while (true) {
    const delimiter = `$migration_${index}_${hash.slice(0, 12)}_${suffix}$`;
    if (!statement.includes(delimiter)) {
      return `${delimiter}${statement}${delimiter}`;
    }
    suffix += 1;
  }
}

export function buildAtomicMigrationSql(
  migrations: PostgresMigration[],
): string {
  if (migrations.length === 0) {
    throw new Error("At least one PostgreSQL migration is required");
  }
  const body = migrations
    .map((migration, migrationIndex) => {
      const statements = migration.statements
        .map(
          (statement, statementIndex) =>
            `      EXECUTE ${dollarQuote(
              statement,
              migrationIndex * 1000 + statementIndex,
              migration.hash,
            )};`,
        )
        .join("\n");
      return `
    recorded_hash := NULL;
    SELECT hash INTO recorded_hash
    FROM drizzle.__drizzle_migrations
    WHERE created_at = ${migration.createdAt};

    IF recorded_hash IS NULL THEN
      IF latest_created_at IS NOT NULL AND latest_created_at > ${migration.createdAt} THEN
        RAISE EXCEPTION 'migration order gap before ${migration.tag}';
      END IF;
${statements}
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${quoteLiteral(migration.hash)}, ${migration.createdAt});
      latest_created_at := ${migration.createdAt};
    ELSIF recorded_hash <> ${quoteLiteral(migration.hash)} THEN
      RAISE EXCEPTION 'migration hash mismatch for ${migration.tag}';
    END IF;`;
    })
    .join("\n");

  return `DO $ai_dev_harness_migrate$
  DECLARE
    recorded_hash text;
    latest_created_at bigint;
  BEGIN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ai-dev-harness:postgres-migrations', 0)
    );
    IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
      RAISE EXCEPTION 'migration ledger is not provisioned';
    END IF;
    SELECT max(created_at) INTO latest_created_at
    FROM drizzle.__drizzle_migrations;
${body}
  END
$ai_dev_harness_migrate$`;
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`Migration receipt ${field} must be an ISO UTC timestamp`);
  }
}

export function validateMigrationReceipt(
  value: unknown,
  migrations: PostgresMigration[],
): asserts value is MigrationReceipt {
  const receipt = requireObject(value, "Migration receipt");
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "environment",
      "database",
      "migrationVersion",
      "migrationCreatedAt",
      "migrationSha256",
      "appliedAt",
      "verifiedAt",
      "result",
      "checks",
    ],
    "Migration receipt",
  );
  const latest = migrations.at(-1);
  if (!latest) {
    throw new Error("Migration receipt requires a committed migration");
  }
  if (
    receipt.schemaVersion !== "postgres-migration-receipt.v1" ||
    receipt.environment !== "development" ||
    receipt.database !== "ai_dev_harness_development"
  ) {
    throw new Error("Migration receipt environment mapping is invalid");
  }
  if (receipt.result !== "applied") {
    throw new Error("Migration receipt must describe a successful migration");
  }
  if (
    receipt.migrationVersion !== latest.tag ||
    receipt.migrationCreatedAt !== latest.createdAt
  ) {
    throw new Error("Migration receipt version does not match the journal");
  }
  if (receipt.migrationSha256 !== latest.hash) {
    throw new Error("Migration receipt hash does not match the migration bytes");
  }
  assertIsoTimestamp(receipt.appliedAt, "appliedAt");
  assertIsoTimestamp(receipt.verifiedAt, "verifiedAt");
  if (Date.parse(receipt.verifiedAt) < Date.parse(receipt.appliedAt)) {
    throw new Error("Migration receipt verification predates application");
  }
  const checks = requireObject(receipt.checks, "Migration receipt checks");
  assertExactKeys(
    checks,
    [
      "emptyDatabaseBeforeApply",
      "repeatExecution",
      "schemaDrift",
      "failedTransaction",
    ],
    "Migration receipt checks",
  );
  if (
    checks.emptyDatabaseBeforeApply !== true ||
    checks.repeatExecution !== "no-op" ||
    checks.schemaDrift !== "none" ||
    checks.failedTransaction !== "rolled-back"
  ) {
    throw new Error("Migration receipt checks are incomplete");
  }
  const serialized = JSON.stringify(receipt);
  if (/postgres(?:ql)?:\/\//i.test(serialized)) {
    throw new Error("Migration receipt must not contain a connection string");
  }
}

export function assertDevelopmentMigrationState(
  observation: DevelopmentMigrationObservation,
  migrations: PostgresMigration[],
): void {
  assertArrayEqual(
    observation.ledger.map(({ createdAt, hash }) => `${createdAt}|${hash}`),
    migrations.map(({ createdAt, hash }) => `${createdAt}|${hash}`),
    "migration ledger drift",
  );
  assertArrayEqual(
    observation.columnSignatures,
    [...EXPECTED_COLUMN_SIGNATURES],
    "column drift",
  );
  assertArrayEqual(
    observation.indexSignatures,
    [...EXPECTED_INDEX_SIGNATURES],
    "index drift",
  );
  if (JSON.stringify(observation.tableOwners) !== JSON.stringify(EXPECTED_OWNERS)) {
    throw new Error("PostgreSQL table owner drift detected");
  }
  if (!observation.appCanReadWrite || observation.appCanCreateInPublic) {
    throw new Error("PostgreSQL app grants do not match least privilege");
  }
  if (
    !observation.migratorCanCreateInPublic ||
    observation.migratorCanCreateInDatabase
  ) {
    throw new Error("PostgreSQL migrator grants do not match least privilege");
  }
  if (observation.failedProbeRecorded || observation.failedProbeTableExists) {
    throw new Error("A failed migration probe was recorded as successful");
  }
}

function assertArrayEqual(
  actual: string[],
  expected: string[],
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`PostgreSQL ${label} detected`);
  }
}
