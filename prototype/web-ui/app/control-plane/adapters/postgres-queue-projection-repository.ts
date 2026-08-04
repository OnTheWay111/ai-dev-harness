import { IdempotencyConflictError } from "../domain/errors.ts";
import type {
  QueueProjectionReceipt,
  QueueProjectionRepository,
} from "../ports/queue-projection-port.ts";
import type { GoalWorkspacePool } from "./postgres-goal-workspace-repository.ts";

interface ProjectionRow {
  issue_plan_id: string;
  plan_digest: string;
  receipt: QueueProjectionReceipt;
}

export class PostgresQueueProjectionRepository implements QueueProjectionRepository {
  private readonly pool: GoalWorkspacePool;

  constructor(pool: GoalWorkspacePool) {
    this.pool = pool;
  }

  async find(input: {
    organizationId: string;
    issuePlanId: string;
    planDigest: string;
    idempotencyKey: string;
  }) {
    const result = await this.pool.query<ProjectionRow>(
      `SELECT issue_plan_id, plan_digest, receipt
         FROM queue_projections
        WHERE organization_id=$1 AND (
          idempotency_key=$2 OR (issue_plan_id=$3 AND plan_digest=$4)
        )
        ORDER BY CASE WHEN idempotency_key=$2 THEN 0 ELSE 1 END
        LIMIT 1`,
      [
        input.organizationId, input.idempotencyKey,
        input.issuePlanId, input.planDigest,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.issue_plan_id !== input.issuePlanId || row.plan_digest !== input.planDigest) {
      throw new IdempotencyConflictError();
    }
    return structuredClone(row.receipt);
  }

  async save(receipt: QueueProjectionReceipt) {
    const result = await this.pool.query<{ receipt: QueueProjectionReceipt }>(
      `INSERT INTO queue_projections
        (organization_id, project_id, goal_id, issue_plan_id, plan_digest,
         idempotency_key, request_id, external_import_id, status, receipt,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9::jsonb,$10,$10)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING receipt`,
      [
        receipt.organizationId, receipt.projectId, receipt.goalId,
        receipt.issuePlanId, receipt.planDigest, receipt.idempotencyKey,
        receipt.requestId, receipt.importId, JSON.stringify(receipt),
        new Date(receipt.projectedAt),
      ],
    );
    if (result.rows[0]) return structuredClone(result.rows[0].receipt);
    const replay = await this.find(receipt);
    if (!replay) throw new IdempotencyConflictError();
    return replay;
  }
}
