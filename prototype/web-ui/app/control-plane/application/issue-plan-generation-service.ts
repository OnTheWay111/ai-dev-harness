import {
  issuePlanDraftOutputSchema,
  issuePlanDraftSchemaVersion,
  validateIssuePlanDraft,
  type IssuePlannerConfiguration,
} from "../domain/issue-plan.ts";
import { validateSpecBundle, type SpecBundle } from "../domain/spec-artifact.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { GoalWorkspaceRepository } from "../ports/goal-workspace-repository.ts";
import type { PlannerPort } from "../ports/planner-port.ts";
import type { SpecApprovalRepository } from "../ports/spec-approval-repository.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type { IssuePlanService } from "./issue-plan-service.ts";

export class IssuePlanGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuePlanGenerationError";
  }
}

export interface IssuePlanGenerationAuthorizer {
  authorize(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: "issue.generate";
  }): Promise<void>;
}

export class IssuePlanGenerationService {
  private readonly goals: GoalWorkspaceRepository;
  private readonly specifications: SpecApprovalRepository;
  private readonly artifacts: ArtifactStore;
  private readonly planner: PlannerPort;
  private readonly plans: Pick<IssuePlanService, "createDraft">;
  private readonly authorizer: IssuePlanGenerationAuthorizer;
  private readonly plannerConfiguration: IssuePlannerConfiguration;

  constructor(input: {
    goals: GoalWorkspaceRepository;
    specifications: SpecApprovalRepository;
    artifacts: ArtifactStore;
    planner: PlannerPort;
    plans: Pick<IssuePlanService, "createDraft">;
    authorizer: IssuePlanGenerationAuthorizer;
    plannerConfiguration?: IssuePlannerConfiguration;
  }) {
    this.goals = input.goals;
    this.specifications = input.specifications;
    this.artifacts = input.artifacts;
    this.planner = input.planner;
    this.plans = input.plans;
    this.authorizer = input.authorizer;
    this.plannerConfiguration = input.plannerConfiguration ?? {
      adapter: "codex",
      modelProfile: "configured-planner",
      schemaVersion: issuePlanDraftSchemaVersion,
    };
  }

  async generate(command: {
    organizationId: string;
    projectId: string;
    goalId: string;
    specRevisionId: string;
    expectedSpecVersion: number;
    actorId: string;
  }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "issue.generate",
    });
    if (!Number.isInteger(command.expectedSpecVersion) || command.expectedSpecVersion < 1) {
      throw new IssuePlanGenerationError("expectedSpecVersion must be positive");
    }
    const scope = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
    };
    const [goal, specification, latest] = await Promise.all([
      this.goals.get({ id: command.goalId, ...scope }),
      this.specifications.get({ ...scope, specRevisionId: command.specRevisionId }),
      this.specifications.getLatest(scope),
    ]);
    if (!goal || !specification) throw new IssuePlanGenerationError("Approved source was not found");
    if (latest?.id !== specification.id || specification.status !== "approved" ||
      specification.version !== command.expectedSpecVersion) {
      throw new VersionConflictError();
    }
    const artifact = await this.artifacts.get<SpecBundle>(specification.artifactRef);
    if (!artifact || artifact.digest !== specification.artifactDigest) {
      throw new IssuePlanGenerationError("Approved specification artifact is unavailable");
    }
    const bundle = validateSpecBundle(artifact.content);
    const planned = await this.planner.plan({
      goal,
      outputSchema: issuePlanDraftOutputSchema,
      purpose: "issue_plan",
      approvedSpecification: bundle,
    });
    if (planned.goalId !== goal.id || planned.sourceGoalVersion !== goal.version) {
      throw new VersionConflictError();
    }
    const draft = validateIssuePlanDraft(planned.output);
    return await this.plans.createDraft({
      scope,
      source: {
        specRevisionId: specification.id,
        specRevisionVersion: specification.version,
        specArtifactDigest: specification.artifactDigest,
        requirements: bundle.prd.requirements.map(({ id, acceptanceCriterionRefs }) => ({
          id,
          acceptanceCriterionRefs,
        })),
        acceptanceCriterionIds: goal.acceptanceCriteria.map(({ id }) => id),
      },
      draft,
      plannerRunId: planned.plannerRunId,
      plannerConfiguration: this.plannerConfiguration,
      actorId: command.actorId,
    });
  }
}
