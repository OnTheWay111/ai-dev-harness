import { ClarificationExpiredError } from "../domain/clarification-history.ts";
import {
  specBundleOutputSchema,
  specBundleSchemaVersion,
  validateSpecBundle,
  type PlannerConfiguration,
  type SpecBundle,
  type SpecRevision,
} from "../domain/spec-artifact.ts";
import {
  classifySolutionElements,
  overdesignPolicyRevision,
} from "../domain/overdesign-review.ts";
import type { GoalWorkspaceRepository } from "../ports/goal-workspace-repository.ts";
import type { ArtifactStore, ImmutableArtifact } from "../ports/artifact-store.ts";
import type { PlannerPort } from "../ports/planner-port.ts";
import type { SpecRevisionRepository } from "../ports/spec-revision-repository.ts";
import {
  diffSpecBundles,
  type SpecRevisionDiff,
} from "../domain/spec-revision-diff.ts";

export class SpecGenerationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecGenerationValidationError";
  }
}

export interface SpecGenerationCommand {
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
  expectedGoalVersion: number;
  reason: string;
}

export interface SpecGenerationReceipt {
  specRevision: SpecRevision;
  artifact: ImmutableArtifact<SpecBundle>;
}

export interface SpecRevisionView extends SpecGenerationReceipt {
  changesFromPrevious: SpecRevisionDiff | null;
}

export interface SpecRevisionViewTimeline {
  revisions: readonly SpecRevisionView[];
}

export interface SpecGenerationAuthorizer {
  authorize(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: "spec.generate" | "spec.read";
  }): Promise<void>;
}

function nonBlank(value: string, name: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new SpecGenerationValidationError(`${name} must be non-blank and bounded`);
  }
  return value.trim();
}

export class SpecGenerationService {
  private readonly planner: PlannerPort;
  private readonly artifacts: ArtifactStore;
  private readonly repository: SpecRevisionRepository;
  private readonly goals: GoalWorkspaceRepository;
  private readonly authorizer: SpecGenerationAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly plannerConfiguration: PlannerConfiguration;

  constructor(input: {
    planner: PlannerPort;
    artifacts: ArtifactStore;
    repository: SpecRevisionRepository;
    goals: GoalWorkspaceRepository;
    authorizer: SpecGenerationAuthorizer;
    clock?: () => Date;
    idGenerator?: () => string;
    plannerConfiguration?: PlannerConfiguration;
  }) {
    this.planner = input.planner;
    this.artifacts = input.artifacts;
    this.repository = input.repository;
    this.goals = input.goals;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
    this.plannerConfiguration = input.plannerConfiguration ?? {
      adapter: "codex",
      modelProfile: "configured-planner",
      schemaVersion: specBundleSchemaVersion,
    };
  }

  async generate(command: SpecGenerationCommand): Promise<SpecGenerationReceipt> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "spec.generate",
    });
    if (!Number.isInteger(command.expectedGoalVersion) || command.expectedGoalVersion < 1) {
      throw new SpecGenerationValidationError("expectedGoalVersion must be positive");
    }
    nonBlank(command.reason, "reason");
    const goal = await this.goals.get({
      id: command.goalId,
      organizationId: command.organizationId,
      projectId: command.projectId,
    });
    if (!goal) throw new SpecGenerationValidationError("Goal was not found");
    if (goal.version !== command.expectedGoalVersion) throw new ClarificationExpiredError();
    if (goal.status !== "planning") {
      throw new SpecGenerationValidationError("Goal must be in planning before spec generation");
    }
    const timeline = await this.repository.list(command);
    const previous = timeline.revisions.at(-1) ?? null;
    const planned = await this.planner.plan<SpecBundle>({
      goal,
      outputSchema: specBundleOutputSchema,
      purpose: "specification",
    });
    if (planned.goalId !== goal.id || planned.sourceGoalVersion !== goal.version) {
      throw new ClarificationExpiredError();
    }
    const content = validateSpecBundle(planned.output);
    const occurredAt = this.clock().toISOString();
    const artifact = await this.artifacts.put({
      content,
      createdAt: occurredAt,
      createdBy: command.actorId,
    });
    const overdesignReview = classifySolutionElements({
      acceptanceCriterionIds: goal.acceptanceCriteria.map(({ id }) => id),
      constraints: goal.constraints,
    }, content.solutionElements);
    const revision: SpecRevision = {
      id: this.idGenerator(),
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      revision: (previous?.revision ?? 0) + 1,
      previousRevisionId: previous?.id ?? null,
      status: "draft",
      sourceGoalVersion: goal.version,
      artifactRef: artifact.ref,
      artifactDigest: artifact.digest,
      artifactMediaType: artifact.mediaType,
      artifactSizeBytes: artifact.sizeBytes,
      plannerRunId: planned.plannerRunId,
      plannerConfiguration: this.plannerConfiguration,
      overdesignPolicyRevision,
      overdesignReview,
      generatedAt: occurredAt,
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    return {
      specRevision: await this.repository.append({
        revision,
        expectedGoalVersion: command.expectedGoalVersion,
        expectedPreviousRevisionId: previous?.id ?? null,
      }),
      artifact,
    };
  }

  async timeline(command: {
    organizationId: string;
    projectId: string;
    goalId: string;
    actorId: string;
  }): Promise<SpecRevisionViewTimeline> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "spec.read",
    });
    const timeline = await this.repository.list(command);
    const loaded = await Promise.all(timeline.revisions.map(async (specRevision) => {
      const artifact = await this.artifacts.get<SpecBundle>(specRevision.artifactRef);
      if (!artifact || artifact.digest !== specRevision.artifactDigest) {
        throw new SpecGenerationValidationError("Spec artifact is missing or does not match its digest");
      }
      return { specRevision, artifact: { ...artifact, content: validateSpecBundle(artifact.content) } };
    }));
    const revisions = loaded.map((revision, index): SpecRevisionView => ({
      ...revision,
      changesFromPrevious: index === 0
        ? null
        : diffSpecBundles(loaded[index - 1].artifact.content, revision.artifact.content),
    }));
    return { revisions };
  }
}
