export const verificationGapReportSchemaVersion =
  "verification-gap-report.v1" as const;

export interface VerificationGap {
  sourceKind: "acceptance_criterion" | "non_goal" | "constraint";
  sourceRef: string;
  criterionRef: string | null;
  currentEvidenceRefs: readonly string[];
  gap: string;
  impact: string;
  suggestedRemediation: string;
}

export interface VerificationGapReport {
  schemaVersion: typeof verificationGapReportSchemaVersion;
  id: string;
  organizationId: string;
  projectId: string;
  goalId: string;
  verificationId: string;
  issuePlanId: string;
  failedCriterionRefs: readonly string[];
  preservedEvidenceRefs: readonly string[];
  gaps: readonly VerificationGap[];
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface GapRemediationReceipt {
  reportId: string;
  plan: {
    id: string;
    previousPlanId: string | null;
    revision: number;
    status: string;
    compilation: { valid: boolean };
    version: number;
  };
  preservedEvidenceRefs: readonly string[];
  actorId: string;
  reason: string;
  recordedAt: string;
}
