import type {
  AcceptanceVerificationPlan,
  AcceptanceVerificationPlanDraft,
} from "../control-plane/domain/acceptance-verification";
import type {
  DeliveryKnownRisk,
  DeliveryReport,
} from "../control-plane/domain/delivery-report";
import type { GoalVerification } from
  "../control-plane/domain/goal-verification";
import type { VerificationGapReport } from
  "../control-plane/domain/verification-gap";
import type { IssuePlan } from "../control-plane/domain/issue-plan";
import type { GoalWorkspaceScope } from "./goal-workspace-api";

interface ErrorEnvelope {
  error?: { code?: string; message?: string; preservedState?: string };
}

export class GoalVerificationApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly preservedState: string;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error?.message ?? "Goal verification request failed");
    this.name = "GoalVerificationApiError";
    this.status = status;
    this.code = envelope.error?.code ?? "unknown_error";
    this.preservedState = envelope.error?.preservedState ??
      "Existing immutable verification state was preserved";
  }
}

async function data<T>(response: Response): Promise<T> {
  const body = await response.json() as { data?: T } & ErrorEnvelope;
  if (!response.ok || body.data === undefined) {
    throw new GoalVerificationApiError(response.status, body);
  }
  return body.data;
}

function headers(): HeadersInit {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    "x-request-id": `ui_${crypto.randomUUID()}`,
  };
}

function query(scope: GoalWorkspaceScope) {
  return new URLSearchParams({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
  });
}

function base(goalId: string) {
  return `/api/v1/goals/${encodeURIComponent(goalId)}`;
}

export const goalVerificationApi = {
  async planTimeline(scope: GoalWorkspaceScope, goalId: string) {
    return await data<readonly AcceptanceVerificationPlan[]>(await fetch(
      `${base(goalId)}/verification-plans?${query(scope)}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async compilePlan(
    scope: GoalWorkspaceScope,
    goalId: string,
    issuePlan: IssuePlan,
    expectedGoalVersion: number,
    draft: AcceptanceVerificationPlanDraft,
  ) {
    return await data<AcceptanceVerificationPlan>(await fetch(
      `${base(goalId)}/verification-plans`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: headers(),
        body: JSON.stringify({
          ...scope,
          issuePlanId: issuePlan.id,
          expectedGoalVersion,
          expectedIssuePlanVersion: issuePlan.version,
          draft,
        }),
      },
    ));
  },

  async verificationTimeline(scope: GoalWorkspaceScope, goalId: string) {
    return await data<readonly GoalVerification[]>(await fetch(
      `${base(goalId)}/verifications?${query(scope)}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async verify(
    scope: GoalWorkspaceScope,
    goalId: string,
    plan: AcceptanceVerificationPlan,
    expectedGoalVersion: number,
    manualEvidence: readonly {
      entryId: string;
      evidenceRef: string;
      reason: string;
    }[] = [],
  ) {
    return await data<GoalVerification>(await fetch(
      `${base(goalId)}/verifications`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: headers(),
        body: JSON.stringify({
          ...scope,
          planId: plan.id,
          expectedGoalVersion,
          manualEvidence,
        }),
      },
    ));
  },

  async gapTimeline(scope: GoalWorkspaceScope, goalId: string) {
    return await data<readonly VerificationGapReport[]>(await fetch(
      `${base(goalId)}/verification-gaps?${query(scope)}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async createGap(
    scope: GoalWorkspaceScope,
    goalId: string,
    verificationId: string,
  ) {
    return await data<VerificationGapReport>(await fetch(
      `${base(goalId)}/verification-gaps`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: headers(),
        body: JSON.stringify({ ...scope, verificationId }),
      },
    ));
  },

  async reportTimeline(scope: GoalWorkspaceScope, goalId: string) {
    return await data<readonly DeliveryReport[]>(await fetch(
      `${base(goalId)}/delivery-reports?${query(scope)}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async generateReport(
    scope: GoalWorkspaceScope,
    goalId: string,
    verificationId: string,
    knownRisks: readonly DeliveryKnownRisk[],
  ) {
    return await data<DeliveryReport>(await fetch(
      `${base(goalId)}/delivery-reports`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: headers(),
        body: JSON.stringify({ ...scope, verificationId, knownRisks }),
      },
    ));
  },

  async acceptReport(
    scope: GoalWorkspaceScope,
    goalId: string,
    reportId: string,
    expectedGoalVersion: number,
    reason: string,
  ) {
    return await data<{ report: DeliveryReport; goal: { status: string } }>(
      await fetch(
        `${base(goalId)}/delivery-reports/${encodeURIComponent(reportId)}/acceptances`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: headers(),
          body: JSON.stringify({
            ...scope,
            expectedGoalVersion,
            reason,
          }),
        },
      ),
    );
  },

  exportUrl(scope: GoalWorkspaceScope, goalId: string, reportId: string) {
    return `${base(goalId)}/delivery-reports/${encodeURIComponent(reportId)}/export?${query(scope)}`;
  },
};
