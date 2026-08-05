import { createHash, randomUUID } from "node:crypto";

import {
  approveCanary,
  createCanary,
  createProductionRelease,
  evaluateProductionRelease,
  finalizeCanary,
  ReleaseCenterValidationError,
  type NewCanaryEvent,
  type ProductionGateId,
  type ReleaseSignatureRole,
  recordCanaryEvent,
  recordCanaryWindow,
  recordProductionGate,
  resolveCanaryAlert,
  restartCanary,
  signProductionRelease,
  type CanaryWindow,
} from "./domain.ts";
import {
  type ReleaseCenterAuthorizer,
  ReleaseCenterNotFoundError,
  type ReleaseCenterRepository,
  type ReleaseCenterScope,
  type ReleaseCommandMetadata,
} from "./repository.ts";

export interface ReleaseCommandIdentity {
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  reason: string;
}

type CommandInput = ReleaseCenterScope & ReleaseCommandIdentity;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function validIdentity(input: ReleaseCommandIdentity) {
  for (const [label, value, minimum] of [
    ["actorId", input.actorId, 1],
    ["requestId", input.requestId, 1],
    ["idempotencyKey", input.idempotencyKey, 8],
    ["reason", input.reason, 20],
  ] as const) {
    if (!value?.trim() || value.trim().length < minimum || value.length > 4_000) {
      throw new ReleaseCenterValidationError(`${label} is required and bounded`);
    }
  }
}

export class ReleaseCenterService {
  private readonly repository: ReleaseCenterRepository;
  private readonly authorizer: ReleaseCenterAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: ReleaseCenterRepository;
    authorizer: ReleaseCenterAuthorizer;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? randomUUID;
  }

  private command(
    input: CommandInput,
    endpoint: string,
    eventType: string,
    payload: unknown,
    auditId = this.idGenerator(),
  ): ReleaseCommandMetadata {
    validIdentity(input);
    return {
      ...input,
      requestHash: hash(payload),
      endpoint,
      auditId,
      eventId: this.idGenerator(),
      eventType,
      occurredAt: this.clock().toISOString(),
    };
  }

  async snapshot(input: ReleaseCenterScope & { actorId: string }) {
    await this.authorizer.authorizePermission({ ...input, permission: "goal.read" });
    const [canaries, releases] = await Promise.all([
      this.repository.listCanaries(input),
      this.repository.listProductionReleases(input),
    ]);
    return { canaries, releases };
  }

  async createCanary(input: CommandInput & {
    goalId: string;
    candidateCommit: string;
    goalContractVersion: number;
    allowedAreas: readonly string[];
    excludedAreas: readonly string[];
    successConditions: readonly string[];
    stopConditions: readonly string[];
    rollbackRunbook: string;
    stopRunbook: string;
  }) {
    await this.authorizer.authorizePermission({ ...input, permission: "run.operate" });
    const now = this.clock();
    const command = this.command(input, "release.canary.create", "release.canary.created", input);
    const replay = await this.repository.findCanaryCommand(command);
    if (replay) return replay;
    const aggregate = createCanary({
      canaryId: this.idGenerator(),
      ...input,
      createdBy: input.actorId,
      now,
    });
    return await this.repository.commitCanary({ aggregate, expectedVersion: 0, command });
  }

  private async canary(input: ReleaseCenterScope & { canaryId: string }) {
    const value = await this.repository.getCanary(input);
    if (!value) throw new ReleaseCenterNotFoundError();
    return value;
  }

  async approveCanary(input: CommandInput & {
    canaryId: string;
    expectedVersion: number;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const command = this.command(
      input, "release.canary.approve", "release.canary.approved", input,
    );
    const replay = await this.repository.findCanaryCommand(command);
    if (replay) return replay;
    const current = await this.canary(input);
    const aggregate = approveCanary(current, {
      actorId: input.actorId, reason: input.reason, now: this.clock(),
    });
    return await this.repository.commitCanary({
      aggregate,
      expectedVersion: input.expectedVersion,
      command,
    });
  }

  async restartCanary(input: CommandInput & {
    canaryId: string;
    expectedVersion: number;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const command = this.command(
      input, "release.canary.restart", "release.canary.restarted", input,
    );
    const replay = await this.repository.findCanaryCommand(command);
    if (replay) return replay;
    const aggregate = restartCanary(await this.canary(input), {
      actorId: input.actorId, reason: input.reason, now: this.clock(),
    });
    return await this.repository.commitCanary({
      aggregate,
      expectedVersion: input.expectedVersion,
      command,
    });
  }

  async recordCanaryWindow(input: CommandInput & {
    canaryId: string;
    expectedVersion: number;
    window: Omit<CanaryWindow, "attempt" | "recordedBy">;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const command = this.command(
      input, "release.canary.window", "release.canary.window-recorded", input,
    );
    const replay = await this.repository.findCanaryCommand(command);
    if (replay) return replay;
    const aggregate = recordCanaryWindow(await this.canary(input), {
      actorId: input.actorId, window: input.window, now: this.clock(),
    });
    return await this.repository.commitCanary({
      aggregate,
      expectedVersion: input.expectedVersion,
      appendWindow: aggregate.windows.at(-1),
      command,
    });
  }

  async recordCanaryEvent(input: CommandInput & {
    canaryId: string;
    expectedVersion: number;
    event: NewCanaryEvent;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const command = this.command(
      input, "release.canary.event", "release.canary.event-recorded", input,
    );
    const replay = await this.repository.findCanaryCommand(command);
    if (replay) return replay;
    const aggregate = recordCanaryEvent(await this.canary(input), {
      actorId: input.actorId, event: input.event, now: this.clock(),
    });
    return await this.repository.commitCanary({
      aggregate,
      expectedVersion: input.expectedVersion,
      appendEvent: aggregate.events.at(-1),
      command,
    });
  }

  async resolveCanaryAlert(input: CommandInput & {
    canaryId: string;
    expectedVersion: number;
    eventId: string;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const command = this.command(
      input,
      "release.canary.resolve-alert",
      "release.canary.alert-resolved",
      input,
    );
    const replay = await this.repository.findCanaryCommand(command);
    if (replay) return replay;
    const aggregate = resolveCanaryAlert(await this.canary(input), {
      actorId: input.actorId,
      eventId: input.eventId,
      reason: input.reason,
      now: this.clock(),
    });
    return await this.repository.commitCanary({
      aggregate,
      expectedVersion: input.expectedVersion,
      resolvedEventId: input.eventId,
      command,
    });
  }

  async finalizeCanary(input: CommandInput & {
    canaryId: string;
    expectedVersion: number;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const command = this.command(
      input, "release.canary.finalize", "release.canary.passed", input,
    );
    const replay = await this.repository.findCanaryCommand(command);
    if (replay) return replay;
    const current = await this.canary(input);
    const endedAt = current.windows
      .filter((window) => window.attempt === current.attempt)
      .at(-1)?.endedAt;
    if (!current.startedAt || !endedAt) {
      throw new ReleaseCenterValidationError("Canary has no observation window");
    }
    const verification = await this.repository.findPassedGoalVerification({
      ...input,
      goalId: current.goalId,
      startedAt: current.startedAt,
      endedAt,
    });
    if (!verification) {
      throw new ReleaseCenterValidationError(
        "No passed Goal Verification exists inside the Canary window",
      );
    }
    const aggregate = finalizeCanary(current, { verification, now: this.clock() });
    return await this.repository.commitCanary({
      aggregate,
      expectedVersion: input.expectedVersion,
      command,
    });
  }

  async createProductionRelease(input: CommandInput & { canaryId: string }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const canary = await this.canary(input);
    const command = this.command(input, "release.production.create", "release.production.created", input);
    const replay = await this.repository.findProductionReleaseCommand(command);
    if (replay) return replay;
    const aggregate = createProductionRelease({
      id: this.idGenerator(), canary, actorId: input.actorId, now: this.clock(),
    });
    return await this.repository.commitProductionRelease({
      aggregate, expectedVersion: 0, command,
    });
  }

  private async production(input: ReleaseCenterScope & { releaseId: string }) {
    const value = await this.repository.getProductionRelease(input);
    if (!value) throw new ReleaseCenterNotFoundError();
    return value;
  }

  async recordProductionGate(input: CommandInput & {
    releaseId: string;
    expectedVersion: number;
    gateId: ProductionGateId;
    ownerRole: ReleaseSignatureRole;
    evidenceRefs: readonly string[];
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: input.ownerRole });
    const command = this.command(
      input,
      "release.production.gate",
      "release.production.gate-passed",
      input,
    );
    const replay = await this.repository.findProductionReleaseCommand(command);
    if (replay) return replay;
    const aggregate = recordProductionGate(await this.production(input), {
      actorId: input.actorId,
      gateId: input.gateId,
      ownerRole: input.ownerRole,
      evidenceRefs: input.evidenceRefs,
      now: this.clock(),
    });
    return await this.repository.commitProductionRelease({
      aggregate,
      expectedVersion: input.expectedVersion,
      gate: aggregate.gates.find(({ gateId }) => gateId === input.gateId),
      command,
    });
  }

  async evaluateProductionRelease(input: CommandInput & {
    releaseId: string;
    expectedVersion: number;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: "owner" });
    const command = this.command(
      input,
      "release.production.evaluate",
      "release.production.evaluated",
      input,
    );
    const replay = await this.repository.findProductionReleaseCommand(command);
    if (replay) return replay;
    const aggregate = evaluateProductionRelease(await this.production(input), {
      actorId: input.actorId, now: this.clock(),
    });
    return await this.repository.commitProductionRelease({
      aggregate,
      expectedVersion: input.expectedVersion,
      command,
    });
  }

  async signProductionRelease(input: CommandInput & {
    releaseId: string;
    expectedVersion: number;
    role: ReleaseSignatureRole;
  }) {
    await this.authorizer.authorizeRole({ ...input, releaseRole: input.role });
    const auditId = this.idGenerator();
    const command = this.command(
      input,
      "release.production.sign",
      "release.production.signed",
      input,
      auditId,
    );
    const replay = await this.repository.findProductionReleaseCommand(command);
    if (replay) return replay;
    const aggregate = signProductionRelease(await this.production(input), {
      actorId: input.actorId,
      role: input.role,
      reason: input.reason,
      requestId: input.requestId,
      auditReceiptId: auditId,
      now: this.clock(),
    });
    return await this.repository.commitProductionRelease({
      aggregate,
      expectedVersion: input.expectedVersion,
      signature: aggregate.signatures.at(-1),
      command,
    });
  }
}
