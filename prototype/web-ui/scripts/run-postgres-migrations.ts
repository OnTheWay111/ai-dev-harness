import { neon } from "@neondatabase/serverless";

import { resolvePostgresConnection } from
  "../app/workbench/server/postgres-environment.ts";
import {
  buildAtomicMigrationSql,
  loadPostgresMigrations,
} from "./postgres-migration.ts";

const migrationsDirectory = new URL("../drizzle-postgres/", import.meta.url);

async function main(): Promise<number> {
  let environment = "unknown";
  try {
    const connection = resolvePostgresConnection(process.env, "migrator");
    environment = connection.environment;
    const migrations = loadPostgresMigrations(migrationsDirectory);
    const sql = neon(connection.databaseUrl);
    const preflight = await sql`
      SELECT
        current_database() AS database,
        session_user AS login_role,
        current_user AS active_role,
        pg_has_role(
          session_user,
          ${connection.capabilityRole},
          'member'
        ) AS capability_role_member,
        has_database_privilege(
          current_user,
          current_database(),
          'CREATE'
        ) AS can_create_in_database,
        has_schema_privilege(
          current_user,
          'public',
          'CREATE'
        ) AS can_create_in_public,
        (
          SELECT pg_get_userbyid(relowner)
          FROM pg_class
          WHERE oid = to_regclass('drizzle.__drizzle_migrations')
        ) AS ledger_owner
    `;
    const row = preflight[0] as Record<string, unknown> | undefined;
    if (
      !row ||
      row.database !== connection.database ||
      row.login_role !== connection.loginRole ||
      row.active_role !== connection.capabilityRole ||
      row.capability_role_member !== true ||
      row.can_create_in_database !== false ||
      row.can_create_in_public !== true ||
      row.ledger_owner !== connection.capabilityRole
    ) {
      throw new Error("PostgreSQL migration preflight failed");
    }

    const before = await sql`
      SELECT count(*)::integer AS count
      FROM drizzle.__drizzle_migrations
    `;
    await sql.query(buildAtomicMigrationSql(migrations));
    const after = await sql`
      SELECT count(*)::integer AS count
      FROM drizzle.__drizzle_migrations
    `;
    const beforeCount = Number(before[0]?.count ?? -1);
    const afterCount = Number(after[0]?.count ?? -1);
    if (afterCount !== migrations.length || beforeCount > afterCount) {
      throw new Error("PostgreSQL migration ledger verification failed");
    }
    const applied = afterCount - beforeCount;
    console.log(
      `PostgreSQL migrations passed for ${environment}; applied=${applied}, total=${afterCount}`,
    );
    return 0;
  } catch {
    console.error(
      `PostgreSQL migration failed for ${environment}; connection details were suppressed`,
    );
    return 1;
  }
}

process.exitCode = await main();
