import { randomUUID } from "node:crypto";

import type { AcceptanceVerificationPlan } from
  "../domain/acceptance-verification.ts";
import { acceptanceVerificationPlanSchemaVersion } from
  "../domain/acceptance-verification.ts";
import type { DeliveryReport } from "../domain/delivery-report.ts";
import { deliveryReportSchemaVersion } from "../domain/delivery-report.ts";
import type { GoalContract } from "../domain/goal-contract.ts";
import type { GoalVerification } from "../domain/goal-verification.ts";
import { goalVerificationSchemaVersion } from
  "../domain/goal-verification.ts";
import type {
  GapRemediationReceipt,
  VerificationGapReport,
} from "../domain/verification-gap.ts";
import { verificationGapReportSchemaVersion } from
  "../domain/verification-gap.ts";
import type {
  GoalVerificationRepository,
  GoalVerificationScope,
} from "../ports/goal-verification-repository.ts";
import type { PostgresPool } from "./postgres-goal-repository.ts";
import type { SqlExecutor } from "./postgres-versioned-state-store.ts";

interface PlanRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  goal_version: number;
  issue_plan_id: string;
  issue_plan_version: number;
  revision: number;
  previous_plan_id: string | null;
  entries: AcceptanceVerificationPlan["entries"];
  compilation: AcceptanceVerificationPlan["compilation"];
  digest: string;
  compiled_at: Date;
  version: number;
}

interface VerificationRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  verification_plan_id: string;
  issue_plan_id: string;
  revision: number;
  previous_verification_id: string | null;
  goal_version: number;
  verdict: GoalVerification["verdict"];
  deterministic_results: GoalVerification["deterministicResults"];
  verifier_output: GoalVerification["verifierOutput"];
  verifier_identity: string;
  verifier_version: string;
  session_id: string;
  verified_at: Date;
  version: number;
}

interface GapRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  verification_id: string;
  issue_plan_id: string;
  failed_criterion_refs: string[];
  preserved_evidence_refs: string[];
  gaps: VerificationGapReport["gaps"];
  created_by: string;
  created_at: Date;
  version: number;
}

interface ReportRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal_id: string;
  revision: number;
  previous_report_id: string | null;
  verification_id: string;
  verification_plan_id: string;
  issue_plan_id: string;
  goal_snapshot: GoalContract;
  acceptance: DeliveryReport["acceptance"];
  issue_runs: DeliveryReport["issueRuns"];
  exceptions: DeliveryReport["exceptions"];
  known_risks: DeliveryReport["knownRisks"];
  regression_risks: DeliveryReport["regressionRisks"];
  status: DeliveryReport["status"];
  human_acceptance: DeliveryReport["humanAcceptance"];
  digest: string;
  generated_by: string;
  generated_at: Date;
  version: number;
}

function mapPlan(row: PlanRow): AcceptanceVerificationPlan {
  return {
    schemaVersion: acceptanceVerificationPlanSchemaVersion,
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    goalVersion: row.goal_version,
    issuePlanId: row.issue_plan_id,
    issuePlanVersion: row.issue_plan_version,
    revision: row.revision,
    previousPlanId: row.previous_plan_id,
    entries: structuredClone(row.entries),
    compilation: structuredClone(row.compilation),
    digest: row.digest,
    compiledAt: row.compiled_at.toISOString(),
    version: row.version,
  };
}

function mapVerification(row: VerificationRow): GoalVerification {
  return {
    schemaVersion: goalVerificationSchemaVersion,
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    verificationPlanId: row.verification_plan_id,
    issuePlanId: row.issue_plan_id,
    revision: row.revision,
    previousVerificationId: row.previous_verification_id,
    goalVersion: row.goal_version,
    verdict: row.verdict,
    deterministicResults: structuredClone(row.deterministic_results),
    verifierOutput: structuredClone(row.verifier_output),
    verifierIdentity: row.verifier_identity,
    verifierVersion: row.verifier_version,
    sessionId: row.session_id,
    verifiedAt: row.verified_at.toISOString(),
    version: row.version,
  };
}

function mapGap(row: GapRow): VerificationGapReport {
  return {
    schemaVersion: verificationGapReportSchemaVersion,
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    verificationId: row.verification_id,
    issuePlanId: row.issue_plan_id,
    failedCriterionRefs: structuredClone(row.failed_criterion_refs),
    preservedEvidenceRefs: structuredClone(row.preserved_evidence_refs),
    gaps: structuredClone(row.gaps),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

function mapReport(row: ReportRow): DeliveryReport {
  return {
    schemaVersion: deliveryReportSchemaVersion,
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    revision: row.revision,
    previousReportId: row.previous_report_id,
    verificationId: row.verification_id,
    verificationPlanId: row.verification_plan_id,
    issuePlanId: row.issue_plan_id,
    goal: structuredClone(row.goal_snapshot),
    acceptance: structuredClone(row.acceptance),
    issueRuns: structuredClone(row.issue_runs),
    exceptions: structuredClone(row.exceptions),
    knownRisks: structuredClone(row.known_risks),
    regressionRisks: structuredClone(row.regression_risks),
    status: row.status,
    humanAcceptance: structuredClone(row.human_acceptance),
    digest: row.digest,
    generatedBy: row.generated_by,
    generatedAt: row.generated_at.toISOString(),
    version: row.version,
  };
}

const scopeValues = (scope: GoalVerificationScope) => [
  scope.organizationId,
  scope.projectId,
  scope.goalId,
];

async function readGoal(
  executor: SqlExecutor,
  scope: GoalVerificationScope,
  lock = false,
): Promise<GoalContract | null> {
  if (lock) {
    const locked = await executor.query(
      `SELECT id FROM goals
        WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
      scopeValues(scope),
    );
    if (locked.rowCount !== 1) return null;
  }
  const result = await executor.query<{
    id: string;
    organization_id: string;
    project_id: string;
    title: string;
    problem_statement: string;
    desired_outcome: string;
    non_goals: string[];
    constraints: string[];
    status: GoalContract["status"];
    version: number;
    created_at: Date;
    updated_at: Date;
    acceptance_criteria: GoalContract["acceptanceCriteria"];
  }>(
    `SELECT goal.*,
       COALESCE(jsonb_agg(jsonb_build_object(
         'id',criterion.id,'position',criterion.position,
         'statement',criterion.statement,'version',criterion.version
       ) ORDER BY criterion.position) FILTER (WHERE criterion.id IS NOT NULL),'[]'::jsonb)
       AS acceptance_criteria
       FROM goals goal
       LEFT JOIN acceptance_criteria criterion
         ON criterion.organization_id=goal.organization_id
        AND criterion.project_id=goal.project_id AND criterion.goal_id=goal.id
      WHERE goal.organization_id=$1 AND goal.project_id=$2 AND goal.id=$3
      GROUP BY goal.id
      `,
    scopeValues(scope),
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    problemStatement: row.problem_statement,
    desiredOutcome: row.desired_outcome,
    acceptanceCriteria: structuredClone(row.acceptance_criteria),
    nonGoals: structuredClone(row.non_goals),
    constraints: structuredClone(row.constraints),
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  } : null;
}

export class PostgresGoalVerificationRepository
implements GoalVerificationRepository {
  private readonly pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.pool = pool;
  }

  async appendPlan(plan: AcceptanceVerificationPlan) {
    await this.pool.query(
      `INSERT INTO acceptance_verification_plans
       (id,organization_id,project_id,goal_id,goal_version,issue_plan_id,
        issue_plan_version,revision,previous_plan_id,entries,compilation,digest,
        compiled_at,version,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$13)`,
      [
        plan.id, plan.organizationId, plan.projectId, plan.goalId,
        plan.goalVersion, plan.issuePlanId, plan.issuePlanVersion, plan.revision,
        plan.previousPlanId, JSON.stringify(plan.entries),
        JSON.stringify(plan.compilation), plan.digest, plan.compiledAt, plan.version,
      ],
    );
    return structuredClone(plan);
  }

  async getPlan(input: GoalVerificationScope & { planId: string }) {
    const result = await this.pool.query<PlanRow>(
      `SELECT * FROM acceptance_verification_plans
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND id=$4`,
      [...scopeValues(input), input.planId],
    );
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  async listPlans(scope: GoalVerificationScope) {
    const result = await this.pool.query<PlanRow>(
      `SELECT * FROM acceptance_verification_plans
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY revision`,
      scopeValues(scope),
    );
    return result.rows.map(mapPlan);
  }

  async appendVerification(verification: GoalVerification) {
    await this.pool.query(
      `INSERT INTO goal_verifications
       (id,organization_id,project_id,goal_id,verification_plan_id,issue_plan_id,
        revision,previous_verification_id,goal_version,verdict,
        deterministic_results,verifier_output,verifier_identity,verifier_version,
        session_id,verified_at,version,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$16)`,
      [
        verification.id, verification.organizationId, verification.projectId,
        verification.goalId, verification.verificationPlanId,
        verification.issuePlanId, verification.revision,
        verification.previousVerificationId, verification.goalVersion,
        verification.verdict, JSON.stringify(verification.deterministicResults),
        JSON.stringify(verification.verifierOutput), verification.verifierIdentity,
        verification.verifierVersion, verification.sessionId,
        verification.verifiedAt, verification.version,
      ],
    );
    return structuredClone(verification);
  }

  async getVerification(
    input: GoalVerificationScope & { verificationId: string },
  ) {
    const result = await this.pool.query<VerificationRow>(
      `SELECT * FROM goal_verifications
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND id=$4`,
      [...scopeValues(input), input.verificationId],
    );
    return result.rows[0] ? mapVerification(result.rows[0]) : null;
  }

  async listVerifications(scope: GoalVerificationScope) {
    const result = await this.pool.query<VerificationRow>(
      `SELECT * FROM goal_verifications
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY revision`,
      scopeValues(scope),
    );
    return result.rows.map(mapVerification);
  }

  async appendGapReport(report: VerificationGapReport) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO verification_gap_reports
         (id,organization_id,project_id,goal_id,verification_id,issue_plan_id,
          failed_criterion_refs,preserved_evidence_refs,gaps,created_by,version,
          created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)`,
        [
          report.id, report.organizationId, report.projectId, report.goalId,
          report.verificationId, report.issuePlanId,
          JSON.stringify(report.failedCriterionRefs),
          JSON.stringify(report.preservedEvidenceRefs), JSON.stringify(report.gaps),
          report.createdBy, report.version, report.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
         (id,organization_id,project_id,goal_id,actor_id,action,entity_type,
          entity_id,entity_version,reason,request_id,policy_revision,
          retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,'verification_gap.created',
                 'verification_gap_report',$6,$7,$8,$9,
                 'goal-verification-gap.v1',$10,$11)`,
        [
          randomUUID(), report.organizationId, report.projectId, report.goalId,
          report.createdBy, report.id, report.version,
          `Verification ${report.verificationId} produced a remediation gap.`,
          `gap-report:${report.id}`,
          new Date(Date.parse(report.createdAt) + 365 * 86_400_000),
          report.createdAt,
        ],
      );
      await client.query("COMMIT");
      return structuredClone(report);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.findGapReportByVerification(report);
        if (existing) return existing;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getGapReport(input: GoalVerificationScope & { reportId: string }) {
    const result = await this.pool.query<GapRow>(
      `SELECT * FROM verification_gap_reports
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND id=$4`,
      [...scopeValues(input), input.reportId],
    );
    return result.rows[0] ? mapGap(result.rows[0]) : null;
  }

  async findGapReportByVerification(
    input: GoalVerificationScope & { verificationId: string },
  ) {
    const result = await this.pool.query<GapRow>(
      `SELECT * FROM verification_gap_reports
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
          AND verification_id=$4`,
      [...scopeValues(input), input.verificationId],
    );
    return result.rows[0] ? mapGap(result.rows[0]) : null;
  }

  async listGapReports(scope: GoalVerificationScope) {
    const result = await this.pool.query<GapRow>(
      `SELECT * FROM verification_gap_reports
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY created_at,id`,
      scopeValues(scope),
    );
    return result.rows.map(mapGap);
  }

  async findGapRemediation(input: {
    organizationId: string;
    reportId: string;
    actorId: string;
    idempotencyKey: string;
  }) {
    const result = await this.pool.query<{
      request_hash: string;
      receipt: GapRemediationReceipt;
    }>(
      `SELECT request_hash,receipt FROM gap_remediation_receipts
        WHERE organization_id=$1 AND report_id=$2 AND actor_id=$3
          AND idempotency_key=$4`,
      [input.organizationId, input.reportId, input.actorId, input.idempotencyKey],
    );
    return result.rows[0] ? {
      requestHash: result.rows[0].request_hash,
      receipt: structuredClone(result.rows[0].receipt),
    } : null;
  }

  async saveGapRemediation(input: {
    organizationId: string;
    reportId: string;
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
    receipt: GapRemediationReceipt;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const report = await client.query<GapRow>(
        `SELECT * FROM verification_gap_reports
          WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
        [input.reportId, input.organizationId],
      );
      const row = report.rows[0];
      if (!row) throw new Error("Verification gap report was not found");
      await client.query(
        `INSERT INTO gap_remediation_receipts
         (id,organization_id,project_id,goal_id,report_id,plan_id,actor_id,
          idempotency_key,request_hash,receipt,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          randomUUID(), row.organization_id, row.project_id, row.goal_id,
          row.id, input.receipt.plan.id, input.actorId, input.idempotencyKey,
          input.requestHash, JSON.stringify(input.receipt), input.receipt.recordedAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
         (id,organization_id,project_id,goal_id,actor_id,action,entity_type,
          entity_id,entity_version,reason,request_id,policy_revision,
          retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,'verification_gap.remediated','issue_plan',
                 $6,$7,$8,$9,'goal-verification-gap.v1',$10,$11)`,
        [
          randomUUID(), row.organization_id, row.project_id, row.goal_id,
          input.actorId, input.receipt.plan.id, input.receipt.plan.version,
          input.receipt.reason, input.idempotencyKey,
          new Date(Date.parse(input.receipt.recordedAt) + 365 * 86_400_000),
          input.receipt.recordedAt,
        ],
      );
      await client.query("COMMIT");
      return structuredClone(input.receipt);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        const replay = await this.findGapRemediation(input);
        if (!replay || replay.requestHash !== input.requestHash) {
          throw new Error("Gap remediation idempotency conflict");
        }
        return replay.receipt;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async appendDeliveryReport(report: DeliveryReport) {
    await this.insertReport(this.pool, report);
    return structuredClone(report);
  }

  private async insertReport(executor: SqlExecutor, report: DeliveryReport) {
    await executor.query(
      `INSERT INTO delivery_reports
       (id,organization_id,project_id,goal_id,revision,previous_report_id,
        verification_id,verification_plan_id,issue_plan_id,goal_snapshot,
        acceptance,issue_runs,exceptions,known_risks,regression_risks,status,
        human_acceptance,digest,generated_by,generated_at,version,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
               $13::jsonb,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18,$19,$20,$21,$20)`,
      [
        report.id, report.organizationId, report.projectId, report.goalId,
        report.revision, report.previousReportId, report.verificationId,
        report.verificationPlanId, report.issuePlanId, JSON.stringify(report.goal),
        JSON.stringify(report.acceptance), JSON.stringify(report.issueRuns),
        JSON.stringify(report.exceptions), JSON.stringify(report.knownRisks),
        JSON.stringify(report.regressionRisks), report.status,
        report.humanAcceptance ? JSON.stringify(report.humanAcceptance) : null,
        report.digest, report.generatedBy, report.generatedAt, report.version,
      ],
    );
  }

  async getDeliveryReport(
    input: GoalVerificationScope & { reportId: string },
  ) {
    const result = await this.pool.query<ReportRow>(
      `SELECT * FROM delivery_reports
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3 AND id=$4`,
      [...scopeValues(input), input.reportId],
    );
    return result.rows[0] ? mapReport(result.rows[0]) : null;
  }

  async listDeliveryReports(scope: GoalVerificationScope) {
    const result = await this.pool.query<ReportRow>(
      `SELECT * FROM delivery_reports
        WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
        ORDER BY revision`,
      scopeValues(scope),
    );
    return result.rows.map(mapReport);
  }

  async acceptDeliveryReport(input: {
    current: DeliveryReport;
    accepted: DeliveryReport;
    expectedGoalVersion: number;
    idempotencyKey: string;
    requestHash: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actorId = input.accepted.humanAcceptance?.actorId;
      if (!actorId) throw new Error("Delivery acceptance actor is missing");
      const operation = await client.query<{
        request_hash: string;
        response_ref: string | null;
        status: string;
      }>(
        `SELECT request_hash,response_ref,status FROM idempotency_records
          WHERE organization_id=$1 AND actor_id=$2
            AND endpoint='delivery_report.accept' AND key=$3 FOR UPDATE`,
        [input.current.organizationId, actorId, input.idempotencyKey],
      );
      if (operation.rows[0]) {
        const stored = operation.rows[0];
        if (stored.request_hash !== input.requestHash) {
          throw new Error("Delivery acceptance idempotency conflict");
        }
        if (stored.status !== "completed" || !stored.response_ref) {
          throw new Error("Delivery acceptance is already in progress");
        }
        const report = await client.query<ReportRow>(
          "SELECT * FROM delivery_reports WHERE id=$1 AND organization_id=$2",
          [stored.response_ref, input.current.organizationId],
        );
        const goal = await readGoal(client, input.current);
        if (!report.rows[0] || !goal) {
          throw new Error("Delivery acceptance replay is unavailable");
        }
        await client.query("COMMIT");
        return { report: mapReport(report.rows[0]), goal };
      }
      await client.query(
        `INSERT INTO idempotency_records
         (id,organization_id,actor_id,endpoint,key,request_hash,status,expires_at,
          created_at,updated_at)
         VALUES ($1,$2,$3,'delivery_report.accept',$4,$5,'in_progress',$6,$7,$7)`,
        [
          randomUUID(), input.current.organizationId, actorId,
          input.idempotencyKey, input.requestHash,
          new Date(Date.parse(input.accepted.generatedAt) + 24 * 60 * 60 * 1_000),
          input.accepted.generatedAt,
        ],
      );
      const latest = await client.query<ReportRow>(
        `SELECT * FROM delivery_reports
          WHERE organization_id=$1 AND project_id=$2 AND goal_id=$3
          ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        scopeValues(input.current),
      );
      const goal = await readGoal(client, input.current, true);
      if (!latest.rows[0] || latest.rows[0].id !== input.current.id ||
        !goal || goal.status !== "verifying" ||
        goal.version !== input.expectedGoalVersion) {
        throw new Error("Delivery acceptance version conflict");
      }
      await this.insertReport(client, input.accepted);
      const updated = await client.query(
        `UPDATE goals SET status='completed',version=version+1,updated_at=$1
          WHERE organization_id=$2 AND project_id=$3 AND id=$4
            AND status='verifying' AND version=$5`,
        [
          input.accepted.generatedAt, input.current.organizationId,
          input.current.projectId, input.current.goalId, input.expectedGoalVersion,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("Goal completion version conflict");
      await client.query(
        `INSERT INTO audit_events
         (id,organization_id,project_id,goal_id,actor_id,action,entity_type,
          entity_id,entity_version,reason,request_id,policy_revision,
          retention_until,created_at)
         VALUES ($1,$2,$3,$4,$5,'delivery_report.accepted','delivery_report',
                 $6,$7,$8,$9,'goal-acceptance.v1',$10,$11)`,
        [
          randomUUID(), input.accepted.organizationId, input.accepted.projectId,
          input.accepted.goalId, input.accepted.humanAcceptance?.actorId,
          input.accepted.id, input.accepted.version,
          input.accepted.humanAcceptance?.reason,
          input.accepted.humanAcceptance?.requestId,
          new Date(Date.parse(input.accepted.generatedAt) + 365 * 86_400_000),
          input.accepted.generatedAt,
        ],
      );
      await client.query(
        `UPDATE idempotency_records
            SET status='completed',response_status=200,response_ref=$1,
                response_digest=$2,updated_at=$3
          WHERE organization_id=$4 AND actor_id=$5
            AND endpoint='delivery_report.accept' AND key=$6
            AND status='in_progress'`,
        [
          input.accepted.id, input.accepted.digest, input.accepted.generatedAt,
          input.accepted.organizationId, actorId, input.idempotencyKey,
        ],
      );
      await client.query("COMMIT");
      return {
        report: structuredClone(input.accepted),
        goal: {
          ...goal,
          status: "completed" as const,
          version: goal.version + 1,
          updatedAt: input.accepted.generatedAt,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getGoal(scope: GoalVerificationScope) {
    return await readGoal(this.pool, scope);
  }

  async synchronizeGoal(goal: GoalContract) {
    const current = await this.getGoal({
      organizationId: goal.organizationId,
      projectId: goal.projectId,
      goalId: goal.id,
    });
    if (!current || current.version !== goal.version) {
      throw new Error("Authoritative Goal does not match Delivery Report source");
    }
  }
}
