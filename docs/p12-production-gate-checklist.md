# P12 Production V1 Gate 当前清单

更新时间：2026-08-05。`evidence-ready` 表示开发与仓库证据已就绪，但不能代替最终 release 文件中的 OIDC
审计签署；`blocked` 表示真实外部门槛尚未发生。最终权威规则为
`ops/production/p12-release-policy.json`，执行校验为 `npm run release:check:p12`。

| Gate | 当前状态 | 证据/缺口 |
|---|---|---|
| browser-e2e | evidence-ready | P12-02/P12-03 真实浏览器、临时 PostgreSQL、主路径与失败路径测试 |
| identity-security | evidence-ready | P3 OIDC/RBAC/CSRF/Audit 门禁与 P11 安全/Secret 扫描 |
| autodev-authorization | evidence-ready | `docs/autodev-0.4.16-execution-compatibility.md` 与授权范围 |
| model-routing-write | evidence-ready | P6 task-level `preferred_builder` 正式 Queue Import 接口与契约测试 |
| supply-chain | evidence-ready | `docs/evidence/p11-supply-chain-baseline-2026-08-05.json` 及 SBOM/例外策略 |
| git-traceability | evidence-ready | P9 Artifact/Review/Commit/Push/PR/Landing 追溯与 P12-04 真实隔离演练 |
| recovery-stop | evidence-ready | P11 恢复/Stop 演练与 `p12-real-autodev-drill-2026-08-05.json` |
| observability-oncall | evidence-ready | P11 指标、告警、Runbook、on-call owner 与演练证据 |
| canary-goal-verification | **blocked** | 尚无获授权的内部低风险项目 owner，也未开始连续 48 小时计时 |
| defect-budget | **blocked** | 尚无 Canary 结束时的 P0/P1=0 及所有 P2 owner/规避方案快照 |

## 最终签署

| 角色 | 当前状态 | 必需证据 |
|---|---|---|
| security | **pending** | OIDC signer、request ID、Audit Receipt、理由、evidence digest |
| operations | **pending** | OIDC signer、request ID、Audit Receipt、理由、evidence digest |
| product | **pending** | OIDC signer、request ID、Audit Receipt、理由、evidence digest |
| project-owner | **pending** | OIDC signer、request ID、Audit Receipt、理由、evidence digest |

当前结论：8/10 项 evidence-ready，0/4 签署，Production V1 `blocked`。不得把单元测试中的合成 48 小时窗口、
fixture signer 或 P12-04 隔离仓库当作真实内部 Canary。
