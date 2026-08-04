import type { IssuePlan } from "../domain/issue-plan.ts";

export interface QueueProjectionTaskReceipt {
  issueKey: string;
  externalTaskId: string;
}

export interface QueueProjectionReceipt {
  importId: string;
  atomic: true;
  organizationId: string;
  projectId: string;
  goalId: string;
  issuePlanId: string;
  planDigest: string;
  requestId: string;
  idempotencyKey: string;
  projectedAt: string;
  tasks: readonly QueueProjectionTaskReceipt[];
}

export interface QueueProjectionPort {
  importApprovedPlan(input: {
    plan: IssuePlan;
    requestId: string;
    idempotencyKey: string;
  }): Promise<QueueProjectionReceipt>;
}

export interface QueueProjectionRepository {
  find(input: {
    organizationId: string;
    issuePlanId: string;
    planDigest: string;
    idempotencyKey: string;
  }): Promise<QueueProjectionReceipt | null>;
  save(receipt: QueueProjectionReceipt): Promise<QueueProjectionReceipt>;
}
