import assert from "node:assert/strict";
import test from "node:test";

import {
  GoalApplicationService,
} from "../app/control-plane/application/goal-application-service.ts";
import {
  MemoryGoalRepository,
} from "../app/control-plane/adapters/memory-goal-repository.ts";
import {
  IdempotencyConflictError,
} from "../app/control-plane/domain/errors.ts";

const goal = {
  id: "00000000-0000-4000-8000-000000000201",
  organizationId: "00000000-0000-4000-8000-000000000202",
  projectId: "00000000-0000-4000-8000-000000000203",
  title: "Reliable command",
  status: "draft",
  version: 1,
};

function command(overrides = {}) {
  return {
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
    actorId: "actor-1",
    requestId: "req-1",
    idempotencyKey: "idem-1",
    expectedVersion: 1,
    nextState: "clarifying",
    reason: "Begin clarification",
    guards: {},
    ...overrides,
  };
}

function setup() {
  const ids = [
    "00000000-0000-4000-8000-000000000204",
    "00000000-0000-4000-8000-000000000205",
  ];
  const repository = new MemoryGoalRepository([goal]);
  const service = new GoalApplicationService({
    repository,
    authorizer: { async authorize() {} },
    clock: () => new Date("2026-08-04T11:00:00.000Z"),
    idGenerator: () => ids.shift() ?? crypto.randomUUID(),
  });
  return { repository, service };
}

test("replays the exact receipt without a second write, Audit, or Outbox event", async () => {
  const { repository, service } = setup();
  const first = await service.transition(command());
  const retry = await service.transition(command({ requestId: "req-retry" }));
  assert.deepEqual(retry, first);
  assert.equal((await repository.get(goal)).version, 2);
  assert.equal(repository.committedEvents.length, 1);
  assert.equal(repository.committedAuditEvents.length, 1);
  assert.equal(repository.idempotencyRecords.length, 1);
  assert.equal(repository.idempotencyRecords[0].status, "completed");
  assert.deepEqual(repository.committedAuditEvents[0], {
    id: "00000000-0000-4000-8000-000000000205",
    organizationId: goal.organizationId,
    projectId: goal.projectId,
    goalId: goal.id,
    actorId: "actor-1",
    action: "goal.state_changed",
    entityType: "goal",
    entityId: goal.id,
    entityVersion: 2,
    reason: "Begin clarification",
    requestId: "req-1",
    createdAt: "2026-08-04T11:00:00.000Z",
  });
});

test("rejects reusing an Idempotency-Key for a different command", async () => {
  const { repository, service } = setup();
  await service.transition(command());
  await assert.rejects(
    () => service.transition(command({ reason: "Different command" })),
    (error) => error instanceof IdempotencyConflictError,
  );
  assert.equal(repository.committedEvents.length, 1);
  assert.equal(repository.committedAuditEvents.length, 1);
});

test("illegal state transitions create no reliability records", async () => {
  const { repository, service } = setup();
  await assert.rejects(
    () => service.transition(command({ nextState: "completed" })),
    /not allowed/i,
  );
  assert.equal((await repository.get(goal)).version, 1);
  assert.deepEqual(repository.committedEvents, []);
  assert.deepEqual(repository.committedAuditEvents, []);
  assert.deepEqual(repository.idempotencyRecords, []);
});

test("a blank Idempotency-Key fails closed before persistence", async () => {
  const { repository, service } = setup();
  await assert.rejects(
    () => service.transition(command({ idempotencyKey: "   " })),
    /Idempotency-Key is required/,
  );
  assert.equal((await repository.get(goal)).version, 1);
  assert.deepEqual(repository.committedEvents, []);
  assert.deepEqual(repository.committedAuditEvents, []);
  assert.deepEqual(repository.idempotencyRecords, []);
});

test("rechecks the key when a concurrent duplicate commits before Goal load", async () => {
  const receipt = {
    goalId: goal.id,
    previousState: "draft",
    state: "clarifying",
    previousVersion: 1,
    version: 2,
    eventId: "00000000-0000-4000-8000-000000000209",
    occurredAt: "2026-08-04T11:00:00.000Z",
  };
  let idempotencyReads = 0;
  const service = new GoalApplicationService({
    repository: {
      async findIdempotentReceipt() {
        idempotencyReads += 1;
        return idempotencyReads === 1 ? null : receipt;
      },
      async get() {
        return { ...goal, status: "clarifying", version: 2 };
      },
      async commitTransition() {
        throw new Error("a concurrent retry must not commit again");
      },
    },
    authorizer: { async authorize() {} },
  });
  assert.deepEqual(await service.transition(command()), receipt);
  assert.equal(idempotencyReads, 2);
});
