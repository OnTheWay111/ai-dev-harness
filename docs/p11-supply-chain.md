# P11 软件供应链安全

生产门禁覆盖仓库 Secret、Web/Python 依赖漏洞、许可证、CycloneDX SBOM、Web 构建产物、容器镜像和来源证明。
机器策略位于 `ops/production/supply-chain-policy.json`，例外清单位于
`ops/production/supply-chain-exceptions.json`。Critical/High 一律阻断；Secret 不可豁免；其他例外必须精确匹配
组件和问题，具有 owner、审批人和不超过 90 天的到期日。

## CI 门禁

`.github/workflows/p1-postgres.yml` 使用完整 commit SHA 固定第三方 Action，并依次执行：

1. Pull Request dependency review，阻断 High/Critical 和 AGPL/GPL/SSPL；
2. 锁定依赖安装，`npm audit`、`pip-audit` 和仓库许可证策略；
3. Trivy 仓库 Secret/SCA/许可证/错误配置扫描；
4. 正式构建与构建产物 Trivy 扫描；
5. 生成 Web/Python CycloneDX SBOM 和逐文件 SHA-256 manifest；
6. 上传 90 天证据，并在 `main` push 上生成 GitHub Artifact Attestation。

当前仓库没有 Dockerfile、Containerfile 或 OCI 构建目标，因此镜像扫描标记为 `not-applicable`。策略会在任何镜像
构建定义出现时立即失败，直到 CI 增加镜像 Critical/High 扫描与来源证明，不能以“当前无镜像”长期绕过。

本地复核命令：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm ci
npm audit --audit-level=high
npm audit --omit=dev --audit-level=moderate
npm run security:policy:p11
npm run build
SUPPLY_CHAIN_OUTPUT_DIR=/absolute/private/output npm run security:artifacts:p11
```

Python 使用 `autodev/requirements-dev.lock` 作为审计和安装约束。升级不得执行未经评审的 `npm audit fix --force`；
当工具只建议破坏性降级时，保留非阻断项、指定 owner 和复核日期，再通过正常依赖升级关闭。

## 当前基线

2026-08-05 的实际扫描结果为：生产 npm 依赖 0 漏洞；Python 锁定依赖 0 漏洞；仓库和 Web 构建产物的
Critical/High、Secret 与错误配置均为 0。完整开发依赖剩余 4 个 Moderate（同一 esbuild 开发服务器 advisory
的依赖路径）和 1 个 Low（Babel 开发工具），不进入生产依赖且均已指定复核日期。当前唯一正式豁免是第一方
AutoDev 的 `LicenseRef-Proprietary`：仅允许本仓库内部生产使用，禁止再分发和第三方托管，2026-09-04 到期。

基线、原始 Trivy 报告、SBOM 和构建 manifest 位于
[`evidence/p11-supply-chain-baseline-2026-08-05.json`](evidence/p11-supply-chain-baseline-2026-08-05.json)
及 `docs/evidence/supply-chain/`。基线记录每个证据的 SHA-256；CI 的 synthetic High 用例证明阻断失败路径有效。
