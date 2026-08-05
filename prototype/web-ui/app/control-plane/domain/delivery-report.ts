import type { GoalContract } from "./goal-contract.ts";

export const deliveryReportSchemaVersion = "delivery-report.v1" as const;
export type DeliveryReportStatus = "awaiting_human_acceptance" | "accepted";

export interface DeliveryKnownRisk {
  severity: "low" | "medium" | "high" | "critical";
  statement: string;
  disposition: "accepted" | "monitor" | "blocked";
}

export interface DeliveryHumanAcceptance {
  actorId: string;
  role: "approver";
  reason: string;
  requestId: string;
  acceptedAt: string;
}

export interface DeliveryIssueRun {
  issueId: string;
  issueKey: string;
  runId: string;
  status: string;
  artifactRefs: readonly string[];
  reviewIds: readonly string[];
  commitSha: string | null;
  pullRequest?: {
    externalId: string;
    url: string;
    status: string;
  };
}

export interface DeliveryReportAcceptance {
  criterionRef: string;
  statement: string;
  verdict: "passed";
  evidenceRefs: readonly string[];
  rationale: string;
}

export interface DeliveryReport {
  schemaVersion: typeof deliveryReportSchemaVersion;
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  revision: number;
  previousReportId: string | null;
  verificationId: string;
  verificationPlanId: string;
  issuePlanId: string;
  goal: GoalContract;
  acceptance: readonly DeliveryReportAcceptance[];
  issueRuns: readonly DeliveryIssueRun[];
  exceptions: readonly string[];
  knownRisks: readonly DeliveryKnownRisk[];
  regressionRisks: readonly {
    severity: "low" | "medium" | "high" | "critical";
    description: string;
    evidenceRefs: readonly string[];
  }[];
  status: DeliveryReportStatus;
  humanAcceptance: DeliveryHumanAcceptance | null;
  digest: string;
  generatedBy: string;
  generatedAt: string;
  version: number;
}

export interface DeliveryReportSource {
  goal: GoalContract;
  issueRuns: readonly DeliveryIssueRun[];
  exceptions: readonly string[];
}
