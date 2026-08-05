import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresVersionedStateStore,
  VersionConflictError,
} from "../app/control-plane/adapters/postgres-versioned-state-store.ts";

test("persists a Goal transition with hierarchy and expectedVersion predicates", async () => {
  const calls = [];
  const store = new PostgresVersionedStateStore({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ status: "clarifying", version: 2 }], rowCount: 1 };
    },
  });
  assert.deepEqual(
    await store.persist({
      entity: "goal",
      id: "goal-id",
      organizationId: "organization-id",
      projectId: "project-id",
      expectedVersion: 1,
      nextState: "clarifying",
      occurredAt: new Date("2026-08-04T09:00:00.000Z"),
    }),
    { state: "clarifying", version: 2 },
  );
  assert.match(calls[0].text, /UPDATE goals/);
  assert.match(calls[0].text, /version = \$6/);
  assert.match(calls[0].text, /GREATEST\(\$2, created_at\)/);
  assert.deepEqual(calls[0].values.slice(0, 6), [
    "clarifying",
    new Date("2026-08-04T09:00:00.000Z"),
    "goal-id",
    "organization-id",
    "project-id",
    1,
  ]);
});

test("sets Run lifecycle timestamps through fixed parameterized SQL", async () => {
  const calls = [];
  const store = new PostgresVersionedStateStore({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ status: "running", version: 4 }], rowCount: 1 };
    },
  });
  await store.persist({
    entity: "run",
    id: "run-id",
    organizationId: "organization-id",
    projectId: "project-id",
    goalId: "goal-id",
    expectedVersion: 3,
    nextState: "running",
    occurredAt: new Date("2026-08-04T09:00:00.000Z"),
  });
  assert.match(calls[0].text, /UPDATE runs/);
  assert.match(calls[0].text, /started_at/);
  assert.match(calls[0].text, /finished_at/);
  assert.doesNotMatch(calls[0].text, /run-id|organization-id/);
});

test("fails closed when an optimistic update matches no row", async () => {
  const store = new PostgresVersionedStateStore({
    async query() {
      return { rows: [], rowCount: 0 };
    },
  });
  await assert.rejects(
    () =>
      store.persist({
        entity: "issue",
        id: "issue-id",
        organizationId: "organization-id",
        projectId: "project-id",
        goalId: "goal-id",
        expectedVersion: 1,
        nextState: "approved",
        occurredAt: new Date("2026-08-04T09:00:00.000Z"),
      }),
    (error) => error instanceof VersionConflictError,
  );
});
