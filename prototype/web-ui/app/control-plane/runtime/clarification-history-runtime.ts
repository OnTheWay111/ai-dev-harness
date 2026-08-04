import { DemoClarificationPlannerAdapter } from "../adapters/demo-clarification-planner-adapter.ts";
import { MemoryClarificationHistoryRepository } from "../adapters/memory-clarification-history-repository.ts";
import { PostgresClarificationHistoryRepository } from "../adapters/postgres-clarification-history-repository.ts";
import { ClarificationHistoryService } from "../application/clarification-history-service.ts";
import { ClarificationPlannerService } from "../application/clarification-planner-service.ts";
import {
  getGoalWorkspaceAuthorizer,
  getGoalWorkspacePool,
  getGoalWorkspaceRepository,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";
import type { ClarificationHistoryRepository } from "../ports/clarification-history-repository.ts";

let service: ClarificationHistoryService | undefined;
let repository: ClarificationHistoryRepository | undefined;

export function getClarificationHistoryService(): ClarificationHistoryService {
  if (service) return service;
  service = new ClarificationHistoryService({
    repository: getClarificationHistoryRepository(),
    goals: getGoalWorkspaceRepository(),
    authorizer: getGoalWorkspaceAuthorizer(),
    planner: new ClarificationPlannerService(new DemoClarificationPlannerAdapter()),
  });
  return service;
}

export function getClarificationHistoryRepository(): ClarificationHistoryRepository {
  if (repository) return repository;
  repository = usesDemoGoalWorkspace()
    ? new MemoryClarificationHistoryRepository()
    : new PostgresClarificationHistoryRepository(getGoalWorkspacePool());
  return repository;
}
