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

let service: ClarificationHistoryService | undefined;

export function getClarificationHistoryService(): ClarificationHistoryService {
  if (service) return service;
  const demo = usesDemoGoalWorkspace();
  service = new ClarificationHistoryService({
    repository: demo
      ? new MemoryClarificationHistoryRepository()
      : new PostgresClarificationHistoryRepository(getGoalWorkspacePool()),
    goals: getGoalWorkspaceRepository(),
    authorizer: getGoalWorkspaceAuthorizer(),
    planner: new ClarificationPlannerService(new DemoClarificationPlannerAdapter()),
  });
  return service;
}
