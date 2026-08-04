import { ClarificationExpiredError } from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type {
  PlannerConfiguration,
  SpecRevision,
} from "../domain/spec-artifact.ts";
import type { OverdesignReview } from "../domain/overdesign-review.ts";
import type {
  SpecRevisionRepository,
  SpecRevisionScope,
} from "../ports/spec-revision-repository.ts";
import type { GoalWorkspacePool } from "./postgres-goal-workspace-repository.ts";

interface SpecRevisionRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  revision: number;
  previous_revision_id: string | null;
  status: SpecRevision["status"];
  source_goal_version: number;
  artifact_ref: string;
  artifact_digest: string;
  artifact_media_type: "application/json";
  artifact_size_bytes: number | string;
  planner_run_id: string;
  planner_configuration: PlannerConfiguration;
  overdesign_policy_revision: string;
  overdesign_review: OverdesignReview;
  generated_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function values(scope: SpecRevisionScope): readonly string[] {
  return [scope.organizationId, scope.projectId, scope.goalId];
}

function mapRevision(row: SpecRevisionRow): SpecRevision {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    revision: row.revision,
    previousRevisionId: row.previous_revision_id,
    status: row.status,
    sourceGoalVersion: row.source_goal_version,
    artifactRef: row.artifact_ref,
    artifactDigest: row.artifact_digest,
    artifactMediaType: row.artifact_media_type,
    artifactSizeBytes: Number(row.artifact_size_bytes),
    plannerRunId: row.planner_run_id,
    plannerConfiguration: row.planner_configuration,
    overdesignPolicyRevision: row.overdesign_policy_revision,
    overdesignReview: row.overdesign_review,
    generatedAt: row.generated_at.toISOString(),
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresSpecRevisionRepository implements SpecRevisionRepository {
  private readonly pool: GoalWorkspacePool;

  constructor(pool: GoalWorkspacePool) {
    this.pool = pool;
  }

  async list(scope: SpecRevisionScope) {
    const result = await this.pool.query<SpecRevisionRow>(
      `SELECT * FROM spec_revisions
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY revision`,
      values(scope),
    );
    return { revisions: result.rows.map(mapRevision) };
  }

  async append(input: Parameters<SpecRevisionRepository["append"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const goal = await client.query<{ version: number }>(
        `SELECT version FROM goals
          WHERE organization_id=$1 AND project_id=$2 AND id=$3
          FOR UPDATE`,
        values(input.revision),
      );
      if (goal.rows[0]?.version !== input.expectedGoalVersion) {
        throw new ClarificationExpiredError();
      }
      const latest = await client.query<{ id: string }>(
        `SELECT id FROM spec_revisions
          WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
          ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        values(input.revision),
      );
      if ((latest.rows[0]?.id ?? null) !== input.expectedPreviousRevisionId) {
        throw new VersionConflictError();
      }
      const revision = input.revision;
      const inserted = await client.query(
        `INSERT INTO spec_revisions
          (id, organization_id, project_id, goal_id, revision,
           previous_revision_id, status, source_goal_version, artifact_ref,
           artifact_digest, artifact_media_type, artifact_size_bytes,
           planner_run_id, planner_configuration, overdesign_policy_revision,
           overdesign_review, generated_at, version,
           created_at, updated_at)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17,$18,$19,$20)`,
        [
          revision.id,
          revision.organizationId,
          revision.projectId,
          revision.goalId,
          revision.revision,
          revision.previousRevisionId,
          revision.status,
          revision.sourceGoalVersion,
          revision.artifactRef,
          revision.artifactDigest,
          revision.artifactMediaType,
          revision.artifactSizeBytes,
          revision.plannerRunId,
          JSON.stringify(revision.plannerConfiguration),
          revision.overdesignPolicyRevision,
          JSON.stringify(revision.overdesignReview),
          new Date(revision.generatedAt),
          revision.version,
          new Date(revision.createdAt),
          new Date(revision.updatedAt),
        ],
      );
      if (inserted.rowCount !== 1) throw new VersionConflictError();
      await client.query("COMMIT");
      return structuredClone(revision);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        throw new VersionConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
