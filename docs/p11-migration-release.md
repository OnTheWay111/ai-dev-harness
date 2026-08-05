# P11 Expand / Migrate / Contract 与应用回滚

生产数据库迁移按 `ops/production/migration-policy.json` 严格分三次发布，不能把兼容性 DDL、数据回填和
破坏性收缩放进同一个部署。可执行门禁在
`prototype/web-ui/app/reliability/migration-release.ts`，静态检查命令为：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run migration:check:p11
```

## 三阶段

1. **Expand**：只允许新增 nullable column、新表/类型、`NOT VALID` constraint 和 Concurrent Index。
   `DROP`、`RENAME`、`SET NOT NULL`、类型替换、多语句注入都被门禁拒绝。部署后必须用上一应用版本完成
   读写冒烟。
2. **Migrate**：候选应用在至少 24 小时兼容窗口内双读/双写；回填必须可重入、分批、有剩余行计数和
   SHA-256 校验。失败可停止回填并回滚应用，Expand Schema 保留。
3. **Contract**：只有回填完成、剩余行归零、旧应用实例归零、不兼容运行中 Run 归零、上一应用回滚已
   验证、15 分钟内备份 Receipt 有效且不可逆审批未过期时才允许。Contract 不承担应用回滚能力，执行后
   如需恢复只能走前向修复或数据库恢复。

正在运行的 Run 默认 Drain：候选版本发布前停止新领取，旧 Worker 完成其 Run 后退出。不得为赶迁移窗口
强制终止；无法安全 Drain 的 Run 会阻断 Contract。上一应用构建产物至少保留 168 小时，并在 Expand 后、
Contract 前各完成一次实际回滚验证。

## 审批与审计

不可逆审批必须精确绑定 migration ID，由 `production-migration-approver` 作出，包含到期时间和备份
Receipt。批准不复用、不通配，数据库角色与应用部署角色分离。每阶段记录 SQL digest、应用版本、活动
实例、Run 数、回填计数、验证 digest 和操作者；任何门禁失败都保持当前兼容 Schema，不执行 reset。

## 2026-08-05 实际演练

在真实 PostgreSQL 14 隔离库中创建 v1 表并写入旧格式记录；Expand 实际增加 nullable JSONB 列，旧应用
继续读取；v2 双写新旧列后，v1 仍能读取候选记录。随后模拟回滚到 v1 并成功继续写入，再执行两次幂等
回填，v2 reader 能读取回滚期间写入的数据。Contract 在旧版本仍活动、兼容窗口未结束且有运行中 Run
时被正确阻断；未执行 DROP/reset，演练表在核验后清理。

实测 0.056 秒，三个阶段 SQL 均保存 SHA-256，收据无缺口：
[`evidence/p11-migration-rollback-drill-2026-08-05.json`](evidence/p11-migration-rollback-drill-2026-08-05.json)。

此外，迁移验证修复了应用时间戳与 PostgreSQL 微秒精度边界：状态更新使用
`GREATEST(command_time, created_at)`，避免同毫秒命令被数据库约束误判为倒序；完整真实数据库套件覆盖
该行为。
