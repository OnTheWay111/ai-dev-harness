# P11 全局/项目 Stop 与 Worker 失联 Runbook

Owner：`execution-platform`。控制面 Stop Receipt 是权威审计记录；AutoDev 的全局/项目 STOP marker 是执行主机的第二道
物理门禁。两者都应设置，避免数据库或主机网络隔离时继续领取。Pause/Drain 不终止 Verify、Review、Landing；紧急 Stop
可取消非安全阶段，但必须先保全工作树与事件序号。

## 触发条件

- 全局：凭证泄漏、数据完整性风险、跨项目重复调度或未知范围的供应链事件。
- 项目：单项目错误率/预算失控、错误迁移、用户要求停止；Worker 心跳超过 60 秒、节点离线或 lease owner 不唯一。

## 权限

- 项目 Stop/Resume 需要项目 `run.operate`；全局 Stop 需要显式全局 operator 且持有 organization owner 绑定。
- 节点隔离和进程终止由 execution-platform 值班执行；Retry 必须在 reconciliation 完成后由 operator 发起。

## 执行命令

先在已认证控制面提交带 reason、expected version、request ID 和 idempotency key 的 Stop，保存 Receipt。随后在执行主机
设置与 `host.yaml`/项目配置完全一致的 marker；路径必须由变更单给出绝对值，禁止猜测。

```bash
test -n "${P11_GLOBAL_STOP_FILE:?P11_GLOBAL_STOP_FILE must be an absolute configured path}"
test "${P11_GLOBAL_STOP_FILE#/}" != "${P11_GLOBAL_STOP_FILE}"
install -d -m 700 "$(dirname "${P11_GLOBAL_STOP_FILE}")"
install -m 600 /dev/null "${P11_GLOBAL_STOP_FILE}"

test -n "${P11_PROJECT_ROOT:?P11_PROJECT_ROOT must be an absolute project path}"
test "${P11_PROJECT_ROOT#/}" != "${P11_PROJECT_ROOT}"
install -m 600 /dev/null "${P11_PROJECT_ROOT}/.autodev/STOP"
autodev schedule --project "${P11_PROJECT_ROOT}/.autodev/project.yaml" --dry-run --json
autodev status --project "${P11_PROJECT_ROOT}/.autodev/project.yaml" --json
```

Worker 失联时保持 Stop/Drain，标记节点 offline，等待 lease 过期并让 Scheduler 先执行 reconciliation。核对 external run、
事件最后序号、worktree 和 Artifact Receipt 后，仅对明确可重试且没有 Landing 不确定性的 Run 发 Retry；不得重新发送原始
Worker 事件或并行启动第二 external run。

## 验证

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run runbook:check:p11
RUNBOOK_DRILL_AUTHOR_ROLE=platform-engineering \
RUNBOOK_DRILL_EXECUTOR_ROLE=independent-on-call-verifier \
RUNBOOK_DRILL_REVISION_NOTE='Operator verified the isolated Stop and lease-expiry sequence.' \
npm run runbook:drill:p11 -- --output /tmp/p11-runbook-drill.json
test -s /tmp/p11-runbook-drill.json
node -e 'const r=require("/tmp/p11-runbook-drill.json"); console.log(JSON.stringify(r,null,2)); if(r.mode!=="isolated-control-plane-real-code-path"||!r.executor.independent||r.result!=="passed"||r.gaps.length)process.exit(1)'
```

演练命令仅使用内存 repository 和 fixture gateway，不设置主机 marker、不调用 Docker 或外部服务；标准输出只有摘要，值班人员
必须检查保存的完整 Receipt。若目标文件已存在，命令会拒绝覆盖，改用新的绝对 `.json` 路径并在事件记录中登记。

验证新任务领取数为 0；Stop Receipt 与 Audit/Outbox 版本一致；失联节点 lease 为 expired/released；同一 Run 只有一个
owner；事件序号连续或进入 reconciliation；Landing 不确定时状态必须 blocked。全局恢复前逐项目检查，再先 Resume 一个
canary 项目。

## 回退

Stop 是安全门禁，不因告警自动清除。根因关闭且 canary 验证通过后，先在控制面发 `resume` Receipt，再删除精确 marker：

```bash
test -f "${P11_PROJECT_ROOT}/.autodev/STOP" && unlink "${P11_PROJECT_ROOT}/.autodev/STOP"
test -f "${P11_GLOBAL_STOP_FILE}" && unlink "${P11_GLOBAL_STOP_FILE}"
autodev schedule --project "${P11_PROJECT_ROOT}/.autodev/project.yaml" --dry-run --json
```

若恢复后出现重复领取、事件 gap 或错误率回升，立即重新 Stop，不清理 worktree/Receipt，并回到 reconciliation。

## 升级联系人

5 分钟内不能证明停止生效、lease 唯一或 external run 状态时升级 `incident-commander`；执行失败模式和重试策略升级
`runtime-quality`。禁止在指挥链未确认时扩大 Resume 范围。
