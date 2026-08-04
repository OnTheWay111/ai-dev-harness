import assert from "node:assert/strict";
import test from "node:test";

import { MemoryExecutionEventRepository } from
  "../app/control-plane/adapters/memory-execution-event-repository.ts";
import {
  ExternalEventConflictError,
  ExternalEventService,
  ExternalEventValidationError,
} from "../app/control-plane/application/external-event-service.ts";

const run = {
  id: "00000000-0000-4000-8000-000000000011",
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  externalRunId: "cp-run-a1",
  externalTaskId: "H-001",
  status: "queued",
  phase: "queued",
  version: 1,
  lastEventSequence: 0,
  reconciliationRequired: false,
};

function event(sequence, phase, status, overrides = {}) {
  return {
    schemaVersion: "autodev.run-event.v1",
    sourceEventId: `event-${sequence}`,
    externalRunId: run.externalRunId,
    externalTaskId: "H-001",
    sequence,
    occurredAt: `2026-08-04T12:00:0${sequence}.000Z`,
    phase,
    status,
    message: `${phase} ${status}`,
    ...overrides,
  };
}

test("P7 inbox closes gaps in order and publishes domain Outbox transitions", async () => {
  const repository = new MemoryExecutionEventRepository([run]);
  const service = new ExternalEventService({ repository });
  const gap = await service.ingest(event(2, "complete", "succeeded"));
  assert.equal(gap.disposition, "gap");
  assert.equal(repository.runs[0].status, "queued");
  assert.equal(repository.runs[0].reconciliationRequired, true);

  const closed = await service.ingest(event(1, "builder", "running"));
  assert.equal(closed.disposition, "applied");
  assert.equal(repository.runs[0].status, "succeeded");
  assert.equal(repository.runs[0].lastEventSequence, 2);
  assert.equal(repository.runs[0].reconciliationRequired, false);
  assert.deepEqual(
    repository.outbox.map((value) => value.eventType),
    ["run.started", "run.succeeded"],
  );
});

test("P7 inbox deduplicates exact replays and rejects source id reuse", async () => {
  const repository = new MemoryExecutionEventRepository([run]);
  const service = new ExternalEventService({ repository });
  const first = event(1, "builder", "running");
  await service.ingest(first);
  assert.equal((await service.ingest(first)).disposition, "duplicate");
  await assert.rejects(
    () => service.ingest({ ...first, message: "tampered" }),
    ExternalEventConflictError,
  );
  assert.equal(repository.inbox.length, 1);
});

test("P7 inbox rejects an event whose task identity does not own the Run", async () => {
  const repository = new MemoryExecutionEventRepository([run]);
  const service = new ExternalEventService({ repository });
  await assert.rejects(
    () => service.ingest(event(1, "builder", "running", { externalTaskId: "H-999" })),
    ExternalEventValidationError,
  );
  assert.equal(repository.inbox.length, 0);
});

test("P7 terminal protection records but never regresses a completed Run", async () => {
  const repository = new MemoryExecutionEventRepository([{
    ...run,
    status: "succeeded",
    phase: "complete",
    lastEventSequence: 2,
    version: 2,
  }]);
  const service = new ExternalEventService({ repository });
  const result = await service.ingest(event(3, "builder", "running"));
  assert.equal(result.disposition, "terminal_ignored");
  assert.equal(repository.runs[0].status, "succeeded");
  assert.equal(repository.runs[0].lastEventSequence, 3);
});
