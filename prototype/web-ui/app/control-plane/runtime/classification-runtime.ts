import { MemoryClassificationRepository } from "../adapters/memory-classification-repository.ts";
import { PostgresClassificationRepository } from "../adapters/postgres-classification-repository.ts";
import { ClassificationService } from "../application/classification-service.ts";
import {
  getGoalWorkspaceAuthorizer,
  getGoalWorkspacePool,
  getGoalWorkspaceRepository,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";
import { getClarificationHistoryRepository } from "./clarification-history-runtime.ts";

let service: ClassificationService | undefined;

export function getClassificationService(): ClassificationService {
  if (service) return service;
  service = new ClassificationService({
    repository: usesDemoGoalWorkspace()
      ? new MemoryClassificationRepository()
      : new PostgresClassificationRepository(getGoalWorkspacePool()),
    goals: getGoalWorkspaceRepository(),
    clarifications: getClarificationHistoryRepository(),
    authorizer: getGoalWorkspaceAuthorizer(),
  });
  return service;
}
