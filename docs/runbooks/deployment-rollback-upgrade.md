# P11 部署、应用回滚与升级 Runbook

Owner：`release-engineering`。适用于 Web、Scheduler、Projector、告警进程和 AutoDev 的生产发布；数据库变更还要
遵循 [Expand/Migrate/Contract](../p11-migration-release.md)。发布平台必须部署 CI 已证明来源的 Artifact digest，
不能从操作者工作区临时打包。

## 触发条件

- 已批准的生产版本、依赖升级或三阶段迁移窗口；或新版本导致健康、错误率、数据兼容性任一门禁失败，需要回滚。
- P0/P1 安全事件不走普通回滚窗口，先进入安全事件 Runbook 和全局 Stop。

## 权限

- release operator 可选择已 attest 的 Artifact 并滚动实例；`production-migration-approver` 单独批准不可逆 Contract。
- database operator 执行迁移；值班 operator 只能 Drain/Stop，不能提高权限或绕过供应链、恢复证据门禁。

## 执行命令

在发布前对将要部署的 `main` 精确版本执行以下命令；所有 Secret 由服务端运行环境注入，不写入参数或日志。

```bash
git -C /Users/onthewayli/harness/ai-dev-harness fetch origin main
test "$(git -C /Users/onthewayli/harness/ai-dev-harness rev-parse HEAD)" = "$(git -C /Users/onthewayli/harness/ai-dev-harness rev-parse origin/main)"
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm ci
npm audit --audit-level=high
npm audit --omit=dev --audit-level=moderate
npm run security:policy:p11
npm run recovery:check:p11
npm run migration:check:p11
npm run build
npm run typecheck
npm run scan:client-secrets
```

在发布平台选择该 SHA 对应、已完成 Attestation 的 Artifact；记录候选/上一版本 digest、发布 Receipt 和变更单。
先 Drain 新领取，逐批替换实例；Expand 后用上一应用版本做读写冒烟，Migrate 保留至少 24 小时双版本窗口，Contract
只在旧实例和不兼容 Run 都为 0 时执行。升级依赖只提交锁文件的可审查差异，禁止 `audit fix --force`。

## 验证

```bash
test -n "${P11_WEB_ORIGIN:?P11_WEB_ORIGIN must name the public non-secret origin}"
curl --fail --silent --show-error "${P11_WEB_ORIGIN}/health/live"
curl --fail --silent --show-error "${P11_WEB_ORIGIN}/health/ready"
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run test:p11
```

只有 readiness 连续通过、Scheduler tick 小于 30 秒、错误率/预算正常、上一版本读写兼容、Artifact digest 与 Receipt
一致才扩大流量。至少观察一个告警持续窗口；变更单附版本、迁移阶段、健康查询和告警恢复证据。

## 回退

停止放量并 Drain；在发布平台重新选择变更单记录的上一 attested Artifact digest。Expand/Migrate 阶段保留兼容
Schema，停止回填并回滚应用；不得执行 reset 或逆向 DROP。Contract 后不能假装应用回滚可恢复旧 Schema，只能前向
修复或按数据库恢复 Runbook 恢复隔离副本。回退后重复健康、旧新字段读写和队列不重复领取检查。

## 升级联系人

一个发布批次内不能恢复时升级 `incident-commander`；涉及 Schema/RPO 升级 `data-platform`；来源证明、许可证、
Secret 或依赖阻断升级 `platform-security`。保持 Drain/上一健康版本，直到事件指挥明确解除。
