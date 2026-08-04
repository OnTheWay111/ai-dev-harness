import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  POSTGRES_ENVIRONMENTS,
  resolvePostgresConnection,
  resolveWorkbenchDeploymentConfig,
} from "../app/workbench/server/postgres-environment.ts";

const developmentAppUrl =
  "postgresql://ai_dev_harness_development_app_a@ep-example.neon.tech/ai_dev_harness_development?sslmode=require";
const developmentMigrationUrl =
  "postgresql://ai_dev_harness_development_migrator_b@ep-example.neon.tech/ai_dev_harness_development?sslmode=require";
const developmentEndpointId = "ep-example";

function readEnvironmentTemplate(environment, access) {
  const contents = readFileSync(
    new URL(
      `../config/environments/${environment}.${access}.env.example`,
      import.meta.url,
    ),
    "utf8",
  );
  const values = Object.fromEntries(
    contents
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return { contents, values };
}

test("maps development, test, and staging to isolated PostgreSQL resources", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(POSTGRES_ENVIRONMENTS).map(([environment, config]) => [
        environment,
        {
          instance: config.instance,
          database: config.database,
          appRole: config.roles.app,
          migratorRole: config.roles.migrator,
          appSecret: config.secrets.app,
          migratorSecret: config.secrets.migrator,
        },
      ]),
    ),
    {
      development: {
        instance: "ai-dev-harness-development",
        database: "ai_dev_harness_development",
        appRole: "ai_dev_harness_development_app",
        migratorRole: "ai_dev_harness_development_migrator",
        appSecret: "AI_DEV_HARNESS_DEVELOPMENT_DATABASE_URL",
        migratorSecret:
          "AI_DEV_HARNESS_DEVELOPMENT_MIGRATION_DATABASE_URL",
      },
      test: {
        instance: "ai-dev-harness-test",
        database: "ai_dev_harness_test",
        appRole: "ai_dev_harness_test_app",
        migratorRole: "ai_dev_harness_test_migrator",
        appSecret: "AI_DEV_HARNESS_TEST_DATABASE_URL",
        migratorSecret: "AI_DEV_HARNESS_TEST_MIGRATION_DATABASE_URL",
      },
      staging: {
        instance: "ai-dev-harness-staging",
        database: "ai_dev_harness_staging",
        appRole: "ai_dev_harness_staging_app",
        migratorRole: "ai_dev_harness_staging_migrator",
        appSecret: "AI_DEV_HARNESS_STAGING_DATABASE_URL",
        migratorSecret: "AI_DEV_HARNESS_STAGING_MIGRATION_DATABASE_URL",
      },
    },
  );
});

test("keeps every environment template credential-free and correctly mapped", () => {
  for (const environment of ["development", "test", "staging"]) {
    const app = readEnvironmentTemplate(environment, "app");
    assert.deepEqual(app.values, {
      HARNESS_DEPLOYMENT_ENV: environment,
      HARNESS_POSTGRES_ENDPOINT_ID: "",
      WORKBENCH_DATA_SOURCE: "postgres",
      WORKBENCH_SCOPE_ID: environment,
      DATABASE_URL: "",
    });

    const migration = readEnvironmentTemplate(environment, "migration");
    assert.deepEqual(migration.values, {
      HARNESS_DEPLOYMENT_ENV: environment,
      HARNESS_POSTGRES_ENDPOINT_ID: "",
      MIGRATION_DATABASE_URL: "",
    });

    assert.doesNotMatch(
      `${app.contents}\n${migration.contents}`,
      /(?:NEXT_PUBLIC_|postgres(?:ql)?:\/\/)/,
    );
  }
});

test("resolves the deployed workbench only from its injected app secret", () => {
  assert.deepEqual(
    resolveWorkbenchDeploymentConfig({
      HARNESS_DEPLOYMENT_ENV: "development",
      HARNESS_POSTGRES_ENDPOINT_ID: developmentEndpointId,
      WORKBENCH_DATA_SOURCE: "postgres",
      WORKBENCH_SCOPE_ID: "development",
      DATABASE_URL: developmentAppUrl,
    }),
    {
      mode: "postgres",
      databaseUrl: developmentAppUrl,
      scopeId: "development",
    },
  );
});

test("fails closed when a deployed environment is missing its app secret", () => {
  assert.throws(
    () =>
      resolveWorkbenchDeploymentConfig({
        HARNESS_DEPLOYMENT_ENV: "test",
        WORKBENCH_DATA_SOURCE: "postgres",
        WORKBENCH_SCOPE_ID: "test",
      }),
    /DATABASE_URL.*AI_DEV_HARNESS_TEST_DATABASE_URL/,
  );
});

test("rejects demo fallback and cross-environment scope mappings", () => {
  assert.throws(
    () =>
      resolveWorkbenchDeploymentConfig({
        HARNESS_DEPLOYMENT_ENV: "development",
        HARNESS_POSTGRES_ENDPOINT_ID: developmentEndpointId,
        WORKBENCH_DATA_SOURCE: "auto",
        WORKBENCH_SCOPE_ID: "development",
        DATABASE_URL: developmentAppUrl,
      }),
    /WORKBENCH_DATA_SOURCE=postgres/,
  );
  assert.throws(
    () =>
      resolveWorkbenchDeploymentConfig({
        HARNESS_DEPLOYMENT_ENV: "development",
        HARNESS_POSTGRES_ENDPOINT_ID: developmentEndpointId,
        WORKBENCH_DATA_SOURCE: "postgres",
        WORKBENCH_SCOPE_ID: "test",
        DATABASE_URL: developmentAppUrl,
      }),
    /WORKBENCH_SCOPE_ID=development/,
  );
});

test("rejects a URL for another environment without echoing connection details", () => {
  const mismatchedUrl =
    "postgresql://ai_dev_harness_test_app_a@ep-example.neon.tech/ai_dev_harness_test?sslmode=require";

  assert.throws(
    () =>
      resolvePostgresConnection(
        {
          HARNESS_DEPLOYMENT_ENV: "development",
          HARNESS_POSTGRES_ENDPOINT_ID: developmentEndpointId,
          DATABASE_URL: mismatchedUrl,
        },
        "app",
      ),
    (error) => {
      assert.match(error.message, /development database/);
      assert.doesNotMatch(error.message, /ep-example/);
      return true;
    },
  );
});

test("rejects a Secret URL for a different Neon endpoint", () => {
  assert.throws(
    () =>
      resolvePostgresConnection(
        {
          HARNESS_DEPLOYMENT_ENV: "development",
          HARNESS_POSTGRES_ENDPOINT_ID: "ep-development-example",
          DATABASE_URL: developmentAppUrl,
        },
        "app",
      ),
    (error) => {
      assert.match(error.message, /Neon endpoint/);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//);
      return true;
    },
  );
});

test("accepts the configured endpoint through a Neon pooled hostname", () => {
  const pooledUrl = developmentAppUrl.replace(
    "@ep-example.neon.tech",
    "@ep-example-pooler.us-east-2.aws.neon.tech",
  );
  const connection = resolvePostgresConnection(
    {
      HARNESS_DEPLOYMENT_ENV: "development",
      HARNESS_POSTGRES_ENDPOINT_ID: developmentEndpointId,
      DATABASE_URL: pooledUrl,
    },
    "app",
  );

  assert.equal(connection.endpointId, developmentEndpointId);
});

test("fails closed when the Neon endpoint identity is missing", () => {
  assert.throws(
    () =>
      resolvePostgresConnection(
        {
          HARNESS_DEPLOYMENT_ENV: "development",
          DATABASE_URL: developmentAppUrl,
        },
        "app",
      ),
    /HARNESS_POSTGRES_ENDPOINT_ID.*development/,
  );
});

test("uses a separate migrator secret and accepts only the A/B migrator roles", () => {
  const connection = resolvePostgresConnection(
    {
      HARNESS_DEPLOYMENT_ENV: "development",
      HARNESS_POSTGRES_ENDPOINT_ID: developmentEndpointId,
      MIGRATION_DATABASE_URL: developmentMigrationUrl,
    },
    "migrator",
  );

  assert.equal(connection.database, "ai_dev_harness_development");
  assert.equal(
    connection.loginRole,
    "ai_dev_harness_development_migrator_b",
  );
  assert.equal(
    connection.capabilityRole,
    "ai_dev_harness_development_migrator",
  );
});

test("rejects unknown deployment environments", () => {
  assert.throws(
    () =>
      resolvePostgresConnection(
        {
          HARNESS_DEPLOYMENT_ENV: "production",
          DATABASE_URL: developmentAppUrl,
        },
        "app",
      ),
    /development, test, or staging/,
  );
});

test("treats an explicitly empty deployment environment as invalid", () => {
  assert.throws(
    () =>
      resolveWorkbenchDeploymentConfig({
        HARNESS_DEPLOYMENT_ENV: "   ",
        WORKBENCH_DATA_SOURCE: "auto",
      }),
    /HARNESS_DEPLOYMENT_ENV is required/,
  );
});
