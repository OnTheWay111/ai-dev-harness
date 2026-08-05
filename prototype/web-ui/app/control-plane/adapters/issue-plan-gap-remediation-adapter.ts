import type { IssuePlanService } from
  "../application/issue-plan-service.ts";
import type { GapRemediationPort } from
  "../application/verification-gap-service.ts";
import type { IssuePlanRepository } from
  "../ports/issue-plan-repository.ts";

export class IssuePlanGapRemediationAdapter implements GapRemediationPort {
  private readonly input: {
    repository: IssuePlanRepository;
    service: Pick<IssuePlanService, "createDraft">;
  };

  constructor(input: {
    repository: IssuePlanRepository;
    service: Pick<IssuePlanService, "createDraft">;
  }) {
    this.input = input;
  }

  async createDraft(command: Parameters<GapRemediationPort["createDraft"]>[0]) {
    const plannerRunId = `gap-remediation:${command.gapReportId}`;
    const recovery = (plan: Awaited<ReturnType<IssuePlanRepository["getLatest"]>>) =>
      plan?.previousPlanId === command.previousIssuePlanId &&
      plan.plannerRunId === plannerRunId &&
      plan.plannerConfiguration.adapter === "goal-verifier-gap"
        ? {
            id: plan.id,
            previousPlanId: plan.previousPlanId,
            revision: plan.revision,
            status: plan.status,
            compilation: { valid: plan.compilation.valid },
            version: plan.version,
          }
        : null;
    const previous = await this.input.repository.get({
      ...command.scope,
      planId: command.previousIssuePlanId,
    });
    const latest = await this.input.repository.getLatest(command.scope);
    const recovered = recovery(latest);
    if (previous && recovered) return recovered;
    if (!previous || latest?.id !== previous.id) {
      throw new Error("Gap remediation source Issue plan is stale");
    }
    let result;
    try {
      result = await this.input.service.createDraft({
        scope: command.scope,
        source: previous.source,
        draft: command.draft,
        plannerRunId,
        plannerConfiguration: {
          adapter: "goal-verifier-gap",
          modelProfile: "human-confirmed-remediation",
          schemaVersion: "issue-plan-draft.v1",
        },
        actorId: command.actorId,
      });
    } catch (error) {
      const raced = recovery(await this.input.repository.getLatest(command.scope));
      if (raced) return raced;
      throw error;
    }
    return {
      id: result.plan.id,
      previousPlanId: result.plan.previousPlanId,
      revision: result.plan.revision,
      status: result.plan.status,
      compilation: { valid: result.plan.compilation.valid },
      version: result.plan.version,
    };
  }
}
