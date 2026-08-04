import { Pool } from "@neondatabase/serverless";

import { PostgresRoleBindingRepository } from "../../auth/postgres-role-binding-repository.ts";
import { PolicyEvaluator } from "../../auth/rbac-policy.ts";
import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import {
  DEMO_ORGANIZATION_ID,
  DEMO_PROJECT_ID,
} from "../../workbench/server/workbench-repository.ts";
import {
  readWorkbenchRepositoryConfig,
  selectWorkbenchDataSource,
} from "../../workbench/server/workbench-repository-factory.ts";
import { MemoryGoalWorkspaceRepository } from
  "../adapters/memory-goal-workspace-repository.ts";
import {
  PostgresGoalWorkspaceRepository,
  type GoalWorkspacePool,
} from "../adapters/postgres-goal-workspace-repository.ts";
import { GoalWorkspaceService } from "../application/goal-workspace-service.ts";

export interface DefaultGoalWorkspaceScope {
  organizationId: string;
  projectId: string;
}

let pool: GoalWorkspacePool | undefined;
let service: GoalWorkspaceService | undefined;

function runtimeConfig() {
  return readWorkbenchRepositoryConfig(process.env);
}

function getPool(): GoalWorkspacePool {
  if (pool) return pool;
  const databaseUrl = runtimeConfig().databaseUrl?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for Goal Workspace");
  pool = new Pool({ connectionString: databaseUrl }) as unknown as GoalWorkspacePool;
  return pool;
}

export function getGoalWorkspaceService(): GoalWorkspaceService {
  if (service) return service;
  const config = runtimeConfig();
  if (selectWorkbenchDataSource(config) === "demo") {
    service = new GoalWorkspaceService({
      repository: new MemoryGoalWorkspaceRepository(),
      authorizer: { async authorize() {} },
    });
    return service;
  }
  const runtimePool = getPool();
  const policy = new PolicyEvaluator(
    new PostgresRoleBindingRepository(runtimePool),
  );
  service = new GoalWorkspaceService({
    repository: new PostgresGoalWorkspaceRepository(runtimePool),
    authorizer: {
      async authorize(input) {
        await policy.assertAllowed(input);
      },
    },
  });
  return service;
}

export async function resolveDefaultGoalWorkspaceScope(
  visibility: ActorVisibilityScope,
): Promise<DefaultGoalWorkspaceScope | null> {
  const config = runtimeConfig();
  if (selectWorkbenchDataSource(config) === "demo") {
    return {
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: DEMO_PROJECT_ID,
    };
  }
  const result = await getPool().query<{
    organization_id: string;
    id: string;
  }>(
    `SELECT organization_id, id
       FROM projects
      WHERE organization_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])
      ORDER BY organization_id, id
      LIMIT 1`,
    [visibility.organizationIds, visibility.projectIds],
  );
  return result.rows[0]
    ? {
        organizationId: result.rows[0].organization_id,
        projectId: result.rows[0].id,
      }
    : null;
}
