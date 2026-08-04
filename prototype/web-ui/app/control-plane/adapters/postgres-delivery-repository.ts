import { randomUUID } from "node:crypto";

import type {
  PostgresPool,
} from "./postgres-goal-repository.ts";
import type { SqlExecutor } from "./postgres-versioned-state-store.ts";
import type {
  DeliveryAuditEvent,
  DeliveryCandidate,
  DeliveryCandidateState,
  LandingReceipt,
  PullRequestReceipt,
  PushReceipt,
} from "../domain/delivery.ts";
import type { DeliveryRepository } from
  "../ports/delivery-repository.ts";

interface CandidateRow {
  id: string;
  organization_id: string;
  project_id: string;
  repository_id: string;
  goal_id: string;
  issue_id: string;
  run_id: string;
  worktree_ref: string;
  baseline_branch: string;
  baseline_sha: string;
  branch: string;
  commit_message: string;
  commit_sha: string | null;
  review_id: string | null;
  state: DeliveryCandidateState;
  version: number;
  push_external_receipt_id: string | null;
  push_remote_name: string | null;
  push_remote_branch: string | null;
  push_commit_sha: string | null;
  pushed_at: Date | null;
  pr_external_id: string | null;
  pr_url: string | null;
  pr_head_branch: string | null;
  pr_base_branch: string | null;
  landing_external_id: string | null;
  landing_commit_sha: string | null;
  landed_at: Date | null;
}

const candidateSelect = `
  candidate.id,candidate.organization_id,candidate.project_id,
  candidate.repository_id,candidate.goal_id,candidate.issue_id,candidate.run_id,
  candidate.worktree_ref,candidate.baseline_branch,candidate.baseline_sha,
  candidate.branch,candidate.commit_message,candidate.commit_sha,
  candidate.review_id,candidate.state,candidate.version,
  push.external_receipt_id AS push_external_receipt_id,
  push.remote_name AS push_remote_name,push.remote_branch AS push_remote_branch,
  push.commit_sha AS push_commit_sha,push.pushed_at,
  pr.external_id AS pr_external_id,pr.url AS pr_url,
  pr.head_branch AS pr_head_branch,pr.base_branch AS pr_base_branch,
  landing.external_id AS landing_external_id,
  landing.landing_commit_sha,landing.landed_at`;

function mapCandidate(row: CandidateRow): DeliveryCandidate {
  const pushReceipt: PushReceipt | undefined = row.push_external_receipt_id &&
      row.push_remote_name && row.push_remote_branch && row.push_commit_sha &&
      row.pushed_at
    ? {
        receiptId: row.push_external_receipt_id,
        remoteName: row.push_remote_name,
        remoteBranch: row.push_remote_branch,
        commitSha: row.push_commit_sha,
        pushedAt: row.pushed_at.toISOString(),
      }
    : undefined;
  const pullRequest: PullRequestReceipt | undefined = row.pr_external_id &&
      row.pr_url && row.pr_head_branch && row.pr_base_branch
    ? {
        externalId: row.pr_external_id,
        url: row.pr_url,
        headBranch: row.pr_head_branch,
        baseBranch: row.pr_base_branch,
      }
    : undefined;
  const landing: LandingReceipt | undefined = row.landing_external_id &&
      row.landing_commit_sha && row.landed_at
    ? {
        externalId: row.landing_external_id,
        landingCommitSha: row.landing_commit_sha,
        landedAt: row.landed_at.toISOString(),
      }
    : undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    goalId: row.goal_id,
    issueId: row.issue_id,
    runId: row.run_id,
    worktreePath: row.worktree_ref,
    baselineBranch: row.baseline_branch,
    baselineSha: row.baseline_sha,
    branch: row.branch,
    commitMessage: row.commit_message,
    commitSha: row.commit_sha,
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    ...(pushReceipt ? { pushReceipt } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(landing ? { landing } : {}),
    state: row.state,
    version: row.version,
  };
}

async function readCandidate(
  executor: SqlExecutor,
  id: string,
  lock = false,
): Promise<DeliveryCandidate | null> {
  const result = await executor.query<CandidateRow>(
    `SELECT ${candidateSelect}
       FROM delivery_candidates candidate
       LEFT JOIN push_receipts push ON push.candidate_id=candidate.id
       LEFT JOIN pull_request_receipts pr ON pr.candidate_id=candidate.id
       LEFT JOIN landing_receipts landing ON landing.candidate_id=candidate.id
      WHERE candidate.id=$1
      ${lock ? "FOR UPDATE OF candidate" : ""}`,
    [id],
  );
  return result.rows[0] ? mapCandidate(result.rows[0]) : null;
}

export class PostgresDeliveryRepository implements DeliveryRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async getCandidate(id: string): Promise<DeliveryCandidate | null> {
    return await readCandidate(this.pool, id);
  }

  async findOperation(
    candidateId: string,
    operationKey: string,
  ): Promise<DeliveryCandidate | null> {
    const result = await this.pool.query<{
      candidate_snapshot: DeliveryCandidate;
    }>(
      `SELECT candidate_snapshot FROM delivery_operation_receipts
        WHERE candidate_id=$1 AND operation_key=$2`,
      [candidateId, operationKey],
    );
    return result.rows[0]
      ? structuredClone(result.rows[0].candidate_snapshot)
      : null;
  }

  async transition(
    input: Parameters<DeliveryRepository["transition"]>[0],
  ): Promise<DeliveryCandidate> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const operation = await client.query<{
        candidate_snapshot: DeliveryCandidate;
      }>(
        `SELECT candidate_snapshot FROM delivery_operation_receipts
          WHERE candidate_id=$1 AND operation_key=$2`,
        [input.candidateId, input.operationKey],
      );
      if (operation.rows[0]) {
        await client.query("COMMIT");
        return structuredClone(operation.rows[0].candidate_snapshot);
      }
      const current = await readCandidate(client, input.candidateId, true);
      if (!current) throw new Error("Delivery candidate was not found");
      if (current.version !== input.expectedVersion) {
        throw new Error("Delivery candidate version conflict");
      }
      if (!input.expectedStates.includes(current.state)) {
        throw new Error(`Delivery transition from ${current.state} is not allowed`);
      }
      await client.query(
        `UPDATE delivery_candidates
            SET state=$1,commit_sha=COALESCE($2,commit_sha),
                review_id=COALESCE($3,review_id),version=version+1,
                updated_at=GREATEST($4,updated_at,created_at)
          WHERE id=$5 AND version=$6`,
        [
          input.nextState, input.patch?.commitSha ?? null,
          input.patch?.reviewId ?? null, input.occurredAt,
          input.candidateId, input.expectedVersion,
        ],
      );
      if (input.patch?.pushReceipt) {
        const receipt = input.patch.pushReceipt;
        await client.query(
          `INSERT INTO push_receipts
            (id,organization_id,project_id,candidate_id,operation_key,
             external_receipt_id,remote_name,remote_branch,commit_sha,
             pushed_at,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
           ON CONFLICT (candidate_id,operation_key) DO NOTHING`,
          [
            randomUUID(), current.organizationId, current.projectId, current.id,
            input.operationKey, receipt.receiptId, receipt.remoteName,
            receipt.remoteBranch, receipt.commitSha, receipt.pushedAt,
          ],
        );
      }
      if (input.patch?.pullRequest) {
        const receipt = input.patch.pullRequest;
        await client.query(
          `INSERT INTO pull_request_receipts
            (id,organization_id,project_id,candidate_id,operation_key,
             external_id,url,head_branch,base_branch,status,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$10)
           ON CONFLICT (candidate_id,operation_key) DO NOTHING`,
          [
            randomUUID(), current.organizationId, current.projectId, current.id,
            input.operationKey, receipt.externalId, receipt.url,
            receipt.headBranch, receipt.baseBranch, input.occurredAt,
          ],
        );
      }
      if (input.patch?.landing) {
        const receipt = input.patch.landing;
        await client.query(
          `INSERT INTO landing_receipts
            (id,organization_id,project_id,candidate_id,operation_key,
             external_id,landing_commit_sha,landed_at,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
           ON CONFLICT (candidate_id,operation_key) DO NOTHING`,
          [
            randomUUID(), current.organizationId, current.projectId, current.id,
            input.operationKey, receipt.externalId,
            receipt.landingCommitSha, receipt.landedAt,
          ],
        );
        await client.query(
          `UPDATE pull_request_receipts
              SET status='merged',updated_at=$1 WHERE candidate_id=$2`,
          [receipt.landedAt, current.id],
        );
      }
      const next = await readCandidate(client, current.id);
      if (!next) throw new Error("Delivery candidate disappeared after transition");
      const retention = new Date(
        Date.parse(input.occurredAt) + 180 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      await client.query(
        `INSERT INTO audit_events
          (id,organization_id,project_id,goal_id,actor_id,action,entity_type,
           entity_id,entity_version,reason,request_id,policy_revision,
           retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'delivery_candidate',$7,$8,$9,$9,
                 'delivery-policy.v1',$10,$11)`,
        [
          randomUUID(), next.organizationId, next.projectId, next.goalId,
          input.actorId, input.action, next.id, next.version,
          input.operationKey, retention, input.occurredAt,
        ],
      );
      await client.query(
        `INSERT INTO delivery_operation_receipts
          (id,organization_id,project_id,candidate_id,operation_key,
           candidate_version,candidate_snapshot,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          randomUUID(), next.organizationId, next.projectId, next.id,
          input.operationKey, next.version, JSON.stringify(next),
          input.occurredAt,
        ],
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rememberOperation(
    candidateId: string,
    operationKey: string,
  ): Promise<DeliveryCandidate> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        candidate_snapshot: DeliveryCandidate;
      }>(
        `SELECT candidate_snapshot FROM delivery_operation_receipts
          WHERE candidate_id=$1 AND operation_key=$2`,
        [candidateId, operationKey],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return structuredClone(existing.rows[0].candidate_snapshot);
      }
      const current = await readCandidate(client, candidateId, true);
      if (!current) throw new Error("Delivery candidate was not found");
      await client.query(
        `INSERT INTO delivery_operation_receipts
          (id,organization_id,project_id,candidate_id,operation_key,
           candidate_version,candidate_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (candidate_id,operation_key) DO NOTHING`,
        [
          randomUUID(), current.organizationId, current.projectId, current.id,
          operationKey, current.version, JSON.stringify(current),
        ],
      );
      await client.query("COMMIT");
      return current;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAuditEvents(
    candidateId: string,
  ): Promise<readonly DeliveryAuditEvent[]> {
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      project_id: string;
      goal_id: string;
      actor_id: string;
      action: string;
      entity_version: number;
      reason: string;
      created_at: Date;
    }>(
      `SELECT id,organization_id,project_id,goal_id,actor_id,action,
              entity_version,reason,created_at
         FROM audit_events
        WHERE entity_type='delivery_candidate' AND entity_id=$1
        ORDER BY created_at,id`,
      [candidateId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      goalId: row.goal_id,
      candidateId,
      actorId: row.actor_id,
      action: row.action,
      entityVersion: row.entity_version,
      operationKey: row.reason,
      occurredAt: row.created_at.toISOString(),
      details: {},
    }));
  }
}
