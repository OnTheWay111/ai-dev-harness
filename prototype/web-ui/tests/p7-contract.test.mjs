import test from "node:test";

import { assertAutoDevExecutionContract } from
  "./execution-gateway-contract.mjs";

test("P7 fake AutoDev satisfies the same execution contract as the real smoke", () => {
  assertAutoDevExecutionContract({
    queueTask: { id: "H-001", preferred_builder: "general_coding" },
    status: { run_id: "fake-run", status: "done" },
    events: [
      {
        schema_version: "autodev.run-event.v1",
        event_id: "fake-run:event-1",
        sequence: 1,
        phase: "builder",
        message: "builder started",
      },
      {
        schema_version: "autodev.run-event.v1",
        event_id: "fake-run:event-2",
        sequence: 2,
        phase: "done",
        message: "task done",
      },
    ],
  });
});
