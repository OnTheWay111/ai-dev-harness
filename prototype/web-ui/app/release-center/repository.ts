import type { Permission } from "../auth/rbac-policy.ts";
import type {
  CanaryAggregate,
  CanaryEvent,
  CanaryWindow,
  PassedGoalVerification,
  ProductionGateCheck,
  ProductionReleaseAggregate,
  ProductionSignature,
  ReleaseSignatureRole,
} from "./domain.ts";

export interface ReleaseCenterScope {
  organizationId: string;
  projectId: string;
}

export interface ReleaseCommandMetadata extends ReleaseCenterScope {
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  endpoint: string;
  reason: string;
  auditId: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export interface CanaryCommit {
  aggregate: CanaryAggregate;
  expectedVersion: number;
  command: ReleaseCommandMetadata;
  appendWindow?: CanaryWindow;
  appendEvent?: CanaryEvent;
  resolvedEventId?: string;
}

export interface ProductionReleaseCommit {
  aggregate: ProductionReleaseAggregate;
  expectedVersion: number;
  command: ReleaseCommandMetadata;
  gate?: ProductionGateCheck;
  signature?: ProductionSignature;
}

export class ReleaseCenterNotFoundError extends Error {
  constructor() {
    super("Release Center resource was not found");
    this.name = "ReleaseCenterNotFoundError";
  }
}

export class ReleaseCenterVersionConflictError extends Error {
  constructor() {
    super("Release Center resource changed before the command committed");
    this.name = "ReleaseCenterVersionConflictError";
  }
}

export class ReleaseCenterIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used for a different release command");
    this.name = "ReleaseCenterIdempotencyConflictError";
  }
}

export interface ReleaseCenterRepository {
  findCanaryCommand(
    command: ReleaseCommandMetadata,
  ): Promise<CanaryAggregate | null>;
  listCanaries(scope: ReleaseCenterScope): Promise<readonly CanaryAggregate[]>;
  getCanary(scope: ReleaseCenterScope & { canaryId: string }): Promise<CanaryAggregate | null>;
  commitCanary(input: CanaryCommit): Promise<CanaryAggregate>;
  findPassedGoalVerification(input: ReleaseCenterScope & {
    goalId: string;
    startedAt: string;
    endedAt: string;
  }): Promise<PassedGoalVerification | null>;
  findProductionReleaseCommand(
    command: ReleaseCommandMetadata,
  ): Promise<ProductionReleaseAggregate | null>;
  listProductionReleases(
    scope: ReleaseCenterScope,
  ): Promise<readonly ProductionReleaseAggregate[]>;
  getProductionRelease(scope: ReleaseCenterScope & {
    releaseId: string;
  }): Promise<ProductionReleaseAggregate | null>;
  commitProductionRelease(
    input: ProductionReleaseCommit,
  ): Promise<ProductionReleaseAggregate>;
}

export interface ReleaseCenterAuthorizer {
  authorizePermission(input: ReleaseCenterScope & {
    actorId: string;
    permission: Permission;
  }): Promise<void>;
  authorizeRole(input: ReleaseCenterScope & {
    actorId: string;
    releaseRole: ReleaseSignatureRole;
  }): Promise<void>;
}
