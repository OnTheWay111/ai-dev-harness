import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRouteAvailable,
  recommendModelRoute,
  withModelRouteOverride,
  ModelRouteUnavailableError,
  modelRouterPolicyRevision,
} from "../app/control-plane/domain/model-router.ts";

function issue(overrides = {}) {
  return {
    key: "DEV-01",
    title: "Implement control plane",
    goal: "Ship safely",
    requirementRefs: ["REQ-01"],
    acceptance: [{ criterionRef: "AC-01", statement: "works" }],
    nonGoals: ["No rewrites"],
    dependencyCandidates: [],
    expectedFiles: ["app/domain.ts"],
    conflictResources: {
      directories: [], publicInterfaces: [], databaseObjects: [],
      sharedConfigurations: [], landingOrder: [],
    },
    developmentPrompt: "Goal Ship safely REQ-01 AC-01 No rewrites app/domain.ts npm test completion evidence",
    verify: ["npm test"],
    completionEvidence: [{ kind: "test", description: "test", required: true }],
    ...overrides,
  };
}

test("P6-04 emits only capability tier and reasoning effort with auditable factors", () => {
  const recommendation = recommendModelRoute(issue());
  assert.equal(recommendation.policyRevision, modelRouterPolicyRevision);
  assert.equal(recommendation.capabilityTier, "cost_optimized");
  assert.equal(recommendation.reasoningEffort, "low");
  assert.equal(recommendation.override, null);
  assert.ok(recommendation.reasons.length > 0);
  assert.equal(JSON.stringify(recommendation).includes("gpt-"), false);
});

test("P6-04 routes risky broad migrations to frontier/highest", () => {
  const recommendation = recommendModelRoute(issue({
    title: "Migrate authorization and credentials",
    expectedFiles: Array.from({ length: 13 }, (_, index) => `app/file-${index}.ts`),
    requirementRefs: ["REQ-01", "REQ-02", "REQ-03", "REQ-04"],
    acceptance: Array.from({ length: 5 }, (_, index) => ({
      criterionRef: `AC-0${index + 1}`,
      statement: "verified",
    })),
    verify: ["npm test", "npm run typecheck", "npm run lint", "npm run test:integration"],
    conflictResources: {
      directories: ["db/migrations/"],
      publicInterfaces: ["auth.v1"],
      databaseObjects: ["public.role_bindings"],
      sharedConfigurations: ["security-policy"],
      landingOrder: ["migration-first"],
    },
  }));
  assert.equal(recommendation.factors.risk, "high");
  assert.equal(recommendation.factors.codeScope, "extensive");
  assert.equal(recommendation.capabilityTier, "frontier");
  assert.equal(recommendation.reasoningEffort, "highest");
});

test("P6-04 blocks high-risk silent downgrade and records valid human overrides", () => {
  const required = recommendModelRoute(issue({
    title: "Security database migration",
    expectedFiles: Array.from({ length: 13 }, (_, index) => `app/file-${index}.ts`),
    conflictResources: {
      directories: ["db/migrations/"], publicInterfaces: ["auth.v1"],
      databaseObjects: ["public.users"], sharedConfigurations: ["security"],
      landingOrder: ["migration-first"],
    },
  }));
  assert.throws(
    () => assertRouteAvailable(required, {
      capabilityTiers: ["cost_optimized", "general_coding", "advanced_coding"],
      reasoningEfforts: ["low", "medium", "high"],
    }),
    ModelRouteUnavailableError,
  );
  assert.throws(
    () => withModelRouteOverride(required, {
      capabilityTier: "general_coding",
      reasoningEffort: "medium",
      actorId: "approver-1",
      reason: "",
      overriddenAt: "2026-08-04T00:00:00.000Z",
    }),
    /reason/i,
  );
  const overridden = withModelRouteOverride(recommendModelRoute(issue()), {
    capabilityTier: "general_coding",
    reasoningEffort: "medium",
    actorId: "approver-1",
    reason: "Use the organization standard coding tier",
    overriddenAt: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(overridden.override.actorId, "approver-1");
  assert.equal(overridden.capabilityTier, "general_coding");
});
