import type {
  GoalContract,
  GoalContractDraft,
} from "../control-plane/domain/goal-contract";
import type { GoalWorkspaceReceipt } from
  "../control-plane/ports/goal-workspace-repository";
import type {
  ClarificationAnswerReceipt,
  ClarificationGenerationReceipt,
  ClarificationTimeline,
} from "../control-plane/domain/clarification-history";
import type {
  ClassificationReceipt,
  ClassificationTimeline,
} from "../control-plane/domain/classification";
import type {
  SpecGenerationReceipt,
  SpecRevisionViewTimeline,
} from "../control-plane/application/spec-generation-service";
import type {
  ScopeChange,
  SpecApprovalDecision,
  SpecApprovalReceipt,
  SpecApprovalTimeline,
} from "../control-plane/domain/spec-approval";

export interface GoalWorkspaceScope {
  organizationId: string;
  projectId: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; preservedState?: string };
}

export class GoalWorkspaceApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error?.message ?? "Goal Workspace request failed");
    this.name = "GoalWorkspaceApiError";
    this.status = status;
    this.code = envelope.error?.code ?? "unknown_error";
  }
}

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json() as { data?: T } & ErrorEnvelope;
  if (!response.ok || body.data === undefined) {
    throw new GoalWorkspaceApiError(response.status, body);
  }
  return body.data;
}

function writeHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    "x-request-id": `ui_${crypto.randomUUID()}`,
  };
}

export const goalWorkspaceApi = {
  async create(
    scope: GoalWorkspaceScope,
    draft: GoalContractDraft,
    reason: string,
  ): Promise<GoalWorkspaceReceipt> {
    return await responseData(await fetch("/api/v1/goals", {
      method: "POST",
      credentials: "same-origin",
      headers: writeHeaders(),
      body: JSON.stringify({ ...scope, draft, reason }),
    }));
  },

  async get(scope: GoalWorkspaceScope, goalId: string): Promise<GoalContract> {
    const query = new URLSearchParams({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}?${query}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async update(
    scope: GoalWorkspaceScope,
    goalId: string,
    expectedVersion: number,
    draft: GoalContractDraft,
    reason: string,
  ): Promise<GoalWorkspaceReceipt> {
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}`,
      {
        method: "PATCH",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({
          ...scope,
          expectedVersion,
          draft,
          reason,
        }),
      },
    ));
  },

  async clarificationTimeline(
    scope: GoalWorkspaceScope,
    goalId: string,
  ): Promise<ClarificationTimeline> {
    const query = new URLSearchParams({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/clarifications?${query}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async generateClarifications(
    scope: GoalWorkspaceScope,
    goalId: string,
    expectedGoalVersion: number,
    reason: string,
  ): Promise<ClarificationGenerationReceipt> {
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/clarifications`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({ ...scope, expectedGoalVersion, reason }),
      },
    ));
  },

  async answerClarification(
    scope: GoalWorkspaceScope,
    goalId: string,
    threadId: string,
    expectedGoalVersion: number,
    expectedQuestionRevision: number,
    answer: string,
    reason: string,
  ): Promise<ClarificationAnswerReceipt> {
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/clarifications/${encodeURIComponent(threadId)}/answers`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({
          ...scope,
          expectedGoalVersion,
          expectedQuestionRevision,
          answer,
          reason,
        }),
      },
    ));
  },

  async classificationTimeline(
    scope: GoalWorkspaceScope,
    goalId: string,
  ): Promise<ClassificationTimeline> {
    const query = new URLSearchParams({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/classifications?${query}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async classify(
    scope: GoalWorkspaceScope,
    goalId: string,
    expectedGoalVersion: number,
    reason: string,
  ): Promise<ClassificationReceipt> {
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/classifications`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({ ...scope, expectedGoalVersion, reason }),
      },
    ));
  },

  async specTimeline(
    scope: GoalWorkspaceScope,
    goalId: string,
  ): Promise<SpecRevisionViewTimeline> {
    const query = new URLSearchParams({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/specs?${query}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async generateSpec(
    scope: GoalWorkspaceScope,
    goalId: string,
    expectedGoalVersion: number,
    reason: string,
  ): Promise<SpecGenerationReceipt> {
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/specs`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({ ...scope, expectedGoalVersion, reason }),
      },
    ));
  },

  async approvalTimeline(
    scope: GoalWorkspaceScope,
    goalId: string,
    specRevisionId: string,
  ): Promise<SpecApprovalTimeline> {
    const query = new URLSearchParams({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/specs/${encodeURIComponent(specRevisionId)}/approvals?${query}`,
      { credentials: "same-origin", cache: "no-store" },
    ));
  },

  async decideSpec(
    scope: GoalWorkspaceScope,
    goalId: string,
    specRevisionId: string,
    input: {
      expectedVersion: number;
      reason: string;
      policyRevision: string;
      decision: SpecApprovalDecision;
      affectedElementIds: readonly string[];
      helpfulExceptionElementIds: readonly string[];
      scopeChanges: readonly ScopeChange[];
    },
  ): Promise<SpecApprovalReceipt> {
    return await responseData(await fetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/specs/${encodeURIComponent(specRevisionId)}/approvals`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeaders(),
        body: JSON.stringify({ ...scope, ...input }),
      },
    ));
  },
};
