import type {
  SchedulerAdmissionCommand,
  SchedulerAdmissionReceipt,
  SchedulerAdmissionRepository,
} from "../ports/scheduler-admission-repository.ts";
import { capabilityTiers } from "../domain/model-router.ts";

export class SchedulerAdmissionService {
  private readonly repository: SchedulerAdmissionRepository;
  private readonly authorizer: {
    authorize(command: SchedulerAdmissionCommand): Promise<void>;
  };

  constructor(input: {
    repository: SchedulerAdmissionRepository;
    authorizer: { authorize(command: SchedulerAdmissionCommand): Promise<void> };
  }) {
    this.repository = input.repository;
    this.authorizer = input.authorizer;
  }

  async admit(command: SchedulerAdmissionCommand): Promise<SchedulerAdmissionReceipt> {
    if (!/^H-\d+$/.test(command.externalTaskId)) {
      throw new Error("A formal AutoDev external task identity is required");
    }
    if (!capabilityTiers.includes(command.requiredCapability)) {
      throw new Error("A supported execution capability is required");
    }
    if (!command.idempotencyKey.trim() || !command.reason.trim()) {
      throw new Error("Admission idempotency and reason are required");
    }
    if (!Number.isSafeInteger(command.maxAttempts) || command.maxAttempts < 1) {
      throw new Error("Admission maxAttempts must be positive");
    }
    const maxRuntimeSeconds = command.budget.maxRuntimeSeconds;
    if (!Number.isSafeInteger(maxRuntimeSeconds) || Number(maxRuntimeSeconds) < 1) {
      throw new Error("Admission runtime budget must be a positive integer");
    }
    const maxCostUsd = command.budget.maxCostUsd;
    if (maxCostUsd !== undefined && (
      typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0
    )) {
      throw new Error("Admission cost budget must be positive");
    }
    if (!Number.isFinite(new Date(command.deadlineAt).getTime())) {
      throw new Error("Admission deadline is invalid");
    }
    await this.authorizer.authorize(command);
    return await this.repository.admit(command);
  }
}
