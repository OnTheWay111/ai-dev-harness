import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { roleBindings } from "../db/postgres-schema.ts";

test("persists scoped, versioned, auditable RoleBindings", () => {
  const config = getTableConfig(roleBindings);
  assert.deepEqual(config.columns.map((column) => column.name), [
    "id",
    "organization_id",
    "project_id",
    "actor_id",
    "role",
    "assigned_by_actor_id",
    "reason",
    "request_id",
    "version",
    "revoked_at",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(
    config.foreignKeys.map((key) => key.getName()).sort(),
    ["role_bindings_organization_fk", "role_bindings_project_organization_fk"],
  );
  const indexes = config.indexes.map((index) => index.config.name);
  assert.ok(indexes.includes("role_bindings_active_organization_uidx"));
  assert.ok(indexes.includes("role_bindings_active_project_uidx"));
  assert.ok(indexes.includes("role_bindings_actor_scope_idx"));
  const checks = config.checks.map((check) => check.name);
  assert.ok(checks.includes("role_bindings_scope_chk"));
  assert.ok(checks.includes("role_bindings_identity_chk"));
  assert.ok(checks.includes("role_bindings_lifecycle_chk"));
});
