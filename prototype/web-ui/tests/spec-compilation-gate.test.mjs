import assert from "node:assert/strict";
import test from "node:test";

import { VersionConflictError } from "../app/control-plane/domain/errors.ts";
import {
  requireCompilableSpecRevision,
  SpecCompilationGateError,
} from "../app/control-plane/domain/spec-compilation-gate.ts";

function revision(overrides = {}) {
  return {
    id: "spec-1",
    organizationId: "org-1",
    projectId: "project-1",
    goalId: "goal-1",
    revision: 1,
    previousRevisionId: null,
    status: "approved",
    sourceGoalVersion: 2,
    artifactRef: "artifact://spec-1",
    artifactDigest: "a".repeat(64),
    artifactMediaType: "application/json",
    artifactSizeBytes: 1,
    plannerRunId: "planner-1",
    plannerConfiguration: {
      adapter: "fixture",
      modelProfile: "deterministic",
      schemaVersion: "spec-bundle.v1",
    },
    overdesignPolicyRevision: "overdesign-policy.v1",
    overdesignReview: {
      policyRevision: "overdesign-policy.v1",
      items: [],
      counts: { Required: 0, Helpful: 0, Speculative: 0 },
    },
    generatedAt: "2026-08-04T00:00:00.000Z",
    version: 3,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("passes only the latest approved revision at the expected version", () => {
  const current = revision();
  assert.equal(requireCompilableSpecRevision({
    candidate: current,
    latest: current,
    expectedVersion: 3,
  }), current);
});

test("fails closed for unapproved, superseded, or version-stale revisions", () => {
  assert.throws(() => requireCompilableSpecRevision({
    candidate: revision({ status: "in_review" }),
    latest: revision({ status: "in_review" }),
    expectedVersion: 3,
  }), SpecCompilationGateError);
  assert.throws(() => requireCompilableSpecRevision({
    candidate: revision(),
    latest: revision({ id: "spec-2", revision: 2 }),
    expectedVersion: 3,
  }), VersionConflictError);
  assert.throws(() => requireCompilableSpecRevision({
    candidate: revision({ version: 2 }),
    latest: revision(),
    expectedVersion: 2,
  }), VersionConflictError);
});
