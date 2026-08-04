import { schedulerCandidates } from "../view-data";
import { StatusPill } from "./ui";

export function SchedulerView({ notify }: { notify: (message: string) => void }) {
  return (
    <div className="screen scheduler-screen">
      <div className="scheduler-page-heading">
        <div>
          <p className="eyebrow">GLOBAL SCHEDULER</p>
          <h2>跨 Goal 调度</h2>
          <p>只展示当前容量、候选队列和影响实际分配的约束。</p>
        </div>
        <div className="scheduler-page-actions">
          <StatusPill tone="success">预算健康</StatusPill>
          <button className="secondary-button" onClick={() => notify("调度策略设置已打开")}>调整策略</button>
        </div>
      </div>

      <section className="scheduler-summary-grid" aria-label="全局调度关键指标">
        <div><span>并行目标</span><strong>3<small>/4</small></strong><small>1 个组合槽位可用</small></div>
        <div><span>活跃 Worker</span><strong>2<small>/3</small></strong><small>当前不自动补满</small></div>
        <div><span>候选任务</span><strong>4</strong><small>0 个可立即领取</small></div>
        <div><span>执行中冲突</span><strong className="teal-text">0</strong><small>1 项已自动串行</small></div>
      </section>

      <section className="panel scheduler-capacity-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">WORKER CAPACITY</p>
            <h3>当前容量</h3>
          </div>
          <span className="scheduler-live"><i /> 2 / 3 活跃</span>
        </div>
        <div className="worker-slot-grid">
          <article className="worker-slot active">
            <div><span>W1</span><StatusPill tone="info">执行中</StatusPill></div>
            <strong>DEV-06 · AutoDev 模型路由</strong>
            <p>GOAL-2407 · 测试 84 / 112</p>
          </article>
          <article className="worker-slot review">
            <div><span>W2</span><StatusPill tone="warning">Review</StatusPill></div>
            <strong>DEV-07 · Web 审批工作区</strong>
            <p>GOAL-2407 · 等待人工边界决定</p>
          </article>
          <article className="worker-slot available">
            <div><span>W3</span><StatusPill tone="neutral">保留</StatusPill></div>
            <strong>暂不领取新任务</strong>
            <p>预算比计划高 3pp，且没有可立即领取任务</p>
          </article>
        </div>
      </section>

      <div className="global-scheduler-grid">
        <main className="panel scheduler-queue-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">CROSS-GOAL QUEUE</p>
              <h3>跨 Goal 候选队列</h3>
            </div>
            <span className="queue-total">4 个候选</span>
          </div>
          <div className="scheduler-queue-head" aria-hidden="true">
            <span>优先级 / 任务</span><span>所属 Goal</span><span>领取条件</span><span>冲突键</span><span>状态</span>
          </div>
          <div className="scheduler-queue-list">
            {schedulerCandidates.map((item) => (
              <article className="scheduler-queue-item" key={item.issue}>
                <div className="scheduler-task"><b>{item.priority}</b><span><strong>{item.issue}</strong>{item.title}</span></div>
                <span>{item.goal}</span>
                <span>{item.gate}</span>
                <code>{item.conflict}</code>
                <StatusPill tone={item.tone}>{item.status}</StatusPill>
              </article>
            ))}
          </div>
        </main>

        <aside className="scheduler-aside">
          <section className="panel scheduler-budget-panel">
            <div className="panel-header">
              <div><p className="eyebrow">BUDGET</p><h3>预算健康</h3></div>
              <StatusPill tone="success">可控</StatusPill>
            </div>
            <div className="scheduler-budget-value"><strong>71%</strong><span>本周期已用</span></div>
            <div className="token-track" aria-label="Token 使用 71%，当前计划 68%">
              <span className="token-target" title="当前计划 68%" />
              <span className="token-fill" />
            </div>
            <dl className="scheduler-budget-facts">
              <div><dt>当前计划</dt><dd>68%</dd></div>
              <div><dt>预计周期利用</dt><dd>96%</dd></div>
              <div><dt>验收与重试预留</dt><dd>15%</dd></div>
            </dl>
          </section>

          <section className="panel scheduler-conflict-panel">
            <div className="panel-header">
              <div><p className="eyebrow">CONFLICTS</p><h3>冲突与串行约束</h3></div>
              <StatusPill tone="success">0 执行冲突</StatusPill>
            </div>
            <div className="conflict-chain">
              <span>DEV-06</span><i>先完成</i><span>ID-11</span>
            </div>
            <p><code>goal-contract.ts</code> 由 GOAL-2407 占用；GOAL-2403 已排到其后，不会并行落地。</p>
          </section>
        </aside>
      </div>

      <section className="scheduler-reason-strip" aria-label="当前分配理由">
        <div><span>1</span><p><strong>为什么 W3 保留？</strong>Token 使用比计划高 3pp，并且候选任务仍有依赖或人工门禁。</p></div>
        <div><span>2</span><p><strong>为什么继续投入 GOAL-2407？</strong>P0 交付路径已进入 Review，完成当前证据的边际价值最高。</p></div>
        <div><span>3</span><p><strong>冲突如何处理？</strong>共享文件通过冲突键自动串行，当前没有执行中写入冲突。</p></div>
      </section>
    </div>
  );
}
