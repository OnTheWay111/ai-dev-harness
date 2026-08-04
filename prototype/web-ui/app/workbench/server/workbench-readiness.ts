import {
  createWorkbenchRepository,
  readWorkbenchRepositoryConfig,
  selectWorkbenchDataSource,
  type WorkbenchRepositoryConfig,
} from "./workbench-repository-factory.ts";
import type {
  WorkbenchReadRepository,
} from "./workbench-repository.ts";

const readinessVisibility = {
  actorId: "system:readiness",
  organizationIds: [],
  projectIds: [],
} as const;

type ReadinessCheck = "pass" | "fail" | "skipped";

export interface WorkbenchReadiness {
  ready: boolean;
  source: "postgres" | "unavailable";
  checks: {
    configuration: ReadinessCheck;
    database: ReadinessCheck;
  };
}

export type WorkbenchRepositoryFactory = (
  config: WorkbenchRepositoryConfig,
) => WorkbenchReadRepository;

const configurationFailure: WorkbenchReadiness = {
  ready: false,
  source: "unavailable",
  checks: { configuration: "fail", database: "skipped" },
};

export async function checkWorkbenchReadiness(
  environmentVariables: Record<string, string | undefined>,
  repositoryFactory: WorkbenchRepositoryFactory = createWorkbenchRepository,
): Promise<WorkbenchReadiness> {
  let config: WorkbenchRepositoryConfig;
  try {
    config = readWorkbenchRepositoryConfig(environmentVariables);
    if (selectWorkbenchDataSource(config) !== "postgres") {
      return configurationFailure;
    }
  } catch {
    return configurationFailure;
  }

  try {
    const repository = repositoryFactory(config);
    if (repository.kind !== "postgres") return configurationFailure;
    await repository.getWorkbench(readinessVisibility, { limit: 1 });
    return {
      ready: true,
      source: "postgres",
      checks: { configuration: "pass", database: "pass" },
    };
  } catch {
    return {
      ready: false,
      source: "postgres",
      checks: { configuration: "pass", database: "fail" },
    };
  }
}
