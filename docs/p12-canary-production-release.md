# P12 Canary 与 Production V1 发布门禁

P12-05 和 P12-06 是实际运行门禁，不是测试夹具。只有有权限负责人选定低风险内部项目、完成连续 48 小时
观测，并由安全、运维、产品和项目负责人通过 OIDC 产生四份独立审计签署后，路线图才能勾选。开发测试中的
合成窗口、身份和 Receipt 只能验证失败关闭逻辑，不能充当发布证据。

## Web 发布中心（主操作入口）

登录后访问 `/releases`。P12-05 与 P12-06 的日常操作应在 Web 发布中心完成，CLI 校验器保留为独立的
最终复核和离线故障排查工具。部署环境必须把 `/releases` 加入 `OIDC_ALLOWED_RETURN_TO_PATHS`。

发布中心把每次写入作为同一 PostgreSQL 事务提交：聚合状态、观测窗口/事件/门禁/签署、Audit Event、
Outbox Event 和 Idempotency Receipt 要么一起成功，要么一起失败。浏览器不能提交 signer ID；服务端从
已验证的 OIDC 会话派生身份，并按以下精确角色授权：

| 发布角色 | 项目角色 |
|---|---|
| `security` | Organization Owner |
| `operations` | Operator |
| `product` | Approver |
| `project-owner` | Project Admin |

操作顺序：

1. Operator 创建低风险内部 Canary 草稿，填写 Goal、完整 Commit SHA、范围、成功/Stop 条件和 Runbook。
2. Project Admin 复核并批准；批准后配置锁定，开始 Attempt 的 48 小时时钟。
3. Operator 最多按一小时连续记录指标窗口，并在事件时间线披露缺陷、告警和人工介入；P0/P1 自动 Stop。
4. 告警解除也通过时间线单独审计。Stop 后由 Project Admin 确认修复并开启新的 Attempt，从零计时。
5. 满 48 小时且同一观测区间内存在 Passed Goal Verification 后，由 Operator 完成 Canary 校验。
6. 创建 Production Release，由责任角色逐项关闭十项门禁；锁定摘要后，四个不同 OIDC 身份依次签署。

服务端接口位于 `/api/v1/releases`、`/api/v1/releases/canaries`、
`/api/v1/releases/canaries/:canaryId/actions`、`/api/v1/releases/production` 和
`/api/v1/releases/production/:releaseId/actions`。所有写接口要求同源请求、`Idempotency-Key`、
`X-Request-Id`、理由和 optimistic `expectedVersion`。

## Canary 准入与计时

Canary owner 必须在计时前批准 Project、Goal Contract、允许/排除范围、成功条件、Stop 条件、回滚和 Stop
Runbook。报告使用 `harness.p12-canary-report.v1`，每个观测窗口最长一小时且首尾连续，每个窗口都引用真实
指标证据。以下任一情况立即 Stop，当前 48 小时时钟作废，修复并重新批准后从零开始：

- P0/P1 缺陷或告警；
- 数据完整性、权限、Secret、重复 Run 或 Landing 不确定性；
- owner 请求 Stop，或回退/恢复步骤不能在 Runbook 预算内完成；
- 观测窗口缺失、未来时间、证据不可读或 Goal Verification 未通过。

P2 可以存在，但每一项必须有真实 owner、可执行规避方案和证据引用。告警、人工介入和缺陷都要记录，不能
通过空数组隐藏已发生事件。最终报告应保存在受权限保护的证据存储中，不把内部项目、人员或原始日志提交到
Git。Web 发布中心通过后，可用以下命令对导出的私有报告做独立复核：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run canary:check:p12 -- --report /absolute/private/p12-canary-report.json
```

## Production Gate 与签署

`ops/production/p12-release-policy.json` 固定十项 Production Gate 和四个签署角色。Release 文件使用
`harness.p12-production-release-gate.v1`，内嵌已通过的 Canary 报告，并逐项引用 E2E、身份安全、AutoDev
授权、模型路由、供应链、Git 追溯、恢复/Stop、监控/on-call、Goal Verification 和缺陷预算证据。

四位 signer 必须互不相同，角色分别为 `security`、`operations`、`product` 和 `project-owner`。每份签署都
需要 OIDC 身份、request ID、Audit Receipt、理由和签署时间，并绑定同一份规范化 release evidence
SHA-256。任何证据变更都会改变 digest，使旧签署失效。Web 签署完成后，最终独立检查命令：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run test:p12:gates
npm run release:check:p12 -- --release /absolute/private/p12-production-release.json
```

## 当前状态

截至 2026-08-05，P12-01～P12-04 已完成；Web/API/PostgreSQL 发布中心及真实浏览器/数据库 E2E 已实现，
但 E2E 中加速生成的 48 个窗口和测试 OIDC 身份不是发布证据。真实内部 Canary owner/项目、实际连续
48 小时报告和四角色真实签署尚未提供。因此 P12-05、P12-06 和 M4 Gate 必须保持未完成，Production V1
不得宣告 ready。
