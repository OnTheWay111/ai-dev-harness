import assert from "node:assert/strict";
import { test } from "node:test";

import { FakePlannerAdapter } from "../app/control-plane/adapters/fake-planner-adapter.ts";
import { MemoryClarificationHistoryRepository } from "../app/control-plane/adapters/memory-clarification-history-repository.ts";
import { MemoryGoalWorkspaceRepository } from "../app/control-plane/adapters/memory-goal-workspace-repository.ts";
import { ClarificationHistoryService } from "../app/control-plane/application/clarification-history-service.ts";
import { ClarificationPlannerService } from "../app/control-plane/application/clarification-planner-service.ts";
import { ClarificationExpiredError } from "../app/control-plane/domain/clarification-history.ts";
import { VersionConflictError } from "../app/control-plane/domain/errors.ts";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  goalId: "30000000-0000-4000-8000-000000000001",
};
const goal = {
  id: scope.goalId,
  organizationId: scope.organizationId,
  projectId: scope.projectId,
  title: "Append clarification history",
  problemStatement: "Answers need an audit trail.",
  desiredOutcome: "Every answer remains reviewable.",
  acceptanceCriteria: [{ id: crypto.randomUUID(), position: 1, statement: "History is immutable", version: 1 }],
  nonGoals: [],
  constraints: ["No overwritten answers"],
  status: "draft",
  version: 2,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};
const output = {
  schemaVersion: "planner-clarification.v1",
  knownFacts: [{ id: "fact_1", fact: "History is required", basis: "goal_contract" }],
  uncertainties: [{ id: "uncertainty_1", statement: "Retention period", impact: "Audit completeness" }],
  questions: [{
    id: "retention_period",
    prompt: "How long must answers be retained?",
    rationale: "The contract does not state a retention period.",
    blockingLevel: "high",
    answerType: "text",
    suggestedOptions: ["One year", "Seven years"],
  }],
};

function createFixture({ outputs = [output, output], authorize = async () => {} } = {}) {
  const history = new MemoryClarificationHistoryRepository();
  const goals = new MemoryGoalWorkspaceRepository([goal]);
  let sequence = 0;
  const service = new ClarificationHistoryService({
    repository: history,
    goals,
    planner: new ClarificationPlannerService(new FakePlannerAdapter(outputs)),
    authorizer: { authorize },
    clock: () => new Date(`2026-08-04T00:00:0${sequence}.000Z`),
    idGenerator: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  return { service, history, goals };
}

function generateCommand(overrides = {}) {
  return {
    ...scope,
    expectedGoalVersion: 2,
    actorId: "human-actor",
    reason: "Identify missing information",
    ...overrides,
  };
}

test("generation appends versioned rounds and records the regeneration source", async () => {
  const { service } = createFixture();
  const first = await service.generate(generateCommand());
  const second = await service.generate(generateCommand({ reason: "Regenerate after review" }));

  assert.equal(first.round.roundNumber, 1);
  assert.equal(first.round.sourceGoalVersion, 2);
  assert.equal(first.questions[0].revision, 1);
  assert.equal(second.round.roundNumber, 2);
  assert.equal(second.round.previousRoundId, first.round.id);
  assert.equal(second.round.regeneratedFromRoundId, first.round.id);
  assert.equal((await service.timeline({ ...scope, actorId: "human-actor" })).rounds.length, 2);
});

test("answering and re-answering append question and human-decision revisions", async () => {
  const { service, history } = createFixture({ outputs: [output] });
  const generated = await service.generate(generateCommand());
  const question = generated.questions[0];
  const first = await service.answer({
    ...scope, threadId: question.threadId, expectedQuestionRevision: 1,
    expectedGoalVersion: 2, answer: "Seven years", actorId: "reviewer-a",
    reason: "Matches compliance policy",
  });
  const second = await service.answer({
    ...scope, threadId: question.threadId, expectedQuestionRevision: 2,
    expectedGoalVersion: 2, answer: "One year", actorId: "reviewer-b",
    reason: "Scope was reduced",
  });

  assert.equal(first.question.revision, 2);
  assert.equal(second.question.revision, 3);
  assert.equal(second.question.previousClarificationId, first.question.id);
  assert.equal(second.decision.revision, 2);
  const timeline = await history.getTimeline(scope);
  assert.deepEqual(timeline.questions.map(({ answer }) => answer), [null, "Seven years", "One year"]);
  assert.deepEqual(timeline.decisions.map(({ actorId }) => actorId), ["reviewer-a", "reviewer-b"]);
});

test("concurrent answer and an answer for a changed Goal fail closed", async () => {
  const { service, goals } = createFixture({ outputs: [output] });
  const generated = await service.generate(generateCommand());
  const threadId = generated.questions[0].threadId;
  await service.answer({ ...scope, threadId, expectedQuestionRevision: 1, expectedGoalVersion: 2, answer: "Seven years", actorId: "reviewer-a", reason: "Initial decision" });
  await assert.rejects(() => service.answer({ ...scope, threadId, expectedQuestionRevision: 1, expectedGoalVersion: 2, answer: "One year", actorId: "reviewer-b", reason: "Racing decision" }), VersionConflictError);

  const current = await goals.get({ id: scope.goalId, organizationId: scope.organizationId, projectId: scope.projectId });
  await goals.commitUpdate({
    current,
    next: { ...current, version: 3, updatedAt: "2026-08-04T00:01:00.000Z" },
    expectedVersion: 2,
    event: { id: crypto.randomUUID(), organizationId: scope.organizationId, aggregateType: "goal", aggregateId: scope.goalId, aggregateVersion: 3, type: "goal.updated", occurredAt: "2026-08-04T00:01:00.000Z", payload: {} },
    audit: { id: crypto.randomUUID(), ...scope, actorId: "editor", action: "goal.updated", entityType: "goal", entityId: scope.goalId, entityVersion: 3, reason: "Change contract", requestId: "request", createdAt: "2026-08-04T00:01:00.000Z" },
    idempotency: { organizationId: scope.organizationId, actorId: "editor", endpoint: "goal.update", key: "update-goal", requestHash: "hash", responseDigest: "digest", expiresAt: new Date("2026-08-05") },
    receipt: { operation: "updated", goal: { ...current, version: 3 }, eventId: crypto.randomUUID(), occurredAt: "2026-08-04T00:01:00.000Z" },
  });
  await assert.rejects(() => service.answer({ ...scope, threadId, expectedQuestionRevision: 2, expectedGoalVersion: 3, answer: "Forever", actorId: "reviewer-c", reason: "Stale question" }), ClarificationExpiredError);
});

test("authorization happens before any history is disclosed or generated", async () => {
  const denied = new Error("denied");
  const { service, history } = createFixture({ authorize: async () => { throw denied; } });
  await assert.rejects(() => service.timeline({ ...scope, actorId: "outsider" }), denied);
  await assert.rejects(() => service.generate(generateCommand()), denied);
  assert.equal((await history.getTimeline(scope)).rounds.length, 0);
});
