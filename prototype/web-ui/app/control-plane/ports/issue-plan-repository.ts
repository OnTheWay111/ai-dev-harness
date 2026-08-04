import type { IssuePlan } from "../domain/issue-plan.ts";
import type {
  IssuePlanApprovalAuditEvent,
  IssuePlanApprovalDecisionRecord,
  IssuePlanApprovalEvent,
  IssuePlanApprovalReceipt,
} from "../domain/issue-plan-approval.ts";

export interface IssuePlanScope {
  organizationId: string;
  projectId: string;
  goalId: string;
}

export interface IssuePlanIdempotencyLookup {
  organizationId: string;
  actorId: string;
  endpoint: "issue_plan.approval";
  key: string;
  requestHash: string;
}

export interface CommitIssuePlanApproval {
  current: IssuePlan;
  next: IssuePlan;
  expectedVersion: number;
  decision: IssuePlanApprovalDecisionRecord;
  audit: IssuePlanApprovalAuditEvent;
  event: IssuePlanApprovalEvent;
  idempotency: IssuePlanIdempotencyLookup & {
    responseDigest: string;
    expiresAt: Date;
  };
  receipt: IssuePlanApprovalReceipt;
}

export interface IssuePlanRepository {
  list(scope: IssuePlanScope): Promise<{ plans: readonly IssuePlan[] }>;
  get(scope: IssuePlanScope & { planId: string }): Promise<IssuePlan | null>;
  getLatest(scope: IssuePlanScope): Promise<IssuePlan | null>;
  append(input: {
    plan: IssuePlan;
    expectedPreviousPlanId: string | null;
  }): Promise<IssuePlan>;
  findApprovalReceipt(
    lookup: IssuePlanIdempotencyLookup,
  ): Promise<IssuePlanApprovalReceipt | null>;
  commitApproval(input: CommitIssuePlanApproval): Promise<IssuePlanApprovalReceipt>;
}
