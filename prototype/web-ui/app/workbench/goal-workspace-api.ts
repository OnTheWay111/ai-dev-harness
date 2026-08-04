import type {
  GoalContract,
  GoalContractDraft,
} from "../control-plane/domain/goal-contract";
import type { GoalWorkspaceReceipt } from
  "../control-plane/ports/goal-workspace-repository";

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
};
