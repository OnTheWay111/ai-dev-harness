import { PostgresVersionedStateStore } from
  "./postgres-versioned-state-store.ts";
import type { SqlExecutor } from "./postgres-versioned-state-store.ts";
import type {
  CommitGoalTransition,
  GoalAggregate,
  GoalRepository,
  GoalScope,
} from "../ports/goal-repository.ts";

interface TransactionClient extends SqlExecutor {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(): void;
}

export interface PostgresPool extends SqlExecutor {
  connect(): Promise<TransactionClient>;
}

interface GoalRow {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  status: GoalAggregate["status"];
  version: number;
}

function mapGoal(row: GoalRow): GoalAggregate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    version: row.version,
  };
}

export class PostgresGoalRepository implements GoalRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async get(scope: GoalScope): Promise<GoalAggregate | null> {
    const result = await this.pool.query<GoalRow>(
      `SELECT id, organization_id, project_id, title, status, version
         FROM goals
        WHERE id = $1 AND organization_id = $2 AND project_id = $3`,
      [scope.id, scope.organizationId, scope.projectId],
    );
    return result.rows[0] ? mapGoal(result.rows[0]) : null;
  }

  async commitTransition(
    command: CommitGoalTransition,
  ): Promise<GoalAggregate> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const persisted = await new PostgresVersionedStateStore(client).persist({
        entity: "goal",
        id: command.current.id,
        organizationId: command.current.organizationId,
        projectId: command.current.projectId,
        expectedVersion: command.expectedVersion,
        nextState: command.nextState,
        occurredAt: command.occurredAt,
      });
      await client.query(
        `INSERT INTO outbox_events
           (id, organization_id, aggregate_type, aggregate_id,
            aggregate_version, event_type, deduplication_key, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          command.event.id,
          command.event.organizationId,
          command.event.aggregateType,
          command.event.aggregateId,
          command.event.aggregateVersion,
          command.event.type,
          command.event.id,
          JSON.stringify(command.event.payload),
        ],
      );
      await client.query("COMMIT");
      return {
        ...command.current,
        status: persisted.state as GoalAggregate["status"],
        version: persisted.version,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
