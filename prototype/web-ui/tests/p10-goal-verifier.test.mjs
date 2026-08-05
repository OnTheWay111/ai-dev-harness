import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";

import { MemoryGoalVerificationRepository } from
  "../app/control-plane/adapters/memory-goal-verification-repository.ts";
import { GoalVerificationService } from
  "../app/control-plane/application/goal-verification-service.ts";
import {
  GoalVerifierContractError,
  goalVerifierOutputSchemaVersion,
} from "../app/control-plane/domain/goal-verification.ts";
import { CodexGoalVerifierAdapter } from
  "../app/control-plane/adapters/codex-goal-verifier-adapter.ts";

const ids = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  issuePlanId: "00000000-0000-4000-8000-000000000004",
  planId: "00000000-0000-4000-8000-000000000005",
  criterionId: "00000000-0000-4000-8000-000000000006",
};
const plan = {
  schemaVersion: "acceptance-verification-plan.v1",
  id: ids.planId,
  ...ids,
  goalVersion: 8,
  issuePlanVersion: 2,
  revision: 1,
  previousPlanId: null,
  entries: [{
    id: "verify-ac-1",
    criterionRef: ids.criterionId,
    environment: "test",
    strategy: { type: "command", reference: "command:test:p10" },
    successCondition: "The approved P10 command exits with code 0.",
    timeoutMs: 60000,
    responsibleParty: "quality-engineering",
  }],
  compilation: { valid: true, coveredCriterionRefs: [ids.criterionId] },
  digest: "a".repeat(64),
  compiledAt: "2026-08-05T08:00:00.000Z",
  version: 1,
};
const goal = {
  id: ids.goalId,
  organizationId: ids.organizationId,
  projectId: ids.projectId,
  title: "Ship P10",
  problemStatement: "Issue completion does not prove the Goal.",
  desiredOutcome: "Every Goal criterion is independently verified.",
  acceptanceCriteria: [{ id: ids.criterionId, position: 1, statement: "P10 tests pass.", version: 1 }],
  nonGoals: ["Do not deploy production."],
  constraints: ["Verifier is read-only."],
  status: "verifying",
  version: 8,
  createdAt: "2026-08-05T07:00:00.000Z",
  updatedAt: "2026-08-05T08:00:00.000Z",
};

function verifierOutput(overrides = {}) {
  return {
    schemaVersion: goalVerifierOutputSchemaVersion,
    overallVerdict: "passed",
    criteria: [{
      criterionRef: ids.criterionId,
      verdict: "passed",
      evidenceRefs: ["artifact:test:p10"],
      rationale: "The deterministic command passed and emitted immutable evidence.",
    }],
    nonGoals: [{ statement: goal.nonGoals[0], verdict: "preserved", rationale: "No production deployment occurred." }],
    constraints: [{ statement: goal.constraints[0], verdict: "satisfied", rationale: "The session had read-only access." }],
    regressionRisks: [{ severity: "low", description: "No material regression risk detected.", evidenceRefs: ["artifact:test:p10"] }],
    ...overrides,
  };
}

test("P10-02 runs deterministic checks before a fresh read-only independent Verifier session", async () => {
  const calls = [];
  const repository = new MemoryGoalVerificationRepository({ plans: [plan] });
  const service = new GoalVerificationService({
    repository,
    goals: { async get() { return goal; } },
    deterministicVerifier: {
      async run(entry) {
        calls.push(["deterministic", entry.id]);
        return { status: "passed", evidenceRefs: ["artifact:test:p10"], summary: "exit code 0", durationMs: 12 };
      },
    },
    verifier: {
      async verify(request) {
        calls.push(["verifier", request.session.id]);
        assert.equal(request.session.fresh, true);
        assert.equal(request.session.access, "read_only");
        assert.equal(request.session.canModifyCode, false);
        assert.notEqual(request.verifierIdentity, request.builderIdentities[0]);
        return verifierOutput();
      },
    },
    issuePlans: { async getLatest() { return { id: ids.issuePlanId, status: "approved" }; } },
    authorizer: { async authorize(input) { assert.equal(input.permission, "goal.verify"); } },
    builderIdentitySource: { async list() { return ["builder-session-1"]; } },
    verifierIdentity: "goal-verifier-session",
    verifierVersion: "goal-verifier.v1",
    clock: () => new Date("2026-08-05T09:00:00.000Z"),
    idGenerator: () => "00000000-0000-4000-8000-000000000007",
  });
  const result = await service.verify({
    ...ids,
    actorId: "operator-1",
    expectedGoalVersion: 8,
  });
  assert.deepEqual(calls.map(([kind]) => kind), ["deterministic", "verifier"]);
  assert.equal(result.verdict, "passed");
  assert.equal(result.verifierOutput.criteria[0].verdict, "passed");
  assert.equal((await repository.listVerifications(ids)).length, 1);
});

test("P10-02 fails closed on invalid output, missing evidence, and timeouts", async () => {
  for (const scenario of ["invalid", "missing", "timeout"]) {
    const repository = new MemoryGoalVerificationRepository({ plans: [plan] });
    const service = new GoalVerificationService({
      repository,
      goals: { async get() { return goal; } },
      deterministicVerifier: {
        async run() {
          return scenario === "missing"
            ? { status: "failed", evidenceRefs: [], summary: "evidence missing", durationMs: 1 }
            : { status: "passed", evidenceRefs: ["artifact:test:p10"], summary: "passed", durationMs: 1 };
        },
      },
      verifier: {
        async verify() {
          if (scenario === "timeout") return await new Promise(() => {});
          return scenario === "invalid"
            ? verifierOutput({ criteria: [] })
            : scenario === "missing"
            ? verifierOutput({
                overallVerdict: "failed",
                criteria: [{
                  criterionRef: ids.criterionId,
                  verdict: "failed",
                  evidenceRefs: [],
                  rationale: "The required deterministic evidence is missing.",
                }],
              })
            : verifierOutput({ overallVerdict: "passed" });
        },
      },
      issuePlans: { async getLatest() { return { id: ids.issuePlanId, status: "approved" }; } },
      authorizer: { async authorize() {} },
      builderIdentitySource: { async list() { return ["builder-session-1"]; } },
      verifierIdentity: "goal-verifier-session",
      verifierVersion: "goal-verifier.v1",
      verifierTimeoutMs: 5,
    });
    if (scenario === "missing") {
      const result = await service.verify({ ...ids, actorId: "operator", expectedGoalVersion: 8 });
      assert.equal(result.verdict, "failed");
      assert.equal(result.deterministicResults[0].status, "failed");
    } else {
      await assert.rejects(
        () => service.verify({ ...ids, actorId: "operator", expectedGoalVersion: 8 }),
        GoalVerifierContractError,
      );
      assert.equal((await repository.listVerifications(ids)).length, 0);
    }
  }
});

test("P10-02 Codex adapter starts an ephemeral read-only controlled Verifier process", async () => {
  let processRequest;
  const adapter = new CodexGoalVerifierAdapter({
    command: "controlled-codex",
    runner: async (request) => {
      processRequest = request;
      await writeFile(request.outputPath, JSON.stringify(verifierOutput()));
      return {
        exitCode: 0,
        timedOut: false,
        stdoutBytes: 0,
        stderrBytes: 0,
      };
    },
  });
  const output = await adapter.verify({
    goal,
    plan,
    deterministicResults: [{
      entryId: "verify-ac-1",
      criterionRef: ids.criterionId,
      status: "passed",
      evidenceRefs: ["artifact:test:p10"],
      summary: "passed",
      durationMs: 1,
    }],
    verifierIdentity: "goal-verifier-session",
    builderIdentities: ["builder-session-1"],
    session: {
      id: "fresh-session-1",
      fresh: true,
      access: "read_only",
      canModifyCode: false,
    },
  });
  assert.equal(output.schemaVersion, goalVerifierOutputSchemaVersion);
  assert.equal(processRequest.command, "controlled-codex");
  assert.ok(processRequest.args.includes("--ephemeral"));
  assert.deepEqual(
    processRequest.args.slice(
      processRequest.args.indexOf("--sandbox"),
      processRequest.args.indexOf("--sandbox") + 2,
    ),
    ["--sandbox", "read-only"],
  );
  assert.match(processRequest.stdin, /cannot modify code/i);
});
