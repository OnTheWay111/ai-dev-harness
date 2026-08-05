import type {
  CanaryAggregate,
  NewCanaryEvent,
  ProductionGateId,
  ProductionReleaseAggregate,
  ReleaseSignatureRole,
  CanaryWindow,
} from "./domain";
import type { ReleaseCenterScope } from "./repository";

export interface ReleaseCenterSnapshot {
  canaries: readonly CanaryAggregate[];
  releases: readonly ProductionReleaseAggregate[];
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    preservedState?: string;
    nextAction?: string;
  };
  requestId?: string;
}

export class ReleaseCenterApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error?.message ?? "Release Center request failed");
    this.name = "ReleaseCenterApiError";
    this.status = status;
    this.code = envelope.error?.code ?? "unknown_error";
    this.requestId = envelope.requestId ?? "request-unavailable";
  }
}

async function data<T>(response: Response): Promise<T> {
  const body = await response.json() as { data?: T } & ErrorEnvelope;
  if (!response.ok || body.data === undefined) {
    throw new ReleaseCenterApiError(response.status, body);
  }
  return body.data;
}

function headers(): HeadersInit {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    "x-request-id": `release-ui-${crypto.randomUUID()}`,
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return await data<T>(await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: headers(),
    body: JSON.stringify(body),
  }));
}

export const releaseCenterApi = {
  async snapshot(scope: ReleaseCenterScope): Promise<ReleaseCenterSnapshot> {
    const query = new URLSearchParams({ ...scope });
    return await data(await fetch(`/api/v1/releases?${query}`, {
      credentials: "same-origin",
      cache: "no-store",
    }));
  },

  async createCanary(scope: ReleaseCenterScope, input: {
    goalId: string;
    candidateCommit: string;
    goalContractVersion: number;
    allowedAreas: string[];
    excludedAreas: string[];
    successConditions: string[];
    stopConditions: string[];
    rollbackRunbook: string;
    stopRunbook: string;
    reason: string;
  }): Promise<CanaryAggregate> {
    return await post("/api/v1/releases/canaries", { ...scope, ...input });
  },

  async canaryAction(
    scope: ReleaseCenterScope,
    canaryId: string,
    input:
      | { type: "approve" | "restart" | "finalize"; expectedVersion: number; reason: string }
      | { type: "record-window"; expectedVersion: number; reason: string; window: Omit<CanaryWindow, "attempt" | "recordedBy"> }
      | { type: "record-event"; expectedVersion: number; reason: string; event: NewCanaryEvent }
      | { type: "resolve-alert"; expectedVersion: number; reason: string; eventId: string },
  ): Promise<CanaryAggregate> {
    return await post(
      `/api/v1/releases/canaries/${encodeURIComponent(canaryId)}/actions`,
      { ...scope, ...input },
    );
  },

  async createProductionRelease(
    scope: ReleaseCenterScope,
    canaryId: string,
    reason: string,
  ): Promise<ProductionReleaseAggregate> {
    return await post("/api/v1/releases/production", {
      ...scope, canaryId, reason,
    });
  },

  async productionAction(
    scope: ReleaseCenterScope,
    releaseId: string,
    input:
      | { type: "evaluate"; expectedVersion: number; reason: string }
      | { type: "check-gate"; expectedVersion: number; reason: string; gateId: ProductionGateId; ownerRole: ReleaseSignatureRole; evidenceRefs: string[] }
      | { type: "sign"; expectedVersion: number; reason: string; role: ReleaseSignatureRole },
  ): Promise<ProductionReleaseAggregate> {
    return await post(
      `/api/v1/releases/production/${encodeURIComponent(releaseId)}/actions`,
      { ...scope, ...input },
    );
  },
};
