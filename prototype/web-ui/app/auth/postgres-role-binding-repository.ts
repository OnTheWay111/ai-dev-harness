import {
  RoleBindingConflictError,
} from "./role-binding-repository.ts";
import type {
  Role,
  RoleBinding,
  RoleBindingRepository,
  RoleChangeAudit,
  RoleScope,
} from "./role-binding-repository.ts";

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface TransactionClient extends SqlExecutor {
  release(): void;
}

export interface RoleBindingPool extends SqlExecutor {
  connect(): Promise<TransactionClient>;
}

interface RoleBindingRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  actor_id: string;
  role: Role;
  version: number;
  created_at: Date;
  revoked_at: Date | null;
}

function mapBinding(row: RoleBindingRow): RoleBinding {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    actorId: row.actor_id,
    role: row.role,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

async function insertAudit(
  executor: SqlExecutor,
  audit: RoleChangeAudit,
): Promise<void> {
  const createdAt = new Date(audit.createdAt);
  const retentionUntil = new Date(
    createdAt.getTime() + 365 * 24 * 60 * 60 * 1000,
  );
  await executor.query(
    `INSERT INTO audit_events
       (id, organization_id, project_id, actor_id, action, entity_type,
        entity_id, entity_version, reason, request_id, retention_until,
        created_at)
     VALUES ($1, $2, $3, $4, $5, 'role_binding', $6, $7, $8, $9, $10, $11)`,
    [
      audit.id,
      audit.organizationId,
      audit.projectId,
      audit.actorId,
      audit.action,
      audit.entityId,
      audit.entityVersion,
      audit.reason,
      audit.requestId,
      retentionUntil,
      createdAt,
    ],
  );
}

export class PostgresRoleBindingRepository implements RoleBindingRepository {
  private readonly pool: RoleBindingPool;

  constructor(pool: RoleBindingPool) {
    this.pool = pool;
  }

  async listActive(scope: RoleScope): Promise<readonly RoleBinding[]> {
    const result = await this.pool.query<RoleBindingRow>(
      `SELECT id, organization_id, project_id, actor_id, role, version,
              created_at, revoked_at
         FROM role_bindings
        WHERE actor_id = $1 AND organization_id = $2 AND revoked_at IS NULL
          AND (project_id IS NULL OR project_id = $3)
        ORDER BY project_id NULLS FIRST, role, id`,
      [scope.actorId, scope.organizationId, scope.projectId ?? null],
    );
    return result.rows.map(mapBinding);
  }

  async get(id: string, organizationId: string): Promise<RoleBinding | null> {
    const result = await this.pool.query<RoleBindingRow>(
      `SELECT id, organization_id, project_id, actor_id, role, version,
              created_at, revoked_at
         FROM role_bindings
        WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : null;
  }

  async assign(input: Readonly<{
    binding: RoleBinding;
    audit: RoleChangeAudit;
  }>): Promise<RoleBinding> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RoleBindingRow>(
        `INSERT INTO role_bindings
           (id, organization_id, project_id, actor_id, role,
            assigned_by_actor_id, reason, request_id, version,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)
         RETURNING id, organization_id, project_id, actor_id, role, version,
                   created_at, revoked_at`,
        [
          input.binding.id,
          input.binding.organizationId,
          input.binding.projectId,
          input.binding.actorId,
          input.binding.role,
          input.audit.actorId,
          input.audit.reason,
          input.audit.requestId,
          new Date(input.binding.createdAt),
        ],
      );
      if (result.rowCount !== 1 || !result.rows[0]) {
        throw new RoleBindingConflictError();
      }
      await insertAudit(client, input.audit);
      await client.query("COMMIT");
      return mapBinding(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(input: Readonly<{
    binding: RoleBinding;
    revokedAt: string;
    audit: RoleChangeAudit;
  }>): Promise<RoleBinding> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RoleBindingRow>(
        `UPDATE role_bindings
            SET revoked_at = $1, version = version + 1, updated_at = $1
          WHERE id = $2 AND organization_id = $3 AND version = $4
            AND revoked_at IS NULL
        RETURNING id, organization_id, project_id, actor_id, role, version,
                  created_at, revoked_at`,
        [
          new Date(input.revokedAt),
          input.binding.id,
          input.binding.organizationId,
          input.binding.version,
        ],
      );
      if (result.rowCount !== 1 || !result.rows[0]) {
        throw new RoleBindingConflictError();
      }
      await insertAudit(client, input.audit);
      await client.query("COMMIT");
      return mapBinding(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
