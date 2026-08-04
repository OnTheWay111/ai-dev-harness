import type { View } from "../contracts";
import { globalNavItems, goalNavItems } from "../view-data";

function ProductMark() {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <strong>FORGE</strong>
        <small>AI DEV HARNESS</small>
      </div>
    </div>
  );
}
export function Sidebar({
  current,
  onChange,
}: {
  current: View;
  onChange: (view: View) => void;
}) {
  return (
    <aside className="sidebar">
      <ProductMark />
      <div className="project-switcher">
        <span className="project-avatar">3</span>
        <div>
          <strong>全部目标</strong>
          <small>3 个并行 · 4 个槽位</small>
        </div>
        <span className="chevron">⌄</span>
      </div>
      <nav className="main-nav" aria-label="主导航">
        <p className="nav-caption">全局</p>
        {globalNavItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${current === item.id ? "active" : ""}`}
            onClick={() => onChange(item.id)}
            aria-current={current === item.id ? "page" : undefined}
            aria-label={item.label}
          >
            <span className="nav-symbol">{item.short}</span>
            <span>{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
        <p className="nav-caption secondary-caption">已选择 · GOAL-2407</p>
        {goalNavItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${current === item.id ? "active" : ""}`}
            onClick={() => onChange(item.id)}
            aria-current={current === item.id ? "page" : undefined}
            aria-label={item.label}
          >
            <span className="nav-symbol">{item.short}</span>
            <span>{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-status">
          <span className="pulse-dot" />
          <div>
            <strong>预算健康</strong>
            <small>预计周期利用 96%</small>
          </div>
        </div>
        <button aria-label="打开设置">设置</button>
      </div>
    </aside>
  );
}

export function Topbar({
  view,
  onCreateGoal,
}: {
  view: View;
  onCreateGoal: () => void;
}) {
  const titles: Record<View, string> = {
    overview: "研发工作台",
    scheduler: "全局调度",
    clarify: "目标工作区",
    issues: "方案与 Issue",
    run: "执行中心",
    verify: "目标验收",
  };

  return (
    <header className="topbar">
      <div>
        <p className="breadcrumb">
          {view === "overview" || view === "scheduler"
            ? "AI Dev Harness · 全部目标"
            : "AI Dev Harness · GOAL-2407"}
        </p>
        <h1>{titles[view]}</h1>
      </div>
      <div className="topbar-actions">
        <button className="primary-button" onClick={onCreateGoal} aria-label="创建新目标">
          <span aria-hidden="true">＋</span>
          <span className="button-label">创建新目标</span>
        </button>
      </div>
    </header>
  );
}
