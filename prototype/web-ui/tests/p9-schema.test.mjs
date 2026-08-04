import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  artifactObjects,
  credentialReferences,
  deliveryCandidates,
  deliveryPolicies,
  landingReceipts,
  pullRequestReceipts,
  pushReceipts,
  reviews,
} from "../db/postgres-schema.ts";

function config(table) {
  const value = getTableConfig(table);
  return {
    name: value.name,
    columns: value.columns.map(({ name }) => name),
    checks: value.checks.map(({ name }) => name),
    indexes: value.indexes.map((index) => index.config.name),
    foreignKeys: value.foreignKeys.map((key) => key.getName()),
  };
}

test("P9 persists only immutable object metadata and traceable delivery receipts", () => {
  assert.deepEqual([
    artifactObjects, reviews, credentialReferences, deliveryPolicies,
    deliveryCandidates, pushReceipts, pullRequestReceipts, landingReceipts,
  ].map((table) => config(table).name), [
    "artifact_objects", "reviews", "credential_references", "delivery_policies",
    "delivery_candidates", "push_receipts", "pull_request_receipts", "landing_receipts",
  ]);
  assert.deepEqual(config(artifactObjects).columns, [
    "id", "organization_id", "project_id", "object_key", "digest", "artifact_kind",
    "media_type", "size_bytes", "created_by_actor_id", "retention_policy",
    "retention_until", "created_at",
  ]);
  assert.equal(config(artifactObjects).columns.includes("content"), false);
  assert.ok(config(artifactObjects).indexes.includes("artifact_objects_scope_digest_uidx"));
  assert.ok(config(reviews).columns.includes("target_commit_sha"));
  assert.ok(config(reviews).columns.includes("input_artifact_digests"));
  assert.ok(config(deliveryPolicies).columns.includes("push_mode"));
  assert.ok(config(deliveryCandidates).columns.includes("commit_sha"));
  assert.ok(config(pushReceipts).columns.includes("remote_branch"));
  assert.ok(config(pullRequestReceipts).columns.includes("external_id"));
  assert.ok(config(landingReceipts).columns.includes("landing_commit_sha"));
});

test("P9 schema never stores credential material", () => {
  const columns = config(credentialReferences).columns;
  assert.ok(columns.includes("external_reference"));
  for (const forbidden of ["token", "secret", "password", "private_key", "credential_value"]) {
    assert.equal(columns.includes(forbidden), false);
  }
});

test("P9 migration makes artifact, review, policy, and delivery receipts append-only", async () => {
  const migration = await readFile(
    new URL("../drizzle-postgres/0018_pale_big_bertha.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "artifact_objects",
    "reviews",
    "delivery_policies",
    "push_receipts",
    "landing_receipts",
    "delivery_operation_receipts",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER ${table}_append_only[\\s\\S]+?ON "${table}"`),
    );
  }
});
