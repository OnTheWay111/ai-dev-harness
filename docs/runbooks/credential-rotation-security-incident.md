# P11 凭证轮换与安全事件 Runbook

Owner：`platform-security`。覆盖 OIDC cookie/signing material、数据库角色、S3 工作负载身份、AutoDev Queue Import token、
Git/GitHub 凭证和模型 provider 凭证。任何 Secret 值都不能进入命令、终端历史、客户端变量、构建参数、日志或 Receipt。

## 触发条件

- 定期轮换、人员/权限变化、供应商通知、疑似泄漏、异常使用或 Secret 扫描命中。
- 确认/可能外泄、签名伪造或跨租户访问按安全事件处理：先全局 Stop、撤销，再恢复；不能只做普通轮换。

## 权限

- security operator 在 Secret Manager 创建/禁用版本；服务 owner 只能更新服务端引用并滚动实例。
- 数据库密码轮换还需 database operator；生产 Resume 需 incident-commander（事件）或变更审批人（例行轮换）。

## 执行命令

在 Secret Manager 创建新版本并记下非敏感 version reference；不要在 shell 中赋值 Secret。双版本支持时先加新、滚动、验证，
再撤销旧；Queue Import 不支持双 token 时先 Stop server，再原子更新服务端和调用方引用后重启。

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run scan:client-secrets
npm run security:policy:p11
npm run build
npm run scan:client-secrets
curl --fail --silent --show-error "${P11_WEB_ORIGIN}/health/ready"
```

安全事件额外冻结发布/Artifact 下载，保存 request/goal/issue/run/receipt/trace ID、时间窗和脱敏日志；在 Secret Manager 撤销旧
版本，在身份供应商撤销会话/授权，在 Git provider 撤销受影响 token。使用测试身份做一次最小授权请求，禁止用真实用户数据
作为探针。

## 验证

新实例只引用新 version reference；旧凭证请求被拒绝，新凭证健康检查成功；OIDC 旧会话按事件范围失效；数据库/S3/Git/模型
调用维持最小权限。重新运行仓库、构建产物和客户端 Secret 扫描，Audit 记录轮换 actor、原因、Secret 名称和版本引用但不含值。

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
node --experimental-strip-types --test tests/request-security.test.mjs tests/p11-supply-chain.test.mjs
```

## 回退

例行轮换在旧版本尚未撤销且无泄漏时，可让服务端引用退回旧 version reference并重新滚动；若怀疑泄漏，禁止恢复旧凭证，保持
Stop 并修复新版本/权限。数据库轮换失败不修改 Schema；对象身份失败不降级为静态 Access Key；所有失败保留审计证据。

## 升级联系人

确认泄漏、越权或跨租户影响立即升级 `incident-commander`；数据库身份升级 `data-platform`；Worker/模型凭证导致执行失联升级
`execution-platform`。范围未确定前按最高影响处理。
