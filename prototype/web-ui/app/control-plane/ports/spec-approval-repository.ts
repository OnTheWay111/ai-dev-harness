import type { SpecRevision } from "../domain/spec-artifact.ts";
import type {
  SpecApprovalAuditEvent,
  SpecApprovalDecisionRecord,
  SpecApprovalEvent,
  SpecApprovalReceipt,
  SpecApprovalTimeline,
} from "../domain/spec-approval.ts";
import type { SpecRevisionScope } from "./spec-revision-repository.ts";

export interface SpecApprovalIdempotencyLookup {
  organizationId: string;
  actorId: string;
  endpoint: "spec.approval";
  key: string;
  requestHash: string;
}

export interface SpecApprovalIdempotency extends SpecApprovalIdempotencyLookup {
  responseDigest: string;
  expiresAt: Date;
}

export interface CommitSpecApproval {
  current: SpecRevision;
  next: SpecRevision;
  expectedVersion: number;
  decision: SpecApprovalDecisionRecord;
  audit: SpecApprovalAuditEvent;
  event: SpecApprovalEvent;
  idempotency: SpecApprovalIdempotency;
  receipt: SpecApprovalReceipt;
}

export interface SpecApprovalRepository {
  get(scope: SpecRevisionScope & { specRevisionId: string }): Promise<SpecRevision | null>;
  approvalTimeline(scope: SpecRevisionScope): Promise<SpecApprovalTimeline>;
  findApprovalReceipt(
    lookup: SpecApprovalIdempotencyLookup,
  ): Promise<SpecApprovalReceipt | null>;
  commitApproval(command: CommitSpecApproval): Promise<SpecApprovalReceipt>;
}
