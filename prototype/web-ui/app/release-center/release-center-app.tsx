"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";

import type {
  CanaryAggregate,
  NewCanaryEvent,
  ProductionGateId,
  ProductionReleaseAggregate,
  ReleaseSignatureRole,
} from "./domain";
import {
  P12_PRODUCTION_GATE_IDS,
  P12_RELEASE_SIGNATURE_ROLES,
} from "./constants";
import {
  releaseCenterApi,
  ReleaseCenterApiError,
  type ReleaseCenterSnapshot,
} from "./api-client";
import type { ReleaseCenterScope } from "./repository";

const gateLabels: Record<ProductionGateId, string> = {
  "browser-e2e": "浏览器 E2E",
  "identity-security": "身份与安全",
  "autodev-authorization": "AutoDev 授权",
  "model-routing-write": "模型路由写入",
  "supply-chain": "供应链",
  "git-traceability": "Git 追溯",
  "recovery-stop": "恢复与 Stop",
  "observability-oncall": "监控与 On-call",
  "canary-goal-verification": "Canary Goal Verification",
  "defect-budget": "缺陷预算",
};

const roleLabels: Record<ReleaseSignatureRole, string> = {
  security: "安全",
  operations: "运维",
  product: "产品",
  "project-owner": "项目负责人",
};

const canaryStatus: Record<CanaryAggregate["status"], string> = {
  draft: "等待项目负责人批准",
  observing: "48 小时连续观测中",
  stopped: "已停止，必须重新计时",
  passed: "Canary 已通过",
};

const releaseStatus: Record<ProductionReleaseAggregate["status"], string> = {
  draft: "门禁证据收集中",
  awaiting_signatures: "等待四方 OIDC 签署",
  approved: "Production V1 已批准",
};

const subscribeToHydration = () => () => undefined;

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function utc(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { timeZone: "UTC" }) + " UTC";
}

function errorText(error: unknown): string {
  if (error instanceof ReleaseCenterApiError) {
    return `${error.message}（${error.code} · ${error.requestId}）`;
  }
  return "发布中心暂时不可用；已保存的状态未改变。";
}

function progressPercent(canary: CanaryAggregate): number {
  return Math.min(100, canaryProgress(canary).completedHours / 48 * 100);
}

function canaryProgress(canary: CanaryAggregate): {
  completedHours: number;
  windowCount: number;
} {
  const windows = canary.windows.filter(({ attempt }) => attempt === canary.attempt);
  const completedMilliseconds = windows.reduce((total, window) =>
    total + Date.parse(window.endedAt) - Date.parse(window.startedAt), 0);
  return {
    completedHours: completedMilliseconds / (60 * 60 * 1_000),
    windowCount: windows.length,
  };
}

export function ReleaseCenterApp({
  scope,
  initialSnapshot,
}: {
  scope: ReleaseCenterScope;
  initialSnapshot: ReleaseCenterSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [selectedCanaryId, setSelectedCanaryId] = useState(
    initialSnapshot.canaries[0]?.id ?? "",
  );
  const [selectedReleaseId, setSelectedReleaseId] = useState(
    initialSnapshot.releases[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({
    goalId: "",
    candidateCommit: "",
    goalContractVersion: "1",
    allowedAreas: "documentation\nnon-production-tooling",
    excludedAreas: "production-data\ncredentials\nbilling",
    successConditions: "Goal Verification passed\nNo P0/P1 for 48 continuous hours",
    stopConditions: "Any P0/P1\nData integrity or authorization alert\nOwner requests Stop",
  });
  const [windowEvidence, setWindowEvidence] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [windowStatus, setWindowStatus] = useState<"healthy" | "unhealthy">("healthy");
  const [p0Count, setP0Count] = useState("0");
  const [p1Count, setP1Count] = useState("0");
  const [eventDraft, setEventDraft] = useState({
    id: "",
    kind: "intervention" as "defect" | "alert" | "intervention",
    severity: "P2" as "P0" | "P1" | "P2" | "P3",
    ownerId: "",
    evidenceRef: "",
    details: "",
  });
  const [gateId, setGateId] = useState<ProductionGateId>("browser-e2e");
  const [gateRole, setGateRole] = useState<ReleaseSignatureRole>("operations");
  const [gateEvidence, setGateEvidence] = useState("");
  const [signatureRole, setSignatureRole] = useState<ReleaseSignatureRole>("security");
  const [signatureReason, setSignatureReason] = useState("");

  const selectedCanary = useMemo(() =>
    snapshot.canaries.find(({ id }) => id === selectedCanaryId) ??
      snapshot.canaries[0], [snapshot.canaries, selectedCanaryId]);
  const selectedRelease = useMemo(() =>
    snapshot.releases.find(({ id }) => id === selectedReleaseId) ??
      snapshot.releases[0], [snapshot.releases, selectedReleaseId]);

  async function refresh(message?: string) {
    const next = await releaseCenterApi.snapshot(scope);
    setSnapshot(next);
    if (message) setNotice(message);
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh(success);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createCanary() {
    await run(async () => {
      const created = await releaseCenterApi.createCanary(scope, {
        goalId: draft.goalId,
        candidateCommit: draft.candidateCommit,
        goalContractVersion: Number(draft.goalContractVersion),
        allowedAreas: lines(draft.allowedAreas),
        excludedAreas: lines(draft.excludedAreas),
        successConditions: lines(draft.successConditions),
        stopConditions: lines(draft.stopConditions),
        rollbackRunbook: "docs/runbooks/deployment-rollback-upgrade.md",
        stopRunbook: "docs/runbooks/execution-stop-worker-loss.md",
        reason: "Create a bounded internal low-risk P12 Canary draft.",
      });
      setSelectedCanaryId(created.id);
    }, "Canary 草稿已创建；配置将在项目负责人批准时锁定。");
  }

  function activeStart(canary: CanaryAggregate): string | null {
    return canary.windows.filter(({ attempt }) => attempt === canary.attempt)
      .at(-1)?.endedAt ?? canary.startedAt;
  }

  async function recordWindow(canary: CanaryAggregate) {
    const startedAt = activeStart(canary);
    if (!startedAt || !windowEnd) {
      setError("请填写窗口结束时间；开始时间由上一窗口自动锁定。");
      return;
    }
    await run(() => releaseCenterApi.canaryAction(scope, canary.id, {
      type: "record-window",
      expectedVersion: canary.version,
      reason: "Record the next auditable P12 Canary observation window.",
      window: {
        sequence: canary.windows.filter(({ attempt }) => attempt === canary.attempt).length + 1,
        startedAt,
        endedAt: new Date(windowEnd).toISOString(),
        status: windowStatus,
        p0Count: Number(p0Count),
        p1Count: Number(p1Count),
        evidenceRefs: [windowEvidence],
      },
    }), "观察窗口已保存并写入审计时间线。");
  }

  async function recordEvent(canary: CanaryAggregate) {
    const common = {
      id: eventDraft.id,
      observedAt: new Date().toISOString(),
      ownerId: eventDraft.ownerId,
      evidenceRefs: [eventDraft.evidenceRef],
    };
    let event: NewCanaryEvent;
    if (eventDraft.kind === "intervention") {
      event = { ...common, kind: "intervention", reason: eventDraft.details };
    } else if (eventDraft.kind === "alert") {
      event = { ...common, kind: "alert", severity: eventDraft.severity, resolved: false };
    } else {
      event = {
        ...common,
        kind: "defect",
        severity: eventDraft.severity,
        status: "mitigated",
        workaround: eventDraft.details,
      };
    }
    await run(() => releaseCenterApi.canaryAction(scope, canary.id, {
      type: "record-event",
      expectedVersion: canary.version,
      reason: "Record a disclosed Canary defect, alert, or intervention.",
      event,
    }), "Canary 事件已披露；P0/P1 会立即停止本次计时。");
  }

  async function createRelease(canary: CanaryAggregate) {
    await run(async () => {
      const release = await releaseCenterApi.createProductionRelease(
        scope,
        canary.id,
        "Create the Production V1 release from passed Canary evidence.",
      );
      setSelectedReleaseId(release.id);
    }, "Production Release 已创建，开始逐项关闭十项门禁。");
  }

  return (
    <div
      className="release-center-shell"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <header className="release-center-header">
        <div>
          <p>FORGE · AI DEV HARNESS</p>
          <h1>P12 发布中心</h1>
          <span>真实 Canary、Production Gate 与四方签署的生产控制面</span>
        </div>
        <Link href="/" className="secondary-button">返回研发工作台</Link>
      </header>

      <main className="release-center-main">
        <section className="release-summary-grid" aria-label="发布状态摘要">
          <article><span>Canary</span><strong>{snapshot.canaries.length}</strong><small>草稿与历史尝试</small></article>
          <article><span>连续观测</span><strong>{selectedCanary ? `${canaryProgress(selectedCanary).completedHours.toFixed(1)}h` : "0h"}</strong><small>最低要求 48h</small></article>
          <article><span>Production Gate</span><strong>{selectedRelease ? `${selectedRelease.gates.length}/10` : "0/10"}</strong><small>证据锁定后不可修改</small></article>
          <article><span>OIDC 签署</span><strong>{selectedRelease ? `${selectedRelease.signatures.length}/4` : "0/4"}</strong><small>签署人必须互不相同</small></article>
        </section>

        {notice && <div className="release-notice" role="status">{notice}</div>}
        {error && <div className="release-error" role="alert">{error}</div>}

        <section className="release-panel">
          <div className="release-panel-heading">
            <div><p>STEP 1</p><h2>创建低风险内部 Canary</h2></div>
            <span>配置在批准时锁定</span>
          </div>
          <div className="release-form-grid">
            <label>Goal ID<input value={draft.goalId} onChange={(event) => setDraft({ ...draft, goalId: event.target.value })} placeholder="UUID" /></label>
            <label>候选 Commit<input value={draft.candidateCommit} onChange={(event) => setDraft({ ...draft, candidateCommit: event.target.value })} placeholder="40 位 Git SHA" /></label>
            <label>Goal Contract 版本<input type="number" min="1" value={draft.goalContractVersion} onChange={(event) => setDraft({ ...draft, goalContractVersion: event.target.value })} /></label>
            <label>允许范围<textarea value={draft.allowedAreas} onChange={(event) => setDraft({ ...draft, allowedAreas: event.target.value })} /></label>
            <label>排除范围<textarea value={draft.excludedAreas} onChange={(event) => setDraft({ ...draft, excludedAreas: event.target.value })} /></label>
            <label>成功条件<textarea value={draft.successConditions} onChange={(event) => setDraft({ ...draft, successConditions: event.target.value })} /></label>
            <label>Stop 条件<textarea value={draft.stopConditions} onChange={(event) => setDraft({ ...draft, stopConditions: event.target.value })} /></label>
          </div>
          <button type="button" className="primary-button" disabled={busy || !hydrated} onClick={() => void createCanary()}>创建 Canary 草稿</button>
        </section>

        <section className="release-panel">
          <div className="release-panel-heading">
            <div><p>STEP 2</p><h2>48 小时连续观测</h2></div>
            <select aria-label="选择 Canary" value={selectedCanary?.id ?? ""} onChange={(event) => setSelectedCanaryId(event.target.value)}>
              {snapshot.canaries.map((canary) => <option key={canary.id} value={canary.id}>{canary.id.slice(0, 8)} · {canaryStatus[canary.status]}</option>)}
            </select>
          </div>
          {!selectedCanary ? <div className="release-empty">创建 Canary 后在这里批准并观测。</div> : (
            <div className="canary-workspace">
              <div className="release-status-line"><span className={`release-badge ${selectedCanary.status}`}>{canaryStatus[selectedCanary.status]}</span><code>{selectedCanary.candidateCommit}</code><span>Attempt {selectedCanary.attempt}</span></div>
              <div className="canary-progress" aria-label="Canary 观测进度"><span style={{ width: `${progressPercent(selectedCanary)}%` }} /></div>
              <p>{canaryProgress(selectedCanary).completedHours.toFixed(2)} / 48 小时 · {canaryProgress(selectedCanary).windowCount} 个证据窗口</p>
              {selectedCanary.status === "draft" && <button className="primary-button" disabled={busy || !hydrated} onClick={() => void run(() => releaseCenterApi.canaryAction(scope, selectedCanary.id, { type: "approve", expectedVersion: selectedCanary.version, reason: "Project owner approves the bounded P12 Canary and starts observation." }), "Owner 已批准，48 小时时钟开始计时。")}>项目负责人批准并开始计时</button>}
              {selectedCanary.status === "stopped" && <button className="danger-button" disabled={busy || !hydrated} onClick={() => void run(() => releaseCenterApi.canaryAction(scope, selectedCanary.id, { type: "restart", expectedVersion: selectedCanary.version, reason: "Project owner confirms remediation and restarts the full Canary clock." }), "修复已确认；新 Attempt 从零开始计时。")}>修复后重新批准并从零计时</button>}
              {selectedCanary.status === "observing" && (
                <div className="release-action-columns">
                  <form onSubmit={(event) => { event.preventDefault(); void recordWindow(selectedCanary); }}>
                    <h3>记录观察窗口</h3>
                    <p>开始：{activeStart(selectedCanary) ? utc(activeStart(selectedCanary) as string) : "等待批准"}</p>
                    <label>窗口结束时间（本地）<input type="datetime-local" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} /></label>
                    <label>指标证据引用<input value={windowEvidence} onChange={(event) => setWindowEvidence(event.target.value)} placeholder="metric-window:20260805-01" /></label>
                    <label>状态<select value={windowStatus} onChange={(event) => setWindowStatus(event.target.value as "healthy" | "unhealthy")}><option value="healthy">healthy</option><option value="unhealthy">unhealthy</option></select></label>
                    <div className="release-inline-fields"><label>P0<input type="number" min="0" value={p0Count} onChange={(event) => setP0Count(event.target.value)} /></label><label>P1<input type="number" min="0" value={p1Count} onChange={(event) => setP1Count(event.target.value)} /></label></div>
                    <button className="secondary-button" disabled={busy}>记录观察窗口</button>
                  </form>
                  <form onSubmit={(event) => { event.preventDefault(); void recordEvent(selectedCanary); }}>
                    <h3>披露事件</h3>
                    <label>事件 ID<input value={eventDraft.id} onChange={(event) => setEventDraft({ ...eventDraft, id: event.target.value })} /></label>
                    <label>类型<select value={eventDraft.kind} onChange={(event) => setEventDraft({ ...eventDraft, kind: event.target.value as typeof eventDraft.kind })}><option value="intervention">人工介入</option><option value="alert">告警</option><option value="defect">缺陷</option></select></label>
                    {eventDraft.kind !== "intervention" && <label>级别<select value={eventDraft.severity} onChange={(event) => setEventDraft({ ...eventDraft, severity: event.target.value as typeof eventDraft.severity })}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>}
                    <label>负责人<input value={eventDraft.ownerId} onChange={(event) => setEventDraft({ ...eventDraft, ownerId: event.target.value })} /></label>
                    <label>证据引用<input value={eventDraft.evidenceRef} onChange={(event) => setEventDraft({ ...eventDraft, evidenceRef: event.target.value })} /></label>
                    <label>{eventDraft.kind === "defect" ? "规避方案" : "原因"}<textarea value={eventDraft.details} onChange={(event) => setEventDraft({ ...eventDraft, details: event.target.value })} /></label>
                    <button className="secondary-button" disabled={busy}>记录事件</button>
                  </form>
                </div>
              )}
              {selectedCanary.events.length > 0 && (
                <div className="canary-event-timeline" aria-label="Canary 事件时间线">
                  <h3>事件时间线</h3>
                  {selectedCanary.events.map((event) => (
                    <article key={`${event.attempt}:${event.id}`}>
                      <div>
                        <strong>{event.kind === "defect" ? "缺陷" : event.kind === "alert" ? "告警" : "人工介入"}</strong>
                        <code>{event.id}</code>
                        <span>Attempt {event.attempt} · {utc(event.observedAt)}</span>
                      </div>
                      <p>
                        负责人 {event.ownerId} · {event.kind === "intervention"
                          ? event.reason
                          : `${event.severity}${event.kind === "alert" ? event.resolved ? " · 已解除" : " · 未解除" : ` · ${event.status}`}`}
                      </p>
                      {event.kind === "alert" && !event.resolved && selectedCanary.status === "observing" && (
                        <button
                          className="secondary-button"
                          disabled={busy || !hydrated}
                          onClick={() => void run(() => releaseCenterApi.canaryAction(scope, selectedCanary.id, {
                            type: "resolve-alert",
                            expectedVersion: selectedCanary.version,
                            eventId: event.id,
                            reason: "Operations verified the alert is resolved with retained evidence.",
                          }), "告警已解除，原始披露记录和解除操作均已保留。")}
                        >
                          确认告警已解除
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              )}
              {selectedCanary.status === "observing" && <button className="primary-button" disabled={busy || !hydrated} onClick={() => void run(() => releaseCenterApi.canaryAction(scope, selectedCanary.id, { type: "finalize", expectedVersion: selectedCanary.version, reason: "Finalize Canary after 48 hours and passed Goal Verification." }), "Canary 报告已通过最终校验。")}>完成 Canary 校验</button>}
              {selectedCanary.status === "passed" && !snapshot.releases.some(({ canaryId }) => canaryId === selectedCanary.id) && <button className="primary-button" disabled={busy || !hydrated} onClick={() => void createRelease(selectedCanary)}>创建 Production Release</button>}
            </div>
          )}
        </section>

        <section className="release-panel">
          <div className="release-panel-heading">
            <div><p>STEP 3</p><h2>Production Gate 与四方签署</h2></div>
            <select aria-label="选择 Production Release" value={selectedRelease?.id ?? ""} onChange={(event) => setSelectedReleaseId(event.target.value)}>
              {snapshot.releases.map((release) => <option key={release.id} value={release.id}>{release.id.slice(0, 8)} · {releaseStatus[release.status]}</option>)}
            </select>
          </div>
          {!selectedRelease ? <div className="release-empty">Canary 通过后创建 Production Release。</div> : (
            <div className="production-workspace">
              <div className="release-status-line"><span className={`release-badge ${selectedRelease.status}`}>{releaseStatus[selectedRelease.status]}</span><code>{selectedRelease.attestationDigest ?? "证据摘要尚未锁定"}</code></div>
              <div className="gate-grid">
                {P12_PRODUCTION_GATE_IDS.map((id) => {
                  const gate = selectedRelease.gates.find(({ gateId: existing }) => existing === id);
                  return <div key={id} className={gate ? "gate-complete" : "gate-pending"}><span>{gate ? "✓" : "○"}</span><strong>{gateLabels[id]}</strong><small>{gate ? `${roleLabels[gate.ownerRole]} · ${gate.evidenceRefs[0]}` : "等待证据"}</small></div>;
                })}
              </div>
              {selectedRelease.status === "draft" && (
                <div className="release-gate-form">
                  <label>门禁<select value={gateId} onChange={(event) => setGateId(event.target.value as ProductionGateId)}>{P12_PRODUCTION_GATE_IDS.map((id) => <option key={id} value={id}>{gateLabels[id]}</option>)}</select></label>
                  <label>责任角色<select value={gateRole} onChange={(event) => setGateRole(event.target.value as ReleaseSignatureRole)}>{P12_RELEASE_SIGNATURE_ROLES.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>
                  <label>证据引用<input value={gateEvidence} onChange={(event) => setGateEvidence(event.target.value)} placeholder="gate-receipt:..." /></label>
                  <button className="secondary-button" disabled={busy || !hydrated} onClick={() => void run(() => releaseCenterApi.productionAction(scope, selectedRelease.id, { type: "check-gate", expectedVersion: selectedRelease.version, gateId, ownerRole: gateRole, evidenceRefs: [gateEvidence], reason: `Confirm ${gateId} passed after evidence review.` }), `${gateLabels[gateId]} 已通过并写入审计。`)}>确认门禁通过</button>
                  <button className="primary-button" disabled={busy || !hydrated || selectedRelease.gates.length !== 10} onClick={() => void run(() => releaseCenterApi.productionAction(scope, selectedRelease.id, { type: "evaluate", expectedVersion: selectedRelease.version, reason: "Lock all ten Production V1 gates and calculate the evidence digest." }), "十项门禁已锁定；现在需要四个不同 OIDC 身份签署。")}>锁定证据并生成摘要</button>
                </div>
              )}
              <div className="signature-grid">
                {P12_RELEASE_SIGNATURE_ROLES.map((role) => {
                  const signature = selectedRelease.signatures.find(({ role: existing }) => existing === role);
                  return <div key={role} className={signature ? "signature-complete" : "signature-pending"}><span>{roleLabels[role]}</span><strong>{signature ? "已签署" : "等待签署"}</strong><small>{signature ? `${signature.signerId} · ${signature.auditReceiptId}` : "需要匹配角色的 OIDC 身份"}</small></div>;
                })}
              </div>
              {selectedRelease.status === "awaiting_signatures" && (
                <div className="release-sign-form">
                  <label>签署角色<select value={signatureRole} onChange={(event) => setSignatureRole(event.target.value as ReleaseSignatureRole)}>{P12_RELEASE_SIGNATURE_ROLES.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>
                  <label>审批理由<textarea value={signatureReason} onChange={(event) => setSignatureReason(event.target.value)} placeholder="说明已审查的证据和批准依据，至少 20 个字符" /></label>
                  <button className="primary-button" disabled={busy || !hydrated} onClick={() => void run(() => releaseCenterApi.productionAction(scope, selectedRelease.id, { type: "sign", expectedVersion: selectedRelease.version, role: signatureRole, reason: signatureReason }), `${roleLabels[signatureRole]}签署已由服务端 OIDC 身份和 Audit Receipt 绑定。`)}>以当前 OIDC 身份签署</button>
                </div>
              )}
              {selectedRelease.status === "approved" && <div className="release-approved"><strong>Production V1 发布门禁已全部通过</strong><span>10/10 Gate · 4/4 独立签署 · evidence digest 已锁定</span></div>}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
