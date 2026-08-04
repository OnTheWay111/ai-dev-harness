import {
  ClarificationExpiredError,
  ClarificationNotFoundError,
  ClarificationValidationError,
  type ClarificationAnswerReceipt,
  type ClarificationGenerationReceipt,
  type ClarificationQuestionRevision,
  type ClarificationRound,
  type ClarificationScope,
  type HumanDecision,
} from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type {
  ClarificationAuthorizer,
  ClarificationHistoryRepository,
} from "../ports/clarification-history-repository.ts";
import type { GoalWorkspaceRepository } from "../ports/goal-workspace-repository.ts";
import type { ClarificationPlannerService } from "./clarification-planner-service.ts";

interface Identity extends ClarificationScope {
  actorId: string;
}

export interface GenerateClarificationsCommand extends Identity {
  expectedGoalVersion: number;
  reason: string;
}

export interface AnswerClarificationCommand extends Identity {
  threadId: string;
  expectedQuestionRevision: number;
  expectedGoalVersion: number;
  answer: string;
  reason: string;
}

function text(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maximum) {
    throw new ClarificationValidationError(`${name} is required and bounded`);
  }
  return value.trim();
}

function positive(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ClarificationValidationError(`${name} must be a positive integer`);
  }
}

export class ClarificationHistoryService {
  private readonly repository: ClarificationHistoryRepository;
  private readonly goals: GoalWorkspaceRepository;
  private readonly planner: ClarificationPlannerService;
  private readonly authorizer: ClarificationAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: ClarificationHistoryRepository;
    goals: GoalWorkspaceRepository;
    planner: ClarificationPlannerService;
    authorizer: ClarificationAuthorizer;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.goals = input.goals;
    this.planner = input.planner;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  async timeline(command: Identity) {
    await this.authorize(command, "goal.read");
    return await this.repository.getTimeline(command);
  }

  async generate(command: GenerateClarificationsCommand): Promise<ClarificationGenerationReceipt> {
    await this.authorize(command, "goal.write");
    positive(command.expectedGoalVersion, "expectedGoalVersion");
    const reason = text(command.reason, "reason", 4_000);
    const goal = await this.goal(command);
    if (goal.version !== command.expectedGoalVersion) throw new VersionConflictError();
    const before = await this.repository.getTimeline(command);
    const previous = before.rounds.at(-1) ?? null;
    const planned = await this.planner.generate(goal);
    if (planned.sourceGoalVersion !== goal.version || planned.goalId !== goal.id) {
      throw new ClarificationExpiredError();
    }
    const createdAt = this.clock().toISOString();
    const round: ClarificationRound = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      actorId: command.actorId,
      id: this.idGenerator(),
      roundNumber: (previous?.roundNumber ?? 0) + 1,
      previousRoundId: previous?.id ?? null,
      regeneratedFromRoundId: previous?.id ?? null,
      sourceGoalVersion: goal.version,
      plannerRunId: planned.plannerRunId,
      knownFacts: planned.output.knownFacts,
      uncertainties: planned.output.uncertainties,
      reason,
      createdAt,
    };
    const questions: ClarificationQuestionRevision[] = planned.output.questions.map(
      (question) => ({
        organizationId: command.organizationId,
        projectId: command.projectId,
        goalId: command.goalId,
        actorId: command.actorId,
        id: this.idGenerator(),
        plannerQuestionId: question.id,
        prompt: question.prompt,
        rationale: question.rationale,
        blockingLevel: question.blockingLevel,
        answerType: question.answerType,
        suggestedOptions: [...question.suggestedOptions],
        roundId: round.id,
        threadId: this.idGenerator(),
        revision: 1,
        previousClarificationId: null,
        status: "open",
        answer: null,
        sourceGoalVersion: goal.version,
        reason,
        createdAt,
      }),
    );
    return await this.repository.appendRound({
      expectedGoalVersion: goal.version,
      expectedPreviousRoundId: previous?.id ?? null,
      round,
      questions,
    });
  }

  async answer(command: AnswerClarificationCommand): Promise<ClarificationAnswerReceipt> {
    await this.authorize(command, "goal.write");
    positive(command.expectedQuestionRevision, "expectedQuestionRevision");
    positive(command.expectedGoalVersion, "expectedGoalVersion");
    const answer = text(command.answer, "answer", 10_000);
    const reason = text(command.reason, "reason", 4_000);
    const goal = await this.goal(command);
    if (goal.version !== command.expectedGoalVersion) throw new VersionConflictError();
    const timeline = await this.repository.getTimeline(command);
    const revisions = timeline.questions.filter(({ threadId }) => threadId === command.threadId);
    const current = revisions.at(-1);
    if (!current) throw new ClarificationNotFoundError();
    if (current.revision !== command.expectedQuestionRevision) throw new VersionConflictError();
    if (
      current.roundId !== timeline.rounds.at(-1)?.id ||
      current.sourceGoalVersion !== goal.version
    ) throw new ClarificationExpiredError();
    const createdAt = this.clock().toISOString();
    const question: ClarificationQuestionRevision = {
      ...current,
      id: this.idGenerator(),
      revision: current.revision + 1,
      previousClarificationId: current.id,
      status: "answered",
      answer,
      actorId: command.actorId,
      reason,
      createdAt,
    };
    const priorDecision = timeline.decisions.filter(
      ({ decisionKey }) => decisionKey === command.threadId,
    ).at(-1);
    const decision: HumanDecision = {
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      actorId: command.actorId,
      id: this.idGenerator(),
      decisionKey: command.threadId,
      revision: (priorDecision?.revision ?? 0) + 1,
      previousDecisionId: priorDecision?.id ?? null,
      status: "approved",
      subjectType: "clarification",
      subjectId: question.id,
      subjectVersion: question.revision,
      outcome: answer,
      reason,
      createdAt,
    };
    return await this.repository.appendAnswer({
      expectedGoalVersion: goal.version,
      expectedQuestionRevision: current.revision,
      expectedQuestionId: current.id,
      question,
      decision,
    });
  }

  private async authorize(command: Identity, permission: "goal.read" | "goal.write") {
    await this.authorizer.authorize({ ...command, permission });
  }

  private async goal(scope: ClarificationScope) {
    const goal = await this.goals.get({ ...scope, id: scope.goalId });
    if (!goal) throw new ClarificationNotFoundError();
    return goal;
  }
}
