# P11 备份、不可变保留与恢复

生产恢复目标固定为 RPO 15 分钟、RTO 4 小时。可执行策略位于
`ops/production/recovery-policy.json`，其部署门禁和恢复 Receipt 校验在
`prototype/web-ui/app/reliability/recovery-policy.ts`。策略不是普通说明文档：CI 校验静态契约，生产发布
还必须携带 24 小时内从数据库和对象存储控制面导出的非敏感证据。

## 生产控制

数据库必须启用自动备份、连续 WAL/PITR、35 天恢复窗口、静态加密和跨区域副本；平台上报的最大可恢复
点滞后不得超过 15 分钟。恢复只能进入独立数据库，使用单独 recovery-operator 身份，默认拒绝生产流量和
外部网络。备份和恢复命令从环境读取连接身份，数据库 URL/密码不进入命令参数、Receipt 或日志。

Artifact Bucket 必须在创建时启用 Versioning、静态加密和 Object Lock COMPLIANCE；不能在已有未启用
Object Lock 的 Bucket 上静默降级。应用上传同时发送保留到期日，`legal_hold` 额外打开 Legal Hold：

| 应用策略 | 最短不可变期限 |
|---|---:|
| `standard_180d` | 180 天 |
| `extended_365d` | 365 天 |
| `legal_hold` | 直至授权解除 |

生命周期只能清理超过保留期的版本，并在 1 天后中止未完成的 Multipart Upload；不能删除仍受 Object Lock
保护的对象。数据库仅恢复 Artifact 元数据，因此演练同时核对 object key、SHA-256、大小、保留策略和期限；
对象存储本体由 Versioning/Object Lock/跨区域复制独立保护。Audit 保留不少于 180 天。

## 发布门禁

静态策略检查：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run recovery:check:p11
```

生产发布设置 `RECOVERY_REQUIRE_PROVIDER_EVIDENCE=true` 和绝对路径
`RECOVERY_PROVIDER_EVIDENCE_PATH`。证据使用 `harness.recovery-provider-evidence.v1`，只含观察时间与
布尔/数值配置，不含账号、Endpoint、Bucket 名或凭证。证据缺失、超过 24 小时、PITR 滞后超过 15 分钟、
Versioning/Object Lock/Lifecycle 任一关闭都会阻断发布。

## 隔离恢复流程

1. recovery-operator 创建无生产路由、无外部写权限的恢复环境，并记录恢复点；生产事故中先全局 Pause/Stop。
2. 从供应商 PITR 恢复指定时间；季度逻辑备份演练可使用 `pg_dump` custom 格式。工具版本必须与数据库
   Server 同主版本。
3. 目标数据库名必须匹配 `harness_recovery_target_*` 且不得与源库相同；已存在目标会拒绝覆盖。
4. 恢复后核对 Drizzle migration ledger 和 `goals`、`issues`、`runs`、`audit_events`、
   `artifact_objects` 的计数及 SHA-256。
5. 只有 Receipt 通过 RPO/RTO、隔离、Schema、事实和 Artifact 保留校验后，才可进入事故切换审批；工具本身
   不会把恢复库接入生产。

受控练习库可先执行 `npm run recovery:fixture:p11`，再执行 `npm run recovery:drill:p11`。所有连接值只从
`RECOVERY_ADMIN_DATABASE_URL` 和 `RECOVERY_SOURCE_DATABASE_URL` 环境注入；`pg_dump`/`pg_restore`
参数只包含选项、无敏感数据库名以外的隔离目标和临时文件路径。

## 2026-08-05 实际演练

本次在 PostgreSQL 14 临时容器中应用 20 个正式迁移，写入一组 Goal/Issue/Run/Audit/Artifact digest，执行
custom-format dump，并恢复到不同的隔离数据库。恢复目标在核验后销毁；源库未被 reset 或覆盖。

- 实测恢复耗时：1.059 秒，低于 4 小时；
- 实测恢复点年龄：0.011 分钟，低于 15 分钟；
- 五类事实计数与 SHA-256 全部一致；
- migration ledger、Schema 和 Artifact 保留元数据一致；
- 发现缺口：无。

机器可验证收据为
[`evidence/p11-recovery-drill-2026-08-05.json`](evidence/p11-recovery-drill-2026-08-05.json)。本次走逻辑
备份恢复路径；季度演练应在逻辑备份和供应商 PITR 之间轮换，避免只验证单一恢复机制。
