import { useState } from "react";

import { StatusPill, Stepper } from "./ui";

export function ClarifyView({
  onContinue,
  notify,
}: {
  onContinue: () => void;
  notify: (message: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({
    compatibility: "兼容现有 API",
    deployment: "私有网络内部部署",
  });
  const [generated, setGenerated] = useState(false);

  const answer = (key: string, value: string) => {
    setAnswers((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="screen detail-screen">
      <div className="goal-heading">
        <div>
          <div className="heading-meta">
            <StatusPill tone="warning">正在澄清</StatusPill>
            <span>GOAL-2407</span>
            <span>Revision 3</span>
          </div>
          <h2>让 AI Dev Harness 第一阶段可投入内部生产</h2>
          <p>目标创建者：Li · 更新于 8 分钟前 · 当前合同摘要 7f4a…19c2</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => notify("草稿已保存")}>保存草稿</button>
          <button
            className="ghost-button"
            onClick={() => {
              setGenerated(true);
              notify("Codex 已根据最新答案生成 1 个补充问题");
            }}
          >
            重新生成问题
          </button>
        </div>
      </div>

      <Stepper current={1} />

      <div className="workspace-grid">
        <main className="workspace-main">
          <section className="panel question-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">CODEX CLARIFIER</p>
                <h3>还需要确认 2 个决定</h3>
                <p>这些答案会改变风险等级、所需门禁和交付范围。</p>
              </div>
              <span className="ai-badge">AI 草稿 · 待人工确认</span>
            </div>

            <div className="question-card answered">
              <div className="question-number">01</div>
              <div className="question-content">
                <div className="question-title">
                  <h4>第一阶段是否允许修改现有 AutoDev Queue 接口？</h4>
                  <StatusPill tone="success">已回答</StatusPill>
                </div>
                <p>自动模型切换需要把 Builder alias 写入任务。AutoDev 0.4.16 的运行时支持，但 CLI 尚未暴露正式参数。</p>
                <div className="choice-grid">
                  {["兼容现有 API", "允许小范围扩展", "先串行降级"].map((item) => (
                    <button
                      key={item}
                      className={answers.compatibility === item ? "selected" : ""}
                      onClick={() => answer("compatibility", item)}
                    >
                      <span>{answers.compatibility === item ? "●" : "○"}</span>
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="question-card">
              <div className="question-number">02</div>
              <div className="question-content">
                <div className="question-title">
                  <h4>Production V1 的部署边界是什么？</h4>
                  <StatusPill tone="warning">需要确认</StatusPill>
                </div>
                <p>部署边界决定身份认证、网络隔离和密钥管理要求。</p>
                <div className="choice-grid">
                  {["私有网络内部部署", "公网但仅组织成员", "面向外部多租户"].map((item) => (
                    <button
                      key={item}
                      className={answers.deployment === item ? "selected" : ""}
                      onClick={() => answer("deployment", item)}
                    >
                      <span>{answers.deployment === item ? "●" : "○"}</span>
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {generated && (
              <div className="question-card new-question">
                <div className="question-number">03</div>
                <div className="question-content">
                  <div className="question-title">
                    <h4>首批 canary 项目是否允许自动创建 Pull Request？</h4>
                    <StatusPill tone="info">新问题</StatusPill>
                  </div>
                  <p>建议允许推送隔离分支，但合并继续由仓库保护规则控制。</p>
                  <textarea aria-label="回答 canary Pull Request 策略" placeholder="输入你的决定和理由…" />
                </div>
              </div>
            )}
          </section>

          <section className="panel contract-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">GOAL CONTRACT</p>
                <h3>验收标准</h3>
              </div>
              <button className="text-button">编辑合同</button>
            </div>
            <div className="criteria-list">
              {[
                "用户可以通过 Web 完成目标、范围和 Issue 审批",
                "AutoDev 能安全领取任务并保留完整运行证据",
                "系统可按 Issue 风险选择 Builder 能力和推理强度",
                "所有 Issue 完成后仍需通过顶层 Goal Verifier",
              ].map((item, index) => (
                <div className="criterion" key={item}>
                  <span>AC-{String(index + 1).padStart(3, "0")}</span>
                  <p>{item}</p>
                  <StatusPill tone="neutral">可验证</StatusPill>
                </div>
              ))}
            </div>
          </section>
        </main>

        <aside className="workspace-aside">
          <section className="panel summary-card">
            <p className="eyebrow">CLASSIFICATION PREVIEW</p>
            <h3>规模与风险建议</h3>
            <div className="classification">
              <div><small>规模</small><strong>L</strong><span>跨模块</span></div>
              <div><small>风险</small><strong className="amber-text">HIGH</strong><span>执行权限</span></div>
            </div>
            <ul className="reason-list">
              <li><span>✓</span>多项目和受控执行节点</li>
              <li><span>✓</span>修改任务模型和 Git Push 策略</li>
              <li><span>✓</span>需要 OIDC、RBAC 和审计</li>
            </ul>
          </section>
          <section className="panel context-card">
            <p className="eyebrow">CONTEXT PACKET</p>
            <h3>Codex 本次读取</h3>
            <div className="context-item">
              <span>01</span>
              <div><strong>Goal Contract</strong><small>2.4 KB · revision 3</small></div>
            </div>
            <div className="context-item">
              <span>02</span>
              <div><strong>AutoDev 能力摘要</strong><small>1.8 KB · 已脱敏</small></div>
            </div>
            <div className="context-safety"><span>盾</span>未读取完整仓库或无关文档</div>
          </section>
        </aside>
      </div>

      <div className="sticky-actionbar">
        <div>
          <span className="save-indicator">✓</span>
          <p><strong>所有回答已保存</strong><small>继续后将锁定 Goal revision 3 并生成最小方案</small></p>
        </div>
        <button className="primary-button" onClick={onContinue}>
          确认答案并继续<span>→</span>
        </button>
      </div>
    </div>
  );
}
