# Web/API 安全基线

P3-04 为所有写入处理器建立同一套 fail-closed 安全顺序：

1. 只接受 `POST` 等声明的方法；
2. `Origin` 必须等于服务端允许的应用 Origin，`Sec-Fetch-Site: cross-site` 一律拒绝；
3. 从安全 Session 解析 actor，不能从请求体或 URL 接受 actor/Organization；
4. 以 `actorId + organizationId + endpoint` 作为限流键；
5. 只接受 `application/json`，先检查 `Content-Length`，再流式计数实际字节，默认上限 16 KiB；
6. 严格解析 Schema，顶层和嵌套对象的未知字段都拒绝；
7. 写入继续使用 `Idempotency-Key`、乐观版本和事务 Audit/Outbox；
8. 只返回稳定错误码和处理建议，不序列化异常、SQL、连接串或 Secret。

`MemoryFixedWindowRateLimiter` 是当前单一部署运行时的 limiter，并通过 `RateLimiter` 端口可替换为共享
存储实现。Goal 写入默认每个 actor/Organization/endpoint 每分钟 30 次；达到上限返回 `429` 和
`Retry-After`。Organization 不来自未校验请求数据。

浏览器响应统一设置：

- CSP：限制 default/base/form/object/frame/connect/img/script/style 来源；
- `X-Frame-Options: DENY`；
- `X-Content-Type-Options: nosniff`；
- `Referrer-Policy: no-referrer`；
- 禁用 camera、microphone、geolocation 的 Permissions Policy。

OIDC Session 使用 `SameSite=Lax` 只是纵深防御，写请求仍必须通过 Origin/Fetch Metadata 检查。登出
同样是受保护、限流且无请求体的写操作。合法请求、缺失/伪造 Origin、cross-site Fetch Metadata、
错误媒体类型、未知字段、未知 guard、实际/声明大小超限和不同 actor 的限流隔离均有自动化测试。

验证：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run test:unit
npm run ci:p1
```

