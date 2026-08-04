import assert from "node:assert/strict";
import test from "node:test";

import { ReviewService } from
  "../app/control-plane/application/review-service.ts";
import { MemoryEvidenceRepository } from
  "../app/control-plane/adapters/memory-evidence-repository.ts";

const context = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  goalId: "00000000-0000-4000-8000-000000000003",
  issueId: "00000000-0000-4000-8000-000000000004",
  runId: "00000000-0000-4000-8000-000000000005",
};
const artifact = {
  id: "10000000-0000-4000-8000-000000000001",
  ...context,
  kind: "test_output",
  objectKey: `${context.organizationId}/${context.projectId}/sha256/${"a".repeat(64)}`,
  digest: "a".repeat(64),
  mediaType: "text/plain",
  sizeBytes: 12,
  createdBy: "builder-session-1",
  retentionPolicy: "standard_180d",
  retentionUntil: "2027-02-01T00:00:00.000Z",
  createdAt: "2026-08-05T05:00:00.000Z",
};

function validInput() {
  return {
    ...context,
    idempotencyKey: "review-idempotency-1",
    targetCommitSha: "b".repeat(40),
    verdict: "approved",
    findings: [],
    builderIdentity: "builder-session-1",
    reviewer: {
      type: "model",
      identity: "reviewer-session-2",
      version: "independent-reviewer.v1",
      modelCapability: "advanced_coding",
      reasoningEffort: "high",
    },
    inputArtifactDigests: [artifact.digest],
  };
}

test("persists an independent review bound to exact artifacts and commit", async () => {
  const repository = new MemoryEvidenceRepository({ artifacts: [artifact] });
  const service = new ReviewService({
    repository,
    clock: () => new Date("2026-08-05T05:30:00.000Z"),
    idFactory: () => "20000000-0000-4000-8000-000000000001",
  });
  const review = await service.submit(validInput());
  assert.equal(review.verdict, "approved");
  assert.equal(review.targetCommitSha, "b".repeat(40));
  assert.equal(review.reviewer.identity, "reviewer-session-2");
  assert.equal(review.reviewer.reasoningEffort, "high");
  assert.deepEqual(review.inputArtifactDigests, [artifact.digest]);

  const replay = await service.submit(validInput());
  assert.deepEqual(replay, review);
  await assert.rejects(
    () => service.submit({ ...validInput(), verdict: "rejected" }),
    /idempotency/i,
  );
});

test("rejects missing commits, changed evidence, and builder/reviewer identity reuse", async () => {
  const repository = new MemoryEvidenceRepository({ artifacts: [artifact] });
  const service = new ReviewService({ repository });
  await assert.rejects(
    () => service.submit({ ...validInput(), targetCommitSha: "missing" }),
    /commit/i,
  );
  await assert.rejects(
    () => service.submit({ ...validInput(), inputArtifactDigests: ["c".repeat(64)] }),
    /artifact/i,
  );
  await assert.rejects(
    () => service.submit({
      ...validInput(),
      reviewer: { ...validInput().reviewer, identity: "builder-session-1" },
    }),
    /independent/i,
  );
  await assert.rejects(
    () => service.submit({
      ...validInput(),
      idempotencyKey: "review-case-identity",
      reviewer: { ...validInput().reviewer, identity: " BUILDER-SESSION-1 " },
    }),
    /independent/i,
  );
});
