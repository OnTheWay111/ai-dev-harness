# P10 Goal Verifier 与 Delivery Report

P10 把“所有 Issue 已完成”升级为“原始 Goal Contract 已被逐条证明满足”。控制面现在提供四个追加式闭环：

1. `AcceptanceVerificationPlan` 把每条 `AcceptanceCriterion` 精确映射到已批准的命令、查询、不可变 Artifact 或人工证据；
2. `GoalVerification` 先执行确定性检查，再启动全新、只读、独立于 Builder 的 Verifier 会话；
3. 失败结果生成 `VerificationGapReport`，经人工确认后创建新的 Issue Plan 草稿，重新经过 Compiler 与审批；
4. `DeliveryReport` 汇总目标、范围、非目标、证据、Issue/Run、Review、Commit/PR、风险和人工签字。最终签字与 Goal `verifying → completed` 在同一 PostgreSQL 事务内完成。

## 1. 确定性验收计划

计划使用 `acceptance-verification-plan-draft.v1`。每条标准必须且只能出现一次；未知标准、重复覆盖、未知证据引用、模糊成功条件、无责任方、无界超时和非 Approver 人工门禁都会失败关闭。

策略类型：

- `command`：只引用服务端配置的固定命令，HTTP 请求不能提交可执行文件、参数或工作目录；
- `query`：仅支持控制面内置查询 `query:issues:completed`、`query:reviews:approved`、`query:delivery:ready`；
- `artifact`：引用当前 Organization/Project/Goal 范围内的 `artifact:<uuid>` 或 `artifact:sha256:<digest>`；
- `manual`：必须由拥有 `goal.accept` 权限的 Approver 提交不可变证据引用和理由。

生产命令白名单通过服务端变量注入：

```json
[
  {
    "reference": "command:test:release-gate",
    "executable": "/usr/bin/npm",
    "arguments": ["run", "test:release"],
    "cwd": "/srv/ai-dev-harness/prototype/web-ui"
  }
]
```

变量名为 `GOAL_VERIFICATION_COMMANDS_JSON`。配置不包含凭证；进程使用参数数组、关闭 Shell，并只继承最小环境变量。

## 2. 独立 Verifier

生产适配器使用一次性 `codex exec`：

- `--ephemeral`；
- `--sandbox read-only`；
- 在仓库外临时目录运行；
- 只接收 Goal、Plan 和确定性结果组成的有界上下文包；
- 使用闭合的 `goal-verifier-output.v1` JSON Schema；
- 不允许修改代码或生成审批。

控制面会再次验证模型输出：每条验收标准、每个非目标和每条约束都必须恰好返回一个 verdict；通过标准只能引用本次确定性检查实际产生的证据；Builder 与 Verifier identity 相同会拒绝；非法输出、缺证据和超时都不会保存成功结果。

可选配置：

- `CODEX_GOAL_VERIFIER_MODEL`：运行时模型映射；
- `GOAL_VERIFIER_IDENTITY`：独立 Verifier identity，默认 `codex-goal-verifier`。

## 3. 差距回流

失败验收保存失败的 AcceptanceCriterion、非目标或约束、现有证据、缺口、影响和建议，不会为非目标或约束伪造 Criterion ID。`VerificationGapReport`、原 Verification、Review、Commit 和 Artifact 均不可更新或删除；差距创建与 remediation receipt 都追加 AuditEvent。

只有人工确认的 remediation 请求才会进入 `IssuePlanGapRemediationAdapter`。适配器要求失败验收绑定的 Issue Plan 仍是最新版本，然后调用现有 `IssuePlanService.createDraft`，所以新版本仍会执行覆盖检查、冲突分析、执行波次与模型路由，并保持 `draft`，不能自动批准或投影队列。同一幂等键只重放完全相同的请求；若 Plan 已提交而 receipt 写入失败，重试会按确定性的 remediation run identity 恢复同一个 Plan revision，不会再生成一版。

## 4. Delivery Report 与最终门禁

报告包含：

- 原始 Goal、最终范围、非目标和约束；
- 逐 AcceptanceCriterion verdict、理由和证据引用；
- Issue、Run、Artifact、独立 Review、Commit 和 PR；
- 异常、已知风险和 Verifier 回归风险；
- 最终 Approver、理由、请求 ID 和签字时间。

缺少任一必需证据、针对最终 Commit 的 approved Review、Commit、最新 passed Verification，或存在 `blocked` 风险时不能生成报告。重复生成会追加新 revision，不覆盖旧报告。最终验收追加 `accepted` 报告 revision，并与 Goal 完成、AuditEvent 和幂等 receipt 原子提交。

导出端点返回 `application/json`，使用 `private, no-store`，所有读取和导出都经过服务端 Organization/Project RBAC。

## 5. API

```text
GET|POST /api/v1/goals/{goalId}/verification-plans
GET|POST /api/v1/goals/{goalId}/verifications
GET|POST /api/v1/goals/{goalId}/verification-gaps
POST     /api/v1/goals/{goalId}/verification-gaps/{reportId}/remediations
GET|POST /api/v1/goals/{goalId}/delivery-reports
POST     /api/v1/goals/{goalId}/delivery-reports/{reportId}/acceptances
GET      /api/v1/goals/{goalId}/delivery-reports/{reportId}/export
```

所有写入要求同源请求、OIDC actor、请求 ID、幂等键、严格字段集合、服务端 RBAC 和速率限制。

## 6. 验证

```bash
cd prototype/web-ui
npm run test:p10
npm run test:p10:postgres
npm run db:check:drift
npm run typecheck
npm run lint
npm run build
```

`test:p10:postgres` 会创建空临时数据库、执行全部迁移，验证不可变触发器、版本链、幂等重放，以及最终报告和 Goal 完成的事务原子性，再销毁临时数据库。
