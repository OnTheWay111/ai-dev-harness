import assert from "node:assert/strict";

export async function assertGoalRepositoryContract({
  repository,
  goal,
  eventCount,
}) {
  assert.deepEqual(await repository.get(goal), goal);
  const event = {
    id: crypto.randomUUID(),
    organizationId: goal.organizationId,
    aggregateType: "goal",
    aggregateId: goal.id,
    aggregateVersion: 2,
    type: "goal.state_changed",
    occurredAt: "2026-08-04T10:15:00.000Z",
    payload: { previousState: "draft", state: "clarifying" },
  };
  const transition = {
    current: goal,
    expectedVersion: 1,
    nextState: "clarifying",
    occurredAt: new Date(event.occurredAt),
    event,
  };
  assert.deepEqual(await repository.commitTransition(transition), {
    ...goal,
    status: "clarifying",
    version: 2,
  });
  await assert.rejects(
    () => repository.commitTransition(transition),
    /version|unique/i,
  );
  assert.deepEqual(await repository.get(goal), {
    ...goal,
    status: "clarifying",
    version: 2,
  });
  assert.equal(await eventCount(event.id), 1);
}
