import type { CapabilityTier } from "../domain/model-router.ts";
import type { SchedulerAdmissionCommand } from
  "../ports/scheduler-admission-repository.ts";
import type { PostgresPool } from "./postgres-goal-repository.ts";

interface ReadyProjectionRow {
  organization_id: string;
  project_id: string;
  goal_id: string;
  issue_id: string;
  issue_version: number;
  external_task_id: string;
  capability_tier: CapabilityTier;
}

export interface SchedulerAdmissionScan {
  actorId: string;
  now: Date;
  maxAttempts: number;
  maxRuntimeSeconds: number;
  maxCostUsd?: number;
  limit: number;
}

export class PostgresSchedulerAdmissionSource {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async listReady(input: SchedulerAdmissionScan): Promise<readonly SchedulerAdmissionCommand[]> {
    if (!input.actorId.trim()) throw new Error("Scheduler admission actor is required");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Scheduler admission batch size must be between 1 and 100");
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new Error("Scheduler admission max attempts must be positive");
    }
    if (!Number.isSafeInteger(input.maxRuntimeSeconds) || input.maxRuntimeSeconds < 1) {
      throw new Error("Scheduler admission runtime budget must be positive");
    }
    if (input.maxCostUsd !== undefined && (
      !Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0
    )) {
      throw new Error("Scheduler admission cost budget must be positive");
    }

    const result = await this.pool.query<ReadyProjectionRow>(
      `SELECT DISTINCT ON (issue.id)
              issue.organization_id,issue.project_id,issue.goal_id,
              issue.id AS issue_id,issue.version AS issue_version,
              task.value->>'externalTaskId' AS external_task_id,
              route.capability_tier
         FROM issues issue
         JOIN issue_plan_revisions plan
           ON plan.organization_id=issue.organization_id
          AND plan.project_id=issue.project_id
          AND plan.goal_id=issue.goal_id
          AND plan.spec_revision_id=issue.spec_revision_id
          AND plan.status='approved'
         JOIN queue_projections projection
           ON projection.organization_id=plan.organization_id
          AND projection.project_id=plan.project_id
          AND projection.goal_id=plan.goal_id
          AND projection.issue_plan_id=plan.id
          AND projection.status='completed'
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(projection.receipt->'tasks')='array'
            THEN projection.receipt->'tasks' ELSE '[]'::jsonb END
        ) AS task(value)
         JOIN model_recommendations route
           ON route.organization_id=plan.organization_id
          AND route.project_id=plan.project_id
          AND route.goal_id=plan.goal_id
          AND route.issue_plan_id=plan.id
          AND route.issue_key=issue.issue_key
        WHERE issue.status='ready'
          AND task.value->>'issueKey'=issue.issue_key
          AND task.value->>'externalTaskId' ~ '^H-[0-9]+$'
          AND NOT EXISTS (
            SELECT 1 FROM issue_dependencies edge
            JOIN issues dependency ON dependency.id=edge.depends_on_issue_id
             WHERE edge.organization_id=issue.organization_id
               AND edge.project_id=issue.project_id
               AND edge.goal_id=issue.goal_id
               AND edge.issue_id=issue.id
               AND dependency.status <> 'completed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_jobs job WHERE job.issue_id=issue.id
          )
        ORDER BY issue.id,projection.created_at DESC
        LIMIT $1`,
      [input.limit],
    );
    const deadlineAt = new Date(
      input.now.getTime() + input.maxRuntimeSeconds * 1000,
    ).toISOString();
    return result.rows.map((row) => {
      const identity = `scheduler-admit:${row.issue_id}:v${row.issue_version}`;
      return {
        organizationId: row.organization_id,
        projectId: row.project_id,
        goalId: row.goal_id,
        issueId: row.issue_id,
        externalTaskId: row.external_task_id,
        requiredCapability: row.capability_tier,
        actorId: input.actorId,
        requestId: identity,
        idempotencyKey: identity,
        reason: "Automatically admit a dependency-ready projected Issue",
        deadlineAt,
        maxAttempts: input.maxAttempts,
        budget: {
          maxRuntimeSeconds: input.maxRuntimeSeconds,
          ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
        },
      };
    });
  }
}
