import { PostgresRoleBindingRepository } from "../../auth/postgres-role-binding-repository.ts";
import { PolicyEvaluator } from "../../auth/rbac-policy.ts";
import { AutoDevQueueImportAdapter } from
  "../adapters/autodev-queue-import-adapter.ts";
import { CodexPlannerAdapter } from "../adapters/codex-planner-adapter.ts";
import { DemoIssuePlannerAdapter } from "../adapters/demo-issue-planner-adapter.ts";
import { MemoryIssuePlanRepository } from
  "../adapters/memory-issue-plan-repository.ts";
import { MemoryQueueProjectionRepository } from
  "../adapters/memory-queue-projection-repository.ts";
import { MemorySpecRevisionRepository } from
  "../adapters/memory-spec-revision-repository.ts";
import { PostgresIssuePlanRepository } from
  "../adapters/postgres-issue-plan-repository.ts";
import { PostgresQueueProjectionRepository } from
  "../adapters/postgres-queue-projection-repository.ts";
import { PostgresSpecApprovalRepository } from
  "../adapters/postgres-spec-approval-repository.ts";
import { IssuePlanGenerationService } from
  "../application/issue-plan-generation-service.ts";
import {
  IssuePlanService,
  type IssuePlanAuthorizer,
} from "../application/issue-plan-service.ts";
import { QueueProjectionService } from
  "../application/queue-projection-service.ts";
import type { IssuePlanRepository } from "../ports/issue-plan-repository.ts";
import type { QueueProjectionRepository } from
  "../ports/queue-projection-port.ts";
import type { SpecApprovalRepository } from
  "../ports/spec-approval-repository.ts";
import {
  getGoalWorkspacePool,
  getGoalWorkspaceRepository,
  usesDemoGoalWorkspace,
} from "./goal-workspace-runtime.ts";
import {
  getSpecArtifactStore,
  getSpecRevisionRepository,
} from "./spec-generation-runtime.ts";

let repository: IssuePlanRepository | undefined;
let planService: IssuePlanService | undefined;
let generationService: IssuePlanGenerationService | undefined;
let projectionService: QueueProjectionService | undefined;
let projectionRepository: QueueProjectionRepository | undefined;

function authorizer(): IssuePlanAuthorizer {
  if (usesDemoGoalWorkspace()) return { async authorize() {} };
  const policy = new PolicyEvaluator(
    new PostgresRoleBindingRepository(getGoalWorkspacePool()),
  );
  return { async authorize(input) { await policy.assertAllowed(input); } };
}

export function getIssuePlanRepository(): IssuePlanRepository {
  if (!repository) {
    repository = usesDemoGoalWorkspace()
      ? new MemoryIssuePlanRepository()
      : new PostgresIssuePlanRepository(getGoalWorkspacePool());
  }
  return repository;
}

function specificationRepository(): SpecApprovalRepository {
  if (usesDemoGoalWorkspace()) {
    const value = getSpecRevisionRepository();
    if (!(value instanceof MemorySpecRevisionRepository)) {
      throw new Error("Demo SpecRevision repository is unavailable");
    }
    return value;
  }
  return new PostgresSpecApprovalRepository(getGoalWorkspacePool());
}

export function getIssuePlanService(): IssuePlanService {
  if (!planService) {
    planService = new IssuePlanService({
      repository: getIssuePlanRepository(),
      authorizer: authorizer(),
    });
  }
  return planService;
}

export function getIssuePlanGenerationService(): IssuePlanGenerationService {
  if (!generationService) {
    const demo = usesDemoGoalWorkspace();
    generationService = new IssuePlanGenerationService({
      goals: getGoalWorkspaceRepository(),
      specifications: specificationRepository(),
      artifacts: getSpecArtifactStore(),
      planner: demo
        ? new DemoIssuePlannerAdapter()
        : new CodexPlannerAdapter({ model: process.env.CODEX_PLANNER_MODEL?.trim() }),
      plans: getIssuePlanService(),
      authorizer: authorizer(),
      plannerConfiguration: {
        adapter: demo ? "demo" : "codex",
        modelProfile: demo
          ? "deterministic-demo"
          : process.env.CODEX_PLANNER_MODEL?.trim() || "configured-planner",
        schemaVersion: "issue-plan-draft.v1",
      },
    });
  }
  return generationService;
}

export function getQueueProjectionService(): QueueProjectionService {
  if (!projectionService) {
    projectionRepository = projectionRepository ?? (usesDemoGoalWorkspace()
      ? new MemoryQueueProjectionRepository()
      : new PostgresQueueProjectionRepository(getGoalWorkspacePool()));
    projectionService = new QueueProjectionService({
      adapter: new AutoDevQueueImportAdapter({
        endpoint: process.env.AUTODEV_QUEUE_IMPORT_URL?.trim() ?? "",
        token: process.env.AUTODEV_QUEUE_IMPORT_TOKEN?.trim() ?? "",
      }),
      repository: projectionRepository,
      authorizer: authorizer(),
    });
  }
  return projectionService;
}
