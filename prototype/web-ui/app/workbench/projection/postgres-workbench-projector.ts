import type { PostgresPool } from
  "../../control-plane/adapters/postgres-goal-repository.ts";
import type { WorkbenchSnapshot } from "../contracts.ts";
import type {
  WorkbenchProjectionCursor,
  WorkbenchProjectionPublisher,
  WorkbenchProjectionSource,
  WorkbenchProjectionState,
} from "./workbench-projection-runner.ts";
import type {
  ExecutionControlProjectionFact,
  ExecutionLeaseProjectionFact,
  ExecutionNodeProjectionFact,
  GoalProjectionFact,
  IssueProjectionFact,
  RunProjectionFact,
  SchedulerJobProjectionFact,
  WorkbenchProjectionFacts,
  WorkbenchProjectionScope,
} from "./workbench-projection.ts";

interface TimestampRow {
  id: string;
  created_at: Date;
}

interface GoalRow {
  id: string;
  title: string;
  status: GoalProjectionFact["status"];
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface IssueRow {
  id: string;
  goal_id: string;
  issue_key: string;
  title: string;
  status: IssueProjectionFact["status"];
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface DependencyRow {
  issue_id: string;
  depends_on_issue_id: string;
  depends_on_issue_key: string;
  satisfied: boolean;
  created_at: Date;
}

interface RunRow {
  id: string;
  issue_id: string;
  status: RunProjectionFact["status"];
  version: number;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

interface JobRow {
  id: string;
  issue_id: string;
  run_id: string;
  state: SchedulerJobProjectionFact["state"];
  phase: string;
  priority: number;
  budget: Record<string, unknown>;
  deadline_at: Date;
  node_id: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface NodeRow {
  id: string;
  name: string;
  status: ExecutionNodeProjectionFact["status"];
  max_concurrent_runs: number;
  offline_after: Date;
  updated_at: Date;
}

interface LeaseRow {
  run_id: string;
  node_id: string;
  status: ExecutionLeaseProjectionFact["status"];
  expires_at: Date;
  heartbeat_at: Date;
}

interface ControlRow {
  scope_type: ExecutionControlProjectionFact["scopeType"];
  state: ExecutionControlProjectionFact["state"];
  circuit_open_until: Date | null;
  updated_at: Date;
}

interface EvidenceCountRow {
  issue_id: string;
  count: string | number;
  updated_at: Date;
}

interface ProjectionRow {
  revision: string | number;
  generated_at: Date;
  summary: WorkbenchSnapshot["summary"];
  snapshot_digest: string;
  last_event_at: Date | null;
  last_event_id: string | null;
}

function taskRows(snapshot: WorkbenchSnapshot) {
  return snapshot.tasks.map((task, rank) => ({
    task,
    rank,
    updatedAt: new Date(task.progress.updatedAt),
  }));
}

function cursorFrom(row: Pick<ProjectionRow, "last_event_at" | "last_event_id">): WorkbenchProjectionCursor | null {
  return row.last_event_at && row.last_event_id
    ? { occurredAt: row.last_event_at.toISOString(), eventId: row.last_event_id }
    : null;
}

export class PostgresWorkbenchProjectionSource
  implements WorkbenchProjectionSource
{
  private readonly pool: PostgresPool;
  private readonly scopeId: string;

  constructor(input: { pool: PostgresPool; scopeId: string }) {
    if (!input.scopeId.trim() || input.scopeId.length > 100) {
      throw new Error("Workbench projection scope ID is required and bounded");
    }
    this.pool = input.pool;
    this.scopeId = input.scopeId;
  }

  async listScopes(): Promise<readonly WorkbenchProjectionScope[]> {
    const result = await this.pool.query<{
      organization_id: string;
      project_id: string;
    }>(
      `SELECT organization_id,id AS project_id
         FROM projects
        ORDER BY organization_id,id`,
      [],
    );
    return result.rows.map((row) => ({
      scopeId: this.scopeId,
      organizationId: row.organization_id,
      projectId: row.project_id,
    }));
  }

  async latestTrigger(
    scope: WorkbenchProjectionScope,
  ): Promise<WorkbenchProjectionCursor | null> {
    const result = await this.pool.query<TimestampRow>(
      `WITH trigger_candidates AS (
         SELECT oe.id,oe.created_at
           FROM outbox_events oe
          WHERE oe.organization_id=$1
            AND (
              (oe.aggregate_type='goal' AND EXISTS (
                SELECT 1 FROM goals g WHERE g.id=oe.aggregate_id AND g.project_id=$2
              )) OR
              (oe.aggregate_type='issue' AND EXISTS (
                SELECT 1 FROM issues i WHERE i.id=oe.aggregate_id AND i.project_id=$2
              )) OR
              (oe.aggregate_type='issue_plan' AND EXISTS (
                SELECT 1 FROM issue_plan_revisions ip WHERE ip.id=oe.aggregate_id AND ip.project_id=$2
              )) OR
              (oe.aggregate_type='run' AND EXISTS (
                SELECT 1 FROM runs r WHERE r.id=oe.aggregate_id AND r.project_id=$2
              )) OR
              (oe.aggregate_type='scheduler_job' AND EXISTS (
                SELECT 1 FROM scheduler_jobs sj WHERE sj.id=oe.aggregate_id AND sj.project_id=$2
              )) OR
              (oe.aggregate_type='execution_control' AND EXISTS (
                SELECT 1 FROM execution_controls ec
                 WHERE ec.id=oe.aggregate_id
                   AND (ec.scope_type='global' OR ec.project_id=$2)
              ))
            )
         UNION ALL
         SELECT id,updated_at FROM goals
          WHERE organization_id=$1 AND project_id=$2
         UNION ALL
         SELECT id,updated_at FROM issues
          WHERE organization_id=$1 AND project_id=$2
         UNION ALL
         SELECT id,updated_at FROM runs
          WHERE organization_id=$1 AND project_id=$2
         UNION ALL
         SELECT id,updated_at FROM scheduler_jobs
          WHERE organization_id=$1 AND project_id=$2
         UNION ALL
         SELECT issue_id AS id,max(created_at) AS created_at
           FROM issue_dependencies
          WHERE organization_id=$1 AND project_id=$2
          GROUP BY issue_id
         UNION ALL
         SELECT node.id,node.heartbeat_at
           FROM execution_nodes node
          WHERE EXISTS (
            SELECT 1 FROM scheduler_jobs job
             WHERE job.node_id=node.id
               AND job.organization_id=$1 AND job.project_id=$2
          )
         UNION ALL
         SELECT lease.id,lease.heartbeat_at
           FROM execution_leases lease
           JOIN runs run ON run.id=lease.run_id
          WHERE run.organization_id=$1 AND run.project_id=$2
         UNION ALL
         SELECT id,created_at FROM evidence
          WHERE organization_id=$1 AND project_id=$2
         UNION ALL
         SELECT id,updated_at FROM execution_controls
          WHERE scope_type='global'
             OR (organization_id=$1 AND project_id=$2)
       )
       SELECT id,created_at
         FROM trigger_candidates
        ORDER BY created_at DESC,id DESC
        LIMIT 1`,
      [scope.organizationId, scope.projectId],
    );
    const row = result.rows[0];
    return row
      ? { occurredAt: row.created_at.toISOString(), eventId: row.id }
      : null;
  }

  async loadFacts(
    scope: WorkbenchProjectionScope,
  ): Promise<WorkbenchProjectionFacts> {
    const parameters = [scope.organizationId, scope.projectId];
    const [goals, issues, dependencies, runs, jobs, nodes, leases, controls, evidence] =
      await Promise.all([
        this.pool.query<GoalRow>(
          `SELECT id,title,status,version,created_at,updated_at
             FROM goals
            WHERE organization_id=$1 AND project_id=$2
            ORDER BY id`,
          parameters,
        ),
        this.pool.query<IssueRow>(
          `SELECT DISTINCT ON (goal_id,issue_key)
                  id,goal_id,issue_key,title,status,version,created_at,updated_at
             FROM issues
            WHERE organization_id=$1 AND project_id=$2
            ORDER BY goal_id,issue_key,revision DESC,id DESC`,
          parameters,
        ),
        this.pool.query<DependencyRow>(
          `SELECT d.issue_id,d.depends_on_issue_id,
                  dependency.issue_key AS depends_on_issue_key,
                  dependency.status='completed' AS satisfied,
                  d.created_at
             FROM issue_dependencies d
             JOIN issues owner ON owner.id=d.issue_id
             JOIN issues dependency ON dependency.id=d.depends_on_issue_id
            WHERE d.organization_id=$1 AND d.project_id=$2
            ORDER BY d.issue_id,dependency.issue_key`,
          parameters,
        ),
        this.pool.query<RunRow>(
          `SELECT DISTINCT ON (issue_id)
                  id,issue_id,status,version,started_at,finished_at,updated_at
             FROM runs
            WHERE organization_id=$1 AND project_id=$2
            ORDER BY issue_id,attempt DESC,id DESC`,
          parameters,
        ),
        this.pool.query<JobRow>(
          `SELECT DISTINCT ON (issue_id)
                  id,issue_id,run_id,state,phase,priority,budget,deadline_at,
                  node_id,failure_code,failure_reason,version,created_at,updated_at
             FROM scheduler_jobs
            WHERE organization_id=$1 AND project_id=$2
            ORDER BY issue_id,attempt DESC,id DESC`,
          parameters,
        ),
        this.pool.query<NodeRow>(
          `SELECT DISTINCT n.id,n.name,n.status,n.max_concurrent_runs,
                  n.offline_after,n.updated_at
             FROM execution_nodes n
             JOIN scheduler_jobs sj ON sj.node_id=n.id
            WHERE sj.organization_id=$1 AND sj.project_id=$2
            ORDER BY n.id`,
          parameters,
        ),
        this.pool.query<LeaseRow>(
          `SELECT l.run_id,l.node_id,l.status,l.expires_at,l.heartbeat_at
             FROM execution_leases l
             JOIN runs r ON r.id=l.run_id
            WHERE r.organization_id=$1 AND r.project_id=$2
            ORDER BY l.run_id,l.acquired_at DESC`,
          parameters,
        ),
        this.pool.query<ControlRow>(
          `SELECT scope_type,state,circuit_open_until,updated_at
             FROM execution_controls
            WHERE scope_type='global'
               OR (organization_id=$1 AND project_id=$2)
            ORDER BY scope_type,updated_at DESC`,
          parameters,
        ),
        this.pool.query<EvidenceCountRow>(
          `SELECT issue_id,count(*)::integer AS count,max(created_at) AS updated_at
             FROM evidence
            WHERE organization_id=$1 AND project_id=$2
            GROUP BY issue_id
            ORDER BY issue_id`,
          parameters,
        ),
      ]);

    return {
      scope,
      goals: goals.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      issues: issues.rows.map((row) => ({
        id: row.id,
        goalId: row.goal_id,
        issueKey: row.issue_key,
        title: row.title,
        status: row.status,
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      dependencies: dependencies.rows.map((row) => ({
        issueId: row.issue_id,
        dependsOnIssueId: row.depends_on_issue_id,
        dependsOnIssueKey: row.depends_on_issue_key,
        satisfied: row.satisfied,
        createdAt: row.created_at.toISOString(),
      })),
      runs: runs.rows.map((row) => ({
        id: row.id,
        issueId: row.issue_id,
        status: row.status,
        version: row.version,
        startedAt: row.started_at?.toISOString() ?? null,
        finishedAt: row.finished_at?.toISOString() ?? null,
        updatedAt: row.updated_at.toISOString(),
      })),
      schedulerJobs: jobs.rows.map((row) => ({
        id: row.id,
        issueId: row.issue_id,
        runId: row.run_id,
        state: row.state,
        phase: row.phase,
        priority: row.priority,
        budget: row.budget,
        deadlineAt: row.deadline_at.toISOString(),
        nodeId: row.node_id,
        failureCode: row.failure_code,
        failureReason: row.failure_reason,
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nodes: nodes.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        maxConcurrentRuns: row.max_concurrent_runs,
        offlineAfter: row.offline_after.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      leases: leases.rows.map((row) => ({
        runId: row.run_id,
        nodeId: row.node_id,
        status: row.status,
        expiresAt: row.expires_at.toISOString(),
        heartbeatAt: row.heartbeat_at.toISOString(),
      })),
      controls: controls.rows.map((row) => ({
        scopeType: row.scope_type,
        state: row.state,
        circuitOpenUntil: row.circuit_open_until?.toISOString() ?? null,
        updatedAt: row.updated_at.toISOString(),
      })),
      evidenceCounts: evidence.rows.map((row) => ({
        issueId: row.issue_id,
        count: Number(row.count),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  }
}

export class PostgresWorkbenchProjectionPublisher
  implements WorkbenchProjectionPublisher
{
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async readState(
    scope: WorkbenchProjectionScope,
  ): Promise<WorkbenchProjectionState | null> {
    const projection = await this.pool.query<ProjectionRow>(
      `SELECT s.revision,s.generated_at,s.summary,c.snapshot_digest,
              c.last_event_at,c.last_event_id
         FROM workbench_snapshots s
         JOIN workbench_projection_checkpoints c
           ON c.scope_id=s.scope_id
          AND c.organization_id=s.organization_id
          AND c.project_id=s.project_id
        WHERE s.scope_id=$1 AND s.organization_id=$2 AND s.project_id=$3`,
      [scope.scopeId, scope.organizationId, scope.projectId],
    );
    const row = projection.rows[0];
    if (!row) return null;
    const tasks = await this.pool.query<{ payload: WorkbenchSnapshot["tasks"][number] }>(
      `SELECT payload
         FROM workbench_tasks
        WHERE scope_id=$1 AND organization_id=$2 AND project_id=$3
        ORDER BY rank,task_id`,
      [scope.scopeId, scope.organizationId, scope.projectId],
    );
    const revision = Number(row.revision);
    return {
      cursor: cursorFrom(row),
      digest: row.snapshot_digest,
      revision,
      snapshot: {
        schemaVersion: "workbench.v1",
        revision,
        generatedAt: row.generated_at.toISOString(),
        summary: row.summary,
        tasks: tasks.rows.map((entry) => entry.payload),
      },
    };
  }

  async publish(input: {
    scope: WorkbenchProjectionScope;
    cursor: WorkbenchProjectionCursor | null;
    digest: string;
    snapshot: WorkbenchSnapshot;
  }): Promise<WorkbenchProjectionState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${input.scope.scopeId}/${input.scope.organizationId}/${input.scope.projectId}`],
      );
      const currentResult = await client.query<ProjectionRow>(
        `SELECT s.revision,s.generated_at,s.summary,c.snapshot_digest,
                c.last_event_at,c.last_event_id
           FROM workbench_snapshots s
           JOIN workbench_projection_checkpoints c
             ON c.scope_id=s.scope_id
            AND c.organization_id=s.organization_id
            AND c.project_id=s.project_id
          WHERE s.scope_id=$1 AND s.organization_id=$2 AND s.project_id=$3
          FOR UPDATE OF s,c`,
        [input.scope.scopeId, input.scope.organizationId, input.scope.projectId],
      );
      const current = currentResult.rows[0];
      if (current?.snapshot_digest === input.digest) {
        await client.query(
          `UPDATE workbench_projection_checkpoints
              SET last_event_at=$4,last_event_id=$5,updated_at=now()
            WHERE scope_id=$1 AND organization_id=$2 AND project_id=$3`,
          [
            input.scope.scopeId,
            input.scope.organizationId,
            input.scope.projectId,
            input.cursor ? new Date(input.cursor.occurredAt) : null,
            input.cursor?.eventId ?? null,
          ],
        );
        await client.query("COMMIT");
        const state = await this.readState(input.scope);
        if (!state) throw new Error("Workbench projection disappeared after checkpoint update");
        return state;
      }

      const revision = Number(current?.revision ?? 0) + 1;
      const snapshot = { ...input.snapshot, revision };
      await client.query(
        `INSERT INTO workbench_snapshots
          (scope_id,organization_id,project_id,revision,generated_at,summary,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())
         ON CONFLICT (scope_id,organization_id,project_id) DO UPDATE SET
           revision=EXCLUDED.revision,
           generated_at=EXCLUDED.generated_at,
           summary=EXCLUDED.summary,
           updated_at=now()`,
        [
          input.scope.scopeId,
          input.scope.organizationId,
          input.scope.projectId,
          revision,
          new Date(snapshot.generatedAt),
          JSON.stringify(snapshot.summary),
        ],
      );
      await client.query(
        `DELETE FROM workbench_tasks
          WHERE scope_id=$1 AND organization_id=$2 AND project_id=$3`,
        [input.scope.scopeId, input.scope.organizationId, input.scope.projectId],
      );
      for (const row of taskRows(snapshot)) {
        await client.query(
          `INSERT INTO workbench_tasks
            (scope_id,organization_id,project_id,task_id,goal_id,priority,
             stage,attention_required,rank,payload,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
          [
            input.scope.scopeId,
            input.scope.organizationId,
            input.scope.projectId,
            row.task.id,
            row.task.goalId,
            row.task.priority,
            row.task.stage,
            row.task.attention.required,
            row.rank,
            JSON.stringify(row.task),
            row.updatedAt,
          ],
        );
      }
      await client.query(
        `INSERT INTO workbench_projection_checkpoints
          (scope_id,organization_id,project_id,revision,snapshot_digest,
           last_event_at,last_event_id,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (scope_id,organization_id,project_id) DO UPDATE SET
           revision=EXCLUDED.revision,
           snapshot_digest=EXCLUDED.snapshot_digest,
           last_event_at=EXCLUDED.last_event_at,
           last_event_id=EXCLUDED.last_event_id,
           updated_at=now()`,
        [
          input.scope.scopeId,
          input.scope.organizationId,
          input.scope.projectId,
          revision,
          input.digest,
          input.cursor ? new Date(input.cursor.occurredAt) : null,
          input.cursor?.eventId ?? null,
        ],
      );
      await client.query("COMMIT");
      return {
        cursor: input.cursor,
        digest: input.digest,
        revision,
        snapshot,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
