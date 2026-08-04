import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

import { resolvePostgresConnection } from
  "../app/workbench/server/postgres-environment.ts";
import {
  assertDevelopmentMigrationState,
  loadPostgresMigrations,
  validateMigrationReceipt,
  type DevelopmentMigrationObservation,
} from "./postgres-migration.ts";

const migrationsDirectory = new URL("../drizzle-postgres/", import.meta.url);
const receiptUrl = new URL(
  "../migration-receipts/development/0000_tan_mikhail_rasputin.json",
  import.meta.url,
);

async function main(): Promise<number> {
  try {
    const connection = resolvePostgresConnection(process.env, "migrator");
    if (connection.environment !== "development") {
      throw new Error("P1-02 receipt is only valid for development");
    }
    const migrations = loadPostgresMigrations(migrationsDirectory);
    const receipt: unknown = JSON.parse(readFileSync(receiptUrl, "utf8"));
    validateMigrationReceipt(receipt, migrations);

    const sql = neon(connection.databaseUrl);
    const [ledger, columns, indexes, owners, grants] = await Promise.all([
      sql`
        SELECT created_at::text AS created_at, hash
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at
      `,
      sql`
        SELECT concat_ws(
          '|',
          table_name,
          ordinal_position::text,
          column_name,
          data_type,
          is_nullable,
          coalesce(column_default, '')
        ) AS signature
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('workbench_snapshots', 'workbench_tasks')
        ORDER BY table_name, ordinal_position
      `,
      sql`
        SELECT indexname || '|' || indexdef AS signature
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('workbench_snapshots', 'workbench_tasks')
        ORDER BY indexname
      `,
      sql`
        SELECT tablename, tableowner
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('workbench_snapshots', 'workbench_tasks')
        ORDER BY tablename
      `,
      sql`
        SELECT
          bool_and(
            has_table_privilege(
              'ai_dev_harness_development_app',
              format('public.%I', tablename),
              'SELECT,INSERT,UPDATE,DELETE'
            )
          ) AS app_can_read_write,
          has_schema_privilege(
            'ai_dev_harness_development_app',
            'public',
            'CREATE'
          ) AS app_can_create_in_public,
          has_schema_privilege(
            'ai_dev_harness_development_migrator',
            'public',
            'CREATE'
          ) AS migrator_can_create_in_public,
          has_database_privilege(
            'ai_dev_harness_development_migrator',
            current_database(),
            'CREATE'
          ) AS migrator_can_create_in_database,
          EXISTS (
            SELECT 1
            FROM drizzle.__drizzle_migrations
            WHERE hash = 'p1-02-failure-probe'
               OR created_at = 1785742303862
          ) AS failed_probe_recorded,
          to_regclass('public.__p1_02_failed_migration_probe') IS NOT NULL
            AS failed_probe_table_exists
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('workbench_snapshots', 'workbench_tasks')
      `,
    ]);
    const grantRow = grants[0] as Record<string, unknown> | undefined;
    if (!grantRow) {
      throw new Error("PostgreSQL migration grant probe returned no row");
    }
    const observation: DevelopmentMigrationObservation = {
      ledger: ledger.map((row) => ({
        createdAt: Number(row.created_at),
        hash: String(row.hash),
      })),
      columnSignatures: columns.map((row) => String(row.signature)),
      indexSignatures: indexes.map((row) => String(row.signature)),
      tableOwners: Object.fromEntries(
        owners.map((row) => [String(row.tablename), String(row.tableowner)]),
      ),
      appCanReadWrite: grantRow.app_can_read_write === true,
      appCanCreateInPublic: grantRow.app_can_create_in_public === true,
      migratorCanCreateInPublic:
        grantRow.migrator_can_create_in_public === true,
      migratorCanCreateInDatabase:
        grantRow.migrator_can_create_in_database === true,
      failedProbeRecorded: grantRow.failed_probe_recorded === true,
      failedProbeTableExists: grantRow.failed_probe_table_exists === true,
    };
    assertDevelopmentMigrationState(observation, migrations);
    console.log(
      "PostgreSQL development migration receipt and schema verification passed",
    );
    return 0;
  } catch {
    console.error(
      "PostgreSQL development migration verification failed; connection details were suppressed",
    );
    return 1;
  }
}

process.exitCode = await main();
