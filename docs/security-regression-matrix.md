# P3 安全回归矩阵

P3-05 的安全回归不是 mock-only 检查。`security-regression-postgres.test.mjs` 在每次运行时创建空的临时
PostgreSQL 数据库、执行全部 Drizzle 迁移，通过真实 Postgres Repository/约束/触发器运行用例，最后
销毁数据库。它与原有迁移、事务和投影集成测试串行执行，避免共享数据库中的竞态。

| 威胁 | 边界与断言 |
|---|---|
| 匿名读取 | Workbench API 在 Repository 访问前返回 401，不返回任务、total 或 summary |
| 角色越权 | Project Admin 对 `goal.approve` 被真实 RoleBinding/PolicyEvaluator 拒绝，Goal 状态和版本不变 |
| 跨组织 ID 猜测 | 仅在 Organization A 有角色的 actor 请求 Organization B/Project B/Goal B，授权先于 Goal 查询失败；Audit 和幂等记录均为 0 |
| 跨项目数量泄漏 | 两个 Project 发布不同投影；任务内容、分页 total、summary 和 SHA-256 ETag 只反映当前可见 Project，外部 ETag 不能触发 304 |
| 重复审批 | 相同 actor、相同审批命令和 Idempotency-Key 返回同一 receipt；只产生 1 个 Goal Audit 和 1 个 Outbox event |
| 跨用户复用 Idempotency-Key | 同一 Organization/Project 内两个 Approver 使用同一 key 操作不同 Goal，各自生成独立幂等记录，不回放他人 receipt |
| Audit 缺字段 | 空 actor/reason/request 被数据库身份约束拒绝 |
| Audit 历史篡改 | 对已提交 Audit 的 UPDATE 和 DELETE 均被 append-only 触发器拒绝 |

已有 `request-security.test.mjs` 同时锁定 CSRF、大小、Schema、限流与安全头；
`postgres-integration.test.mjs` 继续覆盖事务回滚、跨 Goal 外键、Outbox 去重和 RoleBinding 审计。

运行完整矩阵：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run test:postgres:integration
npm run ci:p1
```

任何连接或内部 SQL 错误只输出稳定的失败摘要；测试输出不得包含数据库 URL、Secret、Session 或 OIDC
Token。

