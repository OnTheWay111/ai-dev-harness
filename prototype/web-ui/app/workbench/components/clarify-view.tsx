import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  GoalContract,
  GoalContractDraft,
} from "../../control-plane/domain/goal-contract";
import {
  goalWorkspaceApi,
  GoalWorkspaceApiError,
  type GoalWorkspaceScope,
} from "../goal-workspace-api";
import {
  goalDraftStorageKey,
  restoreGoalDraft,
  serializeGoalDraft,
} from "../goal-workspace-draft";
import { StatusPill, Stepper } from "./ui";

const emptyDraft: GoalContractDraft = {
  title: "",
  problemStatement: "",
  desiredOutcome: "",
  acceptanceCriteria: [""],
  nonGoals: [""],
  constraints: [""],
};

function lines(values: readonly string[]): string {
  return values.join("\n");
}

function fromLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function editableDraft(goal: GoalContract): GoalContractDraft {
  return {
    title: goal.title,
    problemStatement: goal.problemStatement,
    desiredOutcome: goal.desiredOutcome,
    acceptanceCriteria: goal.acceptanceCriteria.map(({ statement }) => statement),
    nonGoals: [...goal.nonGoals],
    constraints: [...goal.constraints],
  };
}

export function ClarifyView({
  scope,
  onContinue,
  notify,
}: {
  scope: GoalWorkspaceScope;
  onContinue: () => void;
  notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<GoalContractDraft>(emptyDraft);
  const [goal, setGoal] = useState<GoalContract | null>(null);
  const [reason, setReason] = useState("Update the Goal Contract draft");
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const storageKey = useMemo(() => goalDraftStorageKey(scope), [scope]);
  const lastGoalKey = `${storageKey}:last-goal`;

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      const saved = window.localStorage.getItem(storageKey);
      const restoredDraft = restoreGoalDraft(saved);
      if (active && restoredDraft) setDraft(restoredDraft);
      else if (saved && !restoredDraft) window.localStorage.removeItem(storageKey);
      const goalId = window.localStorage.getItem(lastGoalKey);
      if (!goalId) {
        if (active) setRestored(true);
        return;
      }
      try {
        const loaded = await goalWorkspaceApi.get(scope, goalId);
        if (!active) return;
        setGoal(loaded);
        if (!saved) setDraft(editableDraft(loaded));
      } catch {
        window.localStorage.removeItem(lastGoalKey);
      } finally {
        if (active) setRestored(true);
      }
    });
    return () => { active = false; };
  }, [lastGoalKey, scope, storageKey]);

  useEffect(() => {
    if (restored) window.localStorage.setItem(storageKey, serializeGoalDraft(draft));
  }, [draft, restored, storageKey]);

  function field<K extends keyof GoalContractDraft>(
    name: K,
    value: GoalContractDraft[K],
  ) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const receipt = goal
        ? await goalWorkspaceApi.update(
            scope,
            goal.id,
            goal.version,
            draft,
            reason,
          )
        : await goalWorkspaceApi.create(
            scope,
            draft,
            reason || "Create the Goal Contract draft",
          );
      setGoal(receipt.goal);
      setDraft(editableDraft(receipt.goal));
      window.localStorage.setItem(lastGoalKey, receipt.goal.id);
      window.localStorage.removeItem(storageKey);
      notify(`Goal Contract revision ${receipt.goal.version} 已保存`);
    } catch (caught) {
      const message = caught instanceof GoalWorkspaceApiError &&
          caught.code === "version_conflict"
        ? "版本已变化，请重新加载后再保存。"
        : "保存失败；本地草稿已保留。";
      setError(message);
      notify(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="screen detail-screen">
      <div className="goal-heading">
        <div>
          <div className="heading-meta">
            <StatusPill tone={goal ? "success" : "warning"}>
              {goal ? "草稿已保存" : "新建 Goal"}
            </StatusPill>
            {goal && <span>{goal.id.slice(0, 8)}</span>}
            <span>Revision {goal?.version ?? "未保存"}</span>
          </div>
          <h2>{draft.title || "创建可验证的 Goal Contract"}</h2>
          <p>所有修改都经过服务端 RBAC、幂等、乐观锁和审计事务。</p>
        </div>
        <div className="heading-actions">
          <button
            className="secondary-button"
            onClick={() => {
              window.localStorage.setItem(storageKey, serializeGoalDraft(draft));
              notify("本地草稿已保存");
            }}
          >
            保存本地草稿
          </button>
        </div>
      </div>

      <Stepper current={1} />

      <div className="workspace-grid">
        <main className="workspace-main">
          <form className="panel contract-panel goal-contract-form" onSubmit={save}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">GOAL CONTRACT</p>
                <h3>目标、边界与验收</h3>
                <p>每行一个验收标准、非目标或约束；至少需要一条验收标准。</p>
              </div>
              <span className="ai-badge">人工输入 · 权威草稿</span>
            </div>

            <div className="goal-form-grid">
              <label className="goal-form-field goal-form-wide">
                <span>目标标题</span>
                <input
                  required
                  maxLength={200}
                  value={draft.title}
                  onChange={(event) => field("title", event.target.value)}
                />
              </label>
              <label className="goal-form-field">
                <span>问题陈述</span>
                <textarea
                  required
                  maxLength={10_000}
                  value={draft.problemStatement}
                  onChange={(event) => field("problemStatement", event.target.value)}
                />
              </label>
              <label className="goal-form-field">
                <span>期望结果</span>
                <textarea
                  required
                  maxLength={10_000}
                  value={draft.desiredOutcome}
                  onChange={(event) => field("desiredOutcome", event.target.value)}
                />
              </label>
              <label className="goal-form-field goal-form-wide">
                <span>验收标准</span>
                <textarea
                  required
                  aria-describedby="acceptance-help"
                  value={lines(draft.acceptanceCriteria)}
                  onChange={(event) =>
                    field("acceptanceCriteria", fromLines(event.target.value))}
                />
                <small id="acceptance-help">写成可观察、可验证的结果。</small>
              </label>
              <label className="goal-form-field">
                <span>非目标</span>
                <textarea
                  value={lines(draft.nonGoals)}
                  onChange={(event) => field("nonGoals", fromLines(event.target.value))}
                />
              </label>
              <label className="goal-form-field">
                <span>约束</span>
                <textarea
                  value={lines(draft.constraints)}
                  onChange={(event) => field("constraints", fromLines(event.target.value))}
                />
              </label>
              <label className="goal-form-field goal-form-wide">
                <span>本次修改原因</span>
                <input
                  required
                  maxLength={4_000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="goal-form-actions">
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? "正在保存…" : goal ? "保存新版本" : "创建 Goal Contract"}
              </button>
            </div>
          </form>
        </main>

        <aside className="workspace-aside">
          <section className="panel summary-card">
            <p className="eyebrow">CONTRACT STATUS</p>
            <h3>版本与安全边界</h3>
            <div className="classification">
              <div><small>版本</small><strong>{goal?.version ?? "—"}</strong><span>乐观锁</span></div>
              <div><small>状态</small><strong>{goal?.status ?? "DRAFT"}</strong><span>人工确认</span></div>
            </div>
            <ul className="reason-list">
              <li><span>✓</span>浏览器不保存数据库凭证</li>
              <li><span>✓</span>服务端逐请求执行 RBAC</li>
              <li><span>✓</span>审计与 Outbox 同事务提交</li>
            </ul>
          </section>
          <section className="panel context-card">
            <p className="eyebrow">DRAFT RECOVERY</p>
            <h3>草稿保护</h3>
            <div className="context-item">
              <span>01</span>
              <div><strong>浏览器本地草稿</strong><small>输入时自动保存</small></div>
            </div>
            <div className="context-item">
              <span>02</span>
              <div><strong>服务端 Goal</strong><small>冲突时不覆盖旧版本</small></div>
            </div>
          </section>
        </aside>
      </div>

      <div className="sticky-actionbar">
        <div>
          <span className="save-indicator">✓</span>
          <p><strong>{goal ? `Revision ${goal.version} 已持久化` : "先保存 Goal Contract"}</strong><small>Planner 只能基于已保存版本生成草稿</small></p>
        </div>
        <button
          className="primary-button"
          disabled={!goal}
          onClick={() => goal && onContinue()}
        >
          进入澄清<span>→</span>
        </button>
      </div>
    </div>
  );
}
