# P11 生产告警策略

生产告警由独立 `monitor:p11` 进程读取 PostgreSQL、Artifact S3 健康和 Workbench SSE
新鲜度信号。规则目录是
`prototype/web-ui/app/observability/alerting.ts`；每条规则固定声明阈值、持续时间、严重度、去重窗口、
责任组与 Runbook，部署平台只负责把 `alert.firing` 和 `alert.resolved` 结构化事件路由到值班系统。

## 信号和规则

| 告警 | 触发条件 | 持续 | 严重度 | Owner |
|---|---|---:|---|---|
| `scheduler_stalled` | 有 Ready Job 且 Scheduler 超过 120 秒未更新 | 120 秒 | Critical | execution-platform |
| `worker_lost` | 有活动 Run 且 Worker 离线或心跳超过 60 秒 | 60 秒 | Critical | execution-platform |
| `run_failure_rate` | 15 分钟至少 10 个终态 Run，失败率超过 20% | 300 秒 | High | runtime-quality |
| `budget_exhaustion` | 预算使用率达到 90% 或已有超限任务 | 60 秒 | High | runtime-quality |
| `queue_backlog` | 队列超过 100 或最老 Ready Job 超过 300 秒 | 300 秒 | High | execution-platform |
| `database_unavailable` | PostgreSQL 查询失败 | 30 秒 | Critical | data-platform |
| `object_store_unavailable` | S3 Bucket 探测失败 | 120 秒 | Critical | data-platform |
| `sse_stale` | Snapshot 超过 15 秒或 SSE 错误率超过 10% | 120 秒 | High | control-plane |

同一告警在 15 分钟（失败率为 30 分钟）内不会重复通知；条件恢复会立即产生一次 resolved 事件。
计划维护只能通过 `ALERT_SUPPRESSIONS` 指定精确规则 ID，抑制不会清除 Pending 计时，维护结束后仍有
故障会立即通知。生产变更单必须记录抑制原因、开始/到期时间和值班批准人，禁止通配符和永久静默。

## 运行

告警进程使用与 Web 相同的 `HARNESS_POSTGRES_APP_URL` Secret 和 S3 工作负载身份；连接串、Access
Key 不得进入命令参数或日志。

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run monitor:p11
```

部署需设置 P1 数据库环境变量、`ARTIFACT_OBJECT_STORE=s3`、`ARTIFACT_S3_REGION` 与
`ARTIFACT_S3_BUCKET`。`HARNESS_SSE_ERROR_RATE` 由入口指标适配器注入 0 到 1 的短窗口错误率；未设置
时仍会由 `workbench_snapshots.generated_at` 检测数据陈旧。

## 验证与演练

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
node --experimental-strip-types --test tests/p11-alerting.test.mjs
```

合成测试同时把八类信号置为故障：第一次采样建立 Pending，超过持续时间只产生一次 firing，健康样本
随后为每条规则产生 resolved；另有维护抑制和数据库/S3 探测异常不泄密测试。处置命令、验证、回退与
升级路径见 [告警 Runbook](runbooks/alerts.md)。
