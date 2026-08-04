export const approvalTargetTypes = ["spec_revision"] as const;
export type ApprovalTargetType = (typeof approvalTargetTypes)[number];

export interface ApprovalScope {
  organizationId: string;
  projectId: string;
  goalId: string;
}

export interface ApprovalTarget<TType extends ApprovalTargetType = ApprovalTargetType> {
  type: TType;
  id: string;
}

/**
 * The write-boundary contract shared by every approval in the planning stage.
 * actorId is intentionally required here but must be populated from trusted
 * authentication context by the HTTP adapter.
 */
export interface ApprovalCommand<
  TDecision extends string,
  TPayload extends Readonly<Record<string, unknown>>,
  TTarget extends ApprovalTarget = ApprovalTarget,
> {
  scope: ApprovalScope;
  target: TTarget;
  expectedVersion: number;
  actorId: string;
  reason: string;
  requestId: string;
  idempotencyKey: string;
  policyRevision: string;
  decision: TDecision;
  affectedItemIds: readonly string[];
  payload: TPayload;
}

/** A stable receipt proves exactly who approved which object and policy. */
export interface ApprovalReceipt<
  TDecision extends string,
  TResult,
  TTarget extends ApprovalTarget = ApprovalTarget,
> {
  receiptId: string;
  target: TTarget;
  previousVersion: number;
  currentVersion: number;
  decision: TDecision;
  actorId: string;
  reason: string;
  requestId: string;
  policyRevision: string;
  recordedAt: string;
  result: TResult;
}
