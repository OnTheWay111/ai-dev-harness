import { useCallback, useEffect, useMemo, useState } from "react";

import type { AcceptanceVerificationPlan } from
  "../../control-plane/domain/acceptance-verification";
import type { DeliveryReport } from
  "../../control-plane/domain/delivery-report";
import type { GoalContract } from
  "../../control-plane/domain/goal-contract";
import type { GoalVerification } from
  "../../control-plane/domain/goal-verification";
import type { VerificationGapReport } from
  "../../control-plane/domain/verification-gap";
import type { IssuePlan } from "../../control-plane/domain/issue-plan";
import {
  GoalVerificationApiError,
  goalVerificationApi,
} from "../goal-verification-api";
import {
  goalWorkspaceApi,
  type GoalWorkspaceScope,
} from "../goal-workspace-api";
import { issuePlanApi } from "../issue-plan-api";
import { StatusPill, Stepper } from "./ui";

const queryReferences = [
  "query:issues:completed",
  "query:reviews:approved",
  "query:delivery:ready",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof GoalVerificationApiError
    ? `${error.message}. ${error.preservedState}`
    : error instanceof Error ? error.message : "目标验收服务暂时不可用";
}

export function VerifyView({
  notify,
  scope,
  goalId,
}: {
  notify: (message: string) => void;
  scope: GoalWorkspaceScope;
  goalId: string | null;
}) {
  const [goal, setGoal] = useState<GoalContract | null>(null);
  const [issuePlan, setIssuePlan] = useState<IssuePlan | null>(null);
  const [plans, setPlans] = useState<readonly AcceptanceVerificationPlan[]>([]);
  const [verifications, setVerifications] = useState<readonly GoalVerification[]>([]);
  const [gaps, setGaps] = useState<readonly VerificationGapReport[]>([]);
  const [reports, setReports] = useState<readonly DeliveryReport[]>([]);
  const [manualEvidence, setManualEvidence] = useState<Record<string, string>>({});
  const [acceptanceReason, setAcceptanceReason] = useState(
    "All required evidence, disclosed risks, and manual checks are accepted.",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!goalId) return;
    const [nextGoal, issueTimeline, nextPlans, nextVerifications, nextGaps, nextReports] =
      await Promise.all([
        goalWorkspaceApi.get(scope, goalId),
        issuePlanApi.timeline(scope, goalId),
        goalVerificationApi.planTimeline(scope, goalId),
        goalVerificationApi.verificationTimeline(scope, goalId),
        goalVerificationApi.gapTimeline(scope, goalId),
        goalVerificationApi.reportTimeline(scope, goalId),
      ]);
    setGoal(nextGoal);
    setIssuePlan(issueTimeline.plans.at(-1) ?? null);
    setPlans(nextPlans);
    setVerifications(nextVerifications);
    setGaps(nextGaps);
    setReports(nextReports);
  }, [goalId, scope]);

  useEffect(() => {
    if (!goalId) return;
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (!active) return;
        setBusy(true);
        return refresh();
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [goalId, refresh]);

  const latestPlan = plans.at(-1) ?? null;
  const latestVerification = verifications.at(-1) ?? null;
  const latestReport = reports.at(-1) ?? null;
  const verdictByCriterion = useMemo(() => new Map(
    latestVerification?.verifierOutput.criteria.map((item) => [
      item.criterionRef,
      item,
    ]) ?? [],
  ), [latestVerification]);
  const passed = goal?.acceptanceCriteria.filter((criterion) =>
    verdictByCriterion.get(criterion.id)?.verdict === "passed"
  ).length ?? 0;

  const perform = useCallback(async (
    action: () => Promise<unknown>,
    success: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      await action();
      notify(success);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [notify, refresh]);

  async function compiledPlan(): Promise<AcceptanceVerificationPlan> {
    if (latestPlan) return latestPlan;
    if (!goal || !goalId || !issuePlan) {
      throw new Error("Goal 与已批准 Issue Plan 尚未就绪");
    }
    return await goalVerificationApi.compilePlan(
      scope,
      goalId,
      issuePlan,
      goal.version,
      {
        schemaVersion: "acceptance-verification-plan-draft.v1",
        entries: goal.acceptanceCriteria.map((criterion, index) => {
          const reference = queryReferences[index % queryReferences.length];
          return {
            id: `verify-ac-${index + 1}`,
            criterionRef: criterion.id,
            environment: "staging" as const,
            strategy: { type: "query" as const, reference },
            successCondition:
              `Approved ${reference} must prove the criterion with zero missing records.`,
            timeoutMs: 30_000,
            responsibleParty: "delivery-platform",
          };
        }),
      },
    );
  }

  if (!goalId) {
    return (
      <div className="screen detail-screen">
        <section className="panel verification-panel">
          <div className="panel-header">
            <div><p className="eyebrow">GOAL VERIFIER</p><h3>尚未选择可验收 Goal</h3></div>
          </div>
          <p>先在“需求澄清”创建 Goal 并完成 Issue 执行，再进入目标验收。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="screen detail-screen" aria-busy={busy}>
      <div className="goal-heading">
        <div>
          <div className="heading-meta">
            <StatusPill tone={latestReport?.status === "accepted" ? "success" : "warning"}>
              {latestReport?.status === "accepted" ? "已完成交付" : "目标验收中"}
            </StatusPill>
            <span>{goalId}</span>
            <span>Verification revision {latestVerification?.revision ?? 0}</span>
          </div>
          <h2>{goal?.title ?? "Goal Verifier 与 Delivery Report"}</h2>
          <p>Issue 完成不等于目标完成；这里逐条验证原始 Goal Contract，并保留不可变报告版本。</p>
        </div>
        <div className="heading-actions">
          {latestReport && (
            <a
              className="secondary-button"
              href={goalVerificationApi.exportUrl(scope, goalId, latestReport.id)}
            >
              导出 Delivery Report
            </a>
          )}
          <button
            className="primary-button"
            disabled={busy || !goal || goal.status !== "verifying"}
            onClick={() => void perform(async () => {
              if (!goal) return;
              const plan = await compiledPlan();
              const signed = plan.entries.flatMap((entry) => {
                if (entry.strategy.type !== "manual") return [];
                const evidenceRef = manualEvidence[entry.id]?.trim();
                return evidenceRef ? [{
                  entryId: entry.id,
                  evidenceRef,
                  reason: `Approver confirmed ${entry.successCondition}`,
                }] : [];
              });
              await goalVerificationApi.verify(
                scope,
                goalId,
                plan,
                goal.version,
                signed,
              );
            }, "独立 Goal Verifier 会话已完成")}
          >
            {latestVerification ? "重新运行验收" : "运行最终验收"}
          </button>
        </div>
      </div>

      <Stepper current={6} />
      {error && <div className="workbench-state-banner failure" role="alert">{error}</div>}

      <div className="verify-layout">
        <main>
          <section className="panel verification-panel">
            <div className="panel-header">
              <div><p className="eyebrow">ACCEPTANCE CRITERIA</p><h3>原始验收标准</h3></div>
              <span className="criteria-score">{passed} / {goal?.acceptanceCriteria.length ?? 0} 通过</span>
            </div>
            <div className="verification-list">
              {goal?.acceptanceCriteria.map((criterion) => {
                const result = verdictByCriterion.get(criterion.id);
                const ready = result?.verdict === "passed";
                return (
                  <article className={ready ? "passed" : "pending"} key={criterion.id}>
                    <span className="verify-icon">{ready ? "✓" : "…"}</span>
                    <div>
                      <span>AC-{String(criterion.position).padStart(3, "0")}</span>
                      <strong>{criterion.statement}</strong>
                      <small>{result?.evidenceRefs.join(" · ") || "等待确定性证据"}</small>
                    </div>
                    <StatusPill tone={ready ? "success" : "warning"}>
                      {result?.verdict ?? "待验证"}
                    </StatusPill>
                  </article>
                );
              })}
            </div>
            {latestPlan?.entries.some(({ strategy }) => strategy.type === "manual") && (
              <div className="risk-row">
                <StatusPill tone="warning">人工证据</StatusPill>
                <div>
                  <strong>Approver 签字证据</strong>
                  {latestPlan.entries.filter(({ strategy }) => strategy.type === "manual")
                    .map((entry) => (
                      <input
                        key={entry.id}
                        aria-label={`${entry.id} evidence reference`}
                        placeholder="不可变证据引用"
                        value={manualEvidence[entry.id] ?? ""}
                        onChange={(event) => setManualEvidence((current) => ({
                          ...current,
                          [entry.id]: event.target.value,
                        }))}
                      />
                    ))}
                </div>
              </div>
            )}
          </section>

          <section className="panel risk-panel">
            <div className="panel-header">
              <div><p className="eyebrow">DISCLOSED RISKS</p><h3>回归风险与差距</h3></div>
              <StatusPill tone={gaps.length ? "warning" : "success"}>
                {gaps.length ? `${gaps.length} 份差距报告` : "无已记录差距"}
              </StatusPill>
            </div>
            {latestVerification?.verifierOutput.regressionRisks.map((risk) => (
              <div className="risk-row" key={risk.description}>
                <StatusPill tone={risk.severity === "critical" || risk.severity === "high" ? "danger" : "info"}>
                  {risk.severity}
                </StatusPill>
                <div><strong>{risk.description}</strong><p>{risk.evidenceRefs.join(" · ")}</p></div>
              </div>
            ))}
            {latestVerification?.verdict === "failed" && (
              <button
                className="secondary-button"
                disabled={busy || gaps.some(({ verificationId }) =>
                  verificationId === latestVerification.id
                )}
                onClick={() => void perform(
                  () => goalVerificationApi.createGap(scope, goalId, latestVerification.id),
                  "差距报告已保存；旧 Evidence、Review、Commit 与 Artifact 未被修改",
                )}
              >
                生成 Verification Gap Report
              </button>
            )}
          </section>
        </main>

        <aside className="panel delivery-card">
          <div className={`delivery-seal ${latestVerification?.verdict === "passed" ? "ready" : ""}`}>
            <span>{latestVerification?.verdict === "passed" ? "✓" : "⌛"}</span>
          </div>
          <p className="eyebrow">DELIVERY DECISION</p>
          <h3>{latestReport?.status === "accepted"
            ? "目标已经达成"
            : latestVerification?.verdict === "passed"
            ? "等待人工最终验收"
            : "验收证据尚未闭合"}</h3>
          <p>只有全部必需标准通过并完成 Approver 门禁，Goal 才会从 verifying 原子转换为 completed。</p>
          <div className="delivery-facts">
            <div><span>Plan</span><strong>r{latestPlan?.revision ?? 0}</strong></div>
            <div><span>Verification</span><strong>r{latestVerification?.revision ?? 0}</strong></div>
            <div><span>Report</span><strong>r{latestReport?.revision ?? 0}</strong></div>
          </div>
          <button
            className="primary-button full"
            disabled={busy || latestVerification?.verdict !== "passed"}
            onClick={() => void perform(async () => {
              if (!latestVerification) return;
              await goalVerificationApi.generateReport(
                scope,
                goalId,
                latestVerification.id,
                latestVerification.verifierOutput.regressionRisks.map((risk) => ({
                  severity: risk.severity,
                  statement: risk.description,
                  disposition: "monitor" as const,
                })),
              );
            }, "新的不可变 Delivery Report 版本已生成")}
          >
            生成 Delivery Report
          </button>
          <textarea
            aria-label="Final acceptance reason"
            value={acceptanceReason}
            onChange={(event) => setAcceptanceReason(event.target.value)}
          />
          <button
            className="secondary-button full"
            disabled={busy || latestReport?.status !== "awaiting_human_acceptance" || !goal}
            onClick={() => void perform(async () => {
              if (!latestReport || !goal) return;
              await goalVerificationApi.acceptReport(
                scope,
                goalId,
                latestReport.id,
                goal.version,
                acceptanceReason,
              );
            }, "人工门禁已记录，Goal 已完成")}
          >
            Approver 最终验收
          </button>
          <small className="delivery-footnote">
            报告包含原始范围、非目标、逐项证据、Issue/Run、Review、Commit/PR、异常、风险与人工签字。
          </small>
        </aside>
      </div>
    </div>
  );
}
