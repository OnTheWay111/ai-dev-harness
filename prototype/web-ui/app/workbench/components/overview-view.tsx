import { useMemo, useState } from "react";

import type {
  GlobalTask,
  TaskFilter,
  TaskKind,
  View,
  WorkbenchMetric,
  WorkbenchSnapshot,
} from "../contracts";
import {
  buildTaskFilters,
  filterGlobalTasks,
  formatClock,
  formatDuration,
} from "../selectors";
import { ProgressBar, StatusPill } from "./ui";
import { TaskActionDialog } from "./task-action-dialog";

const taskKindLabels: Record<TaskKind, string> = {
  issue: "Issue",
  gate: "门禁任务",
  scheduling: "调度任务",
};

function displayTaskId(taskId: string): string {
  return taskId.split(":").at(-1) ?? taskId;
}

function MetricCard({
  metric,
  active,
  onClick,
}: {
  metric: WorkbenchMetric;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`${active ? "active" : ""} ${
        active && metric.tone === "danger" ? "danger" : ""
      }`}
      onClick={onClick}
    >
      <span>{metric.label}</span>
      <strong className={metric.tone === "success" ? "teal-text" : undefined}>
        {metric.value}
        {metric.suffix && <small>{metric.suffix}</small>}
      </strong>
      <small>
        {metric.detailEmphasis && <b>{metric.detailEmphasis}</b>}
        {metric.detailEmphasis && " · "}
        {metric.detail}
      </small>
    </button>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onAction,
  notify,
}: {
  task: GlobalTask;
  expanded: boolean;
  onToggle: () => void;
  onAction: () => void;
  notify: (message: string) => void;
}) {
  return (
    <article
      className={`global-task-row ${
        task.attention.required ? `needs-attention ${task.stage}` : "normal"
      }`}
    >
      <button
        className="global-task-row-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"} ${displayTaskId(task.id)} ${task.title} 详情`}
      >
        <div className="global-task-identity">
          <div className="global-task-meta">
            <b className={`priority-label ${task.priority.toLowerCase()}`}>{task.priority}</b>
            <span className="task-kind">{taskKindLabels[task.kind]}</span>
            <span>{task.goalId} · {displayTaskId(task.id)}</span>
          </div>
          <strong>{task.title}</strong>
          <small>{task.attention.impact}</small>
        </div>
        <div className="global-task-progress">
          <div>
            <StatusPill tone={task.status.tone}>{task.status.label}</StatusPill>
            <b>{task.progress.percent}%</b>
          </div>
          <ProgressBar value={task.progress.percent} />
        </div>
        <div className={`global-task-problem ${task.attention.required ? "attention" : "normal"}`}>
          <span>{task.attention.required ? "需处理" : "正常"}</span>
          <strong>{task.attention.headline}</strong>
          <small>{task.attention.rankingReason}</small>
        </div>
        <div className="global-task-context">
          <strong>{task.execution.actorLabel}</strong>
          <span>已用 {formatDuration(task.execution.elapsedSeconds)}</span>
          <small>下一步 · {task.execution.nextCheckpoint}</small>
        </div>
      </button>
      <button
        className="secondary-button compact task-action"
        onClick={onAction}
        disabled={!task.action.available}
        title={task.action.unavailableReason}
      >
        {task.action.label}
      </button>
      {expanded && (
        <div className="global-task-expanded">
          <div><span>依赖</span><strong>{task.detail.dependency}</strong></div>
          <div><span>证据</span><strong>{task.detail.evidence}</strong></div>
          <div><span>工作区</span><strong>{task.detail.workspace}</strong></div>
          <button className="text-button" onClick={() => notify(`${displayTaskId(task.id)} 日志与证据已打开`)}>
            查看日志与证据 →
          </button>
        </div>
      )}
    </article>
  );
}

export function OverviewView({
  snapshot,
  onNavigate,
  notify,
  onRefresh,
}: {
  snapshot: WorkbenchSnapshot;
  onNavigate: (view: View) => void;
  notify: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [actionTask, setActionTask] = useState<GlobalTask | null>(null);
  const taskFilters = useMemo(
    () => buildTaskFilters(snapshot.tasks, snapshot.summary.taskCounts),
    [snapshot.tasks, snapshot.summary.taskCounts],
  );
  const visibleTasks = useMemo(
    () => filterGlobalTasks(snapshot.tasks, taskFilter),
    [snapshot.tasks, taskFilter],
  );
  const displayedTasks = taskFilter === "all" ? visibleTasks.slice(0, 6) : visibleTasks;

  const applyFilter = (filter: TaskFilter) => {
    setTaskFilter(filter);
    setExpandedTaskId(null);
  };

  const handleMetric = (metric: WorkbenchMetric) => {
    if (metric.targetFilter) applyFilter(metric.targetFilter);
    else if (metric.targetView) onNavigate(metric.targetView);
    else notify("今日完成记录已打开");
  };

  const handleTaskAction = (task: GlobalTask) => {
    if (!task.action.available) {
      notify(task.action.unavailableReason ?? "当前角色没有执行此操作的权限");
      return;
    }
    if (["inspect_schedule", "inspect_run"].includes(task.action.id) &&
      task.action.targetView) {
      onNavigate(task.action.targetView);
    } else {
      setActionTask(task);
    }
  };

  return (
    <div className="screen overview-screen">
      <div className="overview-section-heading">
        <h2>运行态势</h2>
        <span>数据更新于 {formatClock(snapshot.generatedAt)}</span>
      </div>

      <section className="overview-kpi-grid" aria-label="运行数据统计">
        {snapshot.summary.metrics.map((metric) => (
          <MetricCard
            key={metric.id}
            metric={metric}
            active={Boolean(metric.targetFilter && taskFilter === metric.targetFilter)}
            onClick={() => handleMetric(metric)}
          />
        ))}
      </section>

      <section className="panel global-task-panel" aria-labelledby="global-task-title">
        <div className="panel-header global-task-header">
          <div>
            <p className="eyebrow">跨 Goal 工作队列</p>
            <h3 id="global-task-title">全局任务</h3>
          </div>
          <div className="task-filters" aria-label="全局任务筛选">
            {taskFilters.map((filter) => (
              <button
                key={filter.id}
                className={taskFilter === filter.id ? "active" : ""}
                onClick={() => applyFilter(filter.id)}
              >
                {filter.label} <span>{filter.count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="global-task-sort-note">
          <span>需处理任务置顶</span>
          业务优先级 → 截止时间 → 阻塞影响 → 等待时长
          <button onClick={() => notify("排序规则说明已打开")}>为什么这样排？</button>
        </div>
        <div className="global-task-columns" aria-hidden="true">
          <span>任务</span>
          <span>执行进度</span>
          <span>待处理问题</span>
          <span>执行上下文</span>
          <span>操作</span>
        </div>
        <div className="global-task-list">
          {displayedTasks.length === 0 && (
            <div className="workbench-empty-state" role="status">
              <strong>{taskFilter === "all" ? "暂无可见任务，真实数据为空" : "当前筛选暂无可见任务"}</strong>
              <span>已应用服务端权限范围和权威统计口径，可切换筛选或等待新的领域事件。</span>
            </div>
          )}
          {displayedTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={expandedTaskId === task.id}
              onToggle={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
              onAction={() => handleTaskAction(task)}
              notify={notify}
            />
          ))}
        </div>
        <div className="global-task-footer">
          <span>
            {taskFilter === "all"
              ? `显示前 6 项 · 共 ${visibleTasks.length} 项`
              : `已筛选 ${displayedTasks.length} 项`}
          </span>
          <div>
            <button className="text-button" onClick={() => onNavigate("run")}>打开执行中心</button>
            <button className="text-button" onClick={() => onNavigate("scheduler")}>查看全局调度 →</button>
          </div>
        </div>
      </section>
      {actionTask && (
        <TaskActionDialog
          task={actionTask}
          onClose={() => setActionTask(null)}
          onCompleted={() => {
            notify(`${displayTaskId(actionTask.id)} 异步命令已完成`);
            void onRefresh();
          }}
        />
      )}
    </div>
  );
}
