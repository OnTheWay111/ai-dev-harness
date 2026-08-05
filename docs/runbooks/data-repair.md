# P11 生产数据修复 Runbook

Owner：`data-platform`。只用于已定位、范围有界且不需要整库恢复的数据问题。所有修复必须是可审查 SQL/工具、先预览、可重入、
有行数和 digest 断言，并产生 Audit/Receipt；禁止生产控制台即席改表或手工补写不可追踪事实。

## 触发条件

- 单个或有界批次 Goal/Issue/Run/Projection 元数据不一致，且权威来源、正确目标值和受影响行可确定。
- Audit 链、Artifact digest、租户边界或大范围事实不可信时停止本流程，改走数据库恢复/安全事件。

## 权限

- service owner 编写修复计划；第二名 reviewer 校验租户范围、前后断言和回退；database operator 用一次性 repair role 执行。
- Goal/Run 业务状态修复还需 domain owner；repair role 不得拥有角色管理、数据库创建或 Object Lock 删除权限。

## 执行命令

修复文件必须来自已批准提交，包含显式事务、组织/项目谓词、预期行数、前后 SELECT 和 Audit 插入；`P11_REPAIR_SQL` 是绝对路径，
数据库身份由本机 `pg_service.conf`/Secret broker 提供。先以 `P11_REPAIR_MODE=preview` 让脚本 ROLLBACK 并保存输出，审批后才 apply。

```bash
test -n "${P11_REPAIR_SQL:?approved absolute SQL path is required}"
test "${P11_REPAIR_SQL#/}" != "${P11_REPAIR_SQL}"
test -f "${P11_REPAIR_SQL}"
shasum -a 256 "${P11_REPAIR_SQL}"
P11_REPAIR_MODE=preview psql -X --set=ON_ERROR_STOP=1 --set=repair_mode=preview --file="${P11_REPAIR_SQL}" service=harness_production_repair
P11_REPAIR_MODE=apply psql -X --set=ON_ERROR_STOP=1 --set=repair_mode=apply --file="${P11_REPAIR_SQL}" service=harness_production_repair
```

修复前对受影响项目 Drain/Stop，记录 15 分钟内备份 Receipt。禁止拼接用户输入或把连接 URL 放到命令行；超过批准行数、版本变化、
digest 不符或任何跨项目行都会触发事务回滚。

## 验证

由 reviewer 独立运行只读验证：受影响行数等于计划、版本单调、状态机合法、Audit/Outbox/Receipt 同事务存在、Projection 重建后与权威
表一致、未触及其他组织/项目。对 Artifact 重新计算 SHA-256；修复 Run 时确认 lease/external event 序列没有被伪造或重放。

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run db:check:drift
npm run test:postgres:integration
```

## 回退

事务提交前任何失败直接 ROLLBACK。提交后只使用修复计划中预审的补偿事务；不得删除 Audit 或把 version 调低。若补偿断言不成立，
立即 Stop，保留当前事实并恢复到隔离数据库比较；范围扩散时切换到数据库恢复 Runbook。

## 升级联系人

预期行数/digest/租户范围不符、无法构造补偿或出现 Audit 链异常时升级 `incident-commander`；业务语义不确定升级 `control-plane`。
未明确 owner 的数据不执行修复。
