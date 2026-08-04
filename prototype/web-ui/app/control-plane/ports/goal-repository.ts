import type { GoalStatus } from "../domain/state-machines.ts";

export interface GoalScope {
  id: string;
  organizationId: string;
  projectId: string;
}

export interface GoalAggregate extends GoalScope {
  title: string;
  status: GoalStatus;
  version: number;
}

export interface GoalStateChangedEvent {
  id: string;
  organizationId: string;
  aggregateType: "goal";
  aggregateId: string;
  aggregateVersion: number;
  type: "goal.state_changed";
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface GoalAuditEvent {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
  action: "goal.state_changed";
  entityType: "goal";
  entityId: string;
  entityVersion: number;
  reason: string;
  requestId: string;
  createdAt: string;
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

export interface GoalCommandIdempotency {
  organizationId: string;
  actorId: string;
  endpoint: "goal.transition";
  key: string;
  requestHash: string;
  responseDigest: string;
  expiresAt: Date;
}

export interface GoalIdempotencyLookup {
  organizationId: string;
  actorId: string;
  endpoint: "goal.transition";
  key: string;
  requestHash: string;
}

export interface CommitGoalTransition {
  current: GoalAggregate;
  expectedVersion: number;
  nextState: GoalStatus;
  occurredAt: Date;
  event: GoalStateChangedEvent;
  audit: GoalAuditEvent;
  idempotency: GoalCommandIdempotency;
  receipt: GoalTransitionReceipt;
}

export interface GoalCommitResult {
  goal: GoalAggregate;
  receipt: GoalTransitionReceipt;
}

export interface GoalRepository {
  get(scope: GoalScope): Promise<GoalAggregate | null>;
  findIdempotentReceipt(
    lookup: GoalIdempotencyLookup,
  ): Promise<GoalTransitionReceipt | null>;
  commitTransition(command: CommitGoalTransition): Promise<GoalCommitResult>;
}
