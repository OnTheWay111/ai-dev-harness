import {
  type ClassificationPolicyRevision,
  type GoalClassification,
  ClassificationValidationError,
} from "../domain/classification.ts";
import { ClarificationNotFoundError } from "../domain/clarification-history.ts";
import { classificationPolicyV1, classifyGoal } from "../domain/deterministic-classification.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type { ClassificationRepository } from "../ports/classification-repository.ts";
import type { ClarificationHistoryRepository } from "../ports/clarification-history-repository.ts";
import type { GoalWorkspaceAuthorizer, GoalWorkspaceRepository } from "../ports/goal-workspace-repository.ts";

interface Command {
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
}
export interface ClassifyGoalCommand extends Command {
  expectedGoalVersion: number;
  reason: string;
}

function reason(value: string): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 4_000) {
    throw new ClassificationValidationError("reason is required and bounded");
  }
  return value.trim();
}

export class ClassificationService {
  private readonly repository: ClassificationRepository;
  private readonly goals: GoalWorkspaceRepository;
  private readonly clarifications: ClarificationHistoryRepository;
  private readonly authorizer: GoalWorkspaceAuthorizer;
  private readonly idGenerator: () => string;
  private readonly clock: () => Date;

  constructor(input: {
    repository: ClassificationRepository;
    goals: GoalWorkspaceRepository;
    clarifications: ClarificationHistoryRepository;
    authorizer: GoalWorkspaceAuthorizer;
    idGenerator?: () => string;
    clock?: () => Date;
  }) {
    this.repository = input.repository;
    this.goals = input.goals;
    this.clarifications = input.clarifications;
    this.authorizer = input.authorizer;
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
    this.clock = input.clock ?? (() => new Date());
  }

  async timeline(command: Command) {
    await this.authorizer.authorize({ ...command, permission: "goal.read" });
    return await this.repository.getTimeline(command);
  }

  async classify(command: ClassifyGoalCommand) {
    await this.authorizer.authorize({ ...command, permission: "goal.write" });
    if (!Number.isInteger(command.expectedGoalVersion) || command.expectedGoalVersion < 1) {
      throw new ClassificationValidationError("expectedGoalVersion must be positive");
    }
    const normalizedReason = reason(command.reason);
    const goal = await this.goals.get({ ...command, id: command.goalId });
    if (!goal) throw new ClarificationNotFoundError();
    if (goal.version !== command.expectedGoalVersion) throw new VersionConflictError();
    const clarificationTimeline = await this.clarifications.getTimeline(command);
    const latest = new Map<string, typeof clarificationTimeline.questions[number]>();
    for (const question of clarificationTimeline.questions) {
      if ((latest.get(question.threadId)?.revision ?? 0) < question.revision) {
        latest.set(question.threadId, question);
      }
    }
    const output = classifyGoal({
      goal,
      clarifications: [...latest.values()].map(({ blockingLevel, status }) => ({ blockingLevel, status })),
    });
    const current = await this.repository.getTimeline(command);
    const previous = current.classifications.at(-1) ?? null;
    const createdAt = this.clock().toISOString();
    const policy: ClassificationPolicyRevision = {
      id: this.idGenerator(),
      policyKey: classificationPolicyV1.policyKey,
      revision: classificationPolicyV1.revision,
      schemaVersion: classificationPolicyV1.schemaVersion,
      digest: classificationPolicyV1.digest,
      definition: classificationPolicyV1.definition,
      actorId: command.actorId,
      reason: normalizedReason,
      createdAt,
    };
    const classification: GoalClassification = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      id: this.idGenerator(),
      revision: (previous?.revision ?? 0) + 1,
      previousClassificationId: previous?.id ?? null,
      sourceGoalVersion: goal.version,
      policyRevisionId: policy.id,
      ...output,
      actorId: command.actorId,
      reason: normalizedReason,
      createdAt,
    };
    return await this.repository.append({
      expectedGoalVersion: goal.version,
      expectedPreviousClassificationId: previous?.id ?? null,
      policy,
      classification,
    });
  }
}
