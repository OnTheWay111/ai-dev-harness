import {
  createNeonWorkbenchDatabase,
  NeonActorVisibilityResolver,
  NeonWorkbenchReadStore,
} from "./neon-workbench-store.ts";
import type { Pool } from "pg";
import { PostgresRoleBindingRepository } from
  "../../auth/postgres-role-binding-repository.ts";
import type { ActorVisibilityResolver } from "../../auth/visibility-scope.ts";
import { RoleBindingVisibilityResolver } from
  "../../auth/visibility-scope.ts";
import { usesP12ContractAdapters } from
  "../../control-plane/testing/p12-runtime-config.ts";
import { P12PostgresHttpPool } from
  "../../control-plane/testing/p12-postgres-http-pool.ts";
import { NodePostgresWorkbenchReadStore } from
  "./node-postgres-workbench-store.ts";
import {
  resolveWorkbenchDeploymentConfig,
} from "./postgres-environment.ts";
import { PostgresWorkbenchReadRepository } from "./postgres-workbench-repository.ts";
import {
  DEMO_ORGANIZATION_ID,
  demoWorkbenchRepository,
  type WorkbenchReadRepository,
  type WorkbenchRepositoryKind,
} from "./workbench-repository.ts";

export type WorkbenchDataSourceMode = "auto" | WorkbenchRepositoryKind;

export interface WorkbenchRepositoryConfig {
  mode: WorkbenchDataSourceMode;
  databaseUrl?: string;
  scopeId?: string;
}

let p12Pool: P12PostgresHttpPool | undefined;

function getP12Pool(): P12PostgresHttpPool {
  p12Pool ??= new P12PostgresHttpPool();
  return p12Pool;
}

export function selectWorkbenchDataSource(
  config: Pick<WorkbenchRepositoryConfig, "mode" | "databaseUrl">,
): WorkbenchRepositoryKind {
  const databaseUrl = config.databaseUrl?.trim();
  if (config.mode === "demo") return "demo";
  if (config.mode === "postgres") {
    if (!databaseUrl) {
      throw new Error(
        "WORKBENCH_DATA_SOURCE=postgres requires DATABASE_URL",
      );
    }
    return "postgres";
  }
  return databaseUrl ? "postgres" : "demo";
}

export function createWorkbenchRepository(
  config: WorkbenchRepositoryConfig,
): WorkbenchReadRepository {
  const source = selectWorkbenchDataSource(config);
  if (source === "demo") return demoWorkbenchRepository;

  const databaseUrl = config.databaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for PostgreSQL workbench data");
  }
  const store = usesP12ContractAdapters()
    ? new NodePostgresWorkbenchReadStore(
        getP12Pool() as unknown as Pool,
      )
    : new NeonWorkbenchReadStore(createNeonWorkbenchDatabase(databaseUrl));
  return new PostgresWorkbenchReadRepository(
    store,
    config.scopeId?.trim() || "default",
  );
}

function readDataSourceMode(value?: string): WorkbenchDataSourceMode {
  if (!value) return "auto";
  if (value === "auto" || value === "demo" || value === "postgres") {
    return value;
  }
  throw new Error(
    "WORKBENCH_DATA_SOURCE must be auto, demo, or postgres",
  );
}

export function readWorkbenchRepositoryConfig(
  environmentVariables: Record<string, string | undefined>,
): WorkbenchRepositoryConfig {
  if (environmentVariables.HARNESS_DEPLOYMENT_ENV !== undefined) {
    return resolveWorkbenchDeploymentConfig(environmentVariables);
  }
  if (
    environmentVariables.NODE_ENV === "production" &&
    environmentVariables.WORKBENCH_DATA_SOURCE?.trim() !== "postgres"
  ) {
    throw new Error(
      "Production runtime requires WORKBENCH_DATA_SOURCE=postgres",
    );
  }
  if (
    environmentVariables.NODE_ENV === "production" &&
    !environmentVariables.DATABASE_URL?.trim()
  ) {
    throw new Error("Production runtime requires DATABASE_URL");
  }
  return {
    mode: readDataSourceMode(
      environmentVariables.WORKBENCH_DATA_SOURCE,
    ),
    databaseUrl: environmentVariables.DATABASE_URL,
    scopeId: environmentVariables.WORKBENCH_SCOPE_ID,
  };
}

let repository: WorkbenchReadRepository | undefined;
let visibilityResolver: ActorVisibilityResolver | undefined;

export function getWorkbenchRepository(): WorkbenchReadRepository {
  repository ??= createWorkbenchRepository(
    readWorkbenchRepositoryConfig(process.env),
  );
  return repository;
}

export function getWorkbenchVisibilityResolver(): ActorVisibilityResolver {
  if (visibilityResolver) return visibilityResolver;
  const config = readWorkbenchRepositoryConfig(process.env);
  if (selectWorkbenchDataSource(config) === "demo") {
    visibilityResolver = {
      async resolve(actorId) {
        return {
          actorId,
          organizationIds: [DEMO_ORGANIZATION_ID],
          projectIds: [],
        };
      },
    };
    return visibilityResolver;
  }
  const databaseUrl = config.databaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for PostgreSQL visibility");
  }
  visibilityResolver = usesP12ContractAdapters()
    ? new RoleBindingVisibilityResolver(
        new PostgresRoleBindingRepository(getP12Pool()),
      )
    : new NeonActorVisibilityResolver(
        createNeonWorkbenchDatabase(databaseUrl),
      );
  return visibilityResolver;
}
