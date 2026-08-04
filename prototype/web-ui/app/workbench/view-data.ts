import type {
  IssuePlanRow,
  NavItem,
  SchedulerCandidate,
} from "./contracts";

export const globalNavItems: NavItem[] = [
  { id: "overview", label: "工作台", short: "概" },
  { id: "scheduler", label: "全局调度", short: "调" },
];

export const goalNavItems: NavItem[] = [
  { id: "clarify", label: "目标与澄清", short: "目", badge: "2" },
  { id: "issues", label: "方案与 Issue", short: "案", badge: "1" },
  { id: "run", label: "执行中心", short: "执" },
  { id: "verify", label: "目标验收", short: "验" },
];

export const issueRows: IssuePlanRow[] = [
  {
    id: "DEV-01",
    title: "建立 Goal Contract 与版本状态",
    area: "domain",
    depends: "—",
    files: "6 个",
    model: "通用编码",
    effort: "中",
    status: "可执行",
  },
  {
    id: "DEV-02",
    title: "Codex 结构化澄清与风险分级",
    area: "planning",
    depends: "DEV-01",
    files: "8 个",
    model: "强上下文",
    effort: "高",
    status: "等待依赖",
  },
  {
    id: "DEV-03",
    title: "最小范围与过度设计审批",
    area: "governance",
    depends: "DEV-01",
    files: "5 个",
    model: "通用编码",
    effort: "中",
    status: "等待依赖",
  },
  {
    id: "DEV-04",
    title: "Issue DAG、模型路由与 AutoDev 投影",
    area: "execution",
    depends: "DEV-02, 03",
    files: "11 个",
    model: "最强可用",
    effort: "最高",
    status: "等待依赖",
  },
  {
    id: "DEV-05",
    title: "Goal Verifier 与交付报告",
    area: "verification",
    depends: "DEV-04",
    files: "7 个",
    model: "强上下文",
    effort: "高",
    status: "等待依赖",
  },
];

export const schedulerCandidates: SchedulerCandidate[] = [
  {
    priority: "P0",
    issue: "DEV-08",
    title: "Goal Verifier 与 Delivery Report",
    goal: "GOAL-2407 · Production V1",
    gate: "等待 DEV-06、DEV-07",
    conflict: "无冲突",
    status: "等待依赖",
    tone: "neutral",
  },
  {
    priority: "P1",
    issue: "ORD-03",
    title: "游标稳定性与回退验证",
    goal: "GOAL-2406 · 订单服务游标分页",
    gate: "2 个问题待回答",
    conflict: "无冲突",
    status: "人工门禁",
    tone: "warning",
  },
  {
    priority: "P2",
    issue: "ID-11",
    title: "权限策略兼容层迁移",
    goal: "GOAL-2403 · 统一权限模型迁移",
    gate: "凭据恢复后可执行",
    conflict: "goal-contract.ts",
    status: "已串行",
    tone: "danger",
  },
  {
    priority: "P0",
    issue: "DEV-09",
    title: "生产硬化与恢复演练",
    goal: "GOAL-2407 · Production V1",
    gate: "等待 DEV-08",
    conflict: "integration-db",
    status: "资源等待",
    tone: "info",
  },
];

export const steps = ["目标", "澄清", "最小方案", "规格", "Issue", "执行", "交付"];
