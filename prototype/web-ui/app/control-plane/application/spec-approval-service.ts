import { VersionConflictError } from "../domain/errors.ts";
import {
  scopeChangeKinds,
  scopeChangeOperations,
  specApprovalDecisions,
  type ScopeChange,
  type SpecApprovalAuditEvent,
  type SpecApprovalDecision,
  type SpecApprovalDecisionRecord,
  type SpecApprovalEvent,
  type SpecApprovalReceipt,
} from "../domain/spec-approval.ts";
import type { SpecApprovalRepository } from
  "../ports/spec-approval-repository.ts";

export class SpecApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecApprovalValidationError";
  }
}

export interface SpecApprovalCommand {
  organizationId: string;
  projectId: string;
  goalId: string;
  specRevisionId: string;
  expectedVersion: number;
  actorId: string;
  reason: string;
  requestId: string;
  idempotencyKey: string;
  policyRevision: string;
  decision: SpecApprovalDecision;
  affectedElementIds: readonly string[];
  helpfulExceptionElementIds: readonly string[];
  scopeChanges: readonly ScopeChange[];
}

export interface SpecApprovalAuthorizer {
  authorize(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    permission: "spec.approve" | "spec.read";
  }): Promise<void>;
}

function text(value: string, name: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new SpecApprovalValidationError(`${name} must be non-blank and bounded`);
  }
  return value.trim();
}

function ids(value: readonly string[], name: string): string[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new SpecApprovalValidationError(`${name} must be a bounded list`);
  }
  const normalized = value.map((item, index) => text(item, `${name}[${index}]`, 64));
  if (new Set(normalized).size !== normalized.length) {
    throw new SpecApprovalValidationError(`${name} contains duplicates`);
  }
  return normalized;
}

function changes(value: readonly ScopeChange[]): ScopeChange[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new SpecApprovalValidationError("scopeChanges must be a bounded list");
  }
  return value.map((change, index) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      throw new SpecApprovalValidationError(`scopeChanges[${index}] is invalid`);
    }
    if (!scopeChangeOperations.includes(change.operation) ||
      !scopeChangeKinds.includes(change.kind)) {
      throw new SpecApprovalValidationError(`scopeChanges[${index}] is invalid`);
    }
    return {
      operation: change.operation,
      kind: change.kind,
      value: text(change.value, `scopeChanges[${index}].value`, 4_000),
    };
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonical(command: SpecApprovalCommand, normalized: {
  reason: string;
  requestId: string;
  policyRevision: string;
  affectedElementIds: readonly string[];
  helpfulExceptionElementIds: readonly string[];
  scopeChanges: readonly ScopeChange[];
}): string {
  return JSON.stringify({
    endpoint: "spec.approval",
    organizationId: command.organizationId,
    projectId: command.projectId,
    goalId: command.goalId,
    specRevisionId: command.specRevisionId,
    expectedVersion: command.expectedVersion,
    actorId: command.actorId,
    decision: command.decision,
    ...normalized,
  });
}

export class SpecApprovalService {
  private readonly repository: SpecApprovalRepository;
  private readonly authorizer: SpecApprovalAuthorizer;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(input: {
    repository: SpecApprovalRepository;
    authorizer: SpecApprovalAuthorizer;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.repository = input.repository;
    this.authorizer = input.authorizer;
    this.clock = input.clock ?? (() => new Date());
    this.idGenerator = input.idGenerator ?? (() => crypto.randomUUID());
  }

  async timeline(command: {
    organizationId: string;
    projectId: string;
    goalId: string;
    actorId: string;
  }) {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "spec.read",
    });
    return await this.repository.approvalTimeline(command);
  }

  async decide(command: SpecApprovalCommand): Promise<SpecApprovalReceipt> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.organizationId,
      projectId: command.projectId,
      permission: "spec.approve",
    });
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new SpecApprovalValidationError("expectedVersion must be positive");
    }
    if (!specApprovalDecisions.includes(command.decision)) {
      throw new SpecApprovalValidationError("decision is invalid");
    }
    const normalized = {
      reason: text(command.reason, "reason"),
      requestId: text(command.requestId, "requestId", 200),
      policyRevision: text(command.policyRevision, "policyRevision", 100),
      affectedElementIds: ids(command.affectedElementIds, "affectedElementIds"),
      helpfulExceptionElementIds: ids(
        command.helpfulExceptionElementIds,
        "helpfulExceptionElementIds",
      ),
      scopeChanges: changes(command.scopeChanges),
    };
    const idempotencyKey = text(command.idempotencyKey, "idempotencyKey", 200);
    if (command.decision !== "request_changes" && normalized.scopeChanges.length > 0) {
      throw new SpecApprovalValidationError("scopeChanges require request_changes");
    }
    const requestHash = await sha256(canonical(command, normalized));
    const lookup = {
      organizationId: command.organizationId,
      actorId: command.actorId,
      endpoint: "spec.approval" as const,
      key: idempotencyKey,
      requestHash,
    };
    const replay = await this.repository.findApprovalReceipt(lookup);
    if (replay) return replay;
    const current = await this.repository.get(command);
    if (!current) throw new SpecApprovalValidationError("SpecRevision was not found");
    if (current.version !== command.expectedVersion) throw new VersionConflictError();
    const expectedStatus = command.decision === "submit_for_review"
      ? "draft"
      : "in_review";
    if (current.status !== expectedStatus) {
      throw new SpecApprovalValidationError(
        command.decision === "submit_for_review"
          ? "Only a draft SpecRevision can be submitted for review"
          : "SpecRevision is not awaiting approval",
      );
    }
    if (current.overdesignPolicyRevision !== normalized.policyRevision) {
      throw new SpecApprovalValidationError("approval policy revision changed");
    }

    const reviewItems = current.overdesignReview.items;
    const knownIds = new Set(reviewItems.map(({ elementId }) => elementId));
    if (normalized.affectedElementIds.some((id) => !knownIds.has(id))) {
      throw new SpecApprovalValidationError("affectedElementIds contains an unknown item");
    }
    const helpful = new Set(reviewItems
      .filter(({ category }) => category === "Helpful")
      .map(({ elementId }) => elementId));
    if (normalized.helpfulExceptionElementIds.some((id) => !helpful.has(id))) {
      throw new SpecApprovalValidationError("only Helpful elements can be retained by exception");
    }
    const required = reviewItems
      .filter(({ category }) => category === "Required")
      .map(({ elementId }) => elementId);
    const retainedElementIds = command.decision === "approve"
      ? reviewItems
        .filter(({ elementId }) =>
          required.includes(elementId) ||
          normalized.helpfulExceptionElementIds.includes(elementId)
        )
        .map(({ elementId }) => elementId)
      : [];
    const retained = new Set(retainedElementIds);
    const removedElementIds = command.decision === "submit_for_review"
      ? []
      : reviewItems
        .filter(({ elementId }) => !retained.has(elementId))
        .map(({ elementId }) => elementId);
    const occurredAt = this.clock();
    const occurredAtIso = occurredAt.toISOString();
    const next = {
      ...current,
      status: command.decision === "submit_for_review"
        ? "in_review" as const
        : command.decision === "approve"
        ? "approved" as const
        : "rejected" as const,
      version: current.version + 1,
      updatedAt: occurredAtIso,
    };
    const decision: SpecApprovalDecisionRecord = {
      id: this.idGenerator(),
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      specRevisionId: current.id,
      subjectVersion: current.version,
      decision: command.decision,
      actorId: command.actorId,
      reason: normalized.reason,
      requestId: normalized.requestId,
      policyRevision: normalized.policyRevision,
      affectedElementIds: normalized.affectedElementIds,
      helpfulExceptionElementIds: normalized.helpfulExceptionElementIds,
      scopeChanges: normalized.scopeChanges,
      retainedElementIds,
      removedElementIds,
      createdAt: occurredAtIso,
    };
    const receipt: SpecApprovalReceipt = {
      specRevision: next,
      decision,
      retainedElementIds,
      removedElementIds,
    };
    const action = command.decision === "submit_for_review"
      ? "spec.review_submitted" as const
      : command.decision === "approve"
      ? "spec.approved" as const
      : command.decision === "reject"
      ? "spec.rejected" as const
      : "spec.changes_requested" as const;
    const audit: SpecApprovalAuditEvent = {
      id: this.idGenerator(),
      organizationId: command.organizationId,
      projectId: command.projectId,
      goalId: command.goalId,
      actorId: command.actorId,
      action,
      entityId: current.id,
      entityVersion: next.version,
      reason: normalized.reason,
      requestId: normalized.requestId,
      policyRevision: normalized.policyRevision,
      createdAt: occurredAtIso,
    };
    const event: SpecApprovalEvent = {
      id: this.idGenerator(),
      organizationId: command.organizationId,
      aggregateId: current.id,
      aggregateVersion: next.version,
      type: "spec.approval.recorded",
      occurredAt: occurredAtIso,
      payload: {
        decision: command.decision,
        policyRevision: normalized.policyRevision,
        requestId: normalized.requestId,
      },
    };
    return await this.repository.commitApproval({
      current,
      next,
      expectedVersion: command.expectedVersion,
      decision,
      audit,
      event,
      idempotency: {
        ...lookup,
        responseDigest: await sha256(JSON.stringify(receipt)),
        expiresAt: new Date(occurredAt.getTime() + 24 * 60 * 60 * 1_000),
      },
      receipt,
    });
  }
}
