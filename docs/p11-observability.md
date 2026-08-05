# P11 可观测性契约

AI Dev Harness 使用 `harness.observability.v1` 作为 Web、Scheduler、Execution Gateway 与
AutoDev Worker 之间的关联上下文。上下文只包含可公开给受控子进程的关联标识，不包含 actor
邮箱、凭证、连接串、Prompt 或业务正文。

## 字段字典

| 日志/事件字段 | 说明 | 来源 |
|---|---|---|
| `request_id` | 同步请求或最初创建 Run 的命令 ID | Web 请求头或 `runs.request_id` |
| `goal_id` | Goal 权威 ID | URL/领域实体或 Scheduler Job |
| `issue_id` | Issue 权威 ID | Scheduler Job |
| `run_id` | 控制面 Run 权威 ID | Scheduler Job |
| `receipt_id` | 异步命令 Receipt ID | 命令接受后追加 |
| `trace_id` | W3C Trace 全链路 ID | 入口 `traceparent` 或 Web 生成 |
| `span_id` | 当前进程边界 Span | 每次跨进程生成 |
| `parent_span_id` | 上游进程 Span | W3C 父子关系 |
| `process` | `web`、`scheduler`、`gateway`、`worker` | 当前运行边界 |

`proxy.ts` 校验或生成 `x-request-id` 与 W3C `traceparent`；不合法的外部值会被替换。Scheduler
从权威 Job/Run 读取业务 ID，Gateway 只把版本化 JSON 放进
`HARNESS_OBSERVABILITY_CONTEXT`，AutoDev 再生成 Worker Span 并写入
`autodev.run-event.v1`。控制面摄取 Worker 事件时会把其中的 Goal/Issue/Run 与数据库上下文
交叉校验，不能由执行节点替换权威身份。

## 日志、指标与 Trace

结构化日志使用 `harness.telemetry.v1` JSON，每条带 UTC 时间、级别、事件名和关联上下文。
敏感键、Bearer、数据库 URL、GitHub Token、邮箱和超长嵌套属性在输出前统一脱敏。执行原始输出
仍通过 P9 Artifact Ingestion 处理，不能直接写日志。

首批稳定指标为：

- `harness_http_request_duration_ms`：普通 API 延迟，标签仅含低基数 route/status；
- `harness_queue_ready_delay_ms`：可领取 Job 从可用时间到领取的等待时间；
- `harness_scheduler_ticks_total`：Scheduler 空闲 Tick；
- `harness_run_start_total`：Run 启动成功/失败；
- `harness_gateway_start_duration_ms`：Gateway 启动边界耗时与结果；
- `harness_worker_events_total`：Worker 事件摄取 disposition。

指标标签禁止 Goal/Issue/Run/Request ID，避免高基数；这些 ID 只进入日志和 Trace。生产日志收集器
应将 `metric.observation` 转换为后端指标，或由同一 `OperationalTelemetry` 端口接入 OTLP。

## 采样与审计

普通 Trace 可由部署平台按环境采样，但错误 Span 必须保留。`level=audit` 的记录和数据库
`audit_events` 永不参与 Trace 采样；批准、策略、凭证引用、Push、恢复和预算重置仍由权威审计事务
保存。日志采样不能成为审计数据源。

## 验证

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
node --experimental-strip-types --test tests/p11-observability.test.mjs
npm run typecheck

cd /Users/onthewayli/harness/ai-dev-harness
python -m unittest discover -s autodev/tests -p 'test_run_event_contract.py' -v
```

测试覆盖非法入口 Header、Web→Scheduler→Gateway 上下文、Gateway 最小环境、Worker 事件回传、
权威身份交叉校验以及 Secret/连接串/邮箱不出现在结构化输出中。
