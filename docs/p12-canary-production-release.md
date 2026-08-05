# P12 Canary 与 Production V1 发布门禁

P12-05 和 P12-06 是实际运行门禁，不是测试夹具。只有有权限负责人选定低风险内部项目、完成连续 48 小时
观测，并由安全、运维、产品和项目负责人通过 OIDC 产生四份独立审计签署后，路线图才能勾选。开发测试中的
合成窗口、身份和 Receipt 只能验证失败关闭逻辑，不能充当发布证据。

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
Git。完成 48 小时后执行：

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
SHA-256。任何证据变更都会改变 digest，使旧签署失效。最终检查命令：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run test:p12:gates
npm run release:check:p12 -- --release /absolute/private/p12-production-release.json
```

## 当前状态

截至 2026-08-05，P12-01～P12-04 已完成；真实内部 Canary owner/项目、48 小时报告和四角色签署尚未提供。
因此 P12-05、P12-06 和 M4 Gate 必须保持未完成，Production V1 不得宣告 ready。
