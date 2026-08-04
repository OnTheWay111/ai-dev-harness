import {
  goalStateMachine,
  transitionState,
} from "../domain/state-machines.ts";
import type {
  GoalStatus,
  TransitionGuard,
} from "../domain/state-machines.ts";
import type {
  GoalRepository,
  GoalStateChangedEvent,
} from "../ports/goal-repository.ts";

export interface GoalTransitionCommand {
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
  requestId: string;
  expectedVersion: number;
  nextState: GoalStatus;
  reason: string;
  guards: Readonly<Partial<Record<TransitionGuard, boolean>>>;
}

export interface GoalTransitionAuthorizer {
  authorize(command: Readonly<{
    organizationId: string;
    projectId: string;
    goalId: string;
    actorId: string;
    nextState: GoalStatus;
  }>): Promise<void>;
}

export interface GoalTransitionReceipt {
  goalId: string;
  previousState: GoalStatus;
  state: GoalStatus;
  previousVersion: number;
  version: number;
  eventId: string;
  occurredAt: string;
}

export class GoalNotFoundError extends Error {
  constructor() {
    super("Goal was not found in the authorized scope");
    this.name = "GoalNotFoundError";
  }
}

export interface GoalApplicationDependencies {
  repository: GoalRepository;
  authorizer: GoalTransitionAuthorizer;
  clock?: () => Date;
  idGenerator?: () => string;
}

export class GoalApplicationService {
  private readonly repository: GoalRepository;
  private readonly authorizer: GoalTransitionAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(dependencies: GoalApplicationDependencies) {
    this.repository = dependencies.repository;
    this.authorizer = dependencies.authorizer;
    this.clock = dependencies.clock ?? (() => new Date());
    this.idGenerator = dependencies.idGenerator ?? (() => crypto.randomUUID());
  }

  async transition(
    command: GoalTransitionCommand,
  ): Promise<GoalTransitionReceipt> {
    await this.authorizer.authorize({
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      actorId: command.actorId,
      nextState: command.nextState,
    });
    const goal = await this.repository.get({
      id: command.goalId,
      organizationId: command.organizationId,
      projectId: command.projectId,
    });
    if (!goal) throw new GoalNotFoundError();

    const transition = transitionState({
      machine: goalStateMachine,
      currentState: goal.status,
      currentVersion: goal.version,
      expectedVersion: command.expectedVersion,
      nextState: command.nextState,
      guards: {
        ...command.guards,
        reasonProvided: command.reason.trim().length > 0,
      },
    });
    const occurredAt = this.clock();
    const occurredAtIso = occurredAt.toISOString();
    const event: GoalStateChangedEvent = {
      id: this.idGenerator(),
      organizationId: goal.organizationId,
      aggregateType: "goal",
      aggregateId: goal.id,
      aggregateVersion: transition.version,
      type: "goal.state_changed",
      occurredAt: occurredAtIso,
      payload: {
        actorId: command.actorId,
        requestId: command.requestId,
        reason: command.reason,
        previousState: transition.previousState,
        state: transition.state,
      },
    };
    const persisted = await this.repository.commitTransition({
      current: goal,
      expectedVersion: transition.previousVersion,
      nextState: transition.state,
      occurredAt,
      event,
    });
    return {
      goalId: goal.id,
      previousState: transition.previousState,
      state: persisted.status,
      previousVersion: transition.previousVersion,
      version: persisted.version,
      eventId: event.id,
      occurredAt: occurredAtIso,
    };
  }
}
