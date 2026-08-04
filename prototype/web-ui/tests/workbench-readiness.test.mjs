import assert from "node:assert/strict";
import test from "node:test";

import {
  checkWorkbenchReadiness,
} from "../app/workbench/server/workbench-readiness.ts";

const productionEnvironment = {
  NODE_ENV: "production",
  WORKBENCH_DATA_SOURCE: "postgres",
  WORKBENCH_SCOPE_ID: "production",
  DATABASE_URL: "postgresql://app:do-not-expose@example.test/workbench",
};

function repository(overrides = {}) {
  return {
    kind: "postgres",
    async getWorkbench() {
      return {
        data: {
          schemaVersion: "workbench.v1",
          revision: 1,
          generatedAt: "2026-08-04T00:00:00.000Z",
          summary: {},
          tasks: [],
        },
        page: { nextCursor: null, total: 0 },
      };
    },
    ...overrides,
  };
}

test("reports ready only after a PostgreSQL projection read succeeds", async () => {
  const result = await checkWorkbenchReadiness(
    productionEnvironment,
    () => repository(),
  );

  assert.deepEqual(result, {
    ready: true,
    source: "postgres",
    checks: { configuration: "pass", database: "pass" },
  });
});

test("fails readiness closed for an invalid deployed configuration", async () => {
  const result = await checkWorkbenchReadiness(
    {
      HARNESS_DEPLOYMENT_ENV: "staging",
      WORKBENCH_DATA_SOURCE: "demo",
      WORKBENCH_SCOPE_ID: "staging",
    },
    () => repository(),
  );

  assert.deepEqual(result, {
    ready: false,
    source: "unavailable",
    checks: { configuration: "fail", database: "skipped" },
  });
});

test("returns the same safe failure for connection and missing projection errors", async () => {
  const connectionFailure = await checkWorkbenchReadiness(
    productionEnvironment,
    () => repository({
      async getWorkbench() {
        throw new Error(
          "connection failed for postgresql://app:do-not-expose@example.test/workbench",
        );
      },
    }),
  );
  const missingProjection = await checkWorkbenchReadiness(
    productionEnvironment,
    () => repository({
      async getWorkbench() {
        throw new Error("Workbench snapshot is unavailable for production");
      },
    }),
  );

  const expected = {
    ready: false,
    source: "postgres",
    checks: { configuration: "pass", database: "fail" },
  };
  assert.deepEqual(connectionFailure, expected);
  assert.deepEqual(missingProjection, expected);
  assert.doesNotMatch(
    JSON.stringify([connectionFailure, missingProjection]),
    /do-not-expose|snapshot|postgres(?:ql)?:\/\//i,
  );
});

test("never treats a Demo repository as database readiness", async () => {
  const result = await checkWorkbenchReadiness(
    { WORKBENCH_DATA_SOURCE: "demo" },
    () => repository({ kind: "demo" }),
  );

  assert.deepEqual(result, {
    ready: false,
    source: "unavailable",
    checks: { configuration: "fail", database: "skipped" },
  });
});
