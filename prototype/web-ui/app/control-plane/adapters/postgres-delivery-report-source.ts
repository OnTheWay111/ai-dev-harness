import type {
  DeliveryIssueRun,
  DeliveryReportSource,
} from "../domain/delivery-report.ts";
import type { DeliveryReportSourcePort } from
  "../ports/delivery-report-source-port.ts";
import type { GoalVerificationScope } from
  "../ports/goal-verification-repository.ts";
import type { PostgresPool } from "./postgres-goal-repository.ts";
import { PostgresGoalVerificationRepository } from
  "./postgres-goal-verification-repository.ts";

export class PostgresDeliveryReportSource implements DeliveryReportSourcePort {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async collect(scope: GoalVerificationScope): Promise<DeliveryReportSource> {
    const goal = await new PostgresGoalVerificationRepository(this.pool)
      .getGoal(scope);
    if (!goal) throw new Error("Goal was not found for Delivery Report");
    const result = await this.pool.query<{
      issue_id: string;
      issue_key: string;
      issue_status: string;
      run_id: string | null;
      run_status: string | null;
      artifact_refs: string[];
      review_ids: string[];
      commit_sha: string | null;
      pr_external_id: string | null;
      pr_url: string | null;
      pr_status: string | null;
    }>(
      `SELECT issue.id AS issue_id,issue.issue_key,issue.status AS issue_status,
              run.id AS run_id,run.status AS run_status,
              COALESCE((SELECT jsonb_agg(DISTINCT ref)
                FROM (SELECT 'artifact:'||artifact.id::text AS ref
                        FROM evidence evidence
                        JOIN artifact_objects artifact
                          ON artifact.organization_id=evidence.organization_id
                         AND artifact.project_id=evidence.project_id
                         AND artifact.digest=evidence.digest
                       WHERE evidence.run_id=run.id
                      UNION ALL
                      SELECT 'artifact:sha256:'||artifact.digest AS ref
                        FROM evidence evidence
                        JOIN artifact_objects artifact
                          ON artifact.organization_id=evidence.organization_id
                         AND artifact.project_id=evidence.project_id
                         AND artifact.digest=evidence.digest
                       WHERE evidence.run_id=run.id) refs),'[]'::jsonb) artifact_refs,
              COALESCE((SELECT jsonb_agg(review.id::text)
                          FROM reviews review WHERE review.run_id=run.id
                            AND review.verdict='approved'
                            AND review.target_commit_sha=candidate.commit_sha),'[]'::jsonb) review_ids,
              candidate.commit_sha,pr.external_id AS pr_external_id,
              pr.url AS pr_url,pr.status AS pr_status
         FROM issues issue
         LEFT JOIN LATERAL (
           SELECT * FROM runs candidate_run
            WHERE candidate_run.issue_id=issue.id
            ORDER BY candidate_run.attempt DESC LIMIT 1
         ) run ON TRUE
         LEFT JOIN delivery_candidates candidate ON candidate.run_id=run.id
         LEFT JOIN pull_request_receipts pr ON pr.candidate_id=candidate.id
        WHERE issue.organization_id=$1 AND issue.project_id=$2 AND issue.goal_id=$3
          AND issue.status <> 'cancelled'
        ORDER BY issue.issue_key`,
      [scope.organizationId, scope.projectId, scope.goalId],
    );
    const issueRuns: DeliveryIssueRun[] = result.rows.map((row) => ({
      issueId: row.issue_id,
      issueKey: row.issue_key,
      runId: row.run_id ?? "missing",
      status: row.issue_status === "completed" && row.run_status === "succeeded"
        ? "completed"
        : row.issue_status,
      artifactRefs: row.artifact_refs,
      reviewIds: row.review_ids,
      commitSha: row.commit_sha,
      ...(row.pr_external_id && row.pr_url && row.pr_status
        ? {
            pullRequest: {
              externalId: row.pr_external_id,
              url: row.pr_url,
              status: row.pr_status,
            },
          }
        : {}),
    }));
    return { goal, issueRuns, exceptions: [] };
  }
}
