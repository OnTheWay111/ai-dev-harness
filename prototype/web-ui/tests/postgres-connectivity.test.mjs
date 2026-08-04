import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertPostgresConnectivity,
} from "../app/workbench/server/postgres-connectivity.ts";

const appConnection = {
  environment: "test",
  access: "app",
  databaseUrl: "redacted",
  endpointId: "ep-test-example",
  database: "ai_dev_harness_test",
  loginRole: "ai_dev_harness_test_app_a",
  capabilityRole: "ai_dev_harness_test_app",
  secretName: "AI_DEV_HARNESS_TEST_DATABASE_URL",
  injectedVariable: "DATABASE_URL",
};

test("accepts the least-privilege app role mapping", () => {
  assert.doesNotThrow(() =>
    assertPostgresConnectivity(appConnection, {
      database: "ai_dev_harness_test",
      role: "ai_dev_harness_test_app_a",
      capabilityRoleMember: true,
      canConnect: true,
      canCreateInDatabase: false,
      canUsePublicSchema: true,
      canCreateInPublicSchema: false,
    }),
  );
});

test("fails when an app role can create schema objects", () => {
  assert.throws(
    () =>
      assertPostgresConnectivity(appConnection, {
        database: "ai_dev_harness_test",
        role: "ai_dev_harness_test_app_a",
        capabilityRoleMember: true,
        canConnect: true,
        canCreateInDatabase: false,
        canUsePublicSchema: true,
        canCreateInPublicSchema: true,
      }),
    /must not have CREATE/,
  );
});

test("requires the migrator role to create schema objects", () => {
  assert.throws(
    () =>
      assertPostgresConnectivity(
        {
          ...appConnection,
          access: "migrator",
          loginRole: "ai_dev_harness_test_migrator_b",
          capabilityRole: "ai_dev_harness_test_migrator",
          secretName: "AI_DEV_HARNESS_TEST_MIGRATION_DATABASE_URL",
          injectedVariable: "MIGRATION_DATABASE_URL",
        },
        {
          database: "ai_dev_harness_test",
          role: "ai_dev_harness_test_migrator_b",
          capabilityRoleMember: true,
          canConnect: true,
          canCreateInDatabase: false,
          canUsePublicSchema: true,
          canCreateInPublicSchema: false,
        },
      ),
    /requires CREATE/,
  );
});

test("fails on database, login role, or capability-role mismatches", () => {
  const baseline = {
    database: "ai_dev_harness_test",
    role: "ai_dev_harness_test_app_a",
    capabilityRoleMember: true,
    canConnect: true,
    canCreateInDatabase: false,
    canUsePublicSchema: true,
    canCreateInPublicSchema: false,
  };

  assert.throws(
    () =>
      assertPostgresConnectivity(appConnection, {
        ...baseline,
        database: "ai_dev_harness_development",
      }),
    /database mapping mismatch/,
  );
  assert.throws(
    () =>
      assertPostgresConnectivity(appConnection, {
        ...baseline,
        role: "ai_dev_harness_test_app_b",
      }),
    /login role mapping mismatch/,
  );
  assert.throws(
    () =>
      assertPostgresConnectivity(appConnection, {
        ...baseline,
        capabilityRoleMember: false,
      }),
    /capability role/,
  );
});

test("rejects database CREATE for both app and migrator credentials", () => {
  assert.throws(
    () =>
      assertPostgresConnectivity(appConnection, {
        database: "ai_dev_harness_test",
        role: "ai_dev_harness_test_app_a",
        capabilityRoleMember: true,
        canConnect: true,
        canCreateInDatabase: true,
        canUsePublicSchema: true,
        canCreateInPublicSchema: false,
      }),
    /must not have database CREATE/,
  );
});

test("the executable check fails closed without printing a connection URL", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/check-postgres-connectivity.ts",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HARNESS_DEPLOYMENT_ENV: "test",
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /DATABASE_URL.*AI_DEV_HARNESS_TEST_DATABASE_URL/,
  );
  assert.doesNotMatch(result.stderr, /postgres(?:ql)?:\/\//);
});
