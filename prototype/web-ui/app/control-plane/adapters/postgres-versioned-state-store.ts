import type {
  GoalStatus,
  IssueStatus,
  RunStatus,
  SpecRevisionStatus,
} from "../domain/state-machines";
import { VersionConflictError } from "../domain/errors.ts";

export { VersionConflictError } from "../domain/errors.ts";

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface TransitionScope {
  id: string;
  organizationId: string;
  projectId: string;
  expectedVersion: number;
  occurredAt: Date;
}

export type PersistedStateTransition =
  | (TransitionScope & {
    entity: "goal";
    nextState: GoalStatus;
  })
  | (TransitionScope & {
    entity: "specRevision";
    goalId: string;
    nextState: SpecRevisionStatus;
  })
  | (TransitionScope & {
    entity: "issue";
    goalId: string;
    nextState: IssueStatus;
  })
  | (TransitionScope & {
    entity: "run";
    goalId: string;
    nextState: RunStatus;
  });

export interface PersistedState {
  state: string;
  version: number;
}

const goalUpdate = `
  UPDATE goals
     SET status = $1, version = version + 1, updated_at = $2
   WHERE id = $3
     AND organization_id = $4
     AND project_id = $5
     AND version = $6
  RETURNING status, version`;

const specRevisionUpdate = `
  UPDATE spec_revisions
     SET status = $1, version = version + 1, updated_at = $2
   WHERE id = $3
     AND organization_id = $4
     AND project_id = $5
     AND goal_id = $6
     AND version = $7
  RETURNING status, version`;

const issueUpdate = `
  UPDATE issues
     SET status = $1, version = version + 1, updated_at = $2
   WHERE id = $3
     AND organization_id = $4
     AND project_id = $5
     AND goal_id = $6
     AND version = $7
  RETURNING status, version`;

const runUpdate = `
  UPDATE runs
     SET status = $1,
         version = version + 1,
         started_at = CASE
           WHEN $1 = 'running' THEN COALESCE(started_at, $2)
           ELSE started_at
         END,
         finished_at = CASE
           WHEN $1 IN ('succeeded', 'failed', 'cancelled')
             THEN COALESCE(finished_at, $2)
           ELSE NULL
         END,
         updated_at = $2
   WHERE id = $3
     AND organization_id = $4
     AND project_id = $5
     AND goal_id = $6
     AND version = $7
  RETURNING status, version`;

export class PostgresVersionedStateStore {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async persist(command: PersistedStateTransition): Promise<PersistedState> {
    const baseValues = [
      command.nextState,
      command.occurredAt,
      command.id,
      command.organizationId,
      command.projectId,
    ];
    const result = command.entity === "goal"
      ? await this.executor.query<{ status: string; version: number }>(
        goalUpdate,
        [...baseValues, command.expectedVersion],
      )
      : await this.executor.query<{ status: string; version: number }>(
        command.entity === "specRevision"
          ? specRevisionUpdate
          : command.entity === "issue"
          ? issueUpdate
          : runUpdate,
        [...baseValues, command.goalId, command.expectedVersion],
      );
    if (result.rowCount !== 1 || !result.rows[0]) {
      throw new VersionConflictError();
    }
    return { state: result.rows[0].status, version: result.rows[0].version };
  }
}
