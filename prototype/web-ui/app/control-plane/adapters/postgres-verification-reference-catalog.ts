import type { VerificationReferenceCatalog } from
  "../domain/acceptance-verification.ts";
import type { GoalVerificationScope } from
  "../ports/goal-verification-repository.ts";
import type { VerificationReferenceCatalogPort } from
  "../ports/verification-reference-catalog-port.ts";
import type { PostgresPool } from "./postgres-goal-repository.ts";

export const builtInVerificationQueries = [
  "query:issues:completed",
  "query:reviews:approved",
  "query:delivery:ready",
] as const;

export class PostgresVerificationReferenceCatalog
implements VerificationReferenceCatalogPort {
  private readonly pool: PostgresPool;
  private readonly commandReferences: readonly string[];

  constructor(input: {
    pool: PostgresPool;
    commandReferences?: readonly string[];
  }) {
    this.pool = input.pool;
    this.commandReferences = [...new Set(input.commandReferences ?? [])];
  }

  async list(scope: GoalVerificationScope): Promise<VerificationReferenceCatalog> {
    const result = await this.pool.query<{ id: string; digest: string }>(
      `SELECT DISTINCT object.id,object.digest,object.created_at
         FROM artifact_objects object
         JOIN evidence evidence
           ON evidence.organization_id=object.organization_id
          AND evidence.project_id=object.project_id
          AND evidence.digest=object.digest
        WHERE evidence.organization_id=$1 AND evidence.project_id=$2
          AND evidence.goal_id=$3
        ORDER BY object.created_at,object.id`,
      [scope.organizationId, scope.projectId, scope.goalId],
    );
    return {
      command: this.commandReferences,
      query: builtInVerificationQueries,
      artifact: result.rows.flatMap(({ id, digest }) => [
        `artifact:${id}`,
        `artifact:sha256:${digest}`,
      ]),
    };
  }
}

export class StaticVerificationReferenceCatalog
implements VerificationReferenceCatalogPort {
  private readonly value: VerificationReferenceCatalog;

  constructor(value: VerificationReferenceCatalog) {
    this.value = structuredClone(value);
  }

  async list(): Promise<VerificationReferenceCatalog> {
    return structuredClone(this.value);
  }
}
