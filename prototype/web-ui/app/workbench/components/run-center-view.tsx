import { useEffect, useState } from "react";

import { ProgressBar, StatusPill } from "./ui";

const timelineEvents = [
  { time: "14:32:18", title: "DEV-06 测试进入第 84 项", detail: "worker W1 · npm test", tone: "info" },
  { time: "14:31:52", title: "DEV-07 提交已创建", detail: "8d21fa7 · 12 files changed", tone: "success" },
  { time: "14:31:49", title: "浏览器 E2E 通过", detail: "9 scenarios · 1m 42s", tone: "success" },
  { time: "14:29:10", title: "模型路由已锁定", detail: "advanced_coding / high", tone: "violet" },
  { time: "14:27:44", title: "DEV-06 被 Worker W1 领取", detail: "lease 9d8c…a12f", tone: "neutral" },
];

export function RunCenterView({
  onVerify,
  notify,
}: {
  onVerify: () => void;
  notify: (message: string) => void;
}) {
  const [running, setRunning] = useState(true);
  const [progress, setProgress] = useState(62);

  useEffect(() => {
    if (!running || progress >= 86) return;
    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(86, current + 1));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [running, progress]);

  const completed = progress >= 80 ? 6 : 5;

  return (
    <div className="screen detail-screen">
      <div className="goal-heading run-heading">
        <div>
          <div className="heading-meta">
            <StatusPill tone={running ? "info" : "warning"}>{running ? "执行中" : "已暂停领取"}</StatusPill>
            <span>GOAL-2407</span><span>Run loop #18</span>
          </div>
          <h2>Production V1 自动开发</h2>
          <p>受控执行节点 cn-dev-02 · 基线 main@4cd1c4e · 预算剩余 112 分钟</p>
        </div>
        <div className="heading-actions">
          <button
            className={running ? "danger-outline-button" : "secondary-button"}
            onClick={() => {
              setRunning((current) => !current);
              notify(running ? "已停止领取新任务；运行中任务将安全排空" : "已恢复任务领取");
            }}
          >
            {running ? "暂停领取" : "恢复领取"}
          </button>
          <button className="ghost-button" onClick={() => notify("运行证据包已导出")}>导出证据</button>
        </div>
      </div>

      <div className="run-progress-panel">
        <div className="run-progress-copy">
          <p className="eyebrow">GOAL PROGRESS</p>
          <div><strong>{progress}%</strong><span>{completed} / 8 Issue 完成 · 当前 Wave 3 / 4</span></div>
        </div>
        <ProgressBar value={progress} />
        <div className="run-facts">
          <span><i className="fact-dot teal" /> 2 个 Worker 活跃</span>
          <span><i className="fact-dot blue" /> 1 个等待 Review</span>
          <span><i className="fact-dot amber" /> 0 个阻塞</span>
          <button onClick={onVerify}>查看目标验收 →</button>
        </div>
      </div>

      <div className="run-layout">
        <main className="run-main">
          <section className="panel workers-panel">
            <div className="panel-header">
              <div><p className="eyebrow">ACTIVE WORKERS</p><h3>当前执行</h3></div>
              <span className="auto-refresh">每 5 秒自动刷新</span>
            </div>
            <div className="worker-card">
              <div className="worker-top">
                <div className="worker-identity">
                  <span className="worker-number">W1</span>
                  <div>
                    <div><strong>DEV-06 · AutoDev 模型路由</strong><StatusPill tone="info">Builder 工作中</StatusPill></div>
                    <p>Worktree · autodev/goal-2407/dev-06</p>
                  </div>
                </div>
                <span className="elapsed">18:42</span>
              </div>
              <div className="worker-route">
                <div><small>BUILDER</small><span className="route-avatar codex">C</span><strong>Codex · 强编码 / 高推理</strong></div>
                <span className="route-arrow">→</span>
                <div><small>REVIEWER</small><span className="route-avatar reviewer">R</span><strong>独立 Reviewer · 只读新会话</strong></div>
              </div>
              <div className="worker-action">
                <div className="terminal-line"><span>$</span><code>npm test -- --runInBand</code><small>测试 84 / 112</small></div>
                <ProgressBar value={75} />
              </div>
            </div>

            <div className="worker-card">
              <div className="worker-top">
                <div className="worker-identity">
                  <span className="worker-number violet">W2</span>
                  <div>
                    <div><strong>DEV-07 · Web 需求审批工作区</strong><StatusPill tone="warning">等待 Review</StatusPill></div>
                    <p>Worktree · autodev/goal-2407/dev-07</p>
                  </div>
                </div>
                <span className="elapsed">24:08</span>
              </div>
              <div className="evidence-row">
                <span>✓ 类型检查</span><span>✓ 组件测试</span><span>✓ 浏览器 E2E</span><span>Commit 8d21fa7</span>
              </div>
              <div className="review-callout"><span className="spinner" />独立 Reviewer 正在检查权限边界和错误状态…</div>
            </div>
          </section>

          <section className="panel queue-panel">
            <div className="panel-header">
              <div><p className="eyebrow">NEXT WAVE</p><h3>等待队列</h3></div>
              <StatusPill tone="neutral">2 个待执行</StatusPill>
            </div>
            <div className="queue-row">
              <span className="queue-index">08</span>
              <div><strong>Goal Verifier 与 Delivery Report</strong><p>等待 DEV-06、DEV-07 完成 · 与当前文件无冲突</p></div>
              <span className="model-badge">最强可用 · 最高</span>
            </div>
            <div className="queue-row">
              <span className="queue-index">09</span>
              <div><strong>生产硬化与恢复演练</strong><p>等待 DEV-08 · 独占资源 integration-db</p></div>
              <span className="model-badge">强上下文 · 高</span>
            </div>
          </section>
        </main>

        <aside className="panel timeline-panel">
          <div className="panel-header">
            <div><p className="eyebrow">LIVE EVIDENCE</p><h3>运行时间线</h3></div>
            <span className="live-label"><span />LIVE</span>
          </div>
          <div className="timeline">
            {timelineEvents.map((event) => (
              <div className="timeline-event" key={`${event.time}-${event.title}`}>
                <span className={`timeline-dot ${event.tone}`} />
                <time>{event.time}</time>
                <div><strong>{event.title}</strong><small>{event.detail}</small></div>
              </div>
            ))}
          </div>
          <button className="secondary-button full">查看完整日志与 Artifact</button>
        </aside>
      </div>
    </div>
  );
}
