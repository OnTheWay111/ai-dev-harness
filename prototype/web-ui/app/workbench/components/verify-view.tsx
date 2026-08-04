import { useMemo, useState } from "react";

import { StatusPill, Stepper } from "./ui";

export function VerifyView({ notify }: { notify: (message: string) => void }) {
  const [verified, setVerified] = useState(false);
  const criteria = useMemo(
    () => [
      { id: "AC-001", title: "Web 完成目标、范围和 Issue 审批", evidence: "browser-e2e/run-188 · 12 scenarios", ready: true },
      { id: "AC-002", title: "AutoDev 安全领取并保留完整证据", evidence: "run-loop-18 / evidence-manifest.json", ready: true },
      { id: "AC-003", title: "根据风险自动选择 Builder 能力", evidence: "model-route-audit / 8 decisions", ready: true },
      { id: "AC-004", title: "通过 OIDC、RBAC、审计和恢复演练", evidence: verified ? "security-gate / passed" : "等待最终恢复演练", ready: verified },
    ],
    [verified],
  );

  return (
    <div className="screen detail-screen">
      <div className="goal-heading">
        <div>
          <div className="heading-meta">
            <StatusPill tone={verified ? "success" : "warning"}>{verified ? "可以交付" : "等待最终验收"}</StatusPill>
            <span>GOAL-2407</span><span>Verification revision 1</span>
          </div>
          <h2>Production V1 目标验收</h2>
          <p>Issue 完成不等于目标完成。这里逐条验证原始 Goal Contract。</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button">下载证据包</button>
          <button
            className="primary-button"
            onClick={() => {
              setVerified(true);
              notify("Goal Verifier 已通过，Delivery Report 已生成");
            }}
          >
            {verified ? "重新运行验收" : "运行最终验收"}
          </button>
        </div>
      </div>

      <Stepper current={6} />

      <div className="verify-layout">
        <main>
          <section className="panel verification-panel">
            <div className="panel-header">
              <div><p className="eyebrow">ACCEPTANCE CRITERIA</p><h3>原始验收标准</h3></div>
              <span className="criteria-score">{criteria.filter((item) => item.ready).length} / {criteria.length} 通过</span>
            </div>
            <div className="verification-list">
              {criteria.map((item) => (
                <article className={item.ready ? "passed" : "pending"} key={item.id}>
                  <span className="verify-icon">{item.ready ? "✓" : "…"}</span>
                  <div><span>{item.id}</span><strong>{item.title}</strong><small>{item.evidence}</small></div>
                  <StatusPill tone={item.ready ? "success" : "warning"}>{item.ready ? "通过" : "待完成"}</StatusPill>
                </article>
              ))}
            </div>
          </section>

          <section className="panel risk-panel">
            <div className="panel-header">
              <div><p className="eyebrow">DISCLOSED RISKS</p><h3>风险与限制</h3></div>
              <button className="text-button">添加披露</button>
            </div>
            <div className="risk-row">
              <StatusPill tone="warning">已接受</StatusPill>
              <div><strong>首期仅支持单组织内部部署</strong><p>多租户、计费和外部客户注册已明确排除。</p></div>
              <span>Approver · Li</span>
            </div>
            <div className="risk-row">
              <StatusPill tone="info">需监控</StatusPill>
              <div><strong>AutoDev 任务级 Builder 接口依赖授权扩展</strong><p>兼容性测试通过；升级时必须重新执行契约测试。</p></div>
              <span>Owner · Platform</span>
            </div>
          </section>
        </main>

        <aside className="panel delivery-card">
          <div className={`delivery-seal ${verified ? "ready" : ""}`}><span>{verified ? "✓" : "⌛"}</span></div>
          <p className="eyebrow">DELIVERY DECISION</p>
          <h3>{verified ? "目标已经达成" : "还差 1 条证据"}</h3>
          <p>{verified ? "所有原始验收标准通过，没有未披露的阻塞问题。可以通知人工验收。" : "安全与恢复演练尚未完成。系统不会因为所有 Issue 已关闭而提前交付。"}</p>
          <div className="delivery-facts">
            <div><span>Issue</span><strong>8 / 8</strong></div>
            <div><span>测试</span><strong>326 / 326</strong></div>
            <div><span>P0/P1</span><strong>0</strong></div>
          </div>
          <button className="primary-button full" disabled={!verified} onClick={() => notify("交付通知已生成，等待人工验收")}>生成 Delivery Report</button>
          <button className="secondary-button full">预览交付内容</button>
          <small className="delivery-footnote">报告将包含代码、PR、测试、例外、风险和人工重点检查项。</small>
        </aside>
      </div>
    </div>
  );
}
