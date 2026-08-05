import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OidcService } from "../app/auth/oidc-service.ts";
import { validateGoalVerifierOutput } from
  "../app/control-plane/domain/goal-verification.ts";
import { validatePlannerClarificationOutput } from
  "../app/control-plane/domain/planner-clarification-schema.ts";
import {
  createP12ContractEnvironment,
} from "../app/control-plane/testing/p12-contract-environment.ts";

const fixture = JSON.parse(await readFile(new URL(
  "./fixtures/p12/recorded-contracts.v1.json",
  import.meta.url,
), "utf8"));
const cleanups = [];

async function contractEnvironment() {
  const environment = await createP12ContractEnvironment(fixture);
  cleanups.push(() => environment.cleanup());
  return environment;
}

test.after(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

function goal() {
  return {
    id: fixture.fixed.goalId,
    organizationId: fixture.fixed.organizationId,
    projectId: fixture.fixed.projectId,
    title: "Release P12",
    problemStatement: "The complete delivery path needs production evidence.",
    desiredOutcome: "Every release gate is independently verifiable.",
    acceptanceCriteria: [{
      id: "00000000-0000-4000-8000-000000000031",
      position: 1,
      statement: "The deterministic release gate passes.",
      version: 1,
    }],
    nonGoals: ["Public multi-tenant launch"],
    constraints: ["No production credentials"],
    status: "verifying",
    version: 7,
    previousVersionId: null,
    createdAt: fixture.fixed.now,
    updatedAt: fixture.fixed.now,
  };
}

test("P12 fakes replay versioned recorded fixtures through production contracts", async () => {
  const environment = await contractEnvironment();
  const planned = await environment.codex.plan({
    goal: goal(),
    outputSchema: {},
    purpose: "clarification",
  });
  assert.deepEqual(
    validatePlannerClarificationOutput(planned.output),
    fixture.codex.plannerOutput,
  );

  const verified = await environment.codex.verify({
    goal: goal(),
    plan: {},
    deterministicResults: [],
    verifierIdentity: "p12-verifier",
    builderIdentities: ["p12-builder"],
    session: {
      id: "p12-verifier-session",
      fresh: true,
      access: "read_only",
      canModifyCode: false,
    },
  });
  assert.deepEqual(validateGoalVerifierOutput(verified, goal()), fixture.codex.verifierOutput);

  const status = await environment.autodev.start({
    externalTaskId: fixture.fixed.issueId,
    externalRunId: "p12-run-1",
    selectedSecrets: [],
    timeoutMs: 10_000,
  });
  assert.equal(status.state, "running");
  assert.deepEqual(
    environment.autodev.events("p12-run-1").map((event) => event.sequence),
    [1, 2],
  );

  const first = await environment.objectStore.putText();
  const replay = await environment.objectStore.putText();
  assert.equal(first.deduplicated, false);
  assert.equal(replay.deduplicated, true);
  assert.equal(await environment.objectStore.readText(first.objectKey), fixture.objectStore.content);

  const oidc = new OidcService({
    config: environment.oidc.config,
    fetch: environment.oidc.fetch,
    clock: environment.clock,
  });
  const started = await oidc.begin("/");
  environment.oidc.authorize(started.authorizationUrl);
  const completed = await oidc.complete({
    code: "p12-code",
    state: new URL(started.authorizationUrl).searchParams.get("state"),
    transactionCookie: started.transactionCookie,
  });
  assert.equal((await oidc.readSession(completed.sessionCookie))?.subject, fixture.oidc.subject);
});

test("P12 fakes program timeout, invalid output, duplicates, disorder, and partial failure", async () => {
  const environment = await contractEnvironment();
  environment.scenarios.enqueue("codex.plan", "timeout");
  await assert.rejects(
    () => environment.codex.plan({ goal: goal(), outputSchema: {} }),
    (error) => error.code === "planner_timeout",
  );

  environment.scenarios.enqueue("codex.plan", "invalid_output");
  const malformed = await environment.codex.plan({ goal: goal(), outputSchema: {} });
  assert.throws(() => validatePlannerClarificationOutput(malformed.output));

  environment.scenarios.enqueue("autodev.events", "duplicate");
  assert.deepEqual(
    environment.autodev.events("p12-run-1").map((event) => event.sequence),
    [1, 1, 2],
  );
  environment.scenarios.enqueue("autodev.events", "out_of_order");
  assert.deepEqual(
    environment.autodev.events("p12-run-1").map((event) => event.sequence),
    [2, 1],
  );

  environment.scenarios.enqueue("git.openPullRequest", "partial_failure");
  await environment.git.pushBranch({ operationKey: "push-1" });
  await assert.rejects(
    () => environment.git.openPullRequest({ operationKey: "pr-1" }),
    /partial failure/i,
  );
  assert.equal(environment.git.effects.filter((effect) => effect === "push:push-1").length, 1);
});

test("P12 fake and production adapters satisfy the same gateway contract", async () => {
  const environment = await contractEnvironment();
  await environment.assertGatewayContract(environment.autodev);
  await environment.assertGatewayContract(environment.productionAdapters.autodev);
  await environment.assertObjectStoreContract(environment.objectStore);
  await environment.assertObjectStoreContract(environment.productionAdapters.objectStore);

  for (const codex of [environment.codex, environment.productionAdapters.codex]) {
    const planned = await codex.plan({
      goal: goal(),
      outputSchema: {},
      purpose: "clarification",
    });
    assert.deepEqual(
      validatePlannerClarificationOutput(planned.output),
      fixture.codex.plannerOutput,
    );
    const verified = await codex.verify({
      goal: goal(),
      plan: {},
      deterministicResults: [],
      verifierIdentity: "p12-independent-verifier",
      builderIdentities: ["p12-builder"],
      session: {
        id: "p12-contract-session",
        fresh: true,
        access: "read_only",
        canModifyCode: false,
      },
    });
    assert.deepEqual(
      validateGoalVerifierOutput(verified, goal()),
      fixture.codex.verifierOutput,
    );
  }

  for (const [index, git] of [
    environment.git,
    environment.productionAdapters.git,
  ].entries()) {
    const operation = `p12-shared-git-${index}`;
    const credential = {
      token: "p12-synthetic-credential",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["contents:write", "pull_requests:write"],
      async release() {},
    };
    const committed = await git.createCommit({
      operationKey: `${operation}-commit`,
      worktreePath: "/tmp/p12-contract-worktree",
      branch: fixture.git.push.remoteBranch,
      baselineSha: "a".repeat(40),
      message: fixture.git.commit.summary,
    });
    assert.match(committed.commitSha, /^[0-9a-f]{40}$/);
    const pushed = await git.pushBranch({
      operationKey: `${operation}-push`,
      worktreePath: "/tmp/p12-contract-worktree",
      branch: fixture.git.push.remoteBranch,
      commitSha: committed.commitSha,
      credential,
    });
    assert.equal(pushed.commitSha, committed.commitSha);
    const pullRequest = await git.openPullRequest({
      operationKey: `${operation}-pr`,
      repositoryId: fixture.fixed.projectId,
      branch: fixture.git.push.remoteBranch,
      baselineBranch: "main",
      commitSha: committed.commitSha,
      credential,
    });
    assert.equal(pullRequest.externalId, fixture.git.pullRequest.externalId);
    const landing = await git.mergePullRequest({
      operationKey: `${operation}-landing`,
      repositoryId: fixture.fixed.projectId,
      pullRequest,
      expectedCommitSha: committed.commitSha,
      credential,
    });
    assert.match(landing.landingCommitSha, /^[0-9a-f]{40}$/);
  }
});
