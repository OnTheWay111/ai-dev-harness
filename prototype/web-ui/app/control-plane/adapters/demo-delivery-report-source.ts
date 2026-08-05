import type { DeliveryReportSourcePort } from
  "../ports/delivery-report-source-port.ts";
import type { GoalWorkspaceRepository } from
  "../ports/goal-workspace-repository.ts";
import type { IssuePlanRepository } from
  "../ports/issue-plan-repository.ts";

export class DemoDeliveryReportSource implements DeliveryReportSourcePort {
  constructor(private readonly input: {
    goals: Pick<GoalWorkspaceRepository, "get">;
    issuePlans: Pick<IssuePlanRepository, "getLatest">;
  }) {}

  async collect(scope: Parameters<DeliveryReportSourcePort["collect"]>[0]) {
    const [goal, issuePlan] = await Promise.all([
      this.input.goals.get({ id: scope.goalId, ...scope }),
      this.input.issuePlans.getLatest(scope),
    ]);
    if (!goal || !issuePlan) {
      throw new Error("Demo Delivery Report source is incomplete");
    }
    return {
      goal,
      issueRuns: issuePlan.issues.map((issue, index) => ({
        issueId: `${issuePlan.id}:${issue.key}`,
        issueKey: issue.key,
        runId: `demo-run-${index + 1}`,
        status: "completed",
        artifactRefs: [`demo-artifact:${issue.key}`],
        reviewIds: [`demo-review:${issue.key}`],
        commitSha: `${(index + 1).toString(16)}`.repeat(40).slice(0, 40),
      })),
      exceptions: [],
    };
  }
}
