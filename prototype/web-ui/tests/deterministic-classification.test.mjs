import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  classificationPolicyV1,
  classifyGoal,
} from "../app/control-plane/domain/deterministic-classification.ts";
import { MemoryClassificationRepository } from "../app/control-plane/adapters/memory-classification-repository.ts";
import { MemoryClarificationHistoryRepository } from "../app/control-plane/adapters/memory-clarification-history-repository.ts";
import { MemoryGoalWorkspaceRepository } from "../app/control-plane/adapters/memory-goal-workspace-repository.ts";
import { ClassificationService } from "../app/control-plane/application/classification-service.ts";
import { createClassificationHandler } from "../app/control-plane/http/classification-handler.ts";
import { classifications, classificationPolicyRevisions } from "../db/postgres-schema.ts";

const golden = JSON.parse(await readFile(new URL("./fixtures/classification/v1-golden.json", import.meta.url), "utf8"));

function contract(input, version = 1) {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    ...input,
    acceptanceCriteria: input.acceptanceCriteria.map((statement, index) => ({ id: crypto.randomUUID(), position: index + 1, statement, version: 1 })),
    status: "draft",
    version,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

test("v1 golden fixtures produce stable, transparent classifications", () => {
  assert.equal(
    createHash("sha256").update(JSON.stringify(classificationPolicyV1.definition)).digest("hex"),
    classificationPolicyV1.digest,
  );
  for (const fixture of golden) {
    const goal = contract(fixture.goal);
    const first = classifyGoal({ goal, clarifications: fixture.clarifications });
    const second = classifyGoal({ goal: structuredClone(goal), clarifications: structuredClone(fixture.clarifications) });
    assert.deepEqual(first, second, fixture.name);
    assert.deepEqual({
      size: first.size,
      risk: first.risk,
      requiredArtifacts: first.requiredArtifacts,
      requiredApproverRoles: first.requiredApproverRoles,
    }, fixture.expected, fixture.name);
    assert.ok(first.matchedFactors.every(({ code, points, explanation }) => code && Number.isInteger(points) && explanation));
    assert.equal(first.policySchemaVersion, "classification-policy.v1");
  }
});

test("size and risk boundaries are explicit and deterministic", () => {
  const make = (criteria, constraints = [], text = "Ordinary scoped change") => classifyGoal({
    goal: contract({ title: text, problemStatement: text, desiredOutcome: text, acceptanceCriteria: Array.from({ length: criteria }, (_, index) => `Criterion ${index + 1}`), nonGoals: [], constraints }),
    clarifications: [],
  });
  assert.equal(make(1).size, "S");
  assert.equal(make(3).size, "M");
  assert.equal(make(6, ["one"]).size, "L");
  assert.equal(make(11, ["one", "two", "three"]).size, "XL");
  assert.equal(make(1, [], "Authentication secret").risk, "medium");
  assert.equal(make(1, [], "Production deletion with data loss").risk, "high");
  assert.equal(make(1, [], "生产删除可能导致数据丢失").risk, "high");
});

test("service appends classifications and saves the immutable policy revision", async () => {
  const goal = contract(golden[0].goal, 3);
  const repository = new MemoryClassificationRepository();
  const service = new ClassificationService({
    repository,
    goals: new MemoryGoalWorkspaceRepository([goal]),
    clarifications: new MemoryClarificationHistoryRepository(),
    authorizer: { async authorize() {} },
    idGenerator: (() => { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`; })(),
    clock: () => new Date("2026-08-04T01:00:00.000Z"),
  });
  const command = { organizationId: goal.organizationId, projectId: goal.projectId, goalId: goal.id, expectedGoalVersion: 3, actorId: "reviewer", reason: "Classify current scope" };
  const first = await service.classify(command);
  const second = await service.classify(command);
  assert.equal(first.classification.revision, 1);
  assert.equal(second.classification.revision, 2);
  assert.equal(second.classification.previousClassificationId, first.classification.id);
  assert.equal(first.policy.schemaVersion, classificationPolicyV1.schemaVersion);
  assert.equal(first.classification.policyRevisionId, second.classification.policyRevisionId);
  assert.equal((await repository.getTimeline(command)).policies.length, 1);
  assert.equal((await repository.getTimeline(command)).classifications.length, 2);
});

test("PostgreSQL schema stores append-only policy and classification revisions", () => {
  const policy = getTableConfig(classificationPolicyRevisions);
  const result = getTableConfig(classifications);
  assert.deepEqual(policy.indexes.map(({ config }) => config.name).sort(), [
    "classification_policy_revisions_digest_uidx",
    "classification_policy_revisions_key_revision_uidx",
  ]);
  assert.deepEqual(result.foreignKeys.map((key) => key.getName()).sort(), [
    "classifications_goal_organization_fk",
    "classifications_policy_revision_fk",
    "classifications_previous_fk",
  ]);
  assert.ok(result.indexes.some(({ config }) => config.name === "classifications_goal_revision_uidx"));
});

test("classification HTTP boundary uses trusted identity and rejects model/client decisions", async () => {
  let received;
  const handler = createClassificationHandler({
    actorResolver: async () => ({ actorId: "trusted-reviewer" }),
    service: {
      async timeline() { return { policies: [], classifications: [] }; },
      async classify(command) { received = command; return { policy: {}, classification: {} }; },
    },
  });
  const base = { organizationId: "10000000-0000-4000-8000-000000000001", projectId: "20000000-0000-4000-8000-000000000001", expectedGoalVersion: 1, reason: "Apply policy" };
  const invalid = await handler(new Request("https://harness.test/api", { method: "POST", headers: { origin: "https://harness.test", "content-type": "application/json" }, body: JSON.stringify({ ...base, risk: "low", actorId: "model" }) }), "30000000-0000-4000-8000-000000000001");
  assert.equal(invalid.status, 400);
  const accepted = await handler(new Request("https://harness.test/api", { method: "POST", headers: { origin: "https://harness.test", "content-type": "application/json" }, body: JSON.stringify(base) }), "30000000-0000-4000-8000-000000000001");
  assert.equal(accepted.status, 201);
  assert.equal(received.actorId, "trusted-reviewer");
  assert.equal("risk" in received, false);
});

test("UI explains factors, artifacts, approvers, and that models do not decide gates", async () => {
  const source = await readFile(new URL("../app/workbench/components/clarify-view.tsx", import.meta.url), "utf8");
  assert.match(source, /matchedFactors\.map/);
  assert.match(source, /requiredArtifacts\.join/);
  assert.match(source, /requiredApproverRoles\.join/);
  assert.match(source, /模型不参与 Gate 决定/);
});
