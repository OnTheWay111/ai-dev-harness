# P11 告警处置 Runbook

适用于 production 值班。执行命令前确认当前环境、变更单和 RBAC 身份；数据库只使用已注入的
Secret，任何输出不得包含连接串。Critical 告警 5 分钟内响应，High 告警 15 分钟内响应。无法在
一个响应窗口内稳定恢复时升级给 `incident-commander`，并保留告警 firing/resolved、命令结果和审计
Receipt。

## Scheduler stalled

- **触发/权限**：Ready 队列存在且 Scheduler 120 秒没有进度；execution-platform 值班可诊断，停止或
  恢复执行需 production operator。
- **诊断**：在仓库根执行 `git -C /Users/onthewayli/harness/ai-dev-harness rev-parse HEAD` 确认版本；
  查看 `harness_scheduler_tick_age_seconds`、`harness_ready_queue_depth` 与 Scheduler 最近一次脱敏日志。
- **恢复**：先用执行控制 API `pause` 防止重复领取，再滚动重启一个 Scheduler；确认租约后 `resume`。
- **验证/回退/升级**：Ready 深度持续下降且 Tick 小于 30 秒才结束；若新实例重复卡死，回滚上一镜像，
  保持 Pause 并升级 runtime-quality 和 incident-commander。

## Worker lost

- **触发/权限**：活动 Run 的节点离线或心跳超过 60 秒；execution-platform 值班可隔离节点，Retry/Stop
  需 operator。
- **诊断**：关联 `run_id` 检查 lease、worker 终态事件和 Artifact receipt；不得直接重放原始事件。
- **恢复**：Drain 故障节点，等待租约过期与 reconciliation，确认幂等边界后对可重试 Run 发 Retry。
- **验证/回退/升级**：新 lease 只有一个 owner 且事件序号连续；否则 Stop 该项目并升级 incident-commander。

## Run failure rate

- **触发/权限**：15 分钟至少 10 个终态 Run 且失败率超过 20%；runtime-quality 主责。
- **诊断**：按 `failure_code`、部署版本、模型路由聚合，抽查脱敏 Artifact 和验收证据。
- **恢复**：若与新版本相关则停止放量并回滚；若为单一依赖则 Pause 受影响项目，不全局盲目 Retry。
- **验证/回退/升级**：新窗口失败率低于 10% 且至少 10 个样本；未改善则保持 Pause 并升级服务 owner。

## Budget exhaustion

- **触发/权限**：预算使用率达到 90% 或有超限任务；runtime-quality 值班诊断，预算变更需 budget approver。
- **诊断**：核对 Job budget、Run 消耗和异常重试，不记录 Prompt/Token 凭证。
- **恢复**：停止异常 Retry；只有带理由与审批 Receipt 才能提高预算，否则等待窗口重置或缩小范围。
- **验证/回退/升级**：新任务没有超限且消耗斜率正常；撤销临时增额并升级项目 Owner。

## Queue backlog

- **触发/权限**：队列超过 100 或最老 Ready 等待超过 300 秒；execution-platform 主责。
- **诊断**：同时检查 Scheduler、Worker 容量、Stop 状态和数据库延迟，区分流量突增与消费停滞。
- **恢复**：仅在 Worker 健康时按容量计划扩容；故障任务先隔离，禁止无界增加 max concurrency。
- **验证/回退/升级**：深度和最老年龄连续三个采样下降；错误率上升则回退扩容并升级 runtime-quality。

## Database unavailable

- **触发/权限**：健康查询连续失败 30 秒；data-platform 主责，切换/恢复需 database operator。
- **诊断**：检查供应商状态、连接池耗尽、证书和最近迁移；使用 `npm run db:check:postgres`，连接配置只从
  Secret 环境注入。
- **恢复**：先 Pause 写入，按数据库平台 Runbook 故障转移；恢复后运行迁移漂移检查再 Resume。
- **验证/回退/升级**：读写健康、复制点满足 RPO、迁移版本一致；否则保持只读/Pause 并升级 incident-commander。

## Object store unavailable

- **触发/权限**：Artifact Bucket 探测连续失败 120 秒；data-platform 主责，IAM/保留策略变更需 security。
- **诊断**：检查区域状态、工作负载身份、Bucket policy、Object Lock，不输出签名 URL 或 Access Key。
- **恢复**：修复身份或区域路由；Artifact 持久化不可用时 Pause 新 Run，禁止降级到临时本地盘。
- **验证/回退/升级**：Head probe 成功，并以测试对象完成写入、Digest 校验、受控读取；清除测试对象必须遵循
  保留策略，失败则升级 security 和 incident-commander。

## SSE stale

- **触发/权限**：Snapshot 超过 15 秒或 SSE 错误率超过 10%；control-plane 主责。
- **诊断**：检查 Projector checkpoint、数据库延迟、Web 实例和客户端重连率，权威状态仍以数据库为准。
- **恢复**：重启卡住的 Projector；必要时从 checkpoint 幂等重建 projection，不修改 Goal/Issue/Run 权威表。
- **验证/回退/升级**：新鲜度低于 5 秒、错误率低于 2%、revision 单调；重建不收敛则回滚 Projector 并升级
  data-platform。
