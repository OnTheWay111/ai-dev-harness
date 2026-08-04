import assert from "node:assert/strict";
import test from "node:test";

import { createSpecGenerationHandler } from
  "../app/control-plane/http/spec-generation-handler.ts";

const ids = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
};

test("maps authenticated spec generation input without trusting an actor body field", async () => {
  const calls = [];
  const handler = createSpecGenerationHandler({
    service: {
      async generate(command) {
        calls.push(command);
        return { specRevision: { id: "spec-1" }, artifact: { content: {} } };
      },
      async timeline() { return { revisions: [] }; },
    },
    actorResolver: async () => ({ actorId: "actor-from-session" }),
    rateLimiter: { consume() {} },
  });
  const response = await handler(new Request(
    `https://control.invalid/api/v1/goals/${ids.goalId}/specs`,
    {
      method: "POST",
      headers: {
        origin: "https://control.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        expectedGoalVersion: 4,
        reason: "Generate a reviewable revision",
      }),
    },
  ), ids.goalId);
  assert.equal(response.status, 201);
  assert.deepEqual(calls, [{
    ...ids,
    actorId: "actor-from-session",
    expectedGoalVersion: 4,
    reason: "Generate a reviewable revision",
  }]);
});

test("returns a no-store authorized revision timeline", async () => {
  const calls = [];
  const handler = createSpecGenerationHandler({
    service: {
      async generate() { throw new Error("not used"); },
      async timeline(command) { calls.push(command); return { revisions: [] }; },
    },
    actorResolver: async () => ({ actorId: "viewer-1" }),
  });
  const query = new URLSearchParams({
    organizationId: ids.organizationId,
    projectId: ids.projectId,
  });
  const response = await handler(new Request(
    `https://control.invalid/api/v1/goals/${ids.goalId}/specs?${query}`,
  ), ids.goalId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls, [{ ...ids, actorId: "viewer-1" }]);
});

test("fails closed for unauthenticated or unknown generation input", async () => {
  let calls = 0;
  const service = {
    async generate() { calls += 1; },
    async timeline() { calls += 1; },
  };
  const unauthenticated = createSpecGenerationHandler({
    service,
    actorResolver: async () => null,
  });
  const unauthenticatedResponse = await unauthenticated(
    new Request(`https://control.invalid/api/v1/goals/${ids.goalId}/specs`),
    ids.goalId,
  );
  assert.equal(unauthenticatedResponse.status, 401);

  const authenticated = createSpecGenerationHandler({
    service,
    actorResolver: async () => ({ actorId: "actor-1" }),
  });
  const invalid = await authenticated(new Request(
    `https://control.invalid/api/v1/goals/${ids.goalId}/specs`,
    {
      method: "POST",
      headers: {
        origin: "https://control.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        expectedGoalVersion: 4,
        reason: "Generate",
        actorId: "forged",
      }),
    },
  ), ids.goalId);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "validation_failed");
  assert.equal(calls, 0);
});
