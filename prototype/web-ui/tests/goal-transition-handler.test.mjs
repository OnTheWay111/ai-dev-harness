import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoalTransitionHandler,
} from "../app/control-plane/http/goal-transition-handler.ts";
import {
  VersionConflictError,
} from "../app/control-plane/adapters/postgres-versioned-state-store.ts";

test("maps HTTP input and authenticated actor into one application command", async () => {
  const calls = [];
  const handler = createGoalTransitionHandler({
    service: {
      async transition(command) {
        calls.push(command);
        return {
          goalId: command.goalId,
          state: command.nextState,
          version: 2,
        };
      },
    },
    actorResolver: async () => ({ actorId: "actor-1" }),
  });
  const response = await handler(
    new Request("https://control.invalid/goals/goal-1/transition", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
      body: JSON.stringify({
        expectedVersion: 1,
        nextState: "clarifying",
        reason: "Begin clarification",
        guards: {},
      }),
    }),
    { organizationId: "org-1", projectId: "project-1", goalId: "goal-1" },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      organizationId: "org-1",
      projectId: "project-1",
      goalId: "goal-1",
      actorId: "actor-1",
      requestId: "req-1",
      expectedVersion: 1,
      nextState: "clarifying",
      reason: "Begin clarification",
      guards: {},
    },
  ]);
});

test("maps version conflict without exposing persistence details", async () => {
  const handler = createGoalTransitionHandler({
    service: {
      async transition() {
        throw new VersionConflictError();
      },
    },
    actorResolver: async () => ({ actorId: "actor-1" }),
  });
  const response = await handler(
    new Request("https://control.invalid/goals/goal-1/transition", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, nextState: "clarifying" }),
    }),
    { organizationId: "org-1", projectId: "project-1", goalId: "goal-1" },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "version_conflict");
  assert.doesNotMatch(JSON.stringify(body), /UPDATE goals|Postgres/i);
});
