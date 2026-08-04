import assert from "node:assert/strict";
import test from "node:test";

import {
  readWorkbenchRepositoryConfig,
  selectWorkbenchDataSource,
} from "../app/workbench/server/workbench-repository-factory.ts";

test("selects PostgreSQL when DATABASE_URL is available in auto mode", () => {
  assert.equal(
    selectWorkbenchDataSource({
      mode: "auto",
      databaseUrl: "postgresql://example.test/workbench",
    }),
    "postgres",
  );
});

test("uses the demo repository locally when no database is configured", () => {
  assert.equal(
    selectWorkbenchDataSource({ mode: "auto" }),
    "demo",
  );
  assert.equal(
    selectWorkbenchDataSource({ mode: "demo" }),
    "demo",
  );
});

test("fails closed when PostgreSQL is required but DATABASE_URL is missing", () => {
  assert.throws(
    () => selectWorkbenchDataSource({ mode: "postgres" }),
    /DATABASE_URL/,
  );
});

test("keeps local auto/demo behavior when no deployment environment is set", () => {
  assert.deepEqual(
    readWorkbenchRepositoryConfig({
      WORKBENCH_DATA_SOURCE: "auto",
      WORKBENCH_SCOPE_ID: "local",
    }),
    { mode: "auto", databaseUrl: undefined, scopeId: "local" },
  );
});
