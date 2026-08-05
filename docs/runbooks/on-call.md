# P11 生产值班与事件指挥 Runbook

Owner：`incident-management`。Critical 5 分钟、High 15 分钟内确认；值班人负责建立事件、保全证据、选择对应 Runbook 和持续沟通，
不因“告警已恢复”跳过根因/数据完整性验证。八类告警的具体阈值与首轮处置见 [alerts.md](alerts.md)。

专项入口：[部署/回滚/升级](deployment-rollback-upgrade.md)、[Stop/Worker 失联](execution-stop-worker-loss.md)、
[数据库/对象恢复](database-object-recovery.md)、[凭证/安全事件](credential-rotation-security-incident.md)、
[数据修复](data-repair.md)。机器目录和 owner 以 `ops/production/runbook-manifest.json` 为准。

## 触发条件

- 任一 production Critical/High 告警、用户报告的可用性/数据/安全问题、发布门禁失败或演练计划。
- 同一时间多个告警先按共同依赖（数据库、对象存储、Scheduler）聚合，避免重复操作；未知范围按更高严重度。

## 权限

- primary on-call 可读日志/指标/Receipt并执行安全诊断；Stop、回滚、恢复、轮换和数据修复按各 Runbook 的独立权限执行。
- incident-commander 负责严重度、节奏和跨团队决策；scribe 记录时间线，不能代替技术 owner 审批高风险操作。

## 执行命令

先记录事件 ID、UTC 开始时间、告警 ID、owner、受影响范围和当前发布 SHA；查询只用关联 ID，不复制 Secret/Prompt/用户数据。

```bash
git -C /Users/onthewayli/harness/ai-dev-harness rev-parse HEAD
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run runbook:check:p11
npm run recovery:check:p11
npm run migration:check:p11
npm run security:policy:p11
curl --fail --silent --show-error "${P11_WEB_ORIGIN}/health/live"
curl --fail --silent --show-error "${P11_WEB_ORIGIN}/health/ready"
```

按严重度建立 15/30 分钟更新节奏；每次只记录已验证事实、下一动作、owner 和 ETA。所有外部写、Stop/Resume、回滚、恢复、轮换和修复
都附 Receipt/变更单；诊断输出先脱敏。

## 验证

关闭事件前必须满足：告警产生 resolved；至少一个完整持续窗口无复发；健康/SLO/队列趋势正常；Goal/Issue/Run/Audit/Artifact 数据
校验通过；临时抑制和临时权限已撤销；所有行动有 owner/Receipt；用户影响和根因范围已确认。P0/P1 安排复盘和行动项截止日。

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run test:p11
```

## 回退

若处置扩大错误率、数据偏差或影响范围，停止当前动作，回退到上一已验证安全状态并调用对应专项 Runbook。不能确定安全状态时全局 Stop，
保持只读/隔离，不用“重启全部”作为默认恢复。交接时未完成动作保持明确 owner，不静默关闭事件。

## 升级联系人

Critical 立即指定 `incident-commander`；High 一个响应窗口内未稳定、跨两个团队或可能扩大时同样升级。缺少专项 owner 时升级
`service-owner`，由 incident-commander 指派；值班人不得自行承担未知系统的高风险写操作。
