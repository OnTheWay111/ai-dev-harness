import type {
  CanaryAggregate,
  CanaryReport,
  PassedGoalVerification,
  ProductionReleaseAggregate,
} from "./domain.ts";
import {
  type CanaryCommit,
  ReleaseCenterIdempotencyConflictError,
  type ReleaseCenterRepository,
  type ReleaseCenterScope,
  ReleaseCenterVersionConflictError,
  type ProductionReleaseCommit,
} from "./repository.ts";

interface IdempotentResult {
  requestHash: string;
  aggregate: CanaryAggregate | ProductionReleaseAggregate;
}

function key(scope: ReleaseCenterScope, id: string): string {
  return `${scope.organizationId}:${scope.projectId}:${id}`;
}

export class MemoryReleaseCenterRepository implements ReleaseCenterRepository {
  private readonly canaries = new Map<string, CanaryAggregate>();
  private readonly releases = new Map<string, ProductionReleaseAggregate>();
  private readonly idempotency = new Map<string, IdempotentResult>();
  private readonly verifications = new Map<string, PassedGoalVerification>();

  private replay<T extends CanaryAggregate | ProductionReleaseAggregate>(
    input: CanaryCommit | ProductionReleaseCommit,
  ): T | null {
    const commandKey = `${input.command.organizationId}:${input.command.actorId}:${input.command.endpoint}:${input.command.idempotencyKey}`;
    const existing = this.idempotency.get(commandKey);
    if (!existing) return null;
    if (existing.requestHash !== input.command.requestHash) {
      throw new ReleaseCenterIdempotencyConflictError();
    }
    return structuredClone(existing.aggregate) as T;
  }

  async findCanaryCommand(command: CanaryCommit["command"]) {
    return this.replay<CanaryAggregate>({ command } as CanaryCommit);
  }

  async findProductionReleaseCommand(command: ProductionReleaseCommit["command"]) {
    return this.replay<ProductionReleaseAggregate>({ command } as ProductionReleaseCommit);
  }

  private remember(
    input: CanaryCommit | ProductionReleaseCommit,
    aggregate: CanaryAggregate | ProductionReleaseAggregate,
  ) {
    const commandKey = `${input.command.organizationId}:${input.command.actorId}:${input.command.endpoint}:${input.command.idempotencyKey}`;
    this.idempotency.set(commandKey, {
      requestHash: input.command.requestHash,
      aggregate: structuredClone(aggregate),
    });
  }

  async listCanaries(scope: ReleaseCenterScope): Promise<readonly CanaryAggregate[]> {
    return [...this.canaries.values()]
      .filter((value) => value.organizationId === scope.organizationId &&
        value.projectId === scope.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((value) => structuredClone(value));
  }

  async getCanary(scope: ReleaseCenterScope & { canaryId: string }) {
    return structuredClone(this.canaries.get(key(scope, scope.canaryId)) ?? null);
  }

  async commitCanary(input: CanaryCommit): Promise<CanaryAggregate> {
    const replay = this.replay<CanaryAggregate>(input);
    if (replay) return replay;
    const storageKey = key(input.aggregate, input.aggregate.id);
    const current = this.canaries.get(storageKey);
    if ((input.expectedVersion === 0 && current) ||
      (input.expectedVersion > 0 && current?.version !== input.expectedVersion)) {
      throw new ReleaseCenterVersionConflictError();
    }
    this.canaries.set(storageKey, structuredClone(input.aggregate));
    this.remember(input, input.aggregate);
    return structuredClone(input.aggregate);
  }

  async findPassedGoalVerification(input: ReleaseCenterScope & {
    goalId: string;
    startedAt: string;
    endedAt: string;
  }): Promise<PassedGoalVerification | null> {
    const verification = this.verifications.get(key(input, input.goalId));
    if (!verification || verification.verifiedAt < input.startedAt ||
      verification.verifiedAt > input.endedAt) return null;
    return structuredClone(verification);
  }

  seedVerification(scope: ReleaseCenterScope & {
    goalId: string;
    verification: PassedGoalVerification;
  }) {
    this.verifications.set(key(scope, scope.goalId), structuredClone(scope.verification));
  }

  async listProductionReleases(scope: ReleaseCenterScope) {
    return [...this.releases.values()]
      .filter((value) => value.organizationId === scope.organizationId &&
        value.projectId === scope.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((value) => structuredClone(value));
  }

  async getProductionRelease(scope: ReleaseCenterScope & { releaseId: string }) {
    return structuredClone(this.releases.get(key(scope, scope.releaseId)) ?? null);
  }

  async commitProductionRelease(
    input: ProductionReleaseCommit,
  ): Promise<ProductionReleaseAggregate> {
    const replay = this.replay<ProductionReleaseAggregate>(input);
    if (replay) return replay;
    const storageKey = key(input.aggregate, input.aggregate.id);
    const current = this.releases.get(storageKey);
    if ((input.expectedVersion === 0 && current) ||
      (input.expectedVersion > 0 && current?.version !== input.expectedVersion)) {
      throw new ReleaseCenterVersionConflictError();
    }
    this.releases.set(storageKey, structuredClone(input.aggregate));
    this.remember(input, input.aggregate);
    return structuredClone(input.aggregate);
  }

  seedApprovedRelease(input: Partial<ProductionReleaseAggregate> & {
    id: string;
    organizationId: string;
    projectId: string;
    goalId: string;
  }) {
    const canaryReport = {
      schemaVersion: "harness.p12-canary-report.v1",
      canaryId: "00000000-0000-4000-8000-000000000088",
      status: "passed",
      project: {
        projectId: input.projectId,
        internal: true,
        risk: "low",
        ownerId: "oidc_project_owner",
        approvedAt: input.evaluatedAt ?? new Date().toISOString(),
      },
      scope: {
        goalId: input.goalId,
        goalContractVersion: 1,
        allowedAreas: ["documentation"],
        excludedAreas: ["production-data"],
      },
      conditions: {
        success: ["passed"],
        stop: ["P0/P1"],
        rollbackRunbook: "docs/runbooks/deployment-rollback-upgrade.md",
        stopRunbook: "docs/runbooks/execution-stop-worker-loss.md",
      },
      observation: {
        requiredDurationHours: 48,
        startedAt: input.evaluatedAt ?? new Date().toISOString(),
        endedAt: input.evaluatedAt ?? new Date().toISOString(),
        windows: [],
      },
      defects: [], alerts: [], interventions: [],
      goalVerification: {
        status: "passed",
        verificationId: "memory-verification",
        completedAt: input.evaluatedAt ?? new Date().toISOString(),
        evidenceRefs: ["goal-verification:memory"],
      },
      gaps: [], result: "passed",
    } as CanaryReport;
    const now = input.evaluatedAt ?? new Date().toISOString();
    const release: ProductionReleaseAggregate = {
      id: input.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      goalId: input.goalId,
      canaryId: "00000000-0000-4000-8000-000000000088",
      candidateCommit: "a".repeat(40),
      status: input.status ?? "draft",
      canaryReport,
      gates: [],
      defects: { p0Count: 0, p1Count: 0, p2: [] },
      evaluatedAt: input.evaluatedAt ?? null,
      attestationDigest: input.attestationDigest ?? null,
      signatures: [],
      report: input.status === "awaiting_signatures" ? {
        schemaVersion: "harness.p12-production-release-gate.v1",
        releaseId: input.id,
        target: "production-v1",
        candidateCommit: "a".repeat(40),
        evaluatedAt: now,
        canary: canaryReport,
        gates: [],
        defects: { p0Count: 0, p1Count: 0, p2: [] },
        signatures: [], gaps: [], result: "approved",
      } : null,
      version: input.version ?? 1,
      createdBy: "memory-operator",
      createdAt: now,
      updatedAt: now,
    };
    this.releases.set(key(release, release.id), release);
  }
}
