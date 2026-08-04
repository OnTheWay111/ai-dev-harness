import { useState } from "react";

import { issueRows } from "../view-data";
import { StatusPill, Stepper } from "./ui";

export function IssuesView({
  onApprove,
  notify,
}: {
  onApprove: () => void;
  notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<"table" | "waves">("table");
  const [approved, setApproved] = useState(false);

  return (
    <div className="screen detail-screen">
      <div className="goal-heading">
        <div>
          <div className="heading-meta">
            <StatusPill tone="info">等待批准</StatusPill>
            <span>GOAL-2407</span>
            <span>Issue plan revision 2</span>
          </div>
          <h2>Production V1 开发方案</h2>
          <p>5 个纵向切片 · 3 个执行波次 · 需求覆盖率 100%</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => notify("已导出方案快照")}>导出方案</button>
          <button className="ghost-button" onClick={() => notify("已请求 Codex 重新拆分")}>请求重新拆分</button>
        </div>
      </div>

      <Stepper current={4} />

      <section className="plan-summary-grid">
        <article><span className="summary-symbol teal">✓</span><div><small>需求覆盖</small><strong>12 / 12</strong><p>全部可追溯</p></div></article>
        <article><span className="summary-symbol blue">⌘</span><div><small>依赖 DAG</small><strong>健康</strong><p>无环、3 个波次</p></div></article>
        <article><span className="summary-symbol amber">!</span><div><small>人工例外</small><strong>1 项</strong><p>保留 Web 审批层</p></div></article>
        <article><span className="summary-symbol violet">AI</span><div><small>预计模型成本</small><strong>中等</strong><p>2 个高推理任务</p></div></article>
      </section>

      <section className="panel issue-plan-panel">
        <div className="panel-header issue-header">
          <div>
            <p className="eyebrow">ISSUE DEVELOPMENT CONTRACTS</p>
            <h3>开发切片与模型路由</h3>
          </div>
          <div className="view-switcher">
            <button className={mode === "table" ? "active" : ""} onClick={() => setMode("table")}>表格</button>
            <button className={mode === "waves" ? "active" : ""} onClick={() => setMode("waves")}>执行波次</button>
          </div>
        </div>

        {mode === "table" ? (
          <div className="table-wrap">
            <table className="issue-table">
              <thead>
                <tr><th>Issue</th><th>影响区域</th><th>依赖</th><th>预计文件</th><th>推荐模型</th><th>状态</th></tr>
              </thead>
              <tbody>
                {issueRows.map((issue) => (
                  <tr key={issue.id}>
                    <td><span className="issue-id">{issue.id}</span><strong>{issue.title}</strong></td>
                    <td><span className="code-chip">{issue.area}</span></td>
                    <td>{issue.depends}</td>
                    <td>{issue.files}</td>
                    <td><div className="model-cell"><span className="model-badge">{issue.model}</span><small>推理：{issue.effort}</small></div></td>
                    <td><StatusPill tone={issue.status === "可执行" ? "success" : "neutral"}>{issue.status}</StatusPill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="waves-board">
            {[
              { title: "Wave 1", items: ["DEV-01"], detail: "基础合同 · 串行" },
              { title: "Wave 2", items: ["DEV-02", "DEV-03"], detail: "无文件冲突 · 可并行" },
              { title: "Wave 3", items: ["DEV-04", "DEV-05"], detail: "执行与验收 · 串行落地" },
            ].map((wave, index) => (
              <article className="wave-column" key={wave.title}>
                <div className="wave-title">
                  <span>{index + 1}</span>
                  <div><strong>{wave.title}</strong><small>{wave.detail}</small></div>
                </div>
                {wave.items.map((item) => {
                  const issue = issueRows.find((row) => row.id === item)!;
                  return (
                    <div className="wave-issue" key={item}>
                      <div><span>{item}</span><StatusPill tone={index === 0 ? "success" : "neutral"}>{index === 0 ? "Ready" : "Blocked"}</StatusPill></div>
                      <strong>{issue.title}</strong>
                      <small>{issue.model} · {issue.area}</small>
                    </div>
                  );
                })}
                {index < 2 && <div className="wave-arrow">→</div>}
              </article>
            ))}
          </div>
        )}

        <div className="scope-note">
          <div>
            <span className="scope-icon">−</span>
            <p><strong>已排除 3 项过度设计</strong><small>模型市场、多租户计费、拖拽工作流不进入 Production V1。</small></p>
          </div>
          <button className="text-button">查看评审详情</button>
        </div>
      </section>

      <div className="approval-bar">
        <div>
          <span className="approval-lock">审</span>
          <p>
            <strong>{approved ? "方案已批准，准备进入执行" : "批准前请确认范围和模型建议"}</strong>
            <small>操作会锁定 Issue plan revision 2，并投影到 AutoDev Queue。</small>
          </p>
        </div>
        <div className="approval-actions">
          <button className="secondary-button" onClick={() => notify("已返回方案修改")}>要求修改</button>
          <button
            className="primary-button"
            onClick={() => {
              setApproved(true);
              notify("方案已批准，5 个 Issue 已进入待执行队列");
              window.setTimeout(onApprove, 700);
            }}
          >
            批准 5 个 Issue 并进入执行
          </button>
        </div>
      </div>
    </div>
  );
}
