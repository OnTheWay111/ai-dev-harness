export type PostgresDeploymentEnvironment =
  | "development"
  | "test"
  | "staging";

export type PostgresAccess = "app" | "migrator";

type EnvironmentVariables = Record<string, string | undefined>;

interface PostgresEnvironmentDefinition {
  instance: string;
  database: string;
  scopeId: string;
  roles: Record<PostgresAccess, string>;
  secrets: Record<PostgresAccess, string>;
}

export const POSTGRES_ENVIRONMENTS = {
  development: {
    instance: "ai-dev-harness-development",
    database: "ai_dev_harness_development",
    scopeId: "development",
    roles: {
      app: "ai_dev_harness_development_app",
      migrator: "ai_dev_harness_development_migrator",
    },
    secrets: {
      app: "AI_DEV_HARNESS_DEVELOPMENT_DATABASE_URL",
      migrator:
        "AI_DEV_HARNESS_DEVELOPMENT_MIGRATION_DATABASE_URL",
    },
  },
  test: {
    instance: "ai-dev-harness-test",
    database: "ai_dev_harness_test",
    scopeId: "test",
    roles: {
      app: "ai_dev_harness_test_app",
      migrator: "ai_dev_harness_test_migrator",
    },
    secrets: {
      app: "AI_DEV_HARNESS_TEST_DATABASE_URL",
      migrator: "AI_DEV_HARNESS_TEST_MIGRATION_DATABASE_URL",
    },
  },
  staging: {
    instance: "ai-dev-harness-staging",
    database: "ai_dev_harness_staging",
    scopeId: "staging",
    roles: {
      app: "ai_dev_harness_staging_app",
      migrator: "ai_dev_harness_staging_migrator",
    },
    secrets: {
      app: "AI_DEV_HARNESS_STAGING_DATABASE_URL",
      migrator: "AI_DEV_HARNESS_STAGING_MIGRATION_DATABASE_URL",
    },
  },
} as const satisfies Record<
  PostgresDeploymentEnvironment,
  PostgresEnvironmentDefinition
>;

const INJECTED_VARIABLES = {
  app: "DATABASE_URL",
  migrator: "MIGRATION_DATABASE_URL",
} as const satisfies Record<PostgresAccess, string>;

const ENDPOINT_ID_VARIABLE = "HARNESS_POSTGRES_ENDPOINT_ID";

export interface ResolvedPostgresConnection {
  environment: PostgresDeploymentEnvironment;
  access: PostgresAccess;
  databaseUrl: string;
  endpointId: string;
  database: string;
  loginRole: string;
  capabilityRole: string;
  secretName: string;
  injectedVariable: (typeof INJECTED_VARIABLES)[PostgresAccess];
}

function resolveDeploymentEnvironment(
  value: string | undefined,
): PostgresDeploymentEnvironment {
  const environment = value?.trim();
  if (
    environment === "development" ||
    environment === "test" ||
    environment === "staging"
  ) {
    return environment;
  }
  throw new Error(
    "HARNESS_DEPLOYMENT_ENV is required and must be development, test, or staging",
  );
}

function parseConnectionIdentity(
  databaseUrl: string,
  endpointId: string,
  environment: PostgresDeploymentEnvironment,
  access: PostgresAccess,
): { database: string; loginRole: string } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      `${INJECTED_VARIABLES[access]} must be a valid PostgreSQL URL`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `${INJECTED_VARIABLES[access]} must be a PostgreSQL URL`,
    );
  }

  const hostLabels = url.hostname.toLowerCase().split(".");
  const hostnameEndpointId = hostLabels[0]?.replace(/-pooler$/, "");
  if (
    !url.hostname.toLowerCase().endsWith(".neon.tech") ||
    hostnameEndpointId !== endpointId
  ) {
    throw new Error(
      `${INJECTED_VARIABLES[access]} does not target the configured Neon endpoint`,
    );
  }

  const definition = POSTGRES_ENVIRONMENTS[environment];
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== definition.database) {
    throw new Error(
      `${INJECTED_VARIABLES[access]} does not target the ${environment} database`,
    );
  }

  const loginRole = decodeURIComponent(url.username);
  const capabilityRole = definition.roles[access];
  if (
    loginRole !== `${capabilityRole}_a` &&
    loginRole !== `${capabilityRole}_b`
  ) {
    throw new Error(
      `${INJECTED_VARIABLES[access]} does not use an allowed ${environment} ${access} login role`,
    );
  }
  return { database, loginRole };
}

export function resolvePostgresConnection(
  environmentVariables: EnvironmentVariables,
  access: PostgresAccess,
): ResolvedPostgresConnection {
  const environment = resolveDeploymentEnvironment(
    environmentVariables.HARNESS_DEPLOYMENT_ENV,
  );
  const definition = POSTGRES_ENVIRONMENTS[environment];
  const injectedVariable = INJECTED_VARIABLES[access];
  const databaseUrl = environmentVariables[injectedVariable]?.trim();
  if (!databaseUrl) {
    throw new Error(
      `${injectedVariable} is required; inject Secret ${definition.secrets[access]} for ${environment}`,
    );
  }
  const endpointId = environmentVariables[ENDPOINT_ID_VARIABLE]?.trim();
  if (!endpointId || !/^ep-[a-z0-9-]+$/.test(endpointId)) {
    throw new Error(
      `${ENDPOINT_ID_VARIABLE} is required and must be the Neon endpoint ID for ${environment}`,
    );
  }
  const identity = parseConnectionIdentity(
    databaseUrl,
    endpointId,
    environment,
    access,
  );
  return {
    environment,
    access,
    databaseUrl,
    endpointId,
    database: identity.database,
    loginRole: identity.loginRole,
    capabilityRole: definition.roles[access],
    secretName: definition.secrets[access],
    injectedVariable,
  };
}

export function resolveWorkbenchDeploymentConfig(
  environmentVariables: EnvironmentVariables,
): { mode: "postgres"; databaseUrl: string; scopeId: string } {
  const connection = resolvePostgresConnection(
    environmentVariables,
    "app",
  );
  const definition = POSTGRES_ENVIRONMENTS[connection.environment];
  if (environmentVariables.WORKBENCH_DATA_SOURCE?.trim() !== "postgres") {
    throw new Error(
      "Deployed environments require WORKBENCH_DATA_SOURCE=postgres",
    );
  }
  if (environmentVariables.WORKBENCH_SCOPE_ID?.trim() !== definition.scopeId) {
    throw new Error(
      `The ${connection.environment} environment requires WORKBENCH_SCOPE_ID=${definition.scopeId}`,
    );
  }
  return {
    mode: "postgres",
    databaseUrl: connection.databaseUrl,
    scopeId: definition.scopeId,
  };
}
