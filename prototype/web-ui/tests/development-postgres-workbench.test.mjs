import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  validateDevelopmentPostgresEvidence,
} from "../scripts/development-postgres-workbench.ts";

function validEvidence() {
  return {
    source: "postgres",
    revision: 103,
    ssrRevision: 103,
    taskCounts: {
      waiting: 3,
      blocked: 2,
      review: 1,
      running: 1,
      attention: 4,
      all: 7,
    },
    attentionPageSizes: [2, 2],
    attentionTotal: 4,
    goalTotal: 4,
    runningTotal: 1,
    etagReturned: true,
    notModifiedStatus: 304,
    readinessStatus: 200,
    readinessSource: "postgres",
    readinessConfiguration: "pass",
    readinessDatabase: "pass",
    cleanupSnapshotCount: 0,
    cleanupTaskCount: 0,
  };
}

test("accepts complete SSR and PostgreSQL API verification evidence", () => {
  assert.doesNotThrow(() =>
    validateDevelopmentPostgresEvidence(validEvidence()),
  );
});

test("rejects source, revision, pagination, cache, or cleanup drift", () => {
  for (const change of [
    { source: "demo" },
    { ssrRevision: 102 },
    { attentionPageSizes: [2, 1] },
    { notModifiedStatus: 200 },
    { readinessDatabase: "fail" },
    { cleanupTaskCount: 1 },
  ]) {
    assert.throws(
      () =>
        validateDevelopmentPostgresEvidence({
          ...validEvidence(),
          ...change,
        }),
      /P1-0[35]/,
    );
  }
});

test("live verification fails closed without the app Secret", () => {
  const environment = { ...process.env };
  delete environment.HARNESS_DEPLOYMENT_ENV;
  delete environment.HARNESS_POSTGRES_ENDPOINT_ID;
  delete environment.DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL(
        "../scripts/verify-development-postgres-workbench.ts",
        import.meta.url,
      ).pathname,
    ],
    { encoding: "utf8", env: environment },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /P1-03 verification failed/);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /postgres(?:ql)?:\/\//,
  );
});
