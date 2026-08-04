import type { IssueDraft, IssuePlan } from
  "../control-plane/domain/issue-plan";
import type { IssuePlanApprovalReceipt } from
  "../control-plane/domain/issue-plan-approval";
import type {
  CapabilityTier,
  ReasoningEffort,
} from "../control-plane/domain/model-router";
import type { QueueProjectionReceipt } from
  "../control-plane/ports/queue-projection-port";
import type { GoalWorkspaceScope } from "./goal-workspace-api";

interface ErrorEnvelope {
  error?: { code?: string; message?: string; preservedState?: string };
}

export class IssuePlanApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly preservedState: string;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error?.message ?? "Issue plan request failed");
    this.name = "IssuePlanApiError";
    this.status = status;
    this.code = envelope.error?.code ?? "unknown_error";
    this.preservedState = envelope.error?.preservedState ?? "The current draft is preserved";
  }
}

async function data<T>(response: Response): Promise<T> {
  const body = await response.json() as { data?: T } & ErrorEnvelope;
  if (!response.ok || body.data === undefined) throw new IssuePlanApiError(response.status, body);
  return body.data;
}

function writeHeaders(idempotencyKey = crypto.randomUUID()): HeadersInit {
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-request-id": `ui_${crypto.randomUUID()}`,
  };
}

function base(goalId: string) {
  return `/api/v1/goals/${encodeURIComponent(goalId)}/issue-plans`;
}

export const issuePlanApi = {
  async timeline(scope: GoalWorkspaceScope, goalId: string) {
    const query = new URLSearchParams({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    return await data<{ plans: readonly IssuePlan[] }>(await fetch(
      `${base(goalId)}?${query}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async generate(
    scope: GoalWorkspaceScope,
    goalId: string,
    specRevisionId: string,
    expectedSpecVersion: number,
  ) {
    return await data<{ plan: IssuePlan }>(await fetch(base(goalId), {
      method: "POST",
      credentials: "same-origin",
      headers: writeHeaders(),
      body: JSON.stringify({ ...scope, specRevisionId, expectedSpecVersion }),
    }));
  },

  async revise(
    scope: GoalWorkspaceScope,
    goalId: string,
    plan: IssuePlan,
    input: {
      reason: string;
      issues: readonly IssueDraft[];
      modelOverrides: readonly {
        issueKey: string;
        capabilityTier: CapabilityTier;
        reasoningEffort: ReasoningEffort;
        reason: string;
      }[];
    },
  ) {
    return await data<{ plan: IssuePlan }>(await fetch(
      `${base(goalId)}/${encodeURIComponent(plan.id)}`,
      {
        method: "PATCH",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({
          ...scope,
          expectedVersion: plan.version,
          ...input,
        }),
      },
    ));
  },

  async approve(
    scope: GoalWorkspaceScope,
    goalId: string,
    plan: IssuePlan,
    reason: string,
    decision: "approve" | "reject" | "request_changes",
  ) {
    return await data<IssuePlanApprovalReceipt>(await fetch(
      `${base(goalId)}/${encodeURIComponent(plan.id)}/approvals`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({
          ...scope,
          expectedVersion: plan.version,
          reason,
          policyRevision: "issue-plan-approval.v1",
          decision,
          affectedItemIds: plan.issues.map(({ key }) => key),
        }),
      },
    ));
  },

  async project(scope: GoalWorkspaceScope, goalId: string, plan: IssuePlan) {
    return await data<QueueProjectionReceipt>(await fetch(
      `${base(goalId)}/${encodeURIComponent(plan.id)}/queue-projections`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeaders(`issue-plan:${plan.id}:${plan.digest}`),
        body: JSON.stringify({ ...scope, expectedVersion: plan.version }),
      },
    ));
  },
};
