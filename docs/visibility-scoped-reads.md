# 服务端可见范围与隔离读取

P3-03 将 Workbench 读取边界固定为 `ActorVisibilityScope`。该对象只能由服务端使用已验证 OIDC
Session 中的 `actorId` 和 PostgreSQL 中未撤销的 `role_bindings` 构造；Organization、Project 或
Goal 查询参数都不能创建或扩大可见范围。

## 授权与数据流

1. API/SSR 解密并校验 `__Host-harness_session`，得到稳定的 opaque `actorId`。
2. `ActorVisibilityResolver` 查询该 actor 的全部活跃 RoleBinding。
3. Organization Owner 产生 Organization 范围；其他角色产生其精确 Project 范围。没有活跃范围时
   在访问仓库前返回 `403`，没有 Session 时返回 `401`。
4. `WorkbenchReadRepository.getWorkbench(visibility, query)` 强制要求可见范围。调用方不能省略它。
5. PostgreSQL 在 `WHERE` 中同时应用 deployment scope、Organization/Project 范围和可选 Goal/状态
   条件。任务内容、分页 `total` 和 summary 聚合使用同一可信范围，禁止先加载全量数据再过滤。

`WORKBENCH_SCOPE_ID` 只是开发/测试/预发布投影的部署命名空间，不是授权边界。投影行还必须写入
`organization_id` 和 `project_id`；主键包含 deployment scope、Organization、Project 和实体 ID。

## Summary 与缓存

Workbench 不再返回投影中预先计算的跨租户 summary。数据库直接在可见任务行上计算 all、attention、
running、review、blocked、waiting 和 active worker 计数。Goal 查询也会进入 summary 的 SQL 条件。

ETag 输入包含服务端可见范围摘要、当前可见 Project 的 revision/生成时间和已校验查询条件。范围原文
不会进入响应；两个 actor 即使请求 URL 相同，也不会因为另一个组织的 revision 得到相同缓存身份。

## 投影发布与迁移

聚合器按 Project 调用 `replaceProjection({ scopeId, organizationId, projectId }, snapshot)`。同一复合
范围仍须单写者串行发布。迁移 `0006_absurd_thena` 会清空可重建的旧 Workbench 投影，然后把
Organization/Project 归属改为必填并建立复合主键；权威控制面表不受影响。迁移后必须重新发布各
Project 投影。

本地 bootstrap 需要非 Secret 的 `WORKBENCH_ORGANIZATION_ID` 和 `WORKBENCH_PROJECT_ID`。连接串、
OIDC Secret 或 Session 不得写入 Git、日志、浏览器 bundle 或 `NEXT_PUBLIC_` 变量。

## 验证

运行：

```bash
cd /Users/onthewayli/harness/ai-dev-harness/prototype/web-ui
npm run test:postgres:integration
npm run ci:p1
```

真实 PostgreSQL 集成测试写入两个 Organization、三个 Project，并断言任务内容、`total`、summary、
Goal 猜测和 ETag 均无法跨范围泄漏。另有单元测试断言无 Session/无 RoleBinding 在仓库访问前失败，
以及 URL 中伪造的 Organization/Project 参数不能改变服务端解析的范围。

