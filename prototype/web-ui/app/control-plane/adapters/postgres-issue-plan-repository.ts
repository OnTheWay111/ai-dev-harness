import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  VersionConflictError,
} from "../domain/errors.ts";
import type { IssuePlan } from "../domain/issue-plan.ts";
import type { IssuePlanApprovalReceipt } from
  "../domain/issue-plan-approval.ts";
import type {
  CommitIssuePlanApproval,
  IssuePlanIdempotencyLookup,
  IssuePlanRepository,
  IssuePlanScope,
} from "../ports/issue-plan-repository.ts";
import type { GoalWorkspacePool } from "./postgres-goal-workspace-repository.ts";

interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

interface PlanRow {
  id: string;
  status: IssuePlan["status"];
  digest: string;
  version: number;
  plan_data: IssuePlan;
  created_at: Date;
  updated_at: Date;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  payload: unknown;
}

function scopeValues(scope: IssuePlanScope): readonly string[] {
  return [scope.organizationId, scope.projectId, scope.goalId];
}

function mapPlan(row: PlanRow): IssuePlan {
  if (!row.plan_data || row.plan_data.id !== row.id || row.plan_data.digest !== row.digest) {
    throw new Error("Issue plan row metadata does not match its immutable content");
  }
  return {
    ...structuredClone(row.plan_data),
    status: row.status,
    digest: row.digest,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function receiptFromPayload(payload: unknown): IssuePlanApprovalReceipt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const receipt = (payload as Record<string, unknown>).receipt;
  return receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? structuredClone(receipt) as IssuePlanApprovalReceipt
    : null;
}

async function findReceipt(
  executor: SqlExecutor,
  lookup: IssuePlanIdempotencyLookup,
): Promise<IssuePlanApprovalReceipt | null> {
  const result = await executor.query<IdempotencyRow>(
    `SELECT ir.request_hash, ir.status, oe.payload
       FROM idempotency_records ir
       LEFT JOIN outbox_events oe ON oe.id::text = ir.response_ref
      WHERE ir.organization_id=$1 AND ir.actor_id=$2
        AND ir.endpoint=$3 AND ir.key=$4`,
    [lookup.organizationId, lookup.actorId, lookup.endpoint, lookup.key],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== lookup.requestHash) throw new IdempotencyConflictError();
  if (row.status !== "completed") throw new IdempotencyInProgressError();
  const receipt = receiptFromPayload(row.payload);
  if (!receipt) throw new IdempotencyInProgressError();
  return receipt;
}

export class PostgresIssuePlanRepository implements IssuePlanRepository {
  private readonly pool: GoalWorkspacePool;

  constructor(pool: GoalWorkspacePool) {
    this.pool = pool;
  }

  async list(scope: IssuePlanScope) {
    const result = await this.pool.query<PlanRow>(
      `SELECT id, status, digest, version, plan_data, created_at, updated_at
         FROM issue_plan_revisions
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY revision, id`,
      scopeValues(scope),
    );
    return { plans: result.rows.map(mapPlan) };
  }

  async get(scope: IssuePlanScope & { planId: string }) {
    const result = await this.pool.query<PlanRow>(
      `SELECT id, status, digest, version, plan_data, created_at, updated_at
         FROM issue_plan_revisions
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND id=$4`,
      [...scopeValues(scope), scope.planId],
    );
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  async getLatest(scope: IssuePlanScope) {
    const result = await this.pool.query<PlanRow>(
      `SELECT id, status, digest, version, plan_data, created_at, updated_at
         FROM issue_plan_revisions
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY revision DESC, id DESC LIMIT 1`,
      scopeValues(scope),
    );
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  async append(input: { plan: IssuePlan; expectedPreviousPlanId: string | null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const goal = await client.query(
        `SELECT id FROM goals
          WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        scopeValues(input.plan),
      );
      if (goal.rowCount !== 1) throw new VersionConflictError();
      const latest = await client.query<{ id: string; revision: number }>(
        `SELECT id, revision FROM issue_plan_revisions
          WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
          ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        scopeValues(input.plan),
      );
      const previous = latest.rows[0] ?? null;
      if ((previous?.id ?? null) !== input.expectedPreviousPlanId ||
        input.plan.revision !== (previous?.revision ?? 0) + 1) {
        throw new VersionConflictError();
      }
      await client.query(
        `INSERT INTO issue_plan_revisions
          (id, organization_id, project_id, goal_id, spec_revision_id,
           revision, previous_plan_id, status, source_spec_version,
           source_spec_digest, plan_data, digest, planner_run_id,
           planner_configuration, compiler_policy_revision,
           conflict_policy_revision, model_router_policy_revision,
           generated_at, version, created_at, updated_at)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,
           $15,$16,$17,$18,$19,$20,$21)`,
        [
          input.plan.id, input.plan.organizationId, input.plan.projectId,
          input.plan.goalId, input.plan.source.specRevisionId,
          input.plan.revision, input.plan.previousPlanId, input.plan.status,
          input.plan.source.specRevisionVersion, input.plan.source.specArtifactDigest,
          JSON.stringify(input.plan), input.plan.digest, input.plan.plannerRunId,
          JSON.stringify(input.plan.plannerConfiguration),
          input.plan.compilerPolicyRevision, input.plan.conflictPolicyRevision,
          input.plan.modelRouterPolicyRevision, new Date(input.plan.generatedAt),
          input.plan.version, new Date(input.plan.createdAt), new Date(input.plan.updatedAt),
        ],
      );
      for (const recommendation of input.plan.modelRecommendations) {
        await client.query(
          `INSERT INTO model_recommendations
            (organization_id, project_id, goal_id, issue_plan_id, issue_key,
             capability_tier, reasoning_effort, factors, reasons, override,
             policy_revision, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)`,
          [
            input.plan.organizationId, input.plan.projectId, input.plan.goalId,
            input.plan.id, recommendation.issueKey, recommendation.capabilityTier,
            recommendation.reasoningEffort, JSON.stringify(recommendation.factors),
            JSON.stringify(recommendation.reasons), JSON.stringify(recommendation.override),
            recommendation.policyRevision, new Date(input.plan.createdAt),
          ],
        );
      }
      for (const wave of input.plan.waves) {
        await client.query(
          `INSERT INTO execution_waves
            (organization_id, project_id, goal_id, issue_plan_id, wave_number,
             issue_keys, reasons, created_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
          [
            input.plan.organizationId, input.plan.projectId, input.plan.goalId,
            input.plan.id, wave.number, JSON.stringify(wave.issueKeys),
            JSON.stringify(wave.reasons), new Date(input.plan.createdAt),
          ],
        );
      }
      await client.query("COMMIT");
      return structuredClone(input.plan);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findApprovalReceipt(lookup: IssuePlanIdempotencyLookup) {
    return await findReceipt(this.pool, lookup);
  }

  async commitApproval(input: CommitIssuePlanApproval) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `INSERT INTO idempotency_records
          (organization_id, actor_id, endpoint, key, request_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,GREATEST($6::timestamptz,CURRENT_TIMESTAMP + interval '24 hours'))
         ON CONFLICT (organization_id, actor_id, endpoint, key) DO NOTHING
         RETURNING id`,
        [
          input.idempotency.organizationId, input.idempotency.actorId,
          input.idempotency.endpoint, input.idempotency.key,
          input.idempotency.requestHash, input.idempotency.expiresAt,
        ],
      );
      if (claimed.rowCount !== 1) {
        const replay = await findReceipt(client, input.idempotency);
        if (!replay) throw new IdempotencyInProgressError();
        await client.query("COMMIT");
        return replay;
      }
      const locked = await client.query<{ version: number; status: string }>(
        `SELECT version, status FROM issue_plan_revisions
          WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND id=$4
            AND NOT EXISTS (
              SELECT 1 FROM issue_plan_revisions newer
               WHERE newer.organization_id=$1 AND newer.project_id=$2
                 AND newer.goal_id=$3 AND newer.revision > issue_plan_revisions.revision
            ) FOR UPDATE`,
        [...scopeValues(input.current), input.current.id],
      );
      if (locked.rows[0]?.version !== input.expectedVersion ||
        locked.rows[0]?.status !== input.current.status) throw new VersionConflictError();
      const updated = await client.query(
        `UPDATE issue_plan_revisions
            SET status=$1, plan_data=$2::jsonb, version=version+1, updated_at=$3
          WHERE organization_id=$4 AND project_id=$5 AND goal_id=$6
            AND id=$7 AND version=$8`,
        [
          input.next.status, JSON.stringify(input.next), new Date(input.next.updatedAt),
          input.next.organizationId, input.next.projectId, input.next.goalId,
          input.next.id, input.expectedVersion,
        ],
      );
      if (updated.rowCount !== 1) throw new VersionConflictError();
      const decision = input.decision;
      await client.query(
        `INSERT INTO decisions
          (id, organization_id, project_id, goal_id, decision_key, revision,
           status, subject_type, subject_id, subject_version, outcome,
           actor_id, reason, request_id, policy_revision, affected_item_ids,
           decision_payload, created_at)
         VALUES ($1,$2,$3,$4,$1,1,$5,'issue_plan',$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
        [
          decision.id, decision.organizationId, decision.projectId, decision.goalId,
          decision.decision === "approve" ? "approved" : "rejected",
          decision.issuePlanId, decision.subjectVersion, decision.decision,
          decision.actorId, decision.reason, decision.requestId,
          decision.policyRevision, JSON.stringify(decision.affectedIssueKeys),
          JSON.stringify({ planDigest: decision.planDigest }), new Date(decision.createdAt),
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, organization_id, project_id, goal_id, actor_id, action,
           entity_type, entity_id, entity_version, reason, request_id,
           policy_revision, retention_until, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'issue_plan',$7,$8,$9,$10,$11,$12,$13)`,
        [
          input.audit.id, input.audit.organizationId, input.audit.projectId,
          input.audit.goalId, input.audit.actorId, input.audit.action,
          input.audit.entityId, input.audit.entityVersion, input.audit.reason,
          input.audit.requestId, input.audit.policyRevision,
          new Date(new Date(input.audit.createdAt).getTime() + 365 * 24 * 60 * 60 * 1_000),
          new Date(input.audit.createdAt),
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
         (id, organization_id, aggregate_type, aggregate_id,
           aggregate_version, event_type, deduplication_key, payload)
         VALUES ($1,$2,'issue_plan',$3,$4,$5,$7,$6::jsonb)`,
        [
          input.event.id, input.event.organizationId, input.event.aggregateId,
          input.event.aggregateVersion, input.event.type,
          JSON.stringify({ ...input.event.payload, receipt: input.receipt }),
          input.event.id,
        ],
      );
      const completed = await client.query(
        `UPDATE idempotency_records
            SET status='completed', response_status=200, response_ref=$1,
                response_digest=$2, updated_at=CURRENT_TIMESTAMP
          WHERE organization_id=$3 AND actor_id=$4 AND endpoint=$5 AND key=$6
            AND status='in_progress'`,
        [
          input.event.id, input.idempotency.responseDigest,
          input.idempotency.organizationId, input.idempotency.actorId,
          input.idempotency.endpoint, input.idempotency.key,
        ],
      );
      if (completed.rowCount !== 1) throw new IdempotencyInProgressError();
      await client.query("COMMIT");
      return structuredClone(input.receipt);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        throw new IdempotencyConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
