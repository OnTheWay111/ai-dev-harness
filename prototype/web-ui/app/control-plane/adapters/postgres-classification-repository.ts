import type {
  ClassificationPolicyRevision,
  GoalClassification,
} from "../domain/classification.ts";
import type { ClarificationScope } from "../domain/clarification-history.ts";
import { ClarificationExpiredError } from "../domain/clarification-history.ts";
import { VersionConflictError } from "../domain/errors.ts";
import type { ClassificationRepository } from "../ports/classification-repository.ts";
import type { GoalWorkspacePool } from "./postgres-goal-workspace-repository.ts";

interface PolicyRow {
  id: string; policy_key: string; revision: number; schema_version: string;
  digest: string; definition: Readonly<Record<string, unknown>>; actor_id: string;
  reason: string; created_at: Date;
}
interface ClassificationRow {
  id: string; organization_id: string; project_id: string; goal_id: string;
  revision: number; previous_classification_id: string | null;
  source_goal_version: number; policy_revision_id: string;
  size: GoalClassification["size"]; risk: GoalClassification["risk"];
  size_score: number; risk_score: number;
  matched_factors: GoalClassification["matchedFactors"];
  required_artifacts: GoalClassification["requiredArtifacts"];
  required_approver_roles: GoalClassification["requiredApproverRoles"];
  actor_id: string; reason: string; created_at: Date;
  policy_schema_version: GoalClassification["policySchemaVersion"];
}

const scopeValues = (scope: ClarificationScope) =>
  [scope.organizationId, scope.projectId, scope.goalId] as const;
const mapPolicy = (row: PolicyRow): ClassificationPolicyRevision => ({
  id: row.id, policyKey: row.policy_key, revision: row.revision,
  schemaVersion: row.schema_version, digest: row.digest, definition: row.definition,
  actorId: row.actor_id, reason: row.reason, createdAt: row.created_at.toISOString(),
});
const mapClassification = (row: ClassificationRow): GoalClassification => ({
  id: row.id, organizationId: row.organization_id, projectId: row.project_id,
  goalId: row.goal_id, revision: row.revision,
  previousClassificationId: row.previous_classification_id,
  sourceGoalVersion: row.source_goal_version, policyRevisionId: row.policy_revision_id,
  policySchemaVersion: row.policy_schema_version, size: row.size, risk: row.risk,
  sizeScore: row.size_score, riskScore: row.risk_score,
  matchedFactors: row.matched_factors, requiredArtifacts: row.required_artifacts,
  requiredApproverRoles: row.required_approver_roles, actorId: row.actor_id,
  reason: row.reason, createdAt: row.created_at.toISOString(),
});

export class PostgresClassificationRepository implements ClassificationRepository {
  private readonly pool: GoalWorkspacePool;
  constructor(pool: GoalWorkspacePool) { this.pool = pool; }

  async getTimeline(scope: ClarificationScope) {
    const classifications = await this.pool.query<ClassificationRow>(
      `SELECT c.*, p.schema_version AS policy_schema_version
         FROM classifications c
         JOIN classification_policy_revisions p ON p.id=c.policy_revision_id
        WHERE c.organization_id=$1 AND c.project_id=$2 AND c.goal_id=$3
        ORDER BY c.revision`,
      scopeValues(scope),
    );
    const policies = await this.pool.query<PolicyRow>(
      `SELECT DISTINCT ON (p.revision) p.*
         FROM classification_policy_revisions p
         JOIN classifications c ON c.policy_revision_id=p.id
        WHERE c.organization_id=$1 AND c.project_id=$2 AND c.goal_id=$3
        ORDER BY p.revision`,
      scopeValues(scope),
    );
    return {
      policies: policies.rows.map(mapPolicy),
      classifications: classifications.rows.map(mapClassification),
    };
  }

  async append(input: Parameters<ClassificationRepository["append"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const goal = await client.query<{ version: number }>(
        `SELECT version FROM goals WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        scopeValues(input.classification),
      );
      if (goal.rows[0]?.version !== input.expectedGoalVersion) throw new ClarificationExpiredError();
      const latest = await client.query<{ id: string }>(
        `SELECT id FROM classifications WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        scopeValues(input.classification),
      );
      if ((latest.rows[0]?.id ?? null) !== input.expectedPreviousClassificationId) throw new VersionConflictError();
      const policy = input.policy;
      await client.query(
        `INSERT INTO classification_policy_revisions
          (id, policy_key, revision, schema_version, digest, definition, actor_id, reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
         ON CONFLICT (digest) DO NOTHING`,
        [policy.id, policy.policyKey, policy.revision, policy.schemaVersion,
          policy.digest, JSON.stringify(policy.definition), policy.actorId,
          policy.reason, new Date(policy.createdAt)],
      );
      const storedPolicy = await client.query<PolicyRow>(
        `SELECT * FROM classification_policy_revisions WHERE digest=$1`,
        [policy.digest],
      );
      if (!storedPolicy.rows[0]) throw new VersionConflictError();
      const classification = input.classification;
      await client.query(
        `INSERT INTO classifications
          (id, organization_id, project_id, goal_id, revision,
           previous_classification_id, source_goal_version, policy_revision_id,
           size, risk, size_score, risk_score, matched_factors,
           required_artifacts, required_approver_roles, actor_id, reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18)`,
        [classification.id, classification.organizationId, classification.projectId,
          classification.goalId, classification.revision,
          classification.previousClassificationId, classification.sourceGoalVersion,
          storedPolicy.rows[0].id, classification.size, classification.risk,
          classification.sizeScore, classification.riskScore,
          JSON.stringify(classification.matchedFactors),
          JSON.stringify(classification.requiredArtifacts),
          JSON.stringify(classification.requiredApproverRoles), classification.actorId,
          classification.reason, new Date(classification.createdAt)],
      );
      await client.query("COMMIT");
      return {
        policy: mapPolicy(storedPolicy.rows[0]),
        classification: { ...structuredClone(classification), policyRevisionId: storedPolicy.rows[0].id },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") throw new VersionConflictError();
      throw error;
    } finally { client.release(); }
  }
}
