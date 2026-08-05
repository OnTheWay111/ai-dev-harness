import type { GoalVerifierPort } from "../ports/goal-verifier-port.ts";
import { goalVerifierOutputSchemaVersion } from
  "../domain/goal-verification.ts";
import type { DeterministicVerifierPort } from
  "../ports/goal-verifier-port.ts";

export class DemoGoalVerifierAdapter implements GoalVerifierPort {
  async verify(request: Parameters<GoalVerifierPort["verify"]>[0]) {
    const byCriterion = new Map(request.deterministicResults.map((result) => [
      result.criterionRef,
      result,
    ]));
    const criteria = request.goal.acceptanceCriteria.map((criterion) => {
      const result = byCriterion.get(criterion.id);
      return {
        criterionRef: criterion.id,
        verdict: result?.status ?? "failed",
        evidenceRefs: result?.evidenceRefs ?? [],
        rationale: result?.summary ?? "No deterministic result was provided.",
      };
    });
    const overallVerdict = criteria.some(({ verdict }) => verdict === "failed")
      ? "failed" as const
      : criteria.some(({ verdict }) => verdict === "needs_manual")
      ? "needs_manual" as const
      : "passed" as const;
    return {
      schemaVersion: goalVerifierOutputSchemaVersion,
      overallVerdict,
      criteria,
      nonGoals: request.goal.nonGoals.map((statement) => ({
        statement,
        verdict: "preserved" as const,
        rationale: "The deterministic evidence does not show work outside the approved scope.",
      })),
      constraints: request.goal.constraints.map((statement) => ({
        statement,
        verdict: "satisfied" as const,
        rationale: "The supplied evidence is consistent with the approved constraint.",
      })),
      regressionRisks: [],
    };
  }
}

export class DemoDeterministicVerifierAdapter
implements DeterministicVerifierPort {
  async run(entry: Parameters<DeterministicVerifierPort["run"]>[0]) {
    if (entry.strategy.type === "manual") {
      throw new Error("Manual strategies are handled by GoalVerificationService");
    }
    return {
      status: "passed" as const,
      evidenceRefs: [entry.strategy.reference],
      summary: `Demo verification resolved approved ${entry.strategy.type} reference ${entry.strategy.reference}.`,
      durationMs: 1,
    };
  }
}
