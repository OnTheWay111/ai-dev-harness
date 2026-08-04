import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  executionControls,
  executionLeases,
  executionNodes,
  externalEventInbox,
  schedulerJobs,
} from "../db/postgres-schema.ts";

function config(table) {
  const value = getTableConfig(table);
  return {
    name: value.name,
    columns: value.columns.map(({ name }) => name),
    checks: value.checks.map(({ name }) => name).sort(),
    foreignKeys: value.foreignKeys.map((key) => key.getName()).sort(),
    indexes: value.indexes.map((index) => index.config.name).sort(),
  };
}

test("P7 persists jobs, nodes, exclusive leases, inbox, and operator controls", () => {
  assert.deepEqual([
    schedulerJobs, executionNodes, executionLeases, externalEventInbox,
    executionControls,
  ].map((table) => config(table).name), [
    "scheduler_jobs", "execution_nodes", "execution_leases",
    "external_event_inbox", "execution_controls",
  ]);
  assert.ok(config(schedulerJobs).columns.includes("reconciliation_required"));
  assert.ok(config(schedulerJobs).columns.includes("required_capability"));
  assert.ok(config(schedulerJobs).indexes.includes("scheduler_jobs_claim_idx"));
  assert.ok(config(executionNodes).checks.includes("execution_nodes_capacity_chk"));
  assert.ok(config(executionLeases).indexes.includes("execution_leases_active_run_uidx"));
  assert.ok(config(externalEventInbox).indexes.includes("external_event_inbox_source_event_uidx"));
  assert.ok(config(executionControls).indexes.includes("execution_controls_scope_uidx"));
});
