import type {
  ScopeChange,
  SpecApprovalDecision,
  SpecApprovalTimeline,
} from "../../control-plane/domain/spec-approval";
import type { SpecRevision } from
  "../../control-plane/domain/spec-artifact";

export function SpecApprovalPanel({
  specRevision,
  timeline,
  busy,
  readOnly,
  reason,
  setReason,
  helpfulExceptions,
  setHelpfulExceptions,
  scopeChange,
  setScopeChange,
  onDecision,
}: {
  specRevision: SpecRevision;
  timeline: SpecApprovalTimeline;
  busy: boolean;
  readOnly?: boolean;
  reason: string;
  setReason(value: string): void;
  helpfulExceptions: readonly string[];
  setHelpfulExceptions(value: readonly string[]): void;
  scopeChange: ScopeChange;
  setScopeChange(value: ScopeChange): void;
  onDecision(decision: SpecApprovalDecision): void;
}) {
  const helpful = specRevision.overdesignReview.items
    .filter(({ category }) => category === "Helpful");
  const speculative = specRevision.overdesignReview.items
    .filter(({ category }) => category === "Speculative");
  function toggle(id: string) {
    setHelpfulExceptions(
      helpfulExceptions.includes(id)
        ? helpfulExceptions.filter((item) => item !== id)
        : [...helpfulExceptions, id],
    );
  }
  return (
    <section className="spec-approval-panel" aria-labelledby="spec-approval-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">HUMAN GATE</p>
          <h3 id="spec-approval-heading">人工审批与范围决定</h3>
          <p>权限由服务端判断；浏览器只提交明确决定和理由。</p>
        </div>
        <span className="ai-badge">{specRevision.status} · v{specRevision.version}</span>
      </div>

      {helpful.length > 0 && (
        <fieldset disabled={busy || readOnly || specRevision.status !== "in_review"}>
          <legend>Helpful 例外（未勾选则删除）</legend>
          {helpful.map((item) => (
            <label key={item.elementId}>
              <input
                type="checkbox"
                checked={helpfulExceptions.includes(item.elementId)}
                onChange={() => toggle(item.elementId)}
              />
              <span><strong>{item.title}</strong><small>{item.removalImpact}</small></span>
            </label>
          ))}
        </fieldset>
      )}
      {speculative.length > 0 && (
        <p className="form-warning">
          Speculative 默认删除且不能例外保留：{speculative.map(({ title }) => title).join("、")}
        </p>
      )}
      {readOnly && (
        <p className="form-warning">该修订已有后续版本，仅供查看；服务端会拒绝任何过期审批。</p>
      )}

      <div className="scope-change-grid" aria-disabled={readOnly}>
        <label className="goal-form-field">
          <span>范围操作</span>
          <select
            disabled={readOnly}
            value={scopeChange.operation}
            onChange={(event) => setScopeChange({
              ...scopeChange,
              operation: event.target.value as ScopeChange["operation"],
            })}
          >
            <option value="add">增加</option>
            <option value="remove">删除</option>
          </select>
        </label>
        <label className="goal-form-field">
          <span>范围类型</span>
          <select
            disabled={readOnly}
            value={scopeChange.kind}
            onChange={(event) => setScopeChange({
              ...scopeChange,
              kind: event.target.value as ScopeChange["kind"],
            })}
          >
            <option value="requirement">需求</option>
            <option value="non_goal">非目标</option>
            <option value="constraint">约束</option>
          </select>
        </label>
        <label className="goal-form-field goal-form-wide">
          <span>范围修改内容</span>
          <input
            disabled={readOnly}
            value={scopeChange.value}
            maxLength={4_000}
            onChange={(event) => setScopeChange({ ...scopeChange, value: event.target.value })}
          />
        </label>
      </div>
      <label className="goal-form-field">
        <span>审批或修改理由</span>
        <textarea
          required
          disabled={readOnly}
          value={reason}
          maxLength={4_000}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>

      <div className="goal-form-actions approval-actions">
        {specRevision.status === "draft" && (
          <button disabled={busy || readOnly || !reason.trim()} className="primary-button" type="button" onClick={() => onDecision("submit_for_review")}>
            提交人工评审
          </button>
        )}
        {specRevision.status === "in_review" && (
          <>
            <button disabled={busy || readOnly || !reason.trim()} className="secondary-button" type="button" onClick={() => onDecision("reject")}>
              拒绝
            </button>
            <button disabled={busy || readOnly || !reason.trim() || !scopeChange.value.trim()} className="secondary-button" type="button" onClick={() => onDecision("request_changes")}>
              请求范围修改
            </button>
            <button disabled={busy || readOnly || !reason.trim()} className="primary-button" type="button" onClick={() => onDecision("approve")}>
              批准最小合同
            </button>
          </>
        )}
      </div>

      {timeline.decisions.length > 0 && (
        <div className="timeline" aria-label="规格审批历史">
          {timeline.decisions.map((decision) => (
            <div className="timeline-event" key={decision.id}>
              <span className="timeline-dot info" />
              <time>{new Date(decision.createdAt).toLocaleString()}</time>
              <strong>{decision.decision} · {decision.actorId}</strong>
              <small>{decision.reason} · Policy {decision.policyRevision}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
