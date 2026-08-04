import type { RunStatus } from "../domain/state-machines.ts";
import type {
  AutoDevRunEventV1,
  EventIngestResult,
  ExecutionEventRepository,
  ExecutionRunProjection,
} from "../ports/execution-event-repository.ts";

interface InboxRecord {
  event: AutoDevRunEventV1;
  digest: string;
  processingStatus: "pending" | "applied" | "gap" | "terminal_ignored";
}

const terminal = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);

function mappedStatus(event: AutoDevRunEventV1): RunStatus | null {
  const status = event.status.toLowerCase();
  const phase = event.phase.toLowerCase();
  if (["succeeded", "done", "completed", "complete"].includes(status) || phase === "complete") {
    return "succeeded";
  }
  if (["failed", "error", "blocked"].includes(status)) return "failed";
  if (["cancelled", "canceled", "stopped"].includes(status)) return "cancelled";
  if (
    ["running", "in_progress", "started"].includes(status) ||
    ["claim", "worktree", "prompt", "builder", "verify", "review", "landing"].includes(phase)
  ) {
    return "running";
  }
  return null;
}

export class MemoryExecutionEventRepository implements ExecutionEventRepository {
  readonly runs: ExecutionRunProjection[];
  readonly inbox: InboxRecord[] = [];
  readonly outbox: { eventType: string; runId: string; version: number }[] = [];

  constructor(runs: readonly ExecutionRunProjection[]) {
    this.runs = structuredClone([...runs]);
  }

  async ingest(input: {
    event: AutoDevRunEventV1;
    digest: string;
  }): Promise<EventIngestResult> {
    const existing = this.inbox.find((record) =>
      record.event.sourceEventId === input.event.sourceEventId
    );
    if (existing) {
      return existing.digest === input.digest
        ? { disposition: "duplicate" }
        : { disposition: "conflict", existingDigest: existing.digest };
    }
    const run = this.runs.find((candidate) =>
      candidate.externalRunId === input.event.externalRunId
    );
    if (!run) return { disposition: "run_not_found" };
    if (run.externalTaskId !== input.event.externalTaskId) {
      return { disposition: "identity_mismatch" };
    }

    const record: InboxRecord = {
      event: structuredClone(input.event),
      digest: input.digest,
      processingStatus: "pending",
    };
    this.inbox.push(record);
    if (input.event.sequence > run.lastEventSequence + 1) {
      record.processingStatus = "gap";
      run.reconciliationRequired = true;
      return { disposition: "gap", run: structuredClone(run) };
    }
    if (input.event.sequence <= run.lastEventSequence) {
      record.processingStatus = "terminal_ignored";
      return { disposition: "terminal_ignored", run: structuredClone(run) };
    }

    let lastDisposition: "applied" | "terminal_ignored" = "applied";
    for (;;) {
      const next = this.inbox.find((candidate) =>
        candidate.event.externalRunId === run.externalRunId &&
        candidate.event.sequence === run.lastEventSequence + 1 &&
        ["pending", "gap"].includes(candidate.processingStatus)
      );
      if (!next) break;
      const wasTerminal = terminal.has(run.status);
      const nextStatus = mappedStatus(next.event);
      run.phase = next.event.phase;
      run.lastEventSequence = next.event.sequence;
      if (wasTerminal) {
        next.processingStatus = "terminal_ignored";
        lastDisposition = "terminal_ignored";
        continue;
      }
      if (nextStatus && nextStatus !== run.status) {
        if (run.status === "queued" && nextStatus !== "running") {
          run.status = "running";
          run.version += 1;
          this.outbox.push({
            eventType: "run.started",
            runId: run.id,
            version: run.version,
          });
        }
        if (nextStatus !== "running" || run.status === "queued") {
          run.status = nextStatus;
          run.version += 1;
          this.outbox.push({
            eventType: nextStatus === "running" ? "run.started" : `run.${nextStatus}`,
            runId: run.id,
            version: run.version,
          });
        } else {
          run.status = nextStatus;
          run.version += 1;
          this.outbox.push({
            eventType: "run.started",
            runId: run.id,
            version: run.version,
          });
        }
      }
      next.processingStatus = "applied";
      lastDisposition = "applied";
    }
    run.reconciliationRequired = this.inbox.some((candidate) =>
      candidate.event.externalRunId === run.externalRunId &&
      candidate.processingStatus === "gap" &&
      candidate.event.sequence > run.lastEventSequence
    );
    return { disposition: lastDisposition, run: structuredClone(run) };
  }
}
