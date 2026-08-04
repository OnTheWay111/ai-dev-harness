import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  auditEvents,
  evidence,
  evidenceKinds,
  idempotencyRecords,
  idempotencyStatuses,
  outboxEvents,
  outboxStatuses,
  runStatuses,
  runs,
} from "../db/postgres-schema.ts";

function config(table) {
  const value = getTableConfig(table);
  return {
    columns: value.columns.map((column) => column.name),
    checks: value.checks.map((check) => check.name).sort(),
    foreignKeys: value.foreignKeys.map((key) => key.getName()).sort(),
    indexes: value.indexes.map((index) => index.config.name).sort(),
    uniques: value.uniqueConstraints.map((unique) => unique.name).sort(),
  };
}

test("defines stable Run, Evidence, Outbox, and idempotency states", () => {
  assert.deepEqual(runStatuses, [
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual(evidenceKinds, [
    "artifact",
    "log",
    "test",
    "review",
    "commit",
    "push",
  ]);
  assert.deepEqual(outboxStatuses, ["pending", "published", "failed"]);
  assert.deepEqual(idempotencyStatuses, ["in_progress", "completed", "failed"]);
});

test("binds Run and Evidence to the complete Issue hierarchy", () => {
  assert.deepEqual(config(runs).columns, [
    "id",
    "organization_id",
    "project_id",
    "goal_id",
    "issue_id",
    "attempt",
    "status",
    "request_id",
    "version",
    "started_at",
    "finished_at",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(config(runs).foreignKeys, ["runs_issue_goal_fk"]);
  assert.ok(config(runs).indexes.includes("runs_issue_attempt_uidx"));
  assert.ok(config(runs).checks.includes("runs_lifecycle_chk"));

  assert.deepEqual(config(evidence).foreignKeys, ["evidence_run_issue_fk"]);
  assert.ok(config(evidence).indexes.includes("evidence_run_kind_digest_uidx"));
  assert.ok(config(evidence).checks.includes("evidence_digest_chk"));
  assert.ok(config(evidence).columns.includes("retention_until"));
  assert.ok(!config(evidence).columns.includes("content"));
});

test("makes AuditEvent append-only and traceable without embedding artifacts", () => {
  assert.deepEqual(config(auditEvents).columns, [
    "id",
    "organization_id",
    "project_id",
    "goal_id",
    "actor_id",
    "action",
    "entity_type",
    "entity_id",
    "entity_version",
    "reason",
    "request_id",
    "policy_revision",
    "details_ref",
    "details_digest",
    "retention_until",
    "created_at",
  ]);
  assert.deepEqual(config(auditEvents).foreignKeys, [
    "audit_events_goal_organization_fk",
    "audit_events_project_organization_fk",
  ]);
  assert.ok(config(auditEvents).checks.includes("audit_events_scope_chk"));
});

test("defines uniquely deliverable Outbox events and scoped expiring idempotency", () => {
  assert.ok(config(outboxEvents).indexes.includes(
    "outbox_events_organization_dedupe_uidx",
  ));
  assert.ok(config(outboxEvents).indexes.includes(
    "outbox_events_dispatch_idx",
  ));
  assert.ok(config(outboxEvents).checks.includes("outbox_events_state_chk"));

  assert.ok(config(idempotencyRecords).indexes.includes(
    "idempotency_records_scope_key_uidx",
  ));
  assert.ok(config(idempotencyRecords).indexes.includes(
    "idempotency_records_expiry_idx",
  ));
  assert.ok(config(idempotencyRecords).checks.includes(
    "idempotency_records_expiry_chk",
  ));
  assert.ok(!config(idempotencyRecords).columns.includes("response_body"));
});
