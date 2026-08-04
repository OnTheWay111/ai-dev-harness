import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSpecApprovalHandler } from
  "../app/control-plane/http/spec-approval-handler.ts";

const ids = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  specRevisionId: "00000000-0000-4000-8000-000000000004",
};

test("approval HTTP boundary requires trusted actor, request ID, idempotency, and strict input", async () => {
  const calls = [];
  const handler = createSpecApprovalHandler({
    service: {
      async decide(command) { calls.push(command); return { decision: {}, specRevision: {} }; },
      async timeline() { return { decisions: [] }; },
    },
    actorResolver: async () => ({ actorId: "session-approver" }),
    rateLimiter: { consume() {} },
  });
  const response = await handler(new Request(
    `https://control.invalid/api/v1/goals/${ids.goalId}/specs/${ids.specRevisionId}/approvals`,
    {
      method: "POST",
      headers: {
        origin: "https://control.invalid",
        "content-type": "application/json",
        "idempotency-key": "idem-1",
        "x-request-id": "request-1",
      },
      body: JSON.stringify({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        expectedVersion: 1,
        reason: "Approve the minimum contract",
        policyRevision: "overdesign-policy.v1",
        decision: "approve",
        affectedElementIds: ["EL-1"],
        helpfulExceptionElementIds: [],
        scopeChanges: [],
      }),
    },
  ), ids.goalId, ids.specRevisionId);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    ...ids,
    expectedVersion: 1,
    actorId: "session-approver",
    reason: "Approve the minimum contract",
    requestId: "request-1",
    idempotencyKey: "idem-1",
    policyRevision: "overdesign-policy.v1",
    decision: "approve",
    affectedElementIds: ["EL-1"],
    helpfulExceptionElementIds: [],
    scopeChanges: [],
  }]);
});

test("approval history is authorized and scoped to the Goal", async () => {
  const calls = [];
  const handler = createSpecApprovalHandler({
    service: {
      async decide() { throw new Error("not used"); },
      async timeline(command) { calls.push(command); return { decisions: [] }; },
    },
    actorResolver: async () => ({ actorId: "viewer-1" }),
  });
  const query = new URLSearchParams({
    organizationId: ids.organizationId,
    projectId: ids.projectId,
  });
  const response = await handler(new Request(
    `https://control.invalid/api/v1/goals/${ids.goalId}/specs/${ids.specRevisionId}/approvals?${query}`,
  ), ids.goalId, ids.specRevisionId);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    goalId: ids.goalId,
    actorId: "viewer-1",
  }]);
});

test("missing headers, forged actor, and stale versions fail with stable errors", async () => {
  let calls = 0;
  const handler = createSpecApprovalHandler({
    service: {
      async decide() { calls += 1; },
      async timeline() { return { decisions: [] }; },
    },
    actorResolver: async () => ({ actorId: "session-approver" }),
  });
  const response = await handler(new Request(
    `https://control.invalid/api/v1/goals/${ids.goalId}/specs/${ids.specRevisionId}/approvals`,
    {
      method: "POST",
      headers: {
        origin: "https://control.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...ids,
        actorId: "forged",
        expectedVersion: 1,
        reason: "Approve",
        policyRevision: "overdesign-policy.v1",
        decision: "approve",
        affectedElementIds: [],
        helpfulExceptionElementIds: [],
        scopeChanges: [],
      }),
    },
  ), ids.goalId, ids.specRevisionId);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "validation_failed");
  assert.equal(calls, 0);
});

test("UI exposes Helpful exceptions, scope changes, reasons, decisions, and history", () => {
  const source = readFileSync(new URL(
    "../app/workbench/components/spec-approval-panel.tsx",
    import.meta.url,
  ), "utf8");
  assert.match(source, /Helpful 例外/);
  assert.match(source, /type="checkbox"/);
  assert.match(source, /Speculative 默认删除且不能例外保留/);
  assert.match(source, /范围操作/);
  assert.match(source, /审批或修改理由/);
  assert.match(source, /submit_for_review/);
  assert.match(source, /request_changes/);
  assert.match(source, /批准最小合同/);
  assert.match(source, /规格审批历史/);
});
