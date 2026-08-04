import assert from "node:assert/strict";
import test from "node:test";

import { DeliveryOrchestrator } from
  "../app/control-plane/application/delivery-orchestrator.ts";
import { DeliveryPolicyService } from
  "../app/control-plane/application/delivery-policy-service.ts";
import { MemoryDeliveryRepository } from
  "../app/control-plane/adapters/memory-delivery-repository.ts";
import { MemoryDeliveryPolicyRepository } from
  "../app/control-plane/adapters/memory-delivery-policy-repository.ts";
import { MemoryEvidenceRepository } from
  "../app/control-plane/adapters/memory-evidence-repository.ts";

const ids = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  repositoryId: "00000000-0000-4000-8000-000000000003",
  goalId: "00000000-0000-4000-8000-000000000004",
  issueId: "00000000-0000-4000-8000-000000000005",
  runId: "00000000-0000-4000-8000-000000000006",
};
const candidate = {
  id: "00000000-0000-4000-8000-000000000007",
  ...ids,
  worktreePath: "/tmp/autodev-worktree-1",
  baselineBranch: "main",
  baselineSha: "a".repeat(40),
  branch: "autodev/goal-1/issue-1",
  commitMessage: "feat: deliver issue 1",
  commitSha: null,
  state: "verified",
  version: 1,
};
const credential = {
  id: "00000000-0000-4000-8000-000000000008",
  organizationId: ids.organizationId,
  projectId: ids.projectId,
  repositoryId: ids.repositoryId,
  provider: "github_app",
  externalReference: "secret-manager://github/installations/42",
  allowedScopes: ["contents:write", "pull_requests:write"],
  active: true,
  version: 1,
};
const policy = {
  id: "00000000-0000-4000-8000-000000000009",
  organizationId: ids.organizationId,
  projectId: ids.projectId,
  repositoryId: ids.repositoryId,
  mode: "push_and_open_pr",
  baselineBranch: "main",
  branchPrefix: "autodev/",
  protectedBranches: ["main"],
  credentialReferenceId: credential.id,
  revision: 1,
};

function fakeGit() {
  const calls = [];
  const receipts = new Map();
  const once = (key, value) => {
    if (!receipts.has(key)) receipts.set(key, value);
    return receipts.get(key);
  };
  return {
    calls,
    async createCommit(input) {
      calls.push(["commit", input.operationKey]);
      return once(input.operationKey, { commitSha: "b".repeat(40), summary: "1 file changed" });
    },
    async pushBranch(input) {
      calls.push(["push", input.operationKey]);
      return once(input.operationKey, {
        receiptId: "push-42", remoteName: "origin", remoteBranch: input.branch,
        commitSha: input.commitSha, pushedAt: "2026-08-05T06:00:00.000Z",
      });
    },
    async openPullRequest(input) {
      calls.push(["pr", input.operationKey]);
      return once(input.operationKey, {
        externalId: "42", url: "https://github.test/acme/repo/pull/42",
        headBranch: input.branch, baseBranch: input.baselineBranch,
      });
    },
    async mergePullRequest(input) {
      calls.push(["landing", input.operationKey]);
      return once(input.operationKey, {
        externalId: "42", landingCommitSha: "c".repeat(40), landedAt: "2026-08-05T06:30:00.000Z",
      });
    },
  };
}

test("links commit, review, push, PR, landing, and audit idempotently", async () => {
  const deliveryRepository = new MemoryDeliveryRepository({ candidates: [candidate] });
  const evidenceRepository = new MemoryEvidenceRepository({ reviews: [{
    id: "00000000-0000-4000-8000-000000000010",
    ...ids,
    idempotencyKey: "review-1",
    targetCommitSha: "b".repeat(40),
    verdict: "approved",
    findings: [],
    builderIdentity: "builder-1",
    reviewer: { type: "model", identity: "reviewer-2", version: "v1", modelCapability: "advanced_coding", reasoningEffort: "high" },
    inputArtifactDigests: ["d".repeat(64)],
    reviewedAt: "2026-08-05T05:45:00.000Z",
    version: 1,
  }] });
  const git = fakeGit();
  let leases = 0;
  const orchestrator = new DeliveryOrchestrator({
    repository: deliveryRepository,
    evidenceRepository,
    policyService: new DeliveryPolicyService({
      repository: new MemoryDeliveryPolicyRepository({ policies: [policy], credentials: [credential] }),
    }),
    credentialBroker: {
      async acquire(reference, scopes) {
        leases += 1;
        assert.equal(reference.id, credential.id);
        assert.deepEqual(scopes, ["contents:write", "pull_requests:write"]);
        return { token: "synthetic-ephemeral-token", expiresAt: "2026-08-05T06:15:00.000Z", scopes, async release() { leases -= 1; } };
      },
    },
    git,
    actorId: "delivery-supervisor",
    clock: () => new Date("2026-08-05T06:00:00.000Z"),
  });

  const committed = await orchestrator.checkpoint(candidate.id, "checkpoint-1");
  assert.equal(committed.state, "committed");
  assert.equal(committed.commitSha, "b".repeat(40));
  const delivered = await orchestrator.deliver(candidate.id, "delivery-1");
  assert.equal(delivered.state, "pr_open");
  assert.equal(delivered.pushReceipt?.receiptId, "push-42");
  assert.equal(delivered.pullRequest?.externalId, "42");
  assert.equal(leases, 0);

  const replay = await orchestrator.deliver(candidate.id, "delivery-1");
  assert.deepEqual(replay, delivered);
  assert.equal(git.calls.filter(([kind]) => kind === "push").length, 1);
  assert.equal(git.calls.filter(([kind]) => kind === "pr").length, 1);

  await assert.rejects(
    () => orchestrator.land(candidate.id, "landing-denied", { humanGateApproved: false, platformChecksPassed: true }),
    /human gate/i,
  );
  const landed = await orchestrator.land(candidate.id, "landing-1", {
    humanGateApproved: true,
    platformChecksPassed: true,
  });
  assert.equal(landed.state, "landed");
  assert.equal(landed.landing?.landingCommitSha, "c".repeat(40));
  assert.ok(deliveryRepository.auditEvents().some((event) => event.action === "delivery.commit.created"));
  assert.ok(deliveryRepository.auditEvents().some((event) => event.action === "delivery.push.completed"));
  assert.ok(deliveryRepository.auditEvents().some((event) => event.action === "delivery.pull_request.opened"));
  assert.ok(deliveryRepository.auditEvents().some((event) => event.action === "delivery.landed"));
});

test("never pushes directly to a protected branch and does not duplicate external effects after retry", async () => {
  const unsafe = { ...candidate, id: crypto.randomUUID(), branch: "main", commitSha: "b".repeat(40), state: "committed", version: 2 };
  const repository = new MemoryDeliveryRepository({ candidates: [unsafe] });
  const git = fakeGit();
  const orchestrator = new DeliveryOrchestrator({
    repository,
    evidenceRepository: new MemoryEvidenceRepository({ reviews: [{
      id: crypto.randomUUID(), ...ids, issueId: unsafe.issueId, runId: unsafe.runId,
      idempotencyKey: "review-unsafe", targetCommitSha: unsafe.commitSha, verdict: "approved", findings: [],
      builderIdentity: "builder", reviewer: { type: "human", identity: "reviewer", version: "human.v1" },
      inputArtifactDigests: ["e".repeat(64)], reviewedAt: "2026-08-05T05:45:00.000Z", version: 1,
    }] }),
    policyService: new DeliveryPolicyService({ repository: new MemoryDeliveryPolicyRepository({ policies: [policy], credentials: [credential] }) }),
    credentialBroker: { async acquire() { throw new Error("must not acquire"); } },
    git,
    actorId: "delivery-supervisor",
  });
  await assert.rejects(() => orchestrator.deliver(unsafe.id, "unsafe-delivery"), /protected/i);
  assert.equal(git.calls.length, 0);
});

test("resumes local-ready, landing, and landed states after a receipt-write crash", async () => {
  const commitSha = "b".repeat(40);
  const review = {
    id: crypto.randomUUID(),
    ...ids,
    idempotencyKey: "review-recovery",
    targetCommitSha: commitSha,
    verdict: "approved",
    findings: [],
    builderIdentity: "builder",
    reviewer: { type: "human", identity: "reviewer", version: "human.v1" },
    inputArtifactDigests: ["e".repeat(64)],
    reviewedAt: "2026-08-05T05:45:00.000Z",
    version: 1,
  };
  const localCandidate = {
    ...candidate,
    id: crypto.randomUUID(),
    commitSha,
    reviewId: review.id,
    state: "local_ready",
    version: 4,
  };
  const localRepository = new MemoryDeliveryRepository({
    candidates: [localCandidate],
  });
  const local = new DeliveryOrchestrator({
    repository: localRepository,
    evidenceRepository: new MemoryEvidenceRepository({ reviews: [review] }),
    policyService: new DeliveryPolicyService({
      repository: new MemoryDeliveryPolicyRepository(),
    }),
    credentialBroker: { async acquire() { throw new Error("must not acquire"); } },
    git: fakeGit(),
    actorId: "delivery-supervisor",
  });
  assert.equal(
    (await local.deliver(localCandidate.id, "local-recovery-1")).state,
    "local_ready",
  );

  const landingCandidate = {
    ...candidate,
    id: crypto.randomUUID(),
    commitSha,
    reviewId: review.id,
    pushReceipt: {
      receiptId: "push-42",
      remoteName: "origin",
      remoteBranch: candidate.branch,
      commitSha,
      pushedAt: "2026-08-05T06:00:00.000Z",
    },
    pullRequest: {
      externalId: "42",
      url: "https://github.test/acme/repo/pull/42",
      headBranch: candidate.branch,
      baseBranch: "main",
    },
    state: "landing",
    version: 7,
  };
  const landingRepository = new MemoryDeliveryRepository({
    candidates: [landingCandidate],
  });
  const git = fakeGit();
  const landing = new DeliveryOrchestrator({
    repository: landingRepository,
    evidenceRepository: new MemoryEvidenceRepository({ reviews: [review] }),
    policyService: new DeliveryPolicyService({
      repository: new MemoryDeliveryPolicyRepository({
        policies: [policy],
        credentials: [credential],
      }),
    }),
    credentialBroker: {
      async acquire(_reference, scopes) {
        return {
          token: "synthetic-ephemeral-token",
          expiresAt: "2026-08-05T06:15:00.000Z",
          scopes,
          async release() {},
        };
      },
    },
    git,
    actorId: "delivery-supervisor",
    clock: () => new Date("2026-08-05T06:00:00.000Z"),
  });
  const recovered = await landing.land(landingCandidate.id, "landing-recovery-1", {
    humanGateApproved: true,
    platformChecksPassed: true,
  });
  assert.equal(recovered.state, "landed");
  const landedReplay = await landing.land(
    landingCandidate.id,
    "landing-recovery-2",
    { humanGateApproved: true, platformChecksPassed: true },
  );
  assert.equal(landedReplay.state, "landed");
  assert.equal(git.calls.filter(([kind]) => kind === "landing").length, 1);
});
