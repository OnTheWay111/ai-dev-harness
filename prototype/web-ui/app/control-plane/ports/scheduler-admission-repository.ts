import type { CapabilityTier } from "../domain/model-router.ts";

export interface SchedulerAdmissionReceipt {
  runId: string;
  jobId: string;
  issueId: string;
  attempt: number;
  admittedAt: string;
}

export interface SchedulerAdmissionCommand {
  organizationId: string;
  projectId: string;
  goalId: string;
  issueId: string;
  externalTaskId: string;
  requiredCapability: CapabilityTier;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  reason: string;
  deadlineAt: string;
  maxAttempts: number;
  budget: Readonly<Record<string, unknown>>;
}

export interface SchedulerAdmissionRepository {
  admit(command: SchedulerAdmissionCommand): Promise<SchedulerAdmissionReceipt>;
}
