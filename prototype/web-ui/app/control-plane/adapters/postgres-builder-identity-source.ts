import type { BuilderIdentitySourcePort } from
  "../ports/goal-verifier-port.ts";
import type { PostgresPool } from "./postgres-goal-repository.ts";

export class PostgresBuilderIdentitySource implements BuilderIdentitySourcePort {
  constructor(private readonly pool: PostgresPool) {}

  async list(input: Parameters<BuilderIdentitySourcePort["list"]>[0]) {
    const result = await this.pool.query<{ builder_identity: string }>(
      `SELECT DISTINCT builder_identity FROM reviews
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY builder_identity`,
      [input.organizationId, input.projectId, input.goalId],
    );
    return result.rows.map(({ builder_identity }) => builder_identity);
  }
}
