import { PostgresRoleBindingRepository } from
  "../../auth/postgres-role-binding-repository.ts";
import { PolicyEvaluator } from "../../auth/rbac-policy.ts";
import { MemoryGoalWorkspaceRepository } from
  "../adapters/memory-goal-workspace-repository.ts";
import { MemoryGoalWorkspaceTransitionRepository } from
  "../adapters/memory-goal-workspace-transition-repository.ts";
import { PostgresGoalRepository } from
  "../adapters/postgres-goal-repository.ts";
import { GoalApplicationService } from
  "../application/goal-application-service.ts";
import type { GoalRepository } from "../ports/goal-repository.ts";
import {
  getGoalWorkspacePool,
  getGoalWorkspaceRepository,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";

let repository: GoalRepository | undefined;
let service: GoalApplicationService | undefined;

function getRepository(): GoalRepository {
  if (repository) return repository;
  repository = usesDemoGoalWorkspace()
    ? new MemoryGoalWorkspaceTransitionRepository(
        getGoalWorkspaceRepository() as MemoryGoalWorkspaceRepository,
      )
    : new PostgresGoalRepository(getGoalWorkspacePool());
  return repository;
}

export function getGoalTransitionService(): GoalApplicationService {
  if (service) return service;
  const demo = usesDemoGoalWorkspace();
  const policy = demo
    ? null
    : new PolicyEvaluator(
        new PostgresRoleBindingRepository(getGoalWorkspacePool()),
      );
  service = new GoalApplicationService({
    repository: getRepository(),
    authorizer: {
      async authorize(command) {
        if (!policy) return;
        await policy.assertAllowed({
          actorId: command.actorId,
          organizationId: command.organizationId,
          projectId: command.projectId,
          permission: command.nextState === "approved"
            ? "goal.approve"
            : "goal.write",
        });
      },
    },
  });
  return service;
}
