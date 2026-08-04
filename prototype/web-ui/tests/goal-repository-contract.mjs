import assert from "node:assert/strict";

export async function assertGoalRepositoryContract({
  repository,
  goal,
  eventCount,
}) {
  assert.deepEqual(await repository.get(goal), goal);
  const occurredAt = new Date().toISOString();
  const event = {
    id: crypto.randomUUID(),
    organizationId: goal.organizationId,
    aggregateType: "goal",
    aggregateId: goal.id,
    aggregateVersion: 2,
    type: "goal.state_changed",
    occurredAt,
    payload: { previousState: "draft", state: "clarifying" },
  };
  const receipt = {
    goalId: goal.id,
    previousState: "draft",
    state: "clarifying",
    previousVersion: 1,
    version: 2,
    eventId: event.id,
    occurredAt: event.occurredAt,
  };
  const transition = {
    current: goal,
    expectedVersion: 1,
    nextState: "clarifying",
    occurredAt: new Date(event.occurredAt),
    event,
    audit: {
      id: crypto.randomUUID(),
      organizationId: goal.organizationId,
      projectId: goal.projectId,
      goalId: goal.id,
      actorId: "contract-actor",
      action: "goal.state_changed",
      entityType: "goal",
      entityId: goal.id,
      entityVersion: 2,
      reason: "Verify the Repository contract",
      requestId: "contract-request",
      createdAt: event.occurredAt,
    },
    idempotency: {
      organizationId: goal.organizationId,
      actorId: "contract-actor",
      endpoint: "goal.transition",
      key: crypto.randomUUID(),
      requestHash: "d".repeat(64),
      responseDigest: "e".repeat(64),
      expiresAt: new Date(new Date(occurredAt).getTime() + 24 * 60 * 60 * 1000),
    },
    receipt,
  };
  assert.deepEqual(await repository.commitTransition(transition), {
    goal: {
      ...goal,
      status: "clarifying",
      version: 2,
    },
    receipt,
  });
  assert.deepEqual(await repository.commitTransition(transition), {
    goal: {
      ...goal,
      status: "clarifying",
      version: 2,
    },
    receipt,
  });
  assert.deepEqual(await repository.get(goal), {
    ...goal,
    status: "clarifying",
    version: 2,
  });
  assert.equal(await eventCount(event.id), 1);
}
