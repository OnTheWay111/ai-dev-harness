import assert from "node:assert/strict";
import test from "node:test";

import { globalTasks } from "../app/workbench/server/demo-workbench-snapshot.ts";
import {
  createTaskApiHandlers,
} from "../app/workbench/server/task-api-handler.ts";
import {
  MemoryTaskActionRepository,
} from "../app/workbench/server/task-action-repository.ts";
import {
  TaskActionService,
} from "../app/workbench/server/task-action-service.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const visibility = { actorId: "approver-1", organizationIds: [], projectIds: [projectId] };

function harness(options = {}) {
  const repository = new MemoryTaskActionRepository(globalTasks.map((task) => ({
    organizationId,
    projectId,
    task,
  })));
  const service = new TaskActionService({
    repository,
    authorizer: options.authorizer ?? { async authorize() {} },
    clock: () => new Date("2026-08-05T02:00:00.000Z"),
    idFactory: () => "90000000-0000-4000-8000-000000000001",
  });
  const handlers = createTaskApiHandlers({
    service,
    actorResolver: async () => ({ actorId: visibility.actorId }),
    visibilityResolver: async () => visibility,
    allowedOrigins: ["https://harness.test"],
  });
  return { repository, service, handlers };
}

function actionRequest(body, key = "idem-p8-action-0001") {
  return new Request("https://harness.test/api/v1/tasks/DEV-07/actions", {
    method: "POST",
    headers: {
      origin: "https://harness.test",
      "content-type": "application/json",
      "idempotency-key": key,
      "x-request-id": "req-p8-action",
    },
    body: JSON.stringify(body),
  });
}

test("returns task detail and accepts a durable command within 500ms", async () => {
  const { handlers } = harness();
  const detail = await handlers.task(
    new Request("https://harness.test/api/v1/tasks/DEV-07"),
    "DEV-07",
  );
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.id, "DEV-07");

  const started = performance.now();
  const response = await handlers.action(actionRequest({
    action: "review_evidence",
    expectedVersion: 12,
    reason: "Approve the verified production boundary",
    input: { decision: "approve" },
  }), "DEV-07");
  assert.ok(performance.now() - started < 500);
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.taskId, "DEV-07");
  assert.match(receipt.receiptId, /^rcpt_/);

  const fetched = await handlers.receipt(
    new Request(`https://harness.test${receipt.statusUrl}`),
    receipt.receiptId,
  );
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).status, "accepted");

  const malformedReceipt = await handlers.receipt(
    new Request("https://harness.test/api/v1/receipts/rcpt_------------------------------------"),
    "rcpt_------------------------------------",
  );
  assert.equal(malformedReceipt.status, 404);
});

test("replays identical idempotent commands and rejects key reuse, stale versions, and invalid transitions", async () => {
  const { handlers } = harness();
  const command = {
    action: "review_evidence",
    expectedVersion: 12,
    reason: "Approve the verified production boundary",
    input: { decision: "approve" },
  };
  const first = await handlers.action(actionRequest(command), "DEV-07");
  const firstBody = await first.json();
  const duplicate = await handlers.action(actionRequest(command), "DEV-07");
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), firstBody);

  const conflict = await handlers.action(actionRequest({
    ...command,
    input: { decision: "reject" },
  }), "DEV-07");
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");

  const stale = await handlers.action(actionRequest({
    ...command,
    expectedVersion: 11,
  }, "idem-p8-action-stale"), "DEV-07");
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "version_conflict");

  const invalid = await handlers.action(actionRequest({
    action: "resolve_blocker",
    expectedVersion: 12,
    reason: "Wrong action for this task state",
    input: { source: "workbench" },
  }, "idem-p8-action-invalid"), "DEV-07");
  assert.equal(invalid.status, 409);
  assert.equal((await invalid.json()).error.code, "invalid_transition");
});

test("returns forbidden without writing a receipt and validates high-risk reasons", async () => {
  const denied = harness({
    authorizer: { async authorize() { throw Object.assign(new Error("denied"), { code: "forbidden" }); } },
  });
  const response = await denied.handlers.action(actionRequest({
    action: "review_evidence",
    expectedVersion: 12,
    reason: "Approve the verified production boundary",
    input: { decision: "approve" },
  }), "DEV-07");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "forbidden");
  assert.equal(denied.repository.receiptCount(), 0);

  const { handlers } = harness();
  const invalid = await handlers.action(actionRequest({
    action: "review_evidence",
    expectedVersion: 12,
    reason: "",
    input: { decision: "approve" },
  }, "idem-p8-action-no-reason"), "DEV-07");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "validation_failed");

  const invalidInput = await handlers.action(actionRequest({
    action: "review_evidence",
    expectedVersion: 12,
    reason: "Attempt an unsupported decision",
    input: { decision: "silently_override", extra: true },
  }, "idem-p8-action-bad-input"), "DEV-07");
  assert.equal(invalidInput.status, 400);
  assert.equal((await invalidInput.json()).error.code, "validation_failed");
});

test("allows only one durable command to own a composite task version", async () => {
  const { handlers } = harness();
  const command = {
    action: "review_evidence",
    expectedVersion: 12,
    reason: "Approve the verified production boundary",
    input: { decision: "approve" },
  };
  assert.equal((await handlers.action(
    actionRequest(command, "idem-p8-version-owner-1"),
    "DEV-07",
  )).status, 202);
  const competing = await handlers.action(
    actionRequest(command, "idem-p8-version-owner-2"),
    "DEV-07",
  );
  assert.equal(competing.status, 409);
  assert.equal((await competing.json()).error.code, "version_conflict");
});

test("supports accepted, running, completed, and failed receipt transitions", async () => {
  const { service } = harness();
  const receipt = await service.submit({
    taskId: "DEV-07",
    actorId: visibility.actorId,
    visibility,
    requestId: "req-receipt-state",
    idempotencyKey: "idem-p8-receipt-state",
    request: {
      action: "review_evidence",
      expectedVersion: 12,
      reason: "Approve the verified production boundary",
      input: { decision: "approve" },
    },
  });
  assert.equal((await service.transitionReceipt(receipt.receiptId, "running")).status, "running");
  assert.equal((await service.transitionReceipt(receipt.receiptId, "completed", { taskVersion: 13 })).status, "completed");
  await assert.rejects(
    () => service.transitionReceipt(receipt.receiptId, "failed", { error: { code: "late_failure" } }),
    /terminal/i,
  );
});
