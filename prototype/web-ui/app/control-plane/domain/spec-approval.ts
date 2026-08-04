import type { SpecRevision } from "./spec-artifact.ts";

export const specApprovalDecisions = [
  "submit_for_review",
  "approve",
  "reject",
  "request_changes",
] as const;
export type SpecApprovalDecision = (typeof specApprovalDecisions)[number];

export const scopeChangeOperations = ["add", "remove"] as const;
export const scopeChangeKinds = [
  "requirement",
  "non_goal",
  "constraint",
] as const;

export interface ScopeChange {
  operation: (typeof scopeChangeOperations)[number];
  kind: (typeof scopeChangeKinds)[number];
  value: string;
}

export interface SpecApprovalDecisionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  specRevisionId: string;
  subjectVersion: number;
  decision: SpecApprovalDecision;
  actorId: string;
  reason: string;
  requestId: string;
  policyRevision: string;
  affectedElementIds: readonly string[];
  helpfulExceptionElementIds: readonly string[];
  scopeChanges: readonly ScopeChange[];
  retainedElementIds: readonly string[];
  removedElementIds: readonly string[];
  createdAt: string;
}

export interface SpecApprovalReceipt {
  specRevision: SpecRevision;
  decision: SpecApprovalDecisionRecord;
  retainedElementIds: readonly string[];
  removedElementIds: readonly string[];
}

export interface SpecApprovalTimeline {
  decisions: readonly SpecApprovalDecisionRecord[];
}

export interface SpecApprovalAuditEvent {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
  action:
    | "spec.review_submitted"
    | "spec.approved"
    | "spec.rejected"
    | "spec.changes_requested";
  entityId: string;
  entityVersion: number;
  reason: string;
  requestId: string;
  policyRevision: string;
  createdAt: string;
}

export interface SpecApprovalEvent {
  id: string;
  organizationId: string;
  aggregateId: string;
  aggregateVersion: number;
  type: "spec.approval.recorded";
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}
