import { useCallback, useEffect, useMemo, useState } from "react";

import type { IssueDraft, IssuePlan } from
  "../../control-plane/domain/issue-plan";
import {
  capabilityTiers,
  reasoningEfforts,
  type CapabilityTier,
  type ReasoningEffort,
} from "../../control-plane/domain/model-router";
import type { GoalWorkspaceScope } from "../goal-workspace-api";
import { IssuePlanApiError, issuePlanApi } from "../issue-plan-api";
import { StatusPill, Stepper } from "./ui";

export interface IssuePlanContext {
  goalId: string;
  specRevisionId: string;
  specRevisionVersion: number;
}

interface RouteDraft {
  capabilityTier: CapabilityTier;
  reasoningEffort: ReasoningEffort;
}

function routeDrafts(plan: IssuePlan): Record<string, RouteDraft> {
  return Object.fromEntries(plan.modelRecommendations.map((route) => [
    route.issueKey,
    { capabilityTier: route.capabilityTier, reasoningEffort: route.reasoningEffort },
  ]));
}

function routeLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function IssuesView({
  scope,
  context,
  onApprove,
  notify,
}: {
  scope: GoalWorkspaceScope;
  context: IssuePlanContext | null;
  onApprove: () => void;
  notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<"table" | "waves">("table");
  const [plan, setPlan] = useState<IssuePlan | null>(null);
  const [issues, setIssues] = useState<IssueDraft[]>([]);
  const [routes, setRoutes] = useState<Record<string, RouteDraft>>({});
  const [reason, setReason] = useState("Review the Issue DAG and model recommendations");
  const [busy, setBusy] = useState(Boolean(context));
  const [error, setError] = useState("");

  const adopt = useCallback((next: IssuePlan) => {
    setPlan(next);
    setIssues([...structuredClone(next.issues)]);
    setRoutes(routeDrafts(next));
  }, []);

  useEffect(() => {
    if (!context) return;
    let active = true;
    issuePlanApi.timeline(scope, context.goalId)
      .then(async ({ plans }) => {
        const latest = plans.at(-1);
        if (latest?.source.specRevisionId === context.specRevisionId) return latest;
        return (await issuePlanApi.generate(
          scope,
          context.goalId,
          context.specRevisionId,
          context.specRevisionVersion,
        )).plan;
      })
      .then((next) => { if (active) adopt(next); })
      .catch((caught: unknown) => {
        if (!active) return;
        const detail = caught instanceof IssuePlanApiError
          ? caught.preservedState
          : "The current Issue draft remains unchanged";
        setError(`Issue plan loading failed. ${detail}`);
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [adopt, context, scope]);

  const recommendation = useMemo(() => new Map(
    plan?.modelRecommendations.map((item) => [item.issueKey, item]) ?? [],
  ), [plan]);
  const dirty = useMemo(() => Boolean(plan) && (
    JSON.stringify(issues) !== JSON.stringify(plan?.issues) ||
    JSON.stringify(routes) !== JSON.stringify(plan ? routeDrafts(plan) : {})
  ), [issues, plan, routes]);

  function changeIssue(index: number, patch: Partial<IssueDraft>) {
    setIssues((current) => current.map((issue, issueIndex) =>
      issueIndex === index ? { ...issue, ...patch } : issue
    ));
  }

  async function saveRevision() {
    if (!plan || !context) return;
    const preservedIssues = structuredClone(issues);
    const preservedRoutes = structuredClone(routes);
    setBusy(true);
    setError("");
    try {
      const changedRoutes = plan.modelRecommendations.flatMap((current) => {
        const next = routes[current.issueKey];
        if (!next || (next.capabilityTier === current.capabilityTier &&
          next.reasoningEffort === current.reasoningEffort)) return [];
        return [{
          issueKey: current.issueKey,
          ...next,
          reason,
        }];
      });
      const next = await issuePlanApi.revise(scope, context.goalId, plan, {
        reason,
        issues,
        modelOverrides: changedRoutes,
      });
      adopt(next.plan);
      notify(`Issue plan revision ${next.plan.revision} 已保存并重新编译`);
    } catch (caught) {
      setIssues(preservedIssues);
      setRoutes(preservedRoutes);
      const detail = caught instanceof IssuePlanApiError
        ? `${caught.code}. ${caught.preservedState}`
        : "The current browser draft is preserved";
      setError(`保存失败：${detail}`);
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "reject" | "request_changes") {
    if (!plan || !context || dirty) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await issuePlanApi.approve(scope, context.goalId, plan, reason, decision);
      adopt(receipt.result.plan);
      notify(decision === "approve" ? "Issue 方案已批准" : "Issue 方案已返回修改");
    } catch (caught) {
      const detail = caught instanceof IssuePlanApiError
        ? `${caught.code}. ${caught.preservedState}`
        : "The current browser draft is preserved";
      setError(`审批失败：${detail}`);
    } finally {
      setBusy(false);
    }
  }

  async function project() {
    if (!plan || !context) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await issuePlanApi.project(scope, context.goalId, plan);
      notify(`${receipt.tasks.length} 个 Issue 已通过原子 Import 投影`);
      onApprove();
    } catch (caught) {
      const unavailable = caught instanceof IssuePlanApiError &&
        caught.code === "queue_import_unavailable";
      setError(unavailable
        ? "AutoDev 0.4.16 尚无已配置的正式原子 Import/API；方案保持已批准，未写入任何外部任务。"
        : `投影失败：${caught instanceof IssuePlanApiError ? caught.preservedState : "No external tasks were accepted"}`);
    } finally {
      setBusy(false);
    }
  }

  if (!context) {
    return (
      <div className="screen detail-screen">
        <section className="panel empty-state" role="status">
          <h2>尚未选择已批准的规格</h2>
          <p>请先在“目标与澄清”中批准最新 Proposal / PRD，再进入 Issue 编译。</p>
        </section>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="screen detail-screen">
        <section className="panel empty-state" role="status" aria-live="polite">
          <h2>{busy ? "正在生成 Issue 合同…" : "Issue 方案不可用"}</h2>
          <p>{error || "正在读取最新计划修订。"}</p>
        </section>
      </div>
    );
  }

  const covered = plan.compilation.coverage.requirements.covered.length;
  const total = covered + plan.compilation.coverage.requirements.uncovered.length;
  const approved = plan.status === "approved";

  return (
    <div className="screen detail-screen">
      <div className="goal-heading">
        <div>
          <div className="heading-meta">
            <StatusPill tone={approved ? "success" : plan.compilation.valid ? "info" : "danger"}>
              {approved ? "已批准" : plan.compilation.valid ? "等待批准" : "编译失败"}
            </StatusPill>
            <span>{context.goalId.slice(0, 8)}</span>
            <span>Issue plan revision {plan.revision}</span>
          </div>
          <h2>Issue Compiler 与执行合同</h2>
          <p>{plan.issues.length} 个纵向切片 · {plan.waves.length} 个执行波次 · digest {plan.digest.slice(0, 12)}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={() => notify(`方案 digest ${plan.digest}`)}>导出方案摘要</button>
        </div>
      </div>

      <Stepper current={4} />

      <section className="plan-summary-grid" aria-label="Issue 编译摘要">
        <article><span className="summary-symbol teal">✓</span><div><small>需求覆盖</small><strong>{covered} / {total}</strong><p>{plan.compilation.valid ? "全部可追溯" : "存在阻塞诊断"}</p></div></article>
        <article><span className="summary-symbol blue">⌘</span><div><small>依赖 DAG</small><strong>{plan.compilation.valid ? "健康" : "阻塞"}</strong><p>{plan.waves.length} 个稳定波次</p></div></article>
        <article><span className="summary-symbol amber">!</span><div><small>资源冲突</small><strong>{plan.conflicts.length} 组</strong><p>冲突任务已串行</p></div></article>
        <article><span className="summary-symbol violet">AI</span><div><small>高能力路由</small><strong>{plan.modelRecommendations.filter(({ capabilityTier }) => ["advanced_coding", "frontier"].includes(capabilityTier)).length} 项</strong><p>禁止静默降级</p></div></article>
      </section>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {plan.compilation.diagnostics.length > 0 && (
        <section className="panel" aria-label="编译诊断">
          <div className="panel-header"><h3>阻塞诊断</h3></div>
          <ul className="reason-list">
            {plan.compilation.diagnostics.map((item, index) => (
              <li key={`${item.code}-${index}`}><span>•</span><strong>{item.path}</strong> · {item.message}；{item.impact}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel issue-plan-panel">
        <div className="panel-header issue-header">
          <div><p className="eyebrow">ISSUE DEVELOPMENT CONTRACTS</p><h3>开发切片、DAG 与模型建议</h3></div>
          <div className="view-switcher" role="group" aria-label="Issue 方案视图">
            <button type="button" aria-pressed={mode === "table"} className={mode === "table" ? "active" : ""} onClick={() => setMode("table")}>表格</button>
            <button type="button" aria-pressed={mode === "waves"} className={mode === "waves" ? "active" : ""} onClick={() => setMode("waves")}>执行波次</button>
          </div>
        </div>

        {mode === "table" ? (
          <div className="table-wrap">
            <table className="issue-table">
              <thead><tr><th>Issue / 标题</th><th>依赖</th><th>预计文件</th><th>能力等级</th><th>推理强度</th></tr></thead>
              <tbody>
                {issues.map((issue, index) => {
                  const route = routes[issue.key] ?? {
                    capabilityTier: recommendation.get(issue.key)?.capabilityTier ?? "general_coding",
                    reasoningEffort: recommendation.get(issue.key)?.reasoningEffort ?? "medium",
                  };
                  return (
                    <tr key={issue.key}>
                      <td><span className="issue-id">{issue.key}</span><input aria-label={`${issue.key} 标题`} disabled={approved || busy} value={issue.title} onChange={(event) => changeIssue(index, { title: event.target.value })} /></td>
                      <td><input aria-label={`${issue.key} 依赖`} disabled={approved || busy} value={issue.dependencyCandidates.join(", ")} onChange={(event) => changeIssue(index, { dependencyCandidates: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></td>
                      <td><textarea aria-label={`${issue.key} 预计文件`} disabled={approved || busy} value={issue.expectedFiles.join("\n")} onChange={(event) => changeIssue(index, { expectedFiles: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) })} /></td>
                      <td><select aria-label={`${issue.key} 能力等级`} disabled={approved || busy} value={route.capabilityTier} onChange={(event) => setRoutes((current) => ({ ...current, [issue.key]: { ...route, capabilityTier: event.target.value as CapabilityTier } }))}>{capabilityTiers.map((value) => <option key={value} value={value}>{routeLabel(value)}</option>)}</select></td>
                      <td><select aria-label={`${issue.key} 推理强度`} disabled={approved || busy} value={route.reasoningEffort} onChange={(event) => setRoutes((current) => ({ ...current, [issue.key]: { ...route, reasoningEffort: event.target.value as ReasoningEffort } }))}>{reasoningEfforts.map((value) => <option key={value} value={value}>{value}</option>)}</select></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="waves-board" aria-label="Execution Waves">
            {plan.waves.map((wave) => (
              <article className="wave-column" key={wave.number}>
                <div className="wave-title"><span>{wave.number}</span><div><strong>Wave {wave.number}</strong><small>{wave.issueKeys.length > 1 ? "可并行" : "串行"}</small></div></div>
                {wave.issueKeys.map((key) => (
                  <div className="wave-issue" key={key}><div><span>{key}</span><StatusPill tone="neutral">Wave {wave.number}</StatusPill></div><strong>{issues.find((issue) => issue.key === key)?.title}</strong><small>{recommendation.get(key)?.reasons.join(" · ")}</small></div>
                ))}
                <ul className="reason-list">{wave.reasons.map((item) => <li key={item}><span>•</span>{item}</li>)}</ul>
              </article>
            ))}
          </div>
        )}

        {plan.conflicts.length > 0 && (
          <div className="scope-note">
            <div><span className="scope-icon">!</span><p><strong>并行冲突已解释并串行化</strong><small>{plan.conflicts.map(({ issueKeys, reasons }) => `${issueKeys.join(" ↔ ")}: ${reasons.join("; ")}`).join(" · ")}</small></p></div>
          </div>
        )}
      </section>

      <div className="approval-bar">
          <div><span className="approval-lock">审</span><p><strong>{approved ? "方案已批准并锁定" : dirty ? "存在未保存修改，请先重新编译" : "批准前请确认完整 DAG、Wave 和模型建议"}</strong><small>权限由服务端判断；批准绑定 revision {plan.revision} 与 digest。</small></p></div>
          <div className="approval-actions">
            <input aria-label="Issue 方案修改或审批理由" disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} />
          {!approved && <button type="button" disabled={busy || !dirty} className="secondary-button" onClick={saveRevision}>保存修改并重新编译</button>}
          {!approved && <button type="button" disabled={busy || dirty} className="secondary-button" onClick={() => decide("request_changes")}>要求修改</button>}
          {!approved && <button type="button" disabled={busy || !plan.compilation.valid || dirty} className="primary-button" onClick={() => decide("approve")}>批准 {plan.issues.length} 个 Issue</button>}
          {approved && <button type="button" disabled={busy} className="primary-button" onClick={project}>通过正式 Import 投影</button>}
        </div>
      </div>
    </div>
  );
}
