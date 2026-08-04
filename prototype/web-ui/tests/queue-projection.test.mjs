import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AutoDevQueueImportAdapter,
  AutoDevQueueImportContractError,
  AutoDevQueueImportUnavailableError,
} from "../app/control-plane/adapters/autodev-queue-import-adapter.ts";
import { MemoryQueueProjectionRepository } from
  "../app/control-plane/adapters/memory-queue-projection-repository.ts";
import { QueueProjectionService } from
  "../app/control-plane/application/queue-projection-service.ts";

const approvedPlan = {
  id: "00000000-0000-4000-8000-000000000010",
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  status: "approved",
  version: 2,
  digest: "a".repeat(64),
  issues: [
    {
      key: "DEV-01", title: "First", goal: "Ship", requirementRefs: ["REQ-01"],
      acceptance: [{ criterionRef: "AC-01", statement: "done" }], nonGoals: ["none"],
      dependencyCandidates: [], expectedFiles: ["app/a.ts"],
      conflictResources: { directories: [], publicInterfaces: [], databaseObjects: [], sharedConfigurations: [], landingOrder: [] },
      developmentPrompt: "Goal Ship REQ-01 AC-01 app/a.ts npm test completion evidence and all context",
      verify: ["npm test"], completionEvidence: [{ kind: "test", description: "tests", required: true }],
    },
  ],
  modelRecommendations: [{
    issueKey: "DEV-01", capabilityTier: "general_coding", reasoningEffort: "medium",
    policyRevision: "model-router.v1", factors: { risk: "low", codeScope: "narrow", domainComplexity: "standard", verificationDifficulty: "standard" },
    reasons: ["bounded"], override: null,
  }],
  waves: [{ number: 1, issueKeys: ["DEV-01"], reasons: ["dependency-ready"] }],
};

test("P6-06 calls one formal atomic import request and persists an idempotent receipt", async () => {
  const requests = [];
  const adapter = new AutoDevQueueImportAdapter({
    endpoint: "https://autodev.invalid/api/v1/queue/import",
    token: "server-secret",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return Response.json({
        importId: "import-1",
        atomic: true,
        planDigest: approvedPlan.digest,
        tasks: [{ issueKey: "DEV-01", externalTaskId: "TASK-1" }],
      });
    },
  });
  const repository = new MemoryQueueProjectionRepository();
  const service = new QueueProjectionService({ adapter, repository });
  const command = {
    plan: approvedPlan,
    actorId: "approver-1",
    requestId: "request-1",
    idempotencyKey: "projection-1",
  };
  const first = await service.project(command);
  const replay = await service.project(command);
  const replayWithNewRequestKey = await service.project({
    ...command,
    idempotencyKey: "projection-2",
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(replayWithNewRequestKey, first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.authorization, "Bearer server-secret");
  assert.equal(requests[0].init.headers["idempotency-key"], "projection-1");
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.tasks[0].capabilityTier, "general_coding");
  assert.equal(JSON.stringify(payload).includes("server-secret"), false);
  assert.equal(first.tasks[0].externalTaskId, "TASK-1");
});

test("P6-06 normalizes transport and malformed JSON failures into the Import contract", async () => {
  for (const fetcher of [
    async () => { throw new TypeError("private network detail"); },
    async () => new Response("not-json", { status: 200 }),
  ]) {
    const adapter = new AutoDevQueueImportAdapter({
      endpoint: "https://autodev.invalid/api/v1/queue/import",
      token: "secret",
      fetch: fetcher,
    });
    await assert.rejects(
      () => adapter.importApprovedPlan({
        plan: approvedPlan,
        requestId: "request",
        idempotencyKey: "projection",
      }),
      AutoDevQueueImportContractError,
    );
  }
});

test("P6-06 rejects non-atomic, partial, or digest-mismatched imports without a receipt", async () => {
  for (const response of [
    { importId: "i", atomic: false, planDigest: approvedPlan.digest, tasks: [{ issueKey: "DEV-01", externalTaskId: "T" }] },
    { importId: "i", atomic: true, planDigest: approvedPlan.digest, tasks: [] },
    { importId: "i", atomic: true, planDigest: "b".repeat(64), tasks: [{ issueKey: "DEV-01", externalTaskId: "T" }] },
  ]) {
    const repository = new MemoryQueueProjectionRepository();
    const service = new QueueProjectionService({
      repository,
      adapter: new AutoDevQueueImportAdapter({
        endpoint: "https://autodev.invalid/api/v1/queue/import",
        token: "secret",
        fetch: async () => Response.json(response),
      }),
    });
    await assert.rejects(() => service.project({
      plan: approvedPlan, actorId: "actor", requestId: "request",
      idempotencyKey: `key-${response.atomic}-${response.tasks.length}`,
    }));
    assert.equal(repository.receipts.length, 0);
  }
});

test("P6-06 fails closed when no formal import endpoint exists and never edits Queue YAML", async () => {
  const adapter = new AutoDevQueueImportAdapter({ endpoint: "", token: "" });
  await assert.rejects(
    () => adapter.importApprovedPlan({ plan: approvedPlan, requestId: "r", idempotencyKey: "k" }),
    AutoDevQueueImportUnavailableError,
  );
  const source = readFileSync(new URL(
    "../app/control-plane/adapters/autodev-queue-import-adapter.ts",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(source, /writeFile|queue\.ya?ml|child_process|execFile|spawn\(/);
});
