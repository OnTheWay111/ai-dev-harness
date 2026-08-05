# P11 数据库与对象存储恢复 Runbook

Owner：`data-platform`。目标是 RPO 15 分钟、RTO 4 小时；数据库只能恢复到隔离目标，对象必须保持 Versioning、加密和
Object Lock COMPLIANCE。恢复脚本不会自动接入生产流量。

## 触发条件

- 数据库不可用、误写/误删、迁移破坏、恢复点滞后告警；或 Artifact 对象缺失、digest 不一致、区域故障。
- 单条业务数据错误优先走数据修复 Runbook；范围未知、Audit/Artifact 不可信时必须按完整恢复处理。

## 权限

- recovery-operator 使用独立数据库身份和无生产路由的恢复环境；database operator 执行 PITR/切换。
- Object restore 需要受限 data-platform 身份；解除 Legal Hold/Object Lock 另需 platform-security 审批，Runbook 不授权解除。

## 执行命令

先全局 Pause/Stop 并记录恢复点、事件 ID、最新有效备份 Receipt。供应商凭证和连接串只由服务端 Secret broker 注入环境；
以下命令的源/目标名必须匹配安全前缀，目标不得存在。

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run recovery:check:p11
test -n "${RECOVERY_ADMIN_DATABASE_URL:?injected by the recovery environment}"
test -n "${RECOVERY_SOURCE_DATABASE_URL:?injected by the recovery environment}"
test -n "${RECOVERY_TARGET_DATABASE:?isolated target name is required}"
test -n "${RECOVERY_RECEIPT_PATH:?absolute receipt path is required}"
npm run recovery:drill:p11
```

生产 PITR 由供应商控制面恢复到 `harness_recovery_target_*` 隔离库；禁止覆盖源库。对象恢复选择受影响 key 的历史版本，
复制到隔离验证前缀，保留原 version ID、SHA-256、size、retention policy 和 legal hold 状态；不可降级到临时本地盘。

## 验证

核对 migration ledger、Schema，以及 Goal/Issue/Run/Audit/Artifact 五类事实计数和 SHA-256；检查恢复点年龄不超过 15 分钟、
总耗时不超过 240 分钟、目标无生产流量/外部 egress。对象执行 Head、受控读取和本地 SHA-256 比对，确认 Versioning、Object
Lock/Lifecycle 未改变。Receipt 必须通过 `harness.recovery-drill.v1` 校验后才可提交切换审批。

```bash
test -f "${RECOVERY_RECEIPT_PATH}"
jq -e '.result == "passed" and .isolatedTarget == true and .gaps == []' "${RECOVERY_RECEIPT_PATH}"
```

## 回退

切换前失败：销毁隔离目标并保留 Receipt/供应商操作日志，生产保持 Stop。切换后失败：不要回写旧主库；把流量退回最后一个
只读安全端点，重新选择更早恢复点或执行前向修复。对象校验失败时保留历史版本，撤销隔离复制的路由引用，不删除受保留保护
的版本。

## 升级联系人

任何 RPO/RTO、Schema、digest、隔离或 Object Lock 门禁失败立即升级 `incident-commander`；涉及身份、保留策略、Legal Hold
升级 `platform-security`。未获得事件指挥和 database operator 双批准不得切生产。
