import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { PostgresGoalVerificationRepository } from
  "../app/control-plane/adapters/postgres-goal-verification-repository.ts";
import { DeliveryReportService } from
  "../app/control-plane/application/delivery-report-service.ts";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 3 })
  : undefined;

const ids = Object.fromEntries([
  "organization", "project", "goal", "criterion", "spec", "issuePlan",
  "verificationPlan", "verification", "gap",
].map((key) => [key, crypto.randomUUID()]));
const now = "2026-08-05T10:00:00.000Z";
const digest = "a".repeat(64);
const scope = {
  organizationId: ids.organization,
  projectId: ids.project,
  goalId: ids.goal,
};
const goal = {
  id: ids.goal,
  organizationId: ids.organization,
  projectId: ids.project,
  title: "P10 PostgreSQL Goal",
  problemStatement: "Issue closure does not prove Goal completion.",
  desiredOutcome: "Goal evidence and acceptance are immutable.",
  acceptanceCriteria: [{
    id: ids.criterion,
    position: 1,
    statement: "The P10 PostgreSQL integration passes.",
    version: 1,
  }],
  nonGoals: ["Do not deploy production."],
  constraints: ["Verifier remains read-only."],
  status: "verifying",
  version: 8,
  createdAt: now,
  updatedAt: now,
};
const plan = {
  schemaVersion: "acceptance-verification-plan.v1",
  id: ids.verificationPlan,
  ...scope,
  goalVersion: 8,
  issuePlanId: ids.issuePlan,
  issuePlanVersion: 2,
  revision: 1,
  previousPlanId: null,
  entries: [{
    id: "verify-p10-postgres",
    criterionRef: ids.criterion,
    environment: "test",
    strategy: { type: "query", reference: "query:issues:completed" },
    successCondition: "The approved integration query returns zero missing rows.",
    timeoutMs: 30_000,
    responsibleParty: "delivery-platform",
  }],
  compilation: { valid: true, coveredCriterionRefs: [ids.criterion] },
  digest,
  compiledAt: now,
  version: 1,
};
const verification = {
  schemaVersion: "goal-verification.v1",
  id: ids.verification,
  ...scope,
  verificationPlanId: plan.id,
  issuePlanId: ids.issuePlan,
  revision: 1,
  previousVerificationId: null,
  goalVersion: 8,
  verdict: "passed",
  deterministicResults: [{
    entryId: "verify-p10-postgres",
    criterionRef: ids.criterion,
    status: "passed",
    evidenceRefs: ["verification-query:p10-postgres"],
    summary: "All integration rows passed.",
    durationMs: 5,
  }],
  verifierOutput: {
    schemaVersion: "goal-verifier-output.v1",
    overallVerdict: "passed",
    criteria: [{
      criterionRef: ids.criterion,
      verdict: "passed",
      evidenceRefs: ["verification-query:p10-postgres"],
      rationale: "The deterministic integration evidence passed.",
    }],
    nonGoals: [{
      statement: goal.nonGoals[0], verdict: "preserved",
      rationale: "No production deployment occurred.",
    }],
    constraints: [{
      statement: goal.constraints[0], verdict: "satisfied",
      rationale: "The verifier used a read-only evidence packet.",
    }],
    regressionRisks: [],
  },
  verifierIdentity: "p10-goal-verifier",
  verifierVersion: "goal-verifier.v1",
  sessionId: crypto.randomUUID(),
  verifiedAt: now,
  version: 1,
};

before(async () => {
  if (!pool) return;
  await pool.query(
    "INSERT INTO organizations (id,slug,name,created_at,updated_at) VALUES ($1,$2,'P10 organization',$3,$3)",
    [ids.organization, `p10-org-${ids.organization.slice(0, 8)}`, now],
  );
  await pool.query(
    "INSERT INTO projects (id,organization_id,slug,name,created_at,updated_at) VALUES ($1,$2,$3,'P10 project',$4,$4)",
    [ids.project, ids.organization, `p10-project-${ids.project.slice(0, 8)}`, now],
  );
  await pool.query(
    `INSERT INTO goals
     (id,organization_id,project_id,title,problem_statement,desired_outcome,
      non_goals,constraints,status,version,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'verifying',8,$9,$9)`,
    [
      ids.goal, ids.organization, ids.project, goal.title,
      goal.problemStatement, goal.desiredOutcome, JSON.stringify(goal.nonGoals),
      JSON.stringify(goal.constraints), now,
    ],
  );
  await pool.query(
    `INSERT INTO acceptance_criteria
     (id,organization_id,project_id,goal_id,position,statement,created_at,updated_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,$6)`,
    [ids.criterion, ids.organization, ids.project, ids.goal, goal.acceptanceCriteria[0].statement, now],
  );
  await pool.query(
    `INSERT INTO spec_revisions
     (id,organization_id,project_id,goal_id,revision,status,source_goal_version,
      artifact_ref,artifact_digest,artifact_media_type,artifact_size_bytes,
      planner_run_id,planner_configuration,overdesign_policy_revision,
      overdesign_review,generated_at,version,created_at,updated_at)
     VALUES ($1,$2,$3,$4,1,'approved',8,'artifact://p10-spec',$5,
             'application/json',1,'p10-planner','{}'::jsonb,'overdesign.v1',
             '{}'::jsonb,$6,1,$6,$6)`,
    [ids.spec, ids.organization, ids.project, ids.goal, "b".repeat(64), now],
  );
  await pool.query(
    `INSERT INTO issue_plan_revisions
     (id,organization_id,project_id,goal_id,spec_revision_id,revision,status,
      source_spec_version,source_spec_digest,plan_data,digest,planner_run_id,
      planner_configuration,compiler_policy_revision,conflict_policy_revision,
      model_router_policy_revision,generated_at,version,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,1,'approved',1,$6,'{}'::jsonb,$7,
             'p10-issue-planner','{}'::jsonb,'issue-compiler.v1',
             'issue-conflict.v1','model-router.v1',$8,2,$8,$8)`,
    [
      ids.issuePlan, ids.organization, ids.project, ids.goal, ids.spec,
      "b".repeat(64), "c".repeat(64), now,
    ],
  );
});

after(async () => {
  await pool?.end();
});

integrationTest("P10 PostgreSQL preserves immutable chains and atomically accepts a Delivery Report with Goal completion", async () => {
  const repository = new PostgresGoalVerificationRepository(pool);
  await repository.appendPlan(plan);
  await repository.appendVerification(verification);
  const gap = {
    schemaVersion: "verification-gap-report.v1",
    id: ids.gap,
    ...scope,
    verificationId: verification.id,
    issuePlanId: ids.issuePlan,
    failedCriterionRefs: [ids.criterion],
    preservedEvidenceRefs: ["verification-query:p10-postgres"],
    gaps: [{
      sourceKind: "acceptance_criterion",
      sourceRef: ids.criterion,
      criterionRef: ids.criterion,
      currentEvidenceRefs: ["verification-query:p10-postgres"],
      gap: "Historical gap retained for audit.",
      impact: "No current delivery impact.",
      suggestedRemediation: "Retained predecessor revision.",
    }],
    createdBy: "p10-operator",
    createdAt: now,
    version: 1,
  };
  await repository.appendGapReport(gap);

  let idSequence = 0;
  const service = new DeliveryReportService({
    repository,
    source: {
      async collect() {
        return {
          goal,
          issueRuns: [{
            issueId: crypto.randomUUID(), issueKey: "P10-DB",
            runId: crypto.randomUUID(), status: "completed",
            artifactRefs: ["artifact:p10-db"], reviewIds: ["review:p10-db"],
            commitSha: "d".repeat(40),
          }],
          exceptions: [],
        };
      },
    },
    authorizer: { async authorize() {} },
    clock: () => new Date(now),
    idGenerator: () => {
      idSequence += 1;
      return idSequence === 1
        ? "00000000-0000-4000-8000-000000000101"
        : "00000000-0000-4000-8000-000000000102";
    },
  });
  const report = await service.generate({
    ...scope,
    verificationId: verification.id,
    actorId: "p10-operator",
    knownRisks: [],
  });
  const completed = await service.accept({
    ...scope,
    reportId: report.id,
    actorId: "p10-approver",
    expectedGoalVersion: 8,
    reason: "P10 PostgreSQL evidence is accepted.",
    requestId: "p10-acceptance-request",
    idempotencyKey: "p10-acceptance-key",
  });
  assert.equal(completed.report.status, "accepted");
  assert.equal(completed.goal.status, "completed");
  const replay = await service.accept({
    ...scope,
    reportId: report.id,
    actorId: "p10-approver",
    expectedGoalVersion: 8,
    reason: "P10 PostgreSQL evidence is accepted.",
    requestId: "p10-acceptance-request",
    idempotencyKey: "p10-acceptance-key",
  });
  assert.equal(replay.report.id, completed.report.id);

  const counts = await pool.query(
    `SELECT
      (SELECT count(*)::integer FROM acceptance_verification_plans WHERE goal_id=$1) plans,
      (SELECT count(*)::integer FROM goal_verifications WHERE goal_id=$1) verifications,
      (SELECT count(*)::integer FROM verification_gap_reports WHERE goal_id=$1) gaps,
      (SELECT count(*)::integer FROM delivery_reports WHERE goal_id=$1) reports,
      (SELECT count(*)::integer FROM audit_events
        WHERE goal_id=$1 AND action IN (
          'verification_gap.created','delivery_report.accepted'
        )) audits,
      (SELECT status FROM goals WHERE id=$1) goal_status`,
    [ids.goal],
  );
  assert.deepEqual(counts.rows[0], {
    plans: 1,
    verifications: 1,
    gaps: 1,
    reports: 2,
    audits: 2,
    goal_status: "completed",
  });
  for (const table of [
    "acceptance_verification_plans",
    "goal_verifications",
    "verification_gap_reports",
    "delivery_reports",
  ]) {
    await assert.rejects(
      () => pool.query(`UPDATE ${table} SET version=version+1 WHERE goal_id=$1`, [ids.goal]),
      /append-only/i,
    );
  }
});
