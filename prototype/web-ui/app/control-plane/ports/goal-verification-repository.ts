import type { AcceptanceVerificationPlan } from
  "../domain/acceptance-verification.ts";
import type { DeliveryReport } from "../domain/delivery-report.ts";
import type { GoalContract } from "../domain/goal-contract.ts";
import type { GoalVerification } from "../domain/goal-verification.ts";
import type {
  GapRemediationReceipt,
  VerificationGapReport,
} from "../domain/verification-gap.ts";

export interface GoalVerificationScope {
  organizationId: string;
  projectId: string;
  goalId: string;
}

export interface GoalVerificationRepository {
  appendPlan(plan: AcceptanceVerificationPlan): Promise<AcceptanceVerificationPlan>;
  getPlan(scope: GoalVerificationScope & { planId: string }): Promise<AcceptanceVerificationPlan | null>;
  listPlans(scope: GoalVerificationScope): Promise<readonly AcceptanceVerificationPlan[]>;
  appendVerification(verification: GoalVerification): Promise<GoalVerification>;
  getVerification(scope: GoalVerificationScope & { verificationId: string }): Promise<GoalVerification | null>;
  listVerifications(scope: GoalVerificationScope): Promise<readonly GoalVerification[]>;
  appendGapReport(report: VerificationGapReport): Promise<VerificationGapReport>;
  getGapReport(scope: GoalVerificationScope & { reportId: string }): Promise<VerificationGapReport | null>;
  findGapReportByVerification(scope: GoalVerificationScope & { verificationId: string }): Promise<VerificationGapReport | null>;
  listGapReports(scope: GoalVerificationScope): Promise<readonly VerificationGapReport[]>;
  findGapRemediation(input: {
    organizationId: string;
    reportId: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<{ requestHash: string; receipt: GapRemediationReceipt } | null>;
  saveGapRemediation(input: {
    organizationId: string;
    reportId: string;
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
    receipt: GapRemediationReceipt;
  }): Promise<GapRemediationReceipt>;
  appendDeliveryReport(report: DeliveryReport): Promise<DeliveryReport>;
  getDeliveryReport(scope: GoalVerificationScope & { reportId: string }): Promise<DeliveryReport | null>;
  listDeliveryReports(scope: GoalVerificationScope): Promise<readonly DeliveryReport[]>;
  acceptDeliveryReport(input: {
    current: DeliveryReport;
    accepted: DeliveryReport;
    expectedGoalVersion: number;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ report: DeliveryReport; goal: GoalContract }>;
  getGoal(scope: GoalVerificationScope): Promise<GoalContract | null>;
  synchronizeGoal(goal: GoalContract): Promise<void>;
}
