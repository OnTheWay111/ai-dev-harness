import type { RunStatus } from "../domain/state-machines.ts";

export interface AutoDevRunEventV1 {
  schemaVersion: "autodev.run-event.v1";
  sourceEventId: string;
  externalRunId: string;
  externalTaskId: string;
  sequence: number;
  occurredAt: string;
  phase: string;
  status: string;
  message: string;
  observability?: import("../../observability/context.ts").ObservabilityContext;
}

export interface ExecutionRunProjection {
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  issueId?: string;
  externalRunId: string;
  externalTaskId: string;
  status: RunStatus;
  phase: string;
  version: number;
  lastEventSequence: number;
  reconciliationRequired: boolean;
}

export type EventDisposition =
  | "applied"
  | "duplicate"
  | "gap"
  | "terminal_ignored";

export interface EventIngestResult {
  disposition: EventDisposition | "conflict" | "run_not_found" | "identity_mismatch";
  existingDigest?: string;
  run?: ExecutionRunProjection;
}

export interface ExecutionEventRepository {
  ingest(input: {
    event: AutoDevRunEventV1;
    digest: string;
  }): Promise<EventIngestResult>;
}
