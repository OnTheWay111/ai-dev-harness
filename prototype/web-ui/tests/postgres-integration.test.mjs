import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { workbenchSnapshot } from
  "../app/workbench/server/demo-workbench-snapshot.ts";
import {
  NodePostgresWorkbenchProjectionWriter,
  NodePostgresWorkbenchReadStore,
} from "../app/workbench/server/node-postgres-workbench-store.ts";
import { PostgresWorkbenchReadRepository } from
  "../app/workbench/server/postgres-workbench-repository.ts";
import { loadPostgresMigrations } from "../scripts/postgres-migration.ts";
import {
  goalStateMachine,
  issueStateMachine,
  runStateMachine,
  specRevisionStateMachine,
  transitionState,
} from "../app/control-plane/domain/state-machines.ts";
import {
  PostgresVersionedStateStore,
  VersionConflictError,
} from "../app/control-plane/adapters/postgres-versioned-state-store.ts";
import {
  PostgresGoalRepository,
} from "../app/control-plane/adapters/postgres-goal-repository.ts";
import {
  GoalApplicationService,
} from "../app/control-plane/application/goal-application-service.ts";
import {
  GoalWorkspaceService,
} from "../app/control-plane/application/goal-workspace-service.ts";
import {
  PostgresGoalWorkspaceRepository,
} from "../app/control-plane/adapters/postgres-goal-workspace-repository.ts";
import { PostgresClarificationHistoryRepository } from
  "../app/control-plane/adapters/postgres-clarification-history-repository.ts";
import { FakePlannerAdapter } from
  "../app/control-plane/adapters/fake-planner-adapter.ts";
import { ClarificationPlannerService } from
  "../app/control-plane/application/clarification-planner-service.ts";
import { ClarificationHistoryService } from
  "../app/control-plane/application/clarification-history-service.ts";
import { PostgresClassificationRepository } from
  "../app/control-plane/adapters/postgres-classification-repository.ts";
import { ClassificationService } from
  "../app/control-plane/application/classification-service.ts";
import { PostgresSpecRevisionRepository } from
  "../app/control-plane/adapters/postgres-spec-revision-repository.ts";
import { MemoryArtifactStore } from
  "../app/control-plane/adapters/memory-artifact-store.ts";
import { SpecGenerationService } from
  "../app/control-plane/application/spec-generation-service.ts";
import { PostgresSpecApprovalRepository } from
  "../app/control-plane/adapters/postgres-spec-approval-repository.ts";
import { SpecApprovalService } from
  "../app/control-plane/application/spec-approval-service.ts";
import { DemoIssuePlannerAdapter } from
  "../app/control-plane/adapters/demo-issue-planner-adapter.ts";
import { PostgresIssuePlanRepository } from
  "../app/control-plane/adapters/postgres-issue-plan-repository.ts";
import { PostgresQueueProjectionRepository } from
  "../app/control-plane/adapters/postgres-queue-projection-repository.ts";
import { IssuePlanGenerationService } from
  "../app/control-plane/application/issue-plan-generation-service.ts";
import { IssuePlanService } from
  "../app/control-plane/application/issue-plan-service.ts";
import { QueueProjectionService } from
  "../app/control-plane/application/queue-projection-service.ts";
import {
  IdempotencyConflictError,
} from "../app/control-plane/domain/errors.ts";
import {
  PostgresRoleBindingRepository,
} from "../app/auth/postgres-role-binding-repository.ts";
import { PolicyEvaluator } from "../app/auth/rbac-policy.ts";
import {
  RoleBindingApplicationService,
} from "../app/auth/role-binding-service.ts";
import { assertGoalRepositoryContract } from "./goal-repository-contract.mjs";
import { handleWorkbenchRequest } from
  "../app/api/v1/workbench/route.ts";

const databaseUrl = process.env.POSTGRES_INTEGRATION_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const { Pool } = pg;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;
const scopePrefix = `p1_04_${process.pid}`;
const projectionOrganizationId = "30000000-0000-4000-8000-000000000001";
const projectionProjectId = "40000000-0000-4000-8000-000000000001";
const projectionVisibility = {
  actorId: "integration-viewer",
  organizationIds: [projectionOrganizationId],
  projectIds: [],
};

function projectionScope(scopeId, overrides = {}) {
  return {
    scopeId,
    organizationId: projectionOrganizationId,
    projectId: projectionProjectId,
    ...overrides,
  };
}

async function insertReliableGoal(label) {
  const organizationId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const suffix = `${process.pid}-${label}-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO organizations (id, slug, name)
     VALUES ($1, $2, 'Reliable command organization')`,
    [organizationId, `reliable-org-${suffix}`],
  );
  await pool.query(
    `INSERT INTO projects (id, organization_id, slug, name)
     VALUES ($1, $2, $3, 'Reliable command project')`,
    [projectId, organizationId, `reliable-project-${suffix}`],
  );
  await pool.query(
    `INSERT INTO goals
       (id, organization_id, project_id, title,
        problem_statement, desired_outcome)
     VALUES ($1, $2, $3, 'Reliable command goal',
             'A write may be retried or race.',
             'Commit exactly once or fail without partial state.')`,
    [goalId, organizationId, projectId],
  );
  return { organizationId, projectId, goalId };
}

function reliableCommand(scope, overrides = {}) {
  return {
    ...scope,
    actorId: "integration-actor",
    requestId: "integration-request",
    idempotencyKey: "integration-idempotency",
    expectedVersion: 1,
    nextState: "clarifying",
    reason: "Verify reliable command handling",
    guards: {},
    ...overrides,
  };
}

function reliableService(repository, ids) {
  const availableIds = [...ids];
  return new GoalApplicationService({
    repository,
    authorizer: { async authorize() {} },
    clock: () => new Date(),
    idGenerator: () => {
      const id = availableIds.shift();
      assert.ok(id, "the command generated only the expected records");
      return id;
    },
  });
}

before(async () => {
  if (!pool) return;
  await pool.query(
    "DELETE FROM workbench_tasks WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.query(
    "DELETE FROM workbench_snapshots WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
});

after(async () => {
  if (!pool) return;
  await pool.query(
    "DELETE FROM workbench_tasks WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.query(
    "DELETE FROM workbench_snapshots WHERE scope_id LIKE $1",
    [`${scopePrefix}%`],
  );
  await pool.end();
});

integrationTest("migrates an empty temporary PostgreSQL database", async () => {
  const migrations = loadPostgresMigrations(
    new URL("../drizzle-postgres/", import.meta.url),
  );
  assert.equal(migrations.length, 18);
  const ledger = await pool.query(
    "SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at",
  );
  assert.deepEqual(
    ledger.rows,
    migrations.map((migration) => ({
      hash: migration.hash,
      created_at: String(migration.createdAt),
    })),
  );
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [
      "acceptance_criteria",
      "audit_events",
      "clarification_rounds",
      "clarifications",
      "classification_policy_revisions",
      "classifications",
      "decisions",
      "evidence",
      "execution_command_receipts",
      "execution_controls",
      "execution_leases",
      "execution_nodes",
      "execution_waves",
      "external_event_inbox",
      "goals",
      "idempotency_records",
      "issue_dependencies",
      "issue_plan_revisions",
      "issues",
      "model_recommendations",
      "organizations",
      "outbox_events",
      "projects",
      "queue_projections",
      "repositories",
      "role_bindings",
      "runs",
      "scheduler_jobs",
      "spec_revisions",
      "task_action_receipts",
      "workbench_projection_checkpoints",
      "workbench_snapshots",
      "workbench_tasks",
    ],
  );
});

integrationTest(
  "creates and edits a complete Goal Contract in one audited PostgreSQL transaction",
  async () => {
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const suffix = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
      [organizationId, `p4-org-${suffix}`, "P4 Goal Workspace"],
    );
    await pool.query(
      `INSERT INTO projects (id, organization_id, slug, name)
       VALUES ($1, $2, $3, $4)`,
      [projectId, organizationId, `p4-project-${suffix}`, "P4 Project"],
    );
    const repository = new PostgresGoalWorkspaceRepository(pool);
    const service = new GoalWorkspaceService({
      repository,
      authorizer: { async authorize() {} },
    });
    const createCommand = {
      organizationId,
      projectId,
      actorId: "p4-actor",
      requestId: "p4-create-request",
      idempotencyKey: "p4-create-key",
      reason: "Create a durable contract",
      draft: {
        title: "Persist Goal Contracts",
        problemStatement: "The Goal Workspace needs authoritative storage.",
        desiredOutcome: "Create and edit a complete contract transactionally.",
        acceptanceCriteria: ["The contract survives a read", "Stale writes fail"],
        nonGoals: ["Model approval"],
        constraints: ["Use server-side RBAC"],
      },
    };
    const created = await service.create(createCommand);
    assert.deepEqual(await service.create(createCommand), created);
    assert.deepEqual(
      await service.get({
        organizationId,
        projectId,
        goalId: created.goal.id,
        actorId: "p4-actor",
      }),
      created.goal,
    );

    const updated = await service.update({
      ...createCommand,
      goalId: created.goal.id,
      requestId: "p4-update-request",
      idempotencyKey: "p4-update-key",
      expectedVersion: 1,
      reason: "Make verification explicit",
      draft: {
        ...createCommand.draft,
        acceptanceCriteria: ["The contract survives a PostgreSQL read"],
      },
    });
    assert.equal(updated.goal.version, 2);
    assert.deepEqual(updated.goal.nonGoals, ["Model approval"]);
    await assert.rejects(
      () => service.update({
        ...createCommand,
        goalId: created.goal.id,
        requestId: "p4-stale-request",
        idempotencyKey: "p4-stale-key",
        expectedVersion: 1,
      }),
      /version/i,
    );
    const evidence = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM audit_events WHERE goal_id = $1) AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS events,
         (SELECT count(*)::int FROM acceptance_criteria WHERE goal_id = $1) AS criteria`,
      [created.goal.id],
    );
    assert.deepEqual(evidence.rows[0], { audits: 2, events: 2, criteria: 1 });
  },
);

integrationTest(
  "appends clarification rounds, answers, and decisions under concurrent PostgreSQL writes",
  async () => {
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const suffix = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO organizations (id, slug, name) VALUES ($1,$2,'Clarification org')`, [organizationId, `clarification-org-${suffix}`]);
    await pool.query(`INSERT INTO projects (id, organization_id, slug, name) VALUES ($1,$2,$3,'Clarification project')`, [projectId, organizationId, `clarification-project-${suffix}`]);
    const goals = new PostgresGoalWorkspaceRepository(pool);
    const goalService = new GoalWorkspaceService({ repository: goals, authorizer: { async authorize() {} } });
    const created = await goalService.create({
      organizationId, projectId, actorId: "integration-author", requestId: "clarification-goal-request",
      idempotencyKey: `clarification-goal-${suffix}`, reason: "Create source Goal",
      draft: { title: "Clarification history", problemStatement: "Answers can race", desiredOutcome: "One append wins", acceptanceCriteria: ["All revisions remain"], nonGoals: [], constraints: [] },
    });
    const plannerOutput = {
      schemaVersion: "planner-clarification.v1",
      knownFacts: [{ id: "goal_exists", fact: "A Goal exists", basis: "goal_contract" }],
      uncertainties: [{ id: "owner", statement: "Owner is unknown", impact: "Approval cannot route" }],
      questions: [{ id: "owner", prompt: "Who owns approval?", rationale: "Approval needs an actor", blockingLevel: "high", answerType: "text", suggestedOptions: [] }],
    };
    const historyRepository = new PostgresClarificationHistoryRepository(pool);
    const service = new ClarificationHistoryService({
      repository: historyRepository,
      goals,
      planner: new ClarificationPlannerService(new FakePlannerAdapter([plannerOutput])),
      authorizer: { async authorize() {} },
    });
    const scope = { organizationId, projectId, goalId: created.goal.id };
    const generated = await service.generate({ ...scope, expectedGoalVersion: 1, actorId: "integration-author", reason: "Generate missing owner question" });
    const question = generated.questions[0];
    const writes = await Promise.allSettled([
      service.answer({ ...scope, threadId: question.threadId, expectedQuestionRevision: 1, expectedGoalVersion: 1, answer: "Team A", actorId: "reviewer-a", reason: "Team A owns it" }),
      service.answer({ ...scope, threadId: question.threadId, expectedQuestionRevision: 1, expectedGoalVersion: 1, answer: "Team B", actorId: "reviewer-b", reason: "Team B owns it" }),
    ]);
    assert.equal(writes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(writes.filter(({ status }) => status === "rejected").length, 1);
    const timeline = await historyRepository.getTimeline(scope);
    assert.equal(timeline.rounds.length, 1);
    assert.equal(timeline.questions.length, 2);
    assert.equal(timeline.decisions.length, 1);
    await assert.rejects(
      () => pool.query(`UPDATE clarification_rounds SET reason='overwrite' WHERE id=$1`, [generated.round.id]),
      /append-only/i,
    );
  },
);

integrationTest(
  "persists deterministic classifications against one immutable policy revision",
  async () => {
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const suffix = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO organizations (id, slug, name) VALUES ($1,$2,'Classification org')`, [organizationId, `classification-org-${suffix}`]);
    await pool.query(`INSERT INTO projects (id, organization_id, slug, name) VALUES ($1,$2,$3,'Classification project')`, [projectId, organizationId, `classification-project-${suffix}`]);
    const goals = new PostgresGoalWorkspaceRepository(pool);
    const created = await new GoalWorkspaceService({ repository: goals, authorizer: { async authorize() {} } }).create({
      organizationId, projectId, actorId: "classification-author", requestId: "classification-goal-request",
      idempotencyKey: `classification-goal-${suffix}`, reason: "Create classification source",
      draft: { title: "Migrate production schema", problemStatement: "Avoid data loss during migration", desiredOutcome: "A reversible deployment", acceptanceCriteria: ["Migration passes", "Rollback passes", "Audit retained", "No credential leakage", "Production remains available", "Recovery is tested"], nonGoals: [], constraints: ["Production rollout", "PostgreSQL schema migration", "No data loss"] },
    });
    const repository = new PostgresClassificationRepository(pool);
    const service = new ClassificationService({
      repository, goals,
      clarifications: new PostgresClarificationHistoryRepository(pool),
      authorizer: { async authorize() {} },
    });
    const command = { organizationId, projectId, goalId: created.goal.id, expectedGoalVersion: 1, actorId: "classification-reviewer", reason: "Apply policy revision one" };
    const first = await service.classify(command);
    const second = await service.classify(command);
    assert.equal(first.classification.risk, "high");
    assert.equal(second.classification.revision, 2);
    const timeline = await repository.getTimeline(command);
    assert.equal(timeline.policies.length, 1);
    assert.equal(timeline.classifications.length, 2);
    assert.equal(timeline.classifications[0].policyRevisionId, timeline.classifications[1].policyRevisionId);
    await assert.rejects(() => pool.query(`UPDATE classifications SET risk='low' WHERE id=$1`, [first.classification.id]), /append-only/i);
    await assert.rejects(() => pool.query(`DELETE FROM classification_policy_revisions WHERE id=$1`, [first.policy.id]), /append-only/i);
  },
);

integrationTest(
  "appends immutable artifact-backed specification revisions in PostgreSQL",
  async () => {
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const criterionId = crypto.randomUUID();
    const suffix = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1,$2,'Spec org')`,
      [organizationId, `spec-org-${suffix}`],
    );
    await pool.query(
      `INSERT INTO projects (id, organization_id, slug, name)
       VALUES ($1,$2,$3,'Spec project')`,
      [projectId, organizationId, `spec-project-${suffix}`],
    );
    await pool.query(
      `INSERT INTO goals
         (id, organization_id, project_id, title, problem_statement,
          desired_outcome, constraints, status)
       VALUES ($1,$2,$3,'Immutable spec','Specs can be overwritten',
               'Every revision is content addressed','["Zero downtime"]'::jsonb,
               'planning')`,
      [goalId, organizationId, projectId],
    );
    await pool.query(
      `INSERT INTO acceptance_criteria
         (id, organization_id, project_id, goal_id, position, statement)
       VALUES ($1,$2,$3,$4,1,'Prior revisions remain readable')`,
      [criterionId, organizationId, projectId, goalId],
    );
    const output = {
      schemaVersion: "spec-bundle.v1",
      proposal: {
        summary: "Store immutable specifications.",
        value: "Approvers review exact content.",
        inScope: ["Spec generation"],
        outOfScope: ["Issue compilation"],
        deliverySlices: ["Generate and persist one revision"],
      },
      prd: {
        problem: "Specs can be overwritten.",
        users: ["Approver"],
        requirements: [{
          id: "REQ-1",
          statement: "Retain every revision.",
          acceptanceCriterionRefs: [criterionId],
        }],
        nonGoals: ["Issue compilation"],
        constraints: ["Zero downtime"],
      },
      architecture: {
        summary: "Use content-addressed artifacts.",
        components: [{
          id: "store",
          name: "Artifact Store",
          responsibility: "Keep immutable content.",
          requirementRefs: ["REQ-1"],
        }],
        decisions: ["PostgreSQL stores only metadata"],
      },
      migration: { required: false, steps: [], verification: [] },
      rollback: {
        triggers: ["Artifact lookup fails"],
        steps: ["Stop generation"],
        dataRecovery: "Retain prior artifacts.",
      },
      solutionElements: [{
        id: "EL-1",
        title: "Content addressing",
        kind: "architecture",
        description: "Address specifications by digest.",
        acceptanceCriterionRefs: [criterionId],
        constraintRefs: [],
        estimatedCost: "medium",
        removalImpact: "Revisions could be overwritten.",
        evidence: ["REQ-1"],
      }, {
        id: "EL-2",
        title: "Safe rollout",
        kind: "migration",
        description: "Drain active work before rollout.",
        acceptanceCriterionRefs: [],
        constraintRefs: ["Zero downtime"],
        estimatedCost: "low",
        removalImpact: "Rollout may interrupt work.",
        evidence: ["ADR-1"],
      }],
    };
    const artifacts = new MemoryArtifactStore();
    const repository = new PostgresSpecRevisionRepository(pool);
    const service = new SpecGenerationService({
      planner: new FakePlannerAdapter([output]),
      artifacts,
      repository,
      goals: new PostgresGoalWorkspaceRepository(pool),
      authorizer: { async authorize() {} },
    });
    const generated = await service.generate({
      organizationId,
      projectId,
      goalId,
      actorId: "spec-reviewer",
      expectedGoalVersion: 1,
      reason: "Generate integration revision",
    });
    assert.equal(generated.specRevision.revision, 1);
    assert.deepEqual(
      (await service.timeline({
        organizationId,
        projectId,
        goalId,
        actorId: "spec-viewer",
      })).revisions[0].artifact.content,
      output,
    );
    const row = await pool.query(
      `SELECT artifact_digest, planner_configuration, generated_at
         FROM spec_revisions WHERE id=$1`,
      [generated.specRevision.id],
    );
    assert.equal(row.rows[0].artifact_digest, generated.artifact.digest);
    assert.equal(row.rows[0].planner_configuration.schemaVersion, "spec-bundle.v1");
    assert.ok(row.rows[0].generated_at);

    const approvals = new SpecApprovalService({
      repository: new PostgresSpecApprovalRepository(pool),
      authorizer: { async authorize() {} },
    });
    const common = {
      scope: { organizationId, projectId, goalId },
      target: { type: "spec_revision", id: generated.specRevision.id },
      actorId: "integration-approver",
      reason: "Review exact immutable content",
      requestId: "integration-spec-approval",
      policyRevision: generated.specRevision.overdesignPolicyRevision,
      affectedItemIds: ["EL-1", "EL-2"],
      payload: { helpfulExceptionElementIds: [], scopeChanges: [] },
    };
    const submitted = await approvals.decide({
      ...common,
      expectedVersion: 1,
      idempotencyKey: `submit-${suffix}`,
      decision: "submit_for_review",
    });
    assert.equal(submitted.result.specRevision.status, "in_review");
    const approved = await approvals.decide({
      ...common,
      expectedVersion: 2,
      idempotencyKey: `approve-${suffix}`,
      decision: "approve",
      payload: { helpfulExceptionElementIds: ["EL-2"], scopeChanges: [] },
    });
    assert.equal(approved.result.specRevision.status, "approved");
    assert.deepEqual(approved.result.retainedElementIds, ["EL-1", "EL-2"]);
    assert.equal((await approvals.timeline({
      organizationId,
      projectId,
      goalId,
      specRevisionId: generated.specRevision.id,
      actorId: "integration-viewer",
    })).decisions.length, 2);

    const issuePlanRepository = new PostgresIssuePlanRepository(pool);
    const issuePlans = new IssuePlanService({
      repository: issuePlanRepository,
      authorizer: { async authorize() {} },
    });
    const issuePlanGeneration = new IssuePlanGenerationService({
      goals: new PostgresGoalWorkspaceRepository(pool),
      specifications: new PostgresSpecApprovalRepository(pool),
      artifacts,
      planner: new DemoIssuePlannerAdapter(),
      plans: issuePlans,
      authorizer: { async authorize() {} },
    });
    const generatedPlan = await issuePlanGeneration.generate({
      organizationId,
      projectId,
      goalId,
      specRevisionId: generated.specRevision.id,
      expectedSpecVersion: approved.result.specRevision.version,
      actorId: "issue-planner",
    });
    assert.equal(generatedPlan.plan.compilation.valid, true);
    const approvedPlan = await issuePlans.approve({
      scope: { organizationId, projectId, goalId },
      target: { type: "issue_plan", id: generatedPlan.plan.id },
      expectedVersion: 1,
      actorId: "integration-approver",
      reason: "Approve the exact Issue DAG and routes",
      requestId: "integration-issue-approval",
      idempotencyKey: `issue-approve-${suffix}`,
      policyRevision: "issue-plan-approval.v1",
      decision: "approve",
      affectedItemIds: generatedPlan.plan.issues.map(({ key }) => key),
      payload: {},
    });
    assert.equal(approvedPlan.result.plan.status, "approved");
    const normalized = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM model_recommendations WHERE issue_plan_id=$1) AS routes,
         (SELECT count(*)::int FROM execution_waves WHERE issue_plan_id=$1) AS waves`,
      [generatedPlan.plan.id],
    );
    assert.deepEqual(normalized.rows[0], {
      routes: generatedPlan.plan.issues.length,
      waves: generatedPlan.plan.waves.length,
    });

    let imports = 0;
    const queue = new QueueProjectionService({
      repository: new PostgresQueueProjectionRepository(pool),
      adapter: {
        async importApprovedPlan(input) {
          imports += 1;
          return {
            importId: `import-${suffix}`,
            atomic: true,
            organizationId,
            projectId,
            goalId,
            issuePlanId: input.plan.id,
            planDigest: input.plan.digest,
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            projectedAt: new Date().toISOString(),
            tasks: input.plan.issues.map(({ key }) => ({
              issueKey: key,
              externalTaskId: `external-${key}`,
            })),
          };
        },
      },
    });
    const projectionCommand = {
      plan: approvedPlan.result.plan,
      actorId: "integration-approver",
      requestId: "integration-queue-projection",
      idempotencyKey: `queue-projection-${suffix}`,
    };
    const projected = await queue.project(projectionCommand);
    assert.deepEqual(await queue.project(projectionCommand), projected);
    assert.equal(imports, 1);
  },
);

integrationTest(
  "enforces Organization, version, and acceptance constraints",
  async () => {
    const organizationId = crypto.randomUUID();
    const otherOrganizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();
    const repositoryId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const criterionId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          organizationId,
          `p2-org-${process.pid}`,
          "P2 Organization",
          otherOrganizationId,
          `p2-other-${process.pid}`,
          "Other Organization",
        ],
      );
      await pool.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
        [
          projectId,
          organizationId,
          `p2-project-${process.pid}`,
          "P2 Project",
          otherProjectId,
          `p2-other-project-${process.pid}`,
          "Other P2 Project",
        ],
      );
      await pool.query(
        `INSERT INTO repositories
           (id, organization_id, project_id, provider,
            provider_repository_id, owner, name, default_branch)
         VALUES ($1, $2, $3, 'github', $4, $5, $6, 'main')`,
        [
          repositoryId,
          organizationId,
          projectId,
          `provider-${process.pid}`,
          "example",
          "repository",
        ],
      );
      await pool.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          goalId,
          organizationId,
          projectId,
          "P2 Goal",
          "The control plane has no authoritative goal record.",
          "Persist a Goal inside its Organization boundary.",
        ],
      );
      await pool.query(
        `INSERT INTO acceptance_criteria
           (id, organization_id, project_id, goal_id, position, statement)
         VALUES ($1, $2, $3, $4, 1, $5)`,
        [
          criterionId,
          organizationId,
          projectId,
          goalId,
          "The goal can be traced to its project and organization.",
        ],
      );

      const hierarchy = await pool.query(
        `SELECT o.slug AS organization_slug, p.slug AS project_slug,
                r.name AS repository_name, g.title AS goal_title,
                ac.statement
         FROM organizations o
         JOIN projects p ON p.organization_id = o.id
         JOIN repositories r
           ON r.organization_id = p.organization_id AND r.project_id = p.id
         JOIN goals g
           ON g.organization_id = p.organization_id AND g.project_id = p.id
         JOIN acceptance_criteria ac
           ON ac.organization_id = g.organization_id
          AND ac.project_id = g.project_id AND ac.goal_id = g.id
         WHERE o.id = $1`,
        [organizationId],
      );
      assert.equal(hierarchy.rowCount, 1);

      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO repositories
               (organization_id, project_id, provider,
                provider_repository_id, owner, name, default_branch)
             VALUES ($1, $2, 'github', $3, 'wrong', 'organization', 'main')`,
            [
              otherOrganizationId,
              projectId,
              `cross-organization-${process.pid}`,
            ],
          ),
        /foreign key/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO acceptance_criteria
               (organization_id, project_id, goal_id, position, statement)
             VALUES ($1, $2, $3, 2, 'Cross-Project criterion')`,
            [organizationId, otherProjectId, goalId],
          ),
        /foreign key/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO acceptance_criteria
               (organization_id, project_id, goal_id, position, statement)
             VALUES ($1, $2, $3, 2, 'Cross-Organization criterion')`,
            [otherOrganizationId, projectId, goalId],
          ),
        /foreign key/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO goals
               (organization_id, project_id, title,
                problem_statement, desired_outcome, version)
             VALUES ($1, $2, 'Invalid', 'Invalid version', 'Rejected', 0)`,
            [organizationId, projectId],
          ),
        /check constraint/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO acceptance_criteria
               (organization_id, project_id, goal_id, position, statement)
             VALUES ($1, $2, $3, 1, 'Duplicate position')`,
            [organizationId, projectId, goalId],
          ),
        /unique constraint/i,
      );
    } finally {
      await pool.query(
        "DELETE FROM acceptance_criteria WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM goals WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM repositories WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM projects WHERE organization_id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
      await pool.query(
        "DELETE FROM organizations WHERE id IN ($1, $2)",
        [organizationId, otherOrganizationId],
      );
    }
  },
);

integrationTest(
  "enforces immutable planning history and Goal-scoped dependencies",
  async () => {
    const client = await pool.connect();
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const otherGoalId = crypto.randomUUID();
    const specRevisionId = crypto.randomUUID();
    const otherSpecRevisionId = crypto.randomUUID();
    const firstIssueId = crypto.randomUUID();
    const secondIssueId = crypto.randomUUID();
    const otherIssueId = crypto.randomUUID();
    const clarificationId = crypto.randomUUID();
    const clarificationRoundId = crypto.randomUUID();
    const clarificationThreadId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    const digest = "a".repeat(64);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, 'Planning Organization')`,
        [organizationId, `planning-${process.pid}`],
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, 'Planning Project')`,
        [projectId, organizationId, `planning-${process.pid}`],
      );
      await client.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $3, $4, 'Planning Goal', 'Plan safely', 'A valid plan'),
                ($2, $3, $4, 'Other Goal', 'Stay isolated', 'No leakage')`,
        [goalId, otherGoalId, organizationId, projectId],
      );
      await client.query(
        `INSERT INTO spec_revisions
           (id, organization_id, project_id, goal_id, revision,
            source_goal_version, artifact_ref, artifact_digest)
         VALUES ($1, $3, $4, $5, 1, 1, 'artifact://spec/one', $7),
                ($2, $3, $4, $6, 1, 1, 'artifact://spec/two', $7)`,
        [
          specRevisionId,
          otherSpecRevisionId,
          organizationId,
          projectId,
          goalId,
          otherGoalId,
          digest,
        ],
      );
      await client.query(
        `INSERT INTO issues
           (id, organization_id, project_id, goal_id, spec_revision_id,
            issue_key, revision, title, body_ref, body_digest)
         VALUES ($1, $4, $5, $6, $7, 'PLAN-1', 1,
                 'First issue', 'artifact://issue/one', $9),
                ($2, $4, $5, $6, $7, 'PLAN-2', 1,
                 'Second issue', 'artifact://issue/two', $9),
                ($3, $4, $5, $8, $10, 'OTHER-1', 1,
                 'Other issue', 'artifact://issue/other', $9)`,
        [
          firstIssueId,
          secondIssueId,
          otherIssueId,
          organizationId,
          projectId,
          goalId,
          specRevisionId,
          otherGoalId,
          digest,
          otherSpecRevisionId,
        ],
      );
      await client.query(
        `INSERT INTO issue_dependencies
           (organization_id, project_id, goal_id, issue_id, depends_on_issue_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [organizationId, projectId, goalId, secondIssueId, firstIssueId],
      );
      await client.query("SAVEPOINT invalid_dependency");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO issue_dependencies
               (organization_id, project_id, goal_id, issue_id,
                depends_on_issue_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [organizationId, projectId, goalId, firstIssueId, otherIssueId],
          ),
        /foreign key/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_dependency");
      await client.query("SAVEPOINT self_dependency");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO issue_dependencies
               (organization_id, project_id, goal_id, issue_id,
                depends_on_issue_id)
             VALUES ($1, $2, $3, $4, $4)`,
            [organizationId, projectId, goalId, firstIssueId],
          ),
        /check constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT self_dependency");

      await client.query(
        `INSERT INTO clarification_rounds
           (id, organization_id, project_id, goal_id, round_number,
            source_goal_version, planner_run_id, known_facts, uncertainties,
            actor_id, reason)
         VALUES ($1, $2, $3, $4, 1, 1, 'integration-planner-run', '[]', '[]',
                 'integration-actor', 'Generate test questions')`,
        [clarificationRoundId, organizationId, projectId, goalId],
      );
      await client.query(
        `INSERT INTO clarifications
           (id, organization_id, project_id, goal_id, round_id, thread_id,
            revision, status, question, planner_question_id, rationale,
            blocking_level, answer_type, suggested_options,
            source_goal_version, actor_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 'open',
                 'Which boundary applies?', 'boundary', 'Required for scope',
                 'high', 'text', '[]', 1, 'integration-actor', 'Generate')`,
        [
          clarificationId,
          organizationId,
          projectId,
          goalId,
          clarificationRoundId,
          clarificationThreadId,
        ],
      );
      await client.query("SAVEPOINT immutable_clarification");
      await assert.rejects(
        () =>
          client.query(
            "UPDATE clarifications SET question = 'overwritten' WHERE id = $1",
            [clarificationId],
          ),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_clarification");
      await client.query(
        `INSERT INTO clarifications
           (organization_id, project_id, goal_id, round_id, thread_id, revision,
            previous_clarification_id, status, question, planner_question_id,
            rationale, blocking_level, answer_type, suggested_options, answer,
            source_goal_version, actor_id, reason)
         VALUES ($1, $2, $3, $4, $5, 2, $6, 'answered',
                 'Which boundary applies?', 'boundary', 'Required for scope',
                 'high', 'text', '[]', 'The Organization boundary.', 1,
                 'integration-reviewer', 'Confirm scope')`,
        [organizationId, projectId, goalId, clarificationRoundId, clarificationThreadId, clarificationId],
      );

      await client.query(
        `INSERT INTO decisions
           (id, organization_id, project_id, goal_id, decision_key, revision,
            status, subject_type, subject_id, subject_version, outcome, actor_id, reason)
         VALUES ($1, $2, $3, $4, $5, 1, 'approved', 'issue_plan', $6, 1,
                 'Use the Goal-scoped dependency graph',
                 'integration-reviewer', 'Cross-Goal dependencies are not allowed')`,
        [
          decisionId,
          organizationId,
          projectId,
          goalId,
          crypto.randomUUID(),
          specRevisionId,
        ],
      );
      await client.query("SAVEPOINT immutable_decision");
      await assert.rejects(
        () => client.query("DELETE FROM decisions WHERE id = $1", [decisionId]),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_decision");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
);

integrationTest(
  "enforces evidence, audit, Outbox, and idempotency invariants",
  async () => {
    const client = await pool.connect();
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const specRevisionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const evidenceId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const digest = "b".repeat(64);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, 'Reliability Organization')`,
        [organizationId, `reliability-${process.pid}`],
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, 'Reliability Project')`,
        [projectId, organizationId, `reliability-${process.pid}`],
      );
      await client.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $2, $3, 'Reliable writes',
                 'Events need durable evidence', 'Trace every write')`,
        [goalId, organizationId, projectId],
      );
      await client.query(
        `INSERT INTO spec_revisions
           (id, organization_id, project_id, goal_id, revision,
            source_goal_version, artifact_ref, artifact_digest)
         VALUES ($1, $2, $3, $4, 1, 1, 'artifact://spec/reliable', $5)`,
        [specRevisionId, organizationId, projectId, goalId, digest],
      );
      await client.query(
        `INSERT INTO issues
           (id, organization_id, project_id, goal_id, spec_revision_id,
            issue_key, revision, title, body_ref, body_digest)
         VALUES ($1, $2, $3, $4, $5, 'RELIABLE-1', 1,
                 'Reliable issue', 'artifact://issue/reliable', $6)`,
        [issueId, organizationId, projectId, goalId, specRevisionId, digest],
      );
      await client.query(
        `INSERT INTO runs
           (id, organization_id, project_id, goal_id, issue_id,
            attempt, request_id)
         VALUES ($1, $2, $3, $4, $5, 1, 'req-reliability')`,
        [runId, organizationId, projectId, goalId, issueId],
      );
      await client.query("SAVEPOINT duplicate_attempt");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO runs
               (organization_id, project_id, goal_id, issue_id,
                attempt, request_id)
             VALUES ($1, $2, $3, $4, 1, 'req-duplicate')`,
            [organizationId, projectId, goalId, issueId],
          ),
        /unique constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate_attempt");

      await client.query(
        `INSERT INTO evidence
           (id, organization_id, project_id, goal_id, issue_id, run_id,
            kind, artifact_ref, digest, media_type, size_bytes,
            retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, 'test',
                 'artifact://evidence/test', $7, 'application/json', 128,
                 '2030-01-01T00:00:00Z')`,
        [evidenceId, organizationId, projectId, goalId, issueId, runId, digest],
      );
      await client.query("SAVEPOINT immutable_evidence");
      await assert.rejects(
        () =>
          client.query("UPDATE evidence SET size_bytes = 129 WHERE id = $1", [
            evidenceId,
          ]),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_evidence");

      await client.query(
        `INSERT INTO audit_events
           (id, organization_id, project_id, goal_id, actor_id, action,
            entity_type, entity_id, entity_version, reason, request_id,
            retention_until)
         VALUES ($1, $2, $3, $4, 'actor-1', 'run.queued', 'run', $5, 1,
                 'Start approved work', 'req-reliability',
                 '2030-01-01T00:00:00Z')`,
        [auditEventId, organizationId, projectId, goalId, runId],
      );
      await client.query("SAVEPOINT immutable_audit");
      await assert.rejects(
        () =>
          client.query("DELETE FROM audit_events WHERE id = $1", [auditEventId]),
        /append-only/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_audit");

      await client.query(
        `INSERT INTO outbox_events
           (organization_id, aggregate_type, aggregate_id,
            aggregate_version, event_type, deduplication_key, payload)
         VALUES ($1, 'run', $2, 1, 'run.queued', 'run-queued-once',
                 '{"status":"queued"}'::jsonb)`,
        [organizationId, runId],
      );
      await client.query("SAVEPOINT duplicate_outbox");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO outbox_events
               (organization_id, aggregate_type, aggregate_id,
                aggregate_version, event_type, deduplication_key, payload)
             VALUES ($1, 'run', $2, 1, 'run.queued', 'run-queued-once', '{}')`,
            [organizationId, runId],
          ),
        /unique constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate_outbox");

      await client.query(
        `INSERT INTO idempotency_records
           (organization_id, actor_id, endpoint, key, request_hash, expires_at)
         VALUES ($1, 'actor-1', '/goals/actions', 'idem-1', $2,
                 '2030-01-01T00:00:00Z')`,
        [organizationId, digest],
      );
      await client.query("SAVEPOINT duplicate_idempotency");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO idempotency_records
               (organization_id, actor_id, endpoint, key,
                request_hash, expires_at)
             VALUES ($1, 'actor-1', '/goals/actions', 'idem-1', $2,
                     '2030-01-01T00:00:00Z')`,
            [organizationId, digest],
          ),
        /unique constraint/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate_idempotency");
      await client.query(
        `INSERT INTO idempotency_records
           (organization_id, actor_id, endpoint, key, request_hash, expires_at)
         VALUES ($1, 'actor-2', '/goals/actions', 'idem-1', $2,
                 '2030-01-01T00:00:00Z')`,
        [organizationId, digest],
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
);

integrationTest(
  "persists guarded state transitions with optimistic versions",
  async () => {
    const client = await pool.connect();
    const store = new PostgresVersionedStateStore(client);
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const specRevisionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const digest = "c".repeat(64);
    const occurredAt = new Date(Date.now() + 60_000);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, 'State Organization')`,
        [organizationId, `state-${process.pid}`],
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1, $2, $3, 'State Project')`,
        [projectId, organizationId, `state-${process.pid}`],
      );
      await client.query(
        `INSERT INTO goals
           (id, organization_id, project_id, title,
            problem_statement, desired_outcome)
         VALUES ($1, $2, $3, 'State Goal', 'Prevent races', 'One transition')`,
        [goalId, organizationId, projectId],
      );
      await client.query(
        `INSERT INTO spec_revisions
           (id, organization_id, project_id, goal_id, revision,
            source_goal_version, artifact_ref, artifact_digest)
         VALUES ($1, $2, $3, $4, 1, 1, 'artifact://spec/state', $5)`,
        [specRevisionId, organizationId, projectId, goalId, digest],
      );
      await client.query(
        `INSERT INTO issues
           (id, organization_id, project_id, goal_id, spec_revision_id,
            issue_key, revision, title, body_ref, body_digest)
         VALUES ($1, $2, $3, $4, $5, 'STATE-1', 1,
                 'State issue', 'artifact://issue/state', $6)`,
        [issueId, organizationId, projectId, goalId, specRevisionId, digest],
      );
      await client.query(
        `INSERT INTO runs
           (id, organization_id, project_id, goal_id, issue_id,
            attempt, request_id)
         VALUES ($1, $2, $3, $4, $5, 1, 'req-state')`,
        [runId, organizationId, projectId, goalId, issueId],
      );

      const goalTransition = transitionState({
        machine: goalStateMachine,
        currentState: "draft",
        currentVersion: 1,
        expectedVersion: 1,
        nextState: "clarifying",
        guards: {},
      });
      assert.deepEqual(
        await store.persist({
          entity: "goal",
          id: goalId,
          organizationId,
          projectId,
          expectedVersion: goalTransition.previousVersion,
          nextState: goalTransition.state,
          occurredAt,
        }),
        { state: "clarifying", version: 2 },
      );
      await assert.rejects(
        () =>
          store.persist({
            entity: "goal",
            id: goalId,
            organizationId,
            projectId,
            expectedVersion: 1,
            nextState: "planning",
            occurredAt,
          }),
        (error) => error instanceof VersionConflictError,
      );

      for (const transition of [
        {
          machine: specRevisionStateMachine,
          currentState: "draft",
          nextState: "in_review",
          guards: { artifactDigestVerified: true },
          entity: "specRevision",
          id: specRevisionId,
        },
        {
          machine: issueStateMachine,
          currentState: "draft",
          nextState: "approved",
          guards: { specApproved: true },
          entity: "issue",
          id: issueId,
        },
        {
          machine: runStateMachine,
          currentState: "queued",
          nextState: "running",
          guards: {},
          entity: "run",
          id: runId,
        },
      ]) {
        const result = transitionState({
          machine: transition.machine,
          currentState: transition.currentState,
          currentVersion: 1,
          expectedVersion: 1,
          nextState: transition.nextState,
          guards: transition.guards,
        });
        assert.equal(
          (await store.persist({
            entity: transition.entity,
            id: transition.id,
            organizationId,
            projectId,
            goalId,
            expectedVersion: result.previousVersion,
            nextState: result.state,
            occurredAt,
          })).version,
          2,
        );
      }
      const persisted = await client.query(
        `SELECT g.status AS goal_status, g.version AS goal_version,
                sr.status AS spec_status, i.status AS issue_status,
                r.status AS run_status, r.started_at, r.finished_at
           FROM goals g
           JOIN spec_revisions sr ON sr.goal_id = g.id
           JOIN issues i ON i.spec_revision_id = sr.id
           JOIN runs r ON r.issue_id = i.id
          WHERE g.id = $1`,
        [goalId],
      );
      assert.deepEqual(
        {
          goalStatus: persisted.rows[0].goal_status,
          goalVersion: persisted.rows[0].goal_version,
          specStatus: persisted.rows[0].spec_status,
          issueStatus: persisted.rows[0].issue_status,
          runStatus: persisted.rows[0].run_status,
          hasStarted: persisted.rows[0].started_at instanceof Date,
          finishedAt: persisted.rows[0].finished_at,
        },
        {
          goalStatus: "clarifying",
          goalVersion: 2,
          specStatus: "in_review",
          issueStatus: "approved",
          runStatus: "running",
          hasStarted: true,
          finishedAt: null,
        },
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
);

integrationTest(
  "matches the in-memory GoalRepository contract with PostgreSQL",
  async () => {
    const goal = {
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: "Repository contract",
      status: "draft",
      version: 1,
    };
    const repository = new PostgresGoalRepository(pool);
    await pool.query(
      `INSERT INTO organizations (id, slug, name)
       VALUES ($1, $2, 'Repository Contract Organization')`,
      [goal.organizationId, `repository-contract-${process.pid}`],
    );
    await pool.query(
      `INSERT INTO projects (id, organization_id, slug, name)
       VALUES ($1, $2, $3, 'Repository Contract Project')`,
      [goal.projectId, goal.organizationId, `repository-contract-${process.pid}`],
    );
    await pool.query(
      `INSERT INTO goals
         (id, organization_id, project_id, title,
          problem_statement, desired_outcome, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Hide persistence', 'One stable interface',
               now() - interval '1 second', now() - interval '1 second')`,
      [goal.id, goal.organizationId, goal.projectId, goal.title],
    );
    await assertGoalRepositoryContract({
      repository,
      goal,
      eventCount: async (eventId) =>
        Number((await pool.query(
          "SELECT count(*)::int AS count FROM outbox_events WHERE id = $1",
          [eventId],
        )).rows[0].count),
    });
  },
);

integrationTest(
  "commits Goal, Audit, Outbox, and idempotency once and replays the receipt",
  async () => {
    const scope = await insertReliableGoal("replay");
    const repository = new PostgresGoalRepository(pool);
    const service = reliableService(repository, [
      crypto.randomUUID(),
      crypto.randomUUID(),
    ]);
    const first = await service.transition(reliableCommand(scope));
    const replay = await service.transition(reliableCommand(scope, {
      requestId: "integration-retry",
    }));
    assert.deepEqual(replay, first);
    await assert.rejects(
      () => service.transition(reliableCommand(scope, {
        reason: "A different command must not share the same key",
      })),
      (error) => error instanceof IdempotencyConflictError,
    );

    const persisted = await pool.query(
      `SELECT g.status, g.version,
              (SELECT count(*)::int FROM audit_events ae
                WHERE ae.goal_id = g.id) AS audit_count,
              (SELECT count(*)::int FROM outbox_events oe
                WHERE oe.aggregate_id = g.id) AS outbox_count,
              (SELECT count(*)::int FROM idempotency_records ir
                WHERE ir.organization_id = g.organization_id
                  AND ir.key = 'integration-idempotency') AS idempotency_count
         FROM goals g WHERE g.id = $1`,
      [scope.goalId],
    );
    assert.deepEqual(persisted.rows[0], {
      status: "clarifying",
      version: 2,
      audit_count: 1,
      outbox_count: 1,
      idempotency_count: 1,
    });
    const outbox = await pool.query(
      `SELECT status, attempts, published_at, payload->'receipt' AS receipt
         FROM outbox_events WHERE id = $1`,
      [first.eventId],
    );
    assert.deepEqual(outbox.rows[0], {
      status: "pending",
      attempts: 0,
      published_at: null,
      receipt: first,
    });
  },
);

integrationTest(
  "serializes duplicate commands and rejects concurrent stale versions",
  async () => {
    const duplicateScope = await insertReliableGoal("duplicate-race");
    const duplicateRepository = new PostgresGoalRepository(pool);
    const duplicateCommand = reliableCommand(duplicateScope, {
      idempotencyKey: "same-concurrent-key",
    });
    const duplicateReceipts = await Promise.all([
      reliableService(duplicateRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition(duplicateCommand),
      reliableService(duplicateRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition({ ...duplicateCommand, requestId: "concurrent-retry" }),
    ]);
    assert.deepEqual(duplicateReceipts[1], duplicateReceipts[0]);
    const duplicateCounts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM audit_events WHERE goal_id = $1) AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox,
         (SELECT count(*)::int FROM idempotency_records
           WHERE organization_id = $2 AND key = 'same-concurrent-key') AS idempotency`,
      [duplicateScope.goalId, duplicateScope.organizationId],
    );
    assert.deepEqual(duplicateCounts.rows[0], {
      audits: 1,
      outbox: 1,
      idempotency: 1,
    });

    const conflictScope = await insertReliableGoal("version-race");
    const conflictRepository = new PostgresGoalRepository(pool);
    const results = await Promise.allSettled([
      reliableService(conflictRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition(reliableCommand(conflictScope, {
        idempotencyKey: "version-race-a",
      })),
      reliableService(conflictRepository, [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]).transition(reliableCommand(conflictScope, {
        idempotencyKey: "version-race-b",
        requestId: "version-race-b",
      })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.reason instanceof VersionConflictError);
    const conflictCounts = await pool.query(
      `SELECT g.status, g.version,
              (SELECT count(*)::int FROM audit_events WHERE goal_id = g.id) AS audits,
              (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = g.id) AS outbox,
              (SELECT count(*)::int FROM idempotency_records
                WHERE organization_id = g.organization_id
                  AND key LIKE 'version-race-%') AS idempotency
         FROM goals g WHERE g.id = $1`,
      [conflictScope.goalId],
    );
    assert.deepEqual(conflictCounts.rows[0], {
      status: "clarifying",
      version: 2,
      audits: 1,
      outbox: 1,
      idempotency: 1,
    });
  },
);

integrationTest(
  "rolls back the entire reliable command when Audit insertion fails",
  async () => {
    const scope = await insertReliableGoal("rollback");
    const eventId = crypto.randomUUID();
    const duplicateAuditId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO audit_events
         (id, organization_id, project_id, goal_id, actor_id, action,
          entity_type, entity_id, entity_version, reason, request_id,
          retention_until)
       VALUES ($1, $2, $3, $4, 'fixture', 'fixture.created', 'goal', $4, 1,
               'Create rollback fixture', 'fixture-request', now() + interval '180 days')`,
      [duplicateAuditId, scope.organizationId, scope.projectId, scope.goalId],
    );
    const service = reliableService(new PostgresGoalRepository(pool), [
      eventId,
      duplicateAuditId,
    ]);
    await assert.rejects(
      () => service.transition(reliableCommand(scope, {
        idempotencyKey: "rollback-key",
      })),
      /duplicate key/i,
    );
    const persisted = await pool.query(
      `SELECT g.status, g.version,
              (SELECT count(*)::int FROM audit_events WHERE goal_id = g.id) AS audits,
              (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = g.id) AS outbox,
              (SELECT count(*)::int FROM idempotency_records
                WHERE organization_id = g.organization_id
                  AND key = 'rollback-key') AS idempotency
         FROM goals g WHERE g.id = $1`,
      [scope.goalId],
    );
    assert.deepEqual(persisted.rows[0], {
      status: "draft",
      version: 1,
      audits: 1,
      outbox: 0,
      idempotency: 0,
    });
  },
);

integrationTest(
  "evaluates scoped PostgreSQL roles and audits assignment and revocation",
  async () => {
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const ownerBindingId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, slug, name)
       VALUES ($1, $2, 'RBAC integration organization')`,
      [organizationId, `rbac-org-${process.pid}`],
    );
    await pool.query(
      `INSERT INTO projects (id, organization_id, slug, name)
       VALUES ($1, $2, $3, 'RBAC integration project')`,
      [projectId, organizationId, `rbac-project-${process.pid}`],
    );
    await pool.query(
      `INSERT INTO role_bindings
         (id, organization_id, actor_id, role, assigned_by_actor_id,
          reason, request_id)
       VALUES ($1, $2, 'owner', 'organization_owner', 'bootstrap',
               'Bootstrap the first Owner', 'bootstrap-request')`,
      [ownerBindingId, organizationId],
    );
    const repository = new PostgresRoleBindingRepository(pool);
    const policy = new PolicyEvaluator(repository);
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const service = new RoleBindingApplicationService({
      repository,
      policy,
      clock: () => new Date(),
      idGenerator: () => {
        const id = ids.shift();
        assert.ok(id);
        return id;
      },
    });
    const assigned = await service.assign({
      actorId: "owner",
      organizationId,
      projectId,
      targetActorId: "viewer",
      role: "viewer",
      reason: "Read this project",
      requestId: "rbac-assign",
    });
    assert.equal((await policy.decide({
      actorId: "viewer",
      organizationId,
      projectId,
      permission: "goal.read",
    })).allowed, true);
    assert.equal((await policy.decide({
      actorId: "viewer",
      organizationId,
      projectId,
      permission: "goal.write",
    })).allowed, false);
    await service.revoke({
      actorId: "owner",
      organizationId,
      bindingId: assigned.id,
      reason: "Project access ended",
      requestId: "rbac-revoke",
    });
    assert.equal((await policy.decide({
      actorId: "viewer",
      organizationId,
      projectId,
      permission: "goal.read",
    })).allowed, false);
    const persisted = await pool.query(
      `SELECT rb.version, rb.revoked_at IS NOT NULL AS revoked,
              count(ae.id)::int AS audit_count,
              array_agg(ae.action ORDER BY ae.entity_version) AS actions
         FROM role_bindings rb
         JOIN audit_events ae ON ae.entity_id = rb.id
        WHERE rb.id = $1
        GROUP BY rb.version, rb.revoked_at`,
      [assigned.id],
    );
    assert.deepEqual(persisted.rows[0], {
      version: 2,
      revoked: true,
      audit_count: 2,
      actions: ["role_binding.assigned", "role_binding.revoked"],
    });
  },
);

integrationTest(
  "replaces and reads a real projection with consistent revision and filters",
  async () => {
    const scopeId = `${scopePrefix}_projection`;
    const writer = new NodePostgresWorkbenchProjectionWriter(pool);
    const repository = new PostgresWorkbenchReadRepository(
      new NodePostgresWorkbenchReadStore(pool),
      scopeId,
    );
    const snapshot = {
      ...structuredClone(workbenchSnapshot),
      revision: 204,
      generatedAt: "2026-08-04T06:00:00.000Z",
    };
    await writer.replaceProjection(projectionScope(scopeId), snapshot);

    const firstPage = await repository.getWorkbench(
      projectionVisibility,
      { limit: 2 },
    );
    assert.equal(firstPage.data.revision, 204);
    assert.deepEqual(
      firstPage.data.tasks.map((task) => task.id),
      ["DEV-07", "ORD-02"],
    );
    assert.deepEqual(firstPage.page, { nextCursor: "wb1_2", total: 7 });

    const attentionFirst = await repository.getWorkbench(projectionVisibility, {
      filter: "attention",
      limit: 2,
    });
    const attentionSecond = await repository.getWorkbench(projectionVisibility, {
      filter: "attention",
      limit: 2,
      cursor: attentionFirst.page.nextCursor,
    });
    assert.equal(attentionFirst.page.total, 4);
    assert.equal(attentionFirst.data.tasks.length, 2);
    assert.equal(attentionSecond.data.tasks.length, 2);
    assert.ok(
      [...attentionFirst.data.tasks, ...attentionSecond.data.tasks].every(
        (task) => task.attention.required,
      ),
    );

    assert.equal(
      (await repository.getWorkbench(
        projectionVisibility,
        { goalId: "GOAL-2407" },
      )).page.total,
      4,
    );
    assert.equal(
      (await repository.getWorkbench(
        projectionVisibility,
        { filter: "blocked" },
      )).page.total,
      2,
    );
    assert.equal(
      (await repository.getWorkbench(
        projectionVisibility,
        { filter: "running" },
      )).page.total,
      1,
    );
  },
);

integrationTest("fails on empty projection and invalid cursors", async () => {
  const store = new NodePostgresWorkbenchReadStore(pool);
  const empty = new PostgresWorkbenchReadRepository(
    store,
    `${scopePrefix}_empty`,
  );
  await assert.rejects(
    () => empty.getWorkbench(projectionVisibility, { cursor: "invalid" }),
    /cursor/i,
  );

  const populated = new PostgresWorkbenchReadRepository(
    store,
    `${scopePrefix}_projection`,
  );
  await assert.rejects(
    () => populated.getWorkbench(projectionVisibility, { cursor: "invalid" }),
    /cursor/i,
  );
  await assert.rejects(
    () => populated.getWorkbench(
      projectionVisibility,
      { cursor: "wb1_999" },
    ),
    /cursor/i,
  );
});

integrationTest(
  "isolates content, totals, summaries, Goal filters, and ETags across organizations",
  async () => {
    const scopeId = `${scopePrefix}_visibility`;
    const organizationA = "50000000-0000-4000-8000-000000000001";
    const organizationB = "50000000-0000-4000-8000-000000000002";
    const projectA1 = "60000000-0000-4000-8000-000000000001";
    const projectA2 = "60000000-0000-4000-8000-000000000002";
    const projectB = "60000000-0000-4000-8000-000000000003";
    const writer = new NodePostgresWorkbenchProjectionWriter(pool);
    const repository = new PostgresWorkbenchReadRepository(
      new NodePostgresWorkbenchReadStore(pool),
      scopeId,
    );
    const scopedSnapshot = (revision, task, id, goalId, title) => ({
      ...structuredClone(workbenchSnapshot),
      revision,
      tasks: [{ ...structuredClone(task), id, goalId, title }],
    });
    await writer.replaceProjection(
      { scopeId, organizationId: organizationA, projectId: projectA1 },
      scopedSnapshot(401, workbenchSnapshot.tasks[0], "A1-TASK", "GOAL-A1", "A1 visible"),
    );
    await writer.replaceProjection(
      { scopeId, organizationId: organizationA, projectId: projectA2 },
      scopedSnapshot(402, workbenchSnapshot.tasks[4], "A2-TASK", "GOAL-A2", "A2 visible"),
    );
    await writer.replaceProjection(
      { scopeId, organizationId: organizationB, projectId: projectB },
      scopedSnapshot(499, workbenchSnapshot.tasks[2], "B-TASK", "GOAL-B", "B secret"),
    );

    const visibilityA = {
      actorId: "actor-a",
      organizationIds: [organizationA],
      projectIds: [],
    };
    const visibilityB = {
      actorId: "actor-b",
      organizationIds: [],
      projectIds: [projectB],
    };
    const a = await repository.getWorkbench(visibilityA);
    assert.deepEqual(a.data.tasks.map((task) => task.id), ["A1-TASK", "A2-TASK"]);
    assert.equal(a.page.total, 2);
    assert.equal(a.data.summary.taskCounts.all, 2);
    assert.equal(a.data.summary.taskCounts.attention, 1);
    assert.doesNotMatch(JSON.stringify(a), /B-TASK|B secret|GOAL-B/);

    const guessedGoal = await repository.getWorkbench(
      visibilityA,
      { goalId: "GOAL-B" },
    );
    assert.equal(guessedGoal.page.total, 0);
    assert.equal(guessedGoal.data.summary.taskCounts.all, 0);

    const responseA = await handleWorkbenchRequest(
      new Request("http://localhost/api/v1/workbench"),
      () => repository,
      async () => visibilityA,
    );
    const responseB = await handleWorkbenchRequest(
      new Request("http://localhost/api/v1/workbench", {
        headers: { "if-none-match": responseA.headers.get("etag") ?? "" },
      }),
      () => repository,
      async () => visibilityB,
    );
    assert.equal(responseA.status, 200);
    assert.equal(responseB.status, 200);
    assert.notEqual(responseA.headers.get("etag"), responseB.headers.get("etag"));
    const bodyB = await responseB.json();
    assert.equal(bodyB.page.total, 1);
    assert.equal(bodyB.data.summary.taskCounts.all, 1);
    assert.deepEqual(bodyB.data.tasks.map((task) => task.id), ["B-TASK"]);
  },
);

integrationTest("rolls back a partially failed projection replacement", async () => {
  const scopeId = `${scopePrefix}_rollback`;
  const writer = new NodePostgresWorkbenchProjectionWriter(pool);
  const repository = new PostgresWorkbenchReadRepository(
    new NodePostgresWorkbenchReadStore(pool),
    scopeId,
  );
  await writer.replaceProjection(projectionScope(scopeId), {
    ...structuredClone(workbenchSnapshot),
    revision: 301,
  });

  const invalid = structuredClone(workbenchSnapshot);
  invalid.revision = 302;
  invalid.tasks[0].progress.updatedAt = "not-a-timestamp";
  await assert.rejects(() =>
    writer.replaceProjection(projectionScope(scopeId), invalid)
  );

  const preserved = await repository.getWorkbench(projectionVisibility);
  assert.equal(preserved.data.revision, 301);
  assert.equal(preserved.data.tasks.length, 7);
  assert.equal(preserved.data.tasks[0].id, "DEV-07");
});

integrationTest("surfaces a real PostgreSQL connection failure", async () => {
  const unavailablePool = new Pool({
    connectionString: "postgresql://postgres@127.0.0.1:1/postgres",
    connectionTimeoutMillis: 200,
  });
  const repository = new PostgresWorkbenchReadRepository(
    new NodePostgresWorkbenchReadStore(unavailablePool),
    "unavailable",
  );
  try {
    await assert.rejects(() => repository.getWorkbench(projectionVisibility));
  } finally {
    await unavailablePool.end();
  }
});
