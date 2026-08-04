import { CommandValidationError } from "../domain/errors.ts";
import { goalStateMachine, transitionState } from
  "../domain/state-machines.ts";
import type {
  GoalStatus,
  TransitionGuard,
} from "../domain/state-machines.ts";
import type {
  GoalAuditEvent,
  GoalRepository,
  GoalStateChangedEvent,
  GoalTransitionReceipt,
} from "../ports/goal-repository.ts";

export type { GoalTransitionReceipt } from "../ports/goal-repository.ts";

export interface GoalTransitionCommand {
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
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

export class GoalNotFoundError extends Error {
  constructor() {
    super("Goal was not found in the authorized scope");
    this.name = "GoalNotFoundError";
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalCommand(command: GoalTransitionCommand): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    projectId: command.projectId,
    goalId: command.goalId,
    actorId: command.actorId,
    expectedVersion: command.expectedVersion,
    nextState: command.nextState,
    reason: command.reason,
    guards: Object.fromEntries(
      Object.entries(command.guards).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
  });
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
    if (
      command.idempotencyKey.trim().length < 1 ||
      command.idempotencyKey.length > 200
    ) {
      throw new CommandValidationError("Idempotency-Key is required");
    }
    if (command.reason.trim().length < 1 || command.reason.length > 4000) {
      throw new CommandValidationError("A bounded transition reason is required");
    }
    await this.authorizer.authorize({
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      actorId: command.actorId,
      nextState: command.nextState,
    });
    const requestHash = await sha256(canonicalCommand(command));
    const idempotencyLookup = {
      organizationId: command.organizationId,
      actorId: command.actorId,
      endpoint: "goal.transition" as const,
      key: command.idempotencyKey,
      requestHash,
    };
    const replay = await this.repository.findIdempotentReceipt(
      idempotencyLookup,
    );
    if (replay) return replay;

    const goal = await this.repository.get({
      id: command.goalId,
      organizationId: command.organizationId,
      projectId: command.projectId,
    });
    if (!goal) throw new GoalNotFoundError();
    if (goal.version !== command.expectedVersion) {
      const concurrentReplay = await this.repository.findIdempotentReceipt(
        idempotencyLookup,
      );
      if (concurrentReplay) return concurrentReplay;
    }

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
    const eventId = this.idGenerator();
    const receipt: GoalTransitionReceipt = {
      goalId: goal.id,
      previousState: transition.previousState,
      state: transition.state,
      previousVersion: transition.previousVersion,
      version: transition.version,
      eventId,
      occurredAt: occurredAtIso,
    };
    const event: GoalStateChangedEvent = {
      id: eventId,
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
    const audit: GoalAuditEvent = {
      id: this.idGenerator(),
      organizationId: goal.organizationId,
      projectId: goal.projectId,
      goalId: goal.id,
      actorId: command.actorId,
      action: "goal.state_changed",
      entityType: "goal",
      entityId: goal.id,
      entityVersion: transition.version,
      reason: command.reason,
      requestId: command.requestId,
      createdAt: occurredAtIso,
    };
    const expiresAt = new Date(occurredAt.getTime() + 24 * 60 * 60 * 1000);
    const committed = await this.repository.commitTransition({
      current: goal,
      expectedVersion: transition.previousVersion,
      nextState: transition.state,
      occurredAt,
      event,
      audit,
      idempotency: {
        ...idempotencyLookup,
        responseDigest: await sha256(JSON.stringify(receipt)),
        expiresAt,
      },
      receipt,
    });
    return committed.receipt;
  }
}
