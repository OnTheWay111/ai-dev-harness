import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { PostgresDeliveryPolicyRepository } from
  "../app/control-plane/adapters/postgres-delivery-policy-repository.ts";
import { PostgresDeliveryRepository } from
  "../app/control-plane/adapters/postgres-delivery-repository.ts";
import { PostgresEvidenceRepository } from
  "../app/control-plane/adapters/postgres-evidence-repository.ts";
import { DeliveryOrchestrator } from
  "../app/control-plane/application/delivery-orchestrator.ts";
import { DeliveryPolicyService } from
  "../app/control-plane/application/delivery-policy-service.ts";
import { ReviewService } from
  "../app/control-plane/application/review-service.ts";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;

const ids = {
  organization: crypto.randomUUID(),
  project: crypto.randomUUID(),
  repository: crypto.randomUUID(),
  goal: crypto.randomUUID(),
  spec: crypto.randomUUID(),
  issue: crypto.randomUUID(),
  run: crypto.randomUUID(),
  artifact: crypto.randomUUID(),
  candidate: crypto.randomUUID(),
  credential: crypto.randomUUID(),
  policy: crypto.randomUUID(),
};
const digest = "a".repeat(64);

before(async () => {
  if (!pool) return;
  await pool.query(
    `INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'P9 organization')`,
    [ids.organization, `p9-org-${ids.organization.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO projects (id,organization_id,slug,name)
     VALUES ($1,$2,$3,'P9 project')`,
    [ids.project, ids.organization, `p9-project-${ids.project.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO repositories
      (id,organization_id,project_id,provider,provider_repository_id,owner,name,default_branch)
     VALUES ($1,$2,$3,'github',$4,'acme','p9-repo','main')`,
    [ids.repository, ids.organization, ids.project, `p9-${ids.repository}`],
  );
  await pool.query(
    `INSERT INTO goals
      (id,organization_id,project_id,title,problem_statement,desired_outcome)
     VALUES ($1,$2,$3,'P9 goal','Trace delivery','Retain immutable evidence')`,
    [ids.goal, ids.organization, ids.project],
  );
  await pool.query(
    `INSERT INTO spec_revisions
      (id,organization_id,project_id,goal_id,revision,status,source_goal_version,
       artifact_ref,artifact_digest)
     VALUES ($1,$2,$3,$4,1,'approved',1,'artifact://p9',$5)`,
    [ids.spec, ids.organization, ids.project, ids.goal, "b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO issues
      (id,organization_id,project_id,goal_id,spec_revision_id,issue_key,
       revision,status,title,body_ref,body_digest)
     VALUES ($1,$2,$3,$4,$5,'P9-TEST',1,'in_progress','P9 issue',
             'artifact://p9-issue',$6)`,
    [
      ids.issue, ids.organization, ids.project, ids.goal, ids.spec,
      "c".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO runs
      (id,organization_id,project_id,goal_id,issue_id,attempt,status,request_id,
       started_at)
     VALUES ($1,$2,$3,$4,$5,1,'running','p9-integration',CURRENT_TIMESTAMP)`,
    [ids.run, ids.organization, ids.project, ids.goal, ids.issue],
  );
  await pool.query(
    `INSERT INTO credential_references
      (id,organization_id,project_id,repository_id,provider,external_reference,
       allowed_scopes)
     VALUES ($1,$2,$3,$4,'github_app','secret-manager://p9/installations/42',
             '["contents:write","pull_requests:write"]'::jsonb)`,
    [ids.credential, ids.organization, ids.project, ids.repository],
  );
  await pool.query(
    `INSERT INTO delivery_policies
      (id,organization_id,project_id,repository_id,push_mode,baseline_branch,
       branch_prefix,protected_branches,credential_reference_id,revision,
       changed_by_actor_id,reason)
     VALUES ($1,$2,$3,$4,'push_and_open_pr','main','autodev/',
             '["main"]'::jsonb,$5,1,'project-admin','P9 integration')`,
    [ids.policy, ids.organization, ids.project, ids.repository, ids.credential],
  );
  await pool.query(
    `INSERT INTO delivery_candidates
      (id,organization_id,project_id,repository_id,goal_id,issue_id,run_id,
       worktree_ref,baseline_branch,baseline_sha,branch,commit_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'worktree://p9/run','main',$8,
             'autodev/p9/test','feat: P9 integration')`,
    [
      ids.candidate, ids.organization, ids.project, ids.repository, ids.goal,
      ids.issue, ids.run, "d".repeat(40),
    ],
  );
});

after(async () => {
  await pool?.end();
});

integrationTest("P9 PostgreSQL persists immutable metadata, Review, Git receipts, and Audit idempotently", async () => {
  const evidence = new PostgresEvidenceRepository(pool);
  const now = new Date();
  await evidence.saveArtifact({
    id: ids.artifact,
    organizationId: ids.organization,
    projectId: ids.project,
    goalId: ids.goal,
    issueId: ids.issue,
    runId: ids.run,
    kind: "test_output",
    objectKey: `${ids.organization}/${ids.project}/sha256/${digest}`,
    digest,
    mediaType: "text/plain",
    sizeBytes: 12,
    createdBy: "builder-session",
    retentionPolicy: "standard_180d",
    retentionUntil: new Date(now.getTime() + 180 * 86400000).toISOString(),
    createdAt: now.toISOString(),
  });
  const duplicateArtifact = await evidence.saveArtifact({
    id: crypto.randomUUID(),
    organizationId: ids.organization,
    projectId: ids.project,
    goalId: ids.goal,
    issueId: ids.issue,
    runId: ids.run,
    kind: "test_output",
    objectKey: `${ids.organization}/${ids.project}/sha256/${digest}`,
    digest,
    mediaType: "application/json",
    sizeBytes: 999,
    createdBy: "changed-writer",
    retentionPolicy: "extended_365d",
    retentionUntil: new Date(now.getTime() + 365 * 86400000).toISOString(),
    createdAt: new Date(now.getTime() + 1000).toISOString(),
  });
  assert.equal(duplicateArtifact.id, ids.artifact);
  assert.equal(duplicateArtifact.mediaType, "text/plain");
  assert.equal(duplicateArtifact.sizeBytes, 12);
  const commitSha = "e".repeat(40);
  const deliveryRepository = new PostgresDeliveryRepository(pool);
  const calls = [];
  const git = {
    async createCommit() {
      calls.push("commit");
      return { commitSha, summary: "P9 integration commit" };
    },
    async pushBranch(input) {
      calls.push("push");
      return {
        receiptId: "p9-push-receipt", remoteName: "origin",
        remoteBranch: input.branch, commitSha: input.commitSha,
        pushedAt: new Date().toISOString(),
      };
    },
    async openPullRequest(input) {
      calls.push("pr");
      return {
        externalId: "99", url: "https://github.test/acme/p9-repo/pull/99",
        headBranch: input.branch, baseBranch: input.baselineBranch,
      };
    },
    async mergePullRequest() {
      calls.push("landing");
      return {
        externalId: "99", landingCommitSha: "f".repeat(40),
        landedAt: new Date().toISOString(),
      };
    },
  };
  const policyService = new DeliveryPolicyService({
    repository: new PostgresDeliveryPolicyRepository(pool),
  });
  const orchestrator = new DeliveryOrchestrator({
    repository: deliveryRepository,
    evidenceRepository: evidence,
    policyService,
    credentialBroker: {
      async acquire(_reference, scopes) {
        return {
          token: "synthetic-p9-db-token",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          scopes,
          async release() {},
        };
      },
    },
    git,
    actorId: "p9-supervisor",
  });
  await orchestrator.checkpoint(ids.candidate, "p9-checkpoint-integration");
  const review = await new ReviewService({ repository: evidence }).submit({
    organizationId: ids.organization,
    projectId: ids.project,
    goalId: ids.goal,
    issueId: ids.issue,
    runId: ids.run,
    idempotencyKey: "p9-review-integration",
    targetCommitSha: commitSha,
    verdict: "approved",
    findings: [],
    builderIdentity: "builder-session",
    reviewer: {
      type: "model", identity: "reviewer-session", version: "reviewer.v1",
      modelCapability: "advanced_coding", reasoningEffort: "high",
    },
    inputArtifactDigests: [digest],
  });
  assert.equal(review.verdict, "approved");
  const delivered = await orchestrator.deliver(
    ids.candidate,
    "p9-delivery-integration",
  );
  assert.equal(delivered.state, "pr_open");
  const replay = await orchestrator.deliver(
    ids.candidate,
    "p9-delivery-integration",
  );
  assert.deepEqual(replay, delivered);
  assert.deepEqual(calls, ["commit", "push", "pr"]);
  const landed = await orchestrator.land(ids.candidate, "p9-landing-integration", {
    humanGateApproved: true,
    platformChecksPassed: true,
  });
  assert.equal(landed.state, "landed");

  const rows = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM artifact_objects WHERE id=$1) artifacts,
       (SELECT count(*)::integer FROM reviews WHERE run_id=$2) reviews,
       (SELECT count(*)::integer FROM push_receipts WHERE candidate_id=$3) pushes,
       (SELECT count(*)::integer FROM pull_request_receipts WHERE candidate_id=$3) prs,
       (SELECT count(*)::integer FROM landing_receipts WHERE candidate_id=$3) landings,
       (SELECT count(*)::integer FROM audit_events
         WHERE entity_type='delivery_candidate' AND entity_id=$3) audits`,
    [ids.artifact, ids.run, ids.candidate],
  );
  assert.deepEqual(rows.rows[0], {
    artifacts: 1, reviews: 1, pushes: 1, prs: 1, landings: 1, audits: 6,
  });
  await assert.rejects(
    () => pool.query("UPDATE artifact_objects SET size_bytes=size_bytes+1 WHERE id=$1", [ids.artifact]),
    /append-only/i,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM reviews WHERE id=$1", [review.id]),
    /append-only/i,
  );
});
