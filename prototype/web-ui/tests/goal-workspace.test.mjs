import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GoalWorkspaceService,
  GoalWorkspaceValidationError,
} from "../app/control-plane/application/goal-workspace-service.ts";
import {
  MemoryGoalWorkspaceRepository,
} from "../app/control-plane/adapters/memory-goal-workspace-repository.ts";
import {
  createGoalWorkspaceHandler,
} from "../app/control-plane/http/goal-workspace-handler.ts";
import {
  restoreGoalDraft,
  serializeGoalDraft,
} from "../app/workbench/goal-workspace-draft.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000101",
  projectId: "00000000-0000-4000-8000-000000000102",
};

const draft = {
  title: "Ship the Goal Workspace",
  problemStatement: "Goal drafts are not persisted through a safe API.",
  desiredOutcome: "Authorized users can maintain one versioned Goal Contract.",
  acceptanceCriteria: [
    "A creator can save a valid draft",
    "A stale edit is rejected without partial writes",
  ],
  nonGoals: ["Automatically approve the Goal"],
  constraints: ["Planner output remains a draft"],
};

function createService(repository, overrides = {}) {
  const authorizations = [];
  let sequence = 200;
  const service = new GoalWorkspaceService({
    repository,
    authorizer: {
      async authorize(input) {
        authorizations.push(input);
      },
    },
    clock: () => new Date("2026-08-04T12:00:00.000Z"),
    idGenerator: () =>
      `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    ...overrides,
  });
  return { service, authorizations };
}

test("creates, reads, and edits a complete versioned Goal Contract", async () => {
  const repository = new MemoryGoalWorkspaceRepository();
  const { service, authorizations } = createService(repository);
  const created = await service.create({
    ...scope,
    actorId: "actor-1",
    requestId: "req-create",
    idempotencyKey: "goal-create-1",
    draft,
    reason: "Save the initial Goal Contract",
  });

  assert.equal(created.operation, "created");
  assert.equal(created.goal.version, 1);
  assert.deepEqual(
    created.goal.acceptanceCriteria.map(({ position, statement }) => ({
      position,
      statement,
    })),
    draft.acceptanceCriteria.map((statement, index) => ({
      position: index + 1,
      statement,
    })),
  );
  assert.deepEqual(created.goal.nonGoals, draft.nonGoals);
  assert.deepEqual(created.goal.constraints, draft.constraints);

  const loaded = await service.get({
    ...scope,
    goalId: created.goal.id,
    actorId: "actor-1",
  });
  assert.deepEqual(loaded, created.goal);

  const updated = await service.update({
    ...scope,
    goalId: created.goal.id,
    actorId: "actor-1",
    requestId: "req-update",
    idempotencyKey: "goal-update-1",
    expectedVersion: 1,
    draft: { ...draft, title: "Ship a production Goal Workspace" },
    reason: "Clarify the delivery target",
  });
  assert.equal(updated.operation, "updated");
  assert.equal(updated.goal.version, 2);
  assert.equal(updated.goal.title, "Ship a production Goal Workspace");
  assert.deepEqual(authorizations.map(({ permission }) => permission), [
    "goal.write",
    "goal.read",
    "goal.write",
  ]);
  assert.equal(repository.committedAuditEvents.length, 2);
  assert.equal(repository.committedEvents.length, 2);
});

test("replays an identical command and rejects stale or malformed edits", async () => {
  const repository = new MemoryGoalWorkspaceRepository();
  const { service } = createService(repository);
  const command = {
    ...scope,
    actorId: "actor-1",
    requestId: "req-create",
    idempotencyKey: "goal-create-replay",
    draft,
    reason: "Save a draft",
  };
  const first = await service.create(command);
  assert.deepEqual(await service.create(command), first);
  assert.equal(repository.committedEvents.length, 1);

  await assert.rejects(
    () => service.update({
      ...command,
      goalId: first.goal.id,
      idempotencyKey: "stale-update",
      expectedVersion: 2,
    }),
    /version/i,
  );
  assert.equal((await repository.get({ ...scope, id: first.goal.id })).version, 1);

  await assert.rejects(
    () => service.create({
      ...command,
      idempotencyKey: "invalid-create",
      draft: { ...draft, acceptanceCriteria: [] },
    }),
    GoalWorkspaceValidationError,
  );
});

test("authorization fails before Goal Workspace repository access", async () => {
  let accesses = 0;
  const repository = {
    async get() { accesses += 1; },
    async findIdempotentReceipt() { accesses += 1; },
    async commitCreate() { accesses += 1; },
    async commitUpdate() { accesses += 1; },
  };
  const { service } = createService(repository, {
    authorizer: { async authorize() { throw new Error("forbidden"); } },
  });
  await assert.rejects(() => service.create({
    ...scope,
    actorId: "actor-denied",
    requestId: "req-denied",
    idempotencyKey: "denied-create",
    draft,
    reason: "Must not reach persistence",
  }), /forbidden/);
  assert.equal(accesses, 0);
});

test("HTTP handler fails closed and maps create/read/update without trusting actor input", async () => {
  const calls = [];
  const handler = createGoalWorkspaceHandler({
    service: {
      async create(command) {
        calls.push(["create", command]);
        return { operation: "created", goal: { id: "goal-1", version: 1 } };
      },
      async get(command) {
        calls.push(["get", command]);
        return { id: command.goalId, version: 1 };
      },
      async update(command) {
        calls.push(["update", command]);
        return { operation: "updated", goal: { id: command.goalId, version: 2 } };
      },
    },
    actorResolver: async () => ({ actorId: "server-actor" }),
  });

  const missingKey = await handler(new Request("https://control.invalid/api/v1/goals", {
    method: "POST",
    headers: { origin: "https://control.invalid", "content-type": "application/json" },
    body: JSON.stringify({ ...scope, draft, reason: "Create" }),
  }));
  assert.equal(missingKey.status, 400);
  assert.equal(calls.length, 0);

  const created = await handler(new Request("https://control.invalid/api/v1/goals", {
    method: "POST",
    headers: {
      origin: "https://control.invalid",
      "content-type": "application/json",
      "idempotency-key": "create-1",
      "x-request-id": "req-1",
    },
    body: JSON.stringify({ ...scope, draft, reason: "Create" }),
  }));
  assert.equal(created.status, 201);
  assert.equal(calls[0][1].actorId, "server-actor");

  const read = await handler(new Request(
    `https://control.invalid/api/v1/goals/goal-1?organizationId=${scope.organizationId}&projectId=${scope.projectId}`,
  ), "goal-1");
  assert.equal(read.status, 200);

  const patched = await handler(new Request("https://control.invalid/api/v1/goals/goal-1", {
    method: "PATCH",
    headers: {
      origin: "https://control.invalid",
      "content-type": "application/json",
      "idempotency-key": "update-1",
    },
    body: JSON.stringify({
      ...scope,
      expectedVersion: 1,
      draft,
      reason: "Update",
    }),
  }), "goal-1");
  assert.equal(patched.status, 200);
  assert.equal(calls[2][1].actorId, "server-actor");
});

test("rejects a cross-origin Goal write before resolving identity", async () => {
  let identityReads = 0;
  const handler = createGoalWorkspaceHandler({
    service: {
      async create() { throw new Error("must not create"); },
      async get() { throw new Error("must not read"); },
      async update() { throw new Error("must not update"); },
    },
    actorResolver: async () => {
      identityReads += 1;
      return { actorId: "actor" };
    },
  });
  const response = await handler(new Request("https://control.invalid/api/v1/goals", {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      "content-type": "application/json",
      "idempotency-key": "cross-origin",
    },
    body: JSON.stringify({ ...scope, draft, reason: "attack" }),
  }));
  assert.equal(response.status, 403);
  assert.equal(identityReads, 0);
});

test("preserves a valid local draft and rejects corrupted recovery data", () => {
  assert.deepEqual(restoreGoalDraft(serializeGoalDraft(draft)), draft);
  assert.equal(restoreGoalDraft('{"title":true}'), null);
  assert.equal(restoreGoalDraft("not-json"), null);
});

test("keeps explicit labels and accessible error status in the Goal editor", async () => {
  const source = await readFile(new URL(
    "../app/workbench/components/clarify-view.tsx",
    import.meta.url,
  ), "utf8");
  for (const label of [
    "目标标题",
    "问题陈述",
    "期望结果",
    "验收标准",
    "非目标",
    "约束",
    "本次修改原因",
  ]) assert.match(source, new RegExp(label));
  assert.match(source, /<label className=/);
  assert.match(source, /role="alert"/);
  assert.match(source, /disabled=\{!goal\}/);
});
