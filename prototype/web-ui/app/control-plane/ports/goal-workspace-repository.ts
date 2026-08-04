import type { GoalContract } from "../domain/goal-contract.ts";
import type { Permission } from "../../auth/rbac-policy.ts";

export interface GoalWorkspaceScope {
  id: string;
  organizationId: string;
  projectId: string;
}

export type GoalWorkspaceOperation = "created" | "updated";
export type GoalWorkspaceEndpoint = "goal.create" | "goal.update";

export interface GoalWorkspaceReceipt {
  operation: GoalWorkspaceOperation;
  goal: GoalContract;
  eventId: string;
  occurredAt: string;
}

export interface GoalWorkspaceIdempotencyLookup {
  organizationId: string;
  actorId: string;
  endpoint: GoalWorkspaceEndpoint;
  key: string;
  requestHash: string;
}

export interface GoalWorkspaceIdempotency extends GoalWorkspaceIdempotencyLookup {
  responseDigest: string;
  expiresAt: Date;
}

export interface GoalWorkspaceEvent {
  id: string;
  organizationId: string;
  aggregateType: "goal";
  aggregateId: string;
  aggregateVersion: number;
  type: "goal.created" | "goal.updated";
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface GoalWorkspaceAuditEvent {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
  action: "goal.created" | "goal.updated";
  entityType: "goal";
  entityId: string;
  entityVersion: number;
  reason: string;
  requestId: string;
  createdAt: string;
}

interface GoalWorkspaceCommitBase {
  event: GoalWorkspaceEvent;
  audit: GoalWorkspaceAuditEvent;
  idempotency: GoalWorkspaceIdempotency;
  receipt: GoalWorkspaceReceipt;
}

export interface CommitGoalCreate extends GoalWorkspaceCommitBase {
  goal: GoalContract;
}

export interface CommitGoalUpdate extends GoalWorkspaceCommitBase {
  current: GoalContract;
  next: GoalContract;
  expectedVersion: number;
}

export interface GoalWorkspaceRepository {
  get(scope: GoalWorkspaceScope): Promise<GoalContract | null>;
  findIdempotentReceipt(
    lookup: GoalWorkspaceIdempotencyLookup,
  ): Promise<GoalWorkspaceReceipt | null>;
  commitCreate(command: CommitGoalCreate): Promise<GoalWorkspaceReceipt>;
  commitUpdate(command: CommitGoalUpdate): Promise<GoalWorkspaceReceipt>;
}

export interface GoalWorkspaceAuthorizer {
  authorize(input: Readonly<{
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: Extract<Permission, "goal.read" | "goal.write">;
  }>): Promise<void>;
}
