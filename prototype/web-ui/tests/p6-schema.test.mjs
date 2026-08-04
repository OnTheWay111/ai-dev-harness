import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  executionWaves,
  issuePlanRevisions,
  issuePlanStatuses,
  modelRecommendations,
  queueProjections,
  queueProjectionStatuses,
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

test("P6 persists plan revisions, routing, waves, and queue receipts as authoritative facts", () => {
  assert.deepEqual(issuePlanStatuses, ["draft", "approved", "rejected", "superseded"]);
  assert.deepEqual(queueProjectionStatuses, ["completed", "failed"]);
  assert.deepEqual([
    issuePlanRevisions, modelRecommendations, executionWaves, queueProjections,
  ].map((table) => config(table).name), [
    "issue_plan_revisions", "model_recommendations", "execution_waves", "queue_projections",
  ]);
  assert.ok(config(issuePlanRevisions).columns.includes("plan_data"));
  assert.ok(config(issuePlanRevisions).indexes.includes("issue_plan_revisions_goal_revision_uidx"));
  assert.deepEqual(config(modelRecommendations).foreignKeys, ["model_recommendations_plan_fk"]);
  assert.deepEqual(config(executionWaves).foreignKeys, ["execution_waves_plan_fk"]);
  assert.deepEqual(config(queueProjections).foreignKeys, ["queue_projections_plan_fk"]);
  assert.ok(config(queueProjections).indexes.includes("queue_projections_idempotency_uidx"));
});
