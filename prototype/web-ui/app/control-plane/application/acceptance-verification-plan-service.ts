import {
  compileAcceptanceVerificationPlan,
  type AcceptanceVerificationPlan,
} from "../domain/acceptance-verification.ts";
import type { GoalWorkspaceRepository } from
  "../ports/goal-workspace-repository.ts";
import type { GoalVerificationRepository } from
  "../ports/goal-verification-repository.ts";
import type { IssuePlanRepository } from
  "../ports/issue-plan-repository.ts";
import type { VerificationReferenceCatalogPort } from
  "../ports/verification-reference-catalog-port.ts";

export class AcceptanceVerificationPlanService {
  private readonly repository: GoalVerificationRepository;
  private readonly goals: Pick<GoalWorkspaceRepository, "get">;
  private readonly issuePlans: Pick<IssuePlanRepository, "get" | "getLatest">;
  private readonly catalog: VerificationReferenceCatalogPort;
  private readonly authorizer: {
    authorize(input: {
      actorId: string;
      organizationId: string;
      projectId: string;
      permission: "goal.verify";
    }): Promise<void>;
  };
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: GoalVerificationRepository;
    goals: Pick<GoalWorkspaceRepository, "get">;
    issuePlans: Pick<IssuePlanRepository, "get" | "getLatest">;
    catalog: VerificationReferenceCatalogPort;
    authorizer: AcceptanceVerificationPlanService["authorizer"];
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.goals = input.goals;
    this.issuePlans = input.issuePlans;
    this.catalog = input.catalog;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  async compile(command: {
    organizationId: string;
    projectId: string;
    goalId: string;
    issuePlanId: string;
    expectedGoalVersion: number;
    expectedIssuePlanVersion: number;
    actorId: string;
    draft: unknown;
  }): Promise<AcceptanceVerificationPlan> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.verify",
    });
    const scope = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
    };
    const [goal, issuePlan, latestIssuePlan, plans, references] = await Promise.all([
      this.goals.get({ id: command.goalId, ...scope }),
      this.issuePlans.get({ ...scope, planId: command.issuePlanId }),
      this.issuePlans.getLatest(scope),
      this.repository.listPlans(scope),
      this.catalog.list(scope),
    ]);
    if (!goal || goal.status !== "verifying" ||
      goal.version !== command.expectedGoalVersion || !issuePlan ||
      issuePlan.version !== command.expectedIssuePlanVersion ||
      latestIssuePlan?.id !== issuePlan.id || issuePlan.status !== "approved" ||
      !issuePlan.compilation.valid) {
      throw new Error("Goal or Issue plan is stale or not eligible for verification");
    }
    const previous = plans.at(-1);
    const plan = await compileAcceptanceVerificationPlan({
      id: this.idGenerator(),
      ...scope,
      goalVersion: goal.version,
      issuePlanId: issuePlan.id,
      issuePlanVersion: issuePlan.version,
      revision: (previous?.revision ?? 0) + 1,
      previousPlanId: previous?.id ?? null,
      criteria: goal.acceptanceCriteria,
      draft: command.draft,
      availableReferences: references,
      compiledAt: this.clock().toISOString(),
    });
    return await this.repository.appendPlan(plan);
  }

  async timeline(command: {
    organizationId: string;
    projectId: string;
    goalId: string;
    actorId: string;
  }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "goal.verify",
    });
    return await this.repository.listPlans(command);
  }
}
