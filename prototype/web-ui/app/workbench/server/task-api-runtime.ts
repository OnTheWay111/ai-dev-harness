import { readRequestPrincipal } from "../../auth/oidc-http.ts";
import { getOidcService } from "../../auth/oidc-runtime.ts";
import { PostgresRoleBindingRepository } from
  "../../auth/postgres-role-binding-repository.ts";
import {
  type Permission,
  PolicyEvaluator,
} from "../../auth/rbac-policy.ts";
import type { PostgresPool } from
  "../../control-plane/adapters/postgres-goal-repository.ts";
import {
  getGoalWorkspacePool,
  usesDemoGoalWorkspace,
} from "../../control-plane/runtime/goal-workspace-runtime.ts";
import { globalTasks } from "./demo-workbench-snapshot.ts";
import { createTaskApiHandlers } from "./task-api-handler.ts";
import {
  MemoryTaskActionRepository,
  type TaskActionRepository,
} from "./task-action-repository.ts";
import { TaskActionService, type TaskActionAuthorizer } from
  "./task-action-service.ts";
import { PostgresTaskActionRepository } from
  "./postgres-task-action-repository.ts";
import {
  DEMO_ORGANIZATION_ID,
  DEMO_PROJECT_ID,
} from "./workbench-repository.ts";
import { getWorkbenchVisibilityResolver } from
  "./workbench-repository-factory.ts";

let repository: TaskActionRepository | undefined;
let service: TaskActionService | undefined;
let handlers: ReturnType<typeof createTaskApiHandlers> | undefined;

function permissionFor(action: Parameters<TaskActionAuthorizer["authorize"]>[0]["action"]): Permission {
  if (action === "review_evidence") return "issue.approve";
  if (action === "answer_questions") return "goal.approve";
  if (action === "resolve_blocker") return "run.operate";
  return "issue.read";
}

function taskActionAuthorizer(): TaskActionAuthorizer {
  if (usesDemoGoalWorkspace()) return { async authorize() {} };
  const pool = getGoalWorkspacePool();
  const policy = new PolicyEvaluator(
    new PostgresRoleBindingRepository(pool),
  );
  return {
    async authorize(input) {
      await policy.assertAllowed({
        actorId: input.actorId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        permission: permissionFor(input.action),
      });
    },
  };
}

export function getTaskActionRepository(): TaskActionRepository {
  if (repository) return repository;
  repository = usesDemoGoalWorkspace()
    ? new MemoryTaskActionRepository(globalTasks.map((task) => ({
        organizationId: DEMO_ORGANIZATION_ID,
        projectId: DEMO_PROJECT_ID,
        task,
      })))
    : new PostgresTaskActionRepository({
        pool: getGoalWorkspacePool() as unknown as PostgresPool,
        scopeId: process.env.WORKBENCH_SCOPE_ID?.trim() || "default",
      });
  return repository;
}

export function getTaskActionService(): TaskActionService {
  service ??= new TaskActionService({
    repository: getTaskActionRepository(),
    authorizer: taskActionAuthorizer(),
  });
  return service;
}

export function getTaskApiHandlers() {
  handlers ??= createTaskApiHandlers({
    service: getTaskActionService(),
    actorResolver: async (request) =>
      await readRequestPrincipal(request, getOidcService()),
    visibilityResolver: async (request) => {
      const principal = await readRequestPrincipal(request, getOidcService());
      if (!principal) {
        return { actorId: "anonymous", organizationIds: [], projectIds: [] };
      }
      return await getWorkbenchVisibilityResolver().resolve(principal.actorId);
    },
  });
  return handlers;
}
