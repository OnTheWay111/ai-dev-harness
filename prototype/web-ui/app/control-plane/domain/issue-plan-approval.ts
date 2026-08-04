import type {
  ApprovalCommand,
  ApprovalReceipt,
  ApprovalTarget,
} from "./approval.ts";
import type { IssuePlan } from "./issue-plan.ts";

export const issuePlanApprovalPolicyRevision = "issue-plan-approval.v1" as const;
export const issuePlanApprovalDecisions = [
  "approve",
  "reject",
  "request_changes",
] as const;
export type IssuePlanApprovalDecision = (typeof issuePlanApprovalDecisions)[number];

export type IssuePlanApprovalPayload = Readonly<Record<string, never>>;

export type IssuePlanApprovalCommand = ApprovalCommand<
  IssuePlanApprovalDecision,
  IssuePlanApprovalPayload,
  ApprovalTarget<"issue_plan">
>;

export interface IssuePlanApprovalDecisionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  issuePlanId: string;
  subjectVersion: number;
  planDigest: string;
  decision: IssuePlanApprovalDecision;
  actorId: string;
  reason: string;
  requestId: string;
  policyRevision: string;
  affectedIssueKeys: readonly string[];
  createdAt: string;
}

export interface IssuePlanApprovalResult {
  plan: IssuePlan;
  planDigest: string;
  decisionRecord: IssuePlanApprovalDecisionRecord;
}

export type IssuePlanApprovalReceipt = ApprovalReceipt<
  IssuePlanApprovalDecision,
  IssuePlanApprovalResult,
  ApprovalTarget<"issue_plan">
>;

export interface IssuePlanApprovalAuditEvent {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  actorId: string;
  action: "issue_plan.approved" | "issue_plan.rejected" | "issue_plan.changes_requested";
  entityId: string;
  entityVersion: number;
  reason: string;
  requestId: string;
  policyRevision: string;
  createdAt: string;
}

export interface IssuePlanApprovalEvent {
  id: string;
  organizationId: string;
  aggregateId: string;
  aggregateVersion: number;
  type: "issue_plan.approval.recorded";
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}
