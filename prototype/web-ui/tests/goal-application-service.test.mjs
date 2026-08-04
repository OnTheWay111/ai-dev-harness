import assert from "node:assert/strict";
import test from "node:test";

import {
  GoalApplicationService,
} from "../app/control-plane/application/goal-application-service.ts";
import {
  MemoryGoalRepository,
} from "../app/control-plane/adapters/memory-goal-repository.ts";
import { assertGoalRepositoryContract } from "./goal-repository-contract.mjs";

const goal = {
  id: "00000000-0000-4000-8000-000000000101",
  organizationId: "00000000-0000-4000-8000-000000000102",
  projectId: "00000000-0000-4000-8000-000000000103",
  title: "Use application seams",
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

test("authorizes before loading and atomically commits a Goal event", async () => {
  const calls = [];
  const repository = new MemoryGoalRepository([goal]);
  const service = new GoalApplicationService({
    repository,
    authorizer: {
      async authorize(input) {
        calls.push(input);
      },
    },
    clock: () => new Date("2026-08-04T10:00:00.000Z"),
    idGenerator: () => "00000000-0000-4000-8000-000000000104",
  });

  assert.deepEqual(await service.transition(command()), {
    goalId: goal.id,
    previousState: "draft",
    state: "clarifying",
    previousVersion: 1,
    version: 2,
    eventId: "00000000-0000-4000-8000-000000000104",
    occurredAt: "2026-08-04T10:00:00.000Z",
  });
  assert.equal(calls.length, 1);
  assert.equal((await repository.get(goal)).status, "clarifying");
  assert.equal((await repository.get(goal)).version, 2);
  assert.deepEqual(repository.committedEvents, [
    {
      id: "00000000-0000-4000-8000-000000000104",
      organizationId: goal.organizationId,
      aggregateType: "goal",
      aggregateId: goal.id,
      aggregateVersion: 2,
      type: "goal.state_changed",
      occurredAt: "2026-08-04T10:00:00.000Z",
      payload: {
        actorId: "actor-1",
        requestId: "req-1",
        reason: "Begin clarification",
        previousState: "draft",
        state: "clarifying",
      },
    },
  ]);
});

test("authorization failure occurs before repository access", async () => {
  let reads = 0;
  const service = new GoalApplicationService({
    repository: {
      async get() {
        reads += 1;
        return goal;
      },
      async findIdempotentReceipt() {
        return null;
      },
      async commitTransition() {
        throw new Error("must not commit");
      },
    },
    authorizer: {
      async authorize() {
        throw new Error("forbidden");
      },
    },
  });
  await assert.rejects(() => service.transition(command()), /forbidden/);
  assert.equal(reads, 0);
});

test("invalid transitions do not commit state or events", async () => {
  const repository = new MemoryGoalRepository([goal]);
  const service = new GoalApplicationService({
    repository,
    authorizer: { async authorize() {} },
  });
  await assert.rejects(
    () => service.transition(command({ nextState: "completed" })),
    /not allowed/i,
  );
  assert.equal((await repository.get(goal)).status, "draft");
  assert.deepEqual(repository.committedEvents, []);
});

test("the memory adapter rejects stale versions without committing the event", async () => {
  const repository = new MemoryGoalRepository([goal]);
  const input = {
    current: goal,
    expectedVersion: 1,
    nextState: "clarifying",
    occurredAt: new Date("2026-08-04T10:00:00.000Z"),
    event: {
      id: "00000000-0000-4000-8000-000000000105",
      organizationId: goal.organizationId,
      aggregateType: "goal",
      aggregateId: goal.id,
      aggregateVersion: 2,
      type: "goal.state_changed",
      occurredAt: "2026-08-04T10:00:00.000Z",
      payload: {},
    },
    audit: {
      id: "00000000-0000-4000-8000-000000000106",
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
      createdAt: "2026-08-04T10:00:00.000Z",
    },
    idempotency: {
      organizationId: goal.organizationId,
      actorId: "actor-1",
      endpoint: "goal.transition",
      key: "idem-direct",
      requestHash: "a".repeat(64),
      responseDigest: "b".repeat(64),
      expiresAt: new Date("2026-08-05T10:00:00.000Z"),
    },
    receipt: {
      goalId: goal.id,
      previousState: "draft",
      state: "clarifying",
      previousVersion: 1,
      version: 2,
      eventId: "00000000-0000-4000-8000-000000000105",
      occurredAt: "2026-08-04T10:00:00.000Z",
    },
  };
  await repository.commitTransition(input);
  await assert.rejects(
    () =>
      repository.commitTransition({
        ...input,
        event: {
          ...input.event,
          id: "00000000-0000-4000-8000-000000000107",
        },
        audit: {
          ...input.audit,
          id: "00000000-0000-4000-8000-000000000108",
        },
        idempotency: {
          ...input.idempotency,
          key: "idem-stale",
        },
      }),
    /version/i,
  );
  assert.equal(repository.committedEvents.length, 1);
});

test("the memory adapter satisfies the GoalRepository contract", async () => {
  const repository = new MemoryGoalRepository([goal]);
  await assertGoalRepositoryContract({
    repository,
    goal,
    eventCount: async (eventId) =>
      repository.committedEvents.filter((event) => event.id === eventId).length,
  });
});
