import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P12 release center has durable Canary, gate, signature, and audit schema", async () => {
  const [schema, migration, roleMigration] = await Promise.all([
    readFile(new URL("../db/postgres-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle-postgres/0020_wild_matthew_murdock.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle-postgres/0021_lively_spacker_dave.sql", import.meta.url), "utf8"),
  ]);
  for (const table of [
    "release_canaries",
    "release_canary_windows",
    "release_canary_events",
    "production_releases",
    "production_gate_checks",
    "production_release_signatures",
  ]) assert.match(schema, new RegExp(`\"${table}\"`), table);
  assert.match(schema, /production_release_signatures_release_role_uidx/);
  assert.match(schema, /production_release_signatures_release_signer_uidx/);
  assert.match(schema, /release_canary_windows_attempt_sequence_uidx/);
  assert.match(schema, /attestation_digest/);
  assert.match(schema, /audit_receipt_id/);
  assert.match(migration, /release_canary_windows_append_only/);
  assert.match(migration, /production_release_signatures_append_only/);
  assert.match(migration, /production_gate_checks_lock_after_evaluation/);
  assert.match(roleMigration, /owner_role" IN \('owner'/);
  assert.match(roleMigration, /"role" IN \('owner'/);
});
