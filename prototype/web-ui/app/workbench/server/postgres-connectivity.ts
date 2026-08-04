import type {
  ResolvedPostgresConnection,
} from "./postgres-environment.ts";

export interface PostgresConnectivityObservation {
  database: string;
  role: string;
  capabilityRoleMember: boolean;
  canConnect: boolean;
  canCreateInDatabase: boolean;
  canUsePublicSchema: boolean;
  canCreateInPublicSchema: boolean;
}

export function assertPostgresConnectivity(
  connection: ResolvedPostgresConnection,
  observation: PostgresConnectivityObservation,
): void {
  if (observation.database !== connection.database) {
    throw new Error("PostgreSQL database mapping mismatch");
  }
  if (observation.role !== connection.loginRole) {
    throw new Error("PostgreSQL login role mapping mismatch");
  }
  if (!observation.capabilityRoleMember) {
    throw new Error(
      `PostgreSQL login role is not a member of its ${connection.access} capability role`,
    );
  }
  if (!observation.canConnect || !observation.canUsePublicSchema) {
    throw new Error("PostgreSQL role lacks CONNECT or schema USAGE");
  }
  if (observation.canCreateInDatabase) {
    throw new Error(
      "PostgreSQL app and migrator roles must not have database CREATE",
    );
  }
  if (connection.access === "app" && observation.canCreateInPublicSchema) {
    throw new Error(
      "PostgreSQL app role must not have CREATE on the public schema",
    );
  }
  if (
    connection.access === "migrator" &&
    !observation.canCreateInPublicSchema
  ) {
    throw new Error(
      "PostgreSQL migrator role requires CREATE on the public schema",
    );
  }
}
