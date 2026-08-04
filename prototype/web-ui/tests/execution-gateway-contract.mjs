import assert from "node:assert/strict";

export function assertAutoDevExecutionContract({ queueTask, status, events }) {
  assert.match(queueTask.id, /^H-\d+$/);
  assert.ok(queueTask.preferred_builder, "task-level preferred_builder is required");
  assert.equal(status.run_id.length > 0, true);
  assert.equal(typeof status.status, "string");
  assert.ok(status.status.length > 0);
  assert.ok(events.length > 0);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.ok(events.every((event) =>
    event.schema_version === "autodev.run-event.v1" &&
    typeof event.event_id === "string" && event.event_id.length > 0 &&
    typeof event.phase === "string" && typeof event.message === "string"
  ));
}
