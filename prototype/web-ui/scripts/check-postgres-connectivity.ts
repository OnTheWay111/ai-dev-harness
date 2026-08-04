import { neon } from "@neondatabase/serverless";

import {
  assertPostgresConnectivity,
  type PostgresConnectivityObservation,
} from "../app/workbench/server/postgres-connectivity.ts";
import {
  resolvePostgresConnection,
  type PostgresAccess,
} from "../app/workbench/server/postgres-environment.ts";

function readAccessArgument(arguments_: string[]): PostgresAccess {
  const inline = arguments_.find((argument) =>
    argument.startsWith("--access="),
  );
  const accessIndex = arguments_.indexOf("--access");
  const value = inline
    ? inline.slice("--access=".length)
    : accessIndex >= 0
      ? arguments_[accessIndex + 1]
      : "app";
  if (value !== "app" && value !== "migrator") {
    throw new Error("--access must be app or migrator");
  }
  return value;
}

async function main(): Promise<number> {
  let access: PostgresAccess;
  try {
    access = readAccessArgument(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid arguments",
    );
    return 1;
  }

  let connection;
  try {
    connection = resolvePostgresConnection(process.env, access);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "PostgreSQL configuration failed",
    );
    return 1;
  }

  try {
    const sql = neon(connection.databaseUrl);
    const rows = await sql`
    SELECT
      current_database() AS database,
      session_user AS login_role,
      pg_has_role(
        session_user,
        ${connection.capabilityRole},
        'member'
      ) AS capability_role_member,
      has_database_privilege(
        session_user,
        current_database(),
        'CONNECT'
      ) AS can_connect,
      has_database_privilege(
        session_user,
        current_database(),
        'CREATE'
      ) AS can_create_in_database,
      has_schema_privilege(
        session_user,
        'public',
        'USAGE'
      ) AS can_use_public_schema,
      has_schema_privilege(
        session_user,
        'public',
        'CREATE'
      ) AS can_create_in_public_schema
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("PostgreSQL connectivity probe returned no row");
    }
    const observation: PostgresConnectivityObservation = {
      database: String(row.database),
      role: String(row.login_role),
      capabilityRoleMember: row.capability_role_member === true,
      canConnect: row.can_connect === true,
      canCreateInDatabase: row.can_create_in_database === true,
      canUsePublicSchema: row.can_use_public_schema === true,
      canCreateInPublicSchema:
        row.can_create_in_public_schema === true,
    };
    assertPostgresConnectivity(connection, observation);
    console.log(
      `PostgreSQL ${access} connectivity passed for ${connection.environment}`,
    );
    return 0;
  } catch {
    console.error(
      `PostgreSQL ${access} connectivity failed for ${connection.environment}; connection details were suppressed`,
    );
    return 1;
  }
}

process.exitCode = await main();
