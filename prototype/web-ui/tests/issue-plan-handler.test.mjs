import assert from "node:assert/strict";
import test from "node:test";

import { createIssuePlanHandlers } from
  "../app/control-plane/http/issue-plan-handler.ts";
import { VersionConflictError } from
  "../app/control-plane/domain/errors.ts";

const ids = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  planId: "00000000-0000-4000-8000-000000000004",
};

function request(path, body, headers = {}) {
  return new Request(`https://control.invalid${path}`, {
    method: "POST",
    headers: {
      origin: "https://control.invalid",
      "content-type": "application/json",
      "x-request-id": "request-1",
      "idempotency-key": "idem-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function setup(overrides = {}) {
  const calls = [];
  const handlers = createIssuePlanHandlers({
    plans: {
      async timeline(value) { calls.push(["timeline", value]); return { plans: [] }; },
      async get() { return { id: ids.planId, ...ids, status: "approved", version: 2 }; },
      async revise(value) { calls.push(["revise", value]); return { plan: {} }; },
      async approve(value) { calls.push(["approve", value]); return { result: {} }; },
      ...overrides.plans,
    },
    generation: { async generate(value) { calls.push(["generate", value]); return { plan: {} }; } },
    projection: { async project(value) { calls.push(["project", value]); return { importId: "i" }; } },
    actorResolver: async () => ({ actorId: "session-approver" }),
    rateLimiter: { consume() {} },
  });
  return { calls, handlers };
}

test("P6-05 approval uses trusted actor and binds the exact plan revision", async () => {
  const { calls, handlers } = setup();
  const response = await handlers.approval(request(
    `/api/v1/goals/${ids.goalId}/issue-plans/${ids.planId}/approvals`,
    {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      expectedVersion: 1,
      reason: "Approve exact DAG and routes",
      policyRevision: "issue-plan-approval.v1",
      decision: "approve",
      affectedItemIds: ["DEV-01"],
    },
  ), ids.goalId, ids.planId);
  assert.equal(response.status, 200);
  assert.equal(calls[0][0], "approve");
  assert.equal(calls[0][1].actorId, "session-approver");
  assert.equal(calls[0][1].expectedVersion, 1);
  assert.equal(calls[0][1].requestId, "request-1");
  assert.equal(calls[0][1].idempotencyKey, "idem-1");
});

test("P6-05 stale approvals return 409 and advertise preserved browser state", async () => {
  const { handlers } = setup({ plans: { async approve() { throw new VersionConflictError(); } } });
  const response = await handlers.approval(request(
    `/api/v1/goals/${ids.goalId}/issue-plans/${ids.planId}/approvals`,
    {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      expectedVersion: 1,
      reason: "Approve",
      policyRevision: "issue-plan-approval.v1",
      decision: "approve",
      affectedItemIds: ["DEV-01"],
    },
  ), ids.goalId, ids.planId);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "version_conflict");
  assert.match(body.error.preservedState, /browser-owned draft/);
});

test("P6-05 rejects forged actors and unknown fields before the service", async () => {
  const { calls, handlers } = setup();
  const response = await handlers.approval(request(
    `/api/v1/goals/${ids.goalId}/issue-plans/${ids.planId}/approvals`,
    {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      expectedVersion: 1,
      reason: "Approve",
      policyRevision: "issue-plan-approval.v1",
      decision: "approve",
      affectedItemIds: ["DEV-01"],
      actorId: "forged",
    },
  ), ids.goalId, ids.planId);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("P6-06 rejects projection of an approved plan superseded by a newer revision", async () => {
  const stale = { id: ids.planId, ...ids, status: "approved", version: 2 };
  const latest = {
    id: "00000000-0000-4000-8000-000000000005",
    ...ids,
    status: "draft",
    version: 1,
  };
  const { calls, handlers } = setup({
    plans: {
      async get() { return stale; },
      async timeline(value) {
        calls.push(["timeline", value]);
        return { plans: [stale, latest] };
      },
    },
  });
  const response = await handlers.projection(request(
    `/api/v1/goals/${ids.goalId}/issue-plans/${ids.planId}/queue-projections`,
    {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      expectedVersion: 2,
    },
  ), ids.goalId, ids.planId);
  assert.equal(response.status, 409);
  assert.equal(calls.some(([name]) => name === "project"), false);
});
