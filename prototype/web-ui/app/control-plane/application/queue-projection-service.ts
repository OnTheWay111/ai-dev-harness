import type { IssuePlan } from "../domain/issue-plan.ts";
import type {
  QueueProjectionPort,
  QueueProjectionReceipt,
  QueueProjectionRepository,
} from "../ports/queue-projection-port.ts";

export class QueueProjectionService {
  private readonly adapter: QueueProjectionPort;
  private readonly repository: QueueProjectionRepository;
  private readonly authorizer: {
    authorize(input: {
      actorId: string;
      organizationId: string;
      projectId: string;
      permission: "issue.project";
    }): Promise<void>;
  };

  constructor(input: {
    adapter: QueueProjectionPort;
    repository: QueueProjectionRepository;
    authorizer?: {
      authorize(input: {
        actorId: string;
        organizationId: string;
        projectId: string;
        permission: "issue.project";
      }): Promise<void>;
    };
  }) {
    this.adapter = input.adapter;
    this.repository = input.repository;
    this.authorizer = input.authorizer ?? { async authorize() {} };
  }

  async project(command: {
    plan: IssuePlan;
    actorId: string;
    requestId: string;
    idempotencyKey: string;
  }): Promise<QueueProjectionReceipt> {
    await this.authorizer.authorize({
      actorId: command.actorId,
      organizationId: command.plan.organizationId,
      projectId: command.plan.projectId,
      permission: "issue.project",
    });
    if (command.plan.status !== "approved") {
      throw new Error("Only an approved Issue plan can be projected");
    }
    const lookup = {
      organizationId: command.plan.organizationId,
      issuePlanId: command.plan.id,
      planDigest: command.plan.digest,
      idempotencyKey: command.idempotencyKey,
    };
    const replay = await this.repository.find(lookup);
    if (replay) return replay;
    const receipt = await this.adapter.importApprovedPlan({
      plan: command.plan,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
    });
    return await this.repository.save(receipt);
  }
}
