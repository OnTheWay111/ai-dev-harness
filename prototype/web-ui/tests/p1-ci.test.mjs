import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  compareMigrationTrees,
} from "../scripts/check-postgres-migration-drift.ts";
import {
  scanClientArtifacts,
} from "../scripts/check-client-secret-leaks.ts";

const projectDirectory = new URL("..", import.meta.url);
const repositoryDirectory = new URL("../../../", import.meta.url);

test("P1 workflow is valid, least-privilege, and runs the complete gate", () => {
  const workflowText = readFileSync(
    new URL(".github/workflows/p1-postgres.yml", repositoryDirectory),
    "utf8",
  );
  const document = parseDocument(workflowText);
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);

  const job = workflow.jobs["p1-postgres"];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.match(job.services.postgres.image, /^postgres:16(?:\b|\.)/);
  assert.match(job.services.postgres.options, /pg_isready/);
  assert.equal(job.services.postgres.env.POSTGRES_HOST_AUTH_METHOD, "trust");
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  const adminUrl = new URL(job.env.POSTGRES_TEST_ADMIN_URL);
  assert.equal(adminUrl.hostname, "127.0.0.1");
  assert.equal(adminUrl.password, "");

  assert.ok(job.steps.some((step) => step.uses === "actions/checkout@v6"));
  assert.ok(job.steps.some((step) => step.uses === "actions/setup-node@v6"));
  assert.ok(
    job.steps.some(
      (step) =>
        step.run === "npm run ci:p1" &&
        step["working-directory"] === "prototype/web-ui",
    ),
  );
});

test("package exposes one local command for the same P1 gate", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("package.json", projectDirectory), "utf8"),
  );
  assert.match(packageJson.scripts["db:check:drift"], /migration-drift/);
  assert.match(packageJson.scripts["scan:client-secrets"], /secret-leaks/);
  for (const required of [
    "db:check:drift",
    "test:postgres:integration",
    "test",
    "typecheck",
    "lint",
    "scan:client-secrets",
  ]) {
    assert.match(packageJson.scripts["ci:p1"], new RegExp(`npm run ${required}`));
  }
  assert.ok(packageJson.devDependencies.yaml);
});

test("migration tree comparison reports only changed relative paths", () => {
  assert.deepEqual(
    compareMigrationTrees(
      new Map([["0000.sql", "hash-a"]]),
      new Map([["0000.sql", "hash-a"]]),
    ),
    [],
  );
  assert.deepEqual(
    compareMigrationTrees(
      new Map([["0000.sql", "hash-a"], ["removed.json", "hash-b"]]),
      new Map([["0000.sql", "hash-c"], ["added.json", "hash-d"]]),
    ),
    ["added.json", "0000.sql", "removed.json"],
  );
});

test("committed PostgreSQL migrations have no generated drift", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL(
        "../scripts/check-postgres-migration-drift.ts",
        import.meta.url,
      ).pathname,
    ],
    { cwd: projectDirectory, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no drift/i);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /postgres(?:ql)?:\/\/|DATABASE_URL=/i,
  );
});

test("client artifact scan blocks connection, Secret, and server-driver markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p1-client-scan-"));
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "assets", "clean.js"), "console.log('client')");
    assert.deepEqual(await scanClientArtifacts(directory), {
      filesScanned: 1,
      leaks: [],
    });

    for (const [contents, label] of [
      ["postgresql://app:password@example.test/db", "database connection URL"],
      ["AI_DEV_HARNESS_STAGING_DATABASE_URL", "database Secret name"],
      ["@neondatabase/serverless", "server database driver"],
      ["pg-protocol", "server database driver"],
      ["OIDC_COOKIE_SECRET", "OIDC server Secret name"],
      ["AUTODEV_QUEUE_IMPORT_TOKEN", "AutoDev server Secret name"],
      ["refresh_token", "OIDC token material"],
    ]) {
      await writeFile(join(directory, "assets", "unsafe.js"), contents);
      const result = await scanClientArtifacts(directory);
      assert.deepEqual(
        result.leaks.map((leak) => leak.label),
        [label],
      );
      assert.equal(result.leaks[0].path, "assets/unsafe.js");
      assert.doesNotMatch(JSON.stringify(result.leaks), /password@example/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("client artifact command fails closed when the build is absent", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL(
        "../scripts/check-client-secret-leaks.ts",
        import.meta.url,
      ).pathname,
      join(tmpdir(), `missing-p1-client-${process.pid}`),
    ],
    { cwd: projectDirectory, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contents.*suppressed/i);
  assert.doesNotMatch(result.stderr, /missing-p1-client/);
});

test("the production client build contains no database material", async () => {
  const result = await scanClientArtifacts(
    new URL("../dist/client", import.meta.url),
  );
  assert.ok(result.filesScanned > 0);
  assert.deepEqual(result.leaks, []);
});
