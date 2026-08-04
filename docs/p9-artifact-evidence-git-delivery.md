# P9 Artifact、Evidence、Review 与 Git 交付

本文记录 P9 的运行契约。目标是让每个 Issue 的完成结果都能从原始执行输出追溯到
独立 Review、Commit、远程分支、PR 和最终 Landing，同时不把大文本或凭证明文写入
PostgreSQL。

## 1. 不可变对象与元数据

`ObjectStorePort` 接受 `AsyncIterable<Uint8Array>`，边读取边计算 SHA-256，并在完成前写入
临时对象。对象 key 固定为：

```text
<organization-id>/<project-id>/sha256/<digest>
```

只有 digest、kind、媒体类型、大小、对象 key、创建者和保留策略进入
`artifact_objects`；Prompt、日志、测试输出、构建结果或失败正文不进入数据库。
同一租户、类型和 digest 重复上传返回去重 receipt，不覆盖已有对象。digest 不匹配、
流中断、越租户 key 或超出大小上限均失败关闭。

适配器包括：

- `MemoryObjectStore`：单元与契约测试；
- `FileSystemObjectStore`：本地兼容测试和开发；
- `S3ObjectStore`：生产 S3/R2 兼容存储，使用条件写、完成后 HEAD 校验、服务端加密和
  短期签名下载。

生产必须设置 `ARTIFACT_OBJECT_STORE=s3`。`ARTIFACT_S3_REGION`、
`ARTIFACT_S3_BUCKET` 和可选 endpoint/prefix 是非 Secret 配置；访问凭证只由工作负载身份
或 Secret Manager 在服务端运行时注入。对象下载使用：

```http
POST /api/v1/artifacts/{artifactId}/download
```

服务端先按 OIDC actor 的 Organization/Project 可见范围查元数据，再签发最长 300 秒的下载
URL。工作台只得到 artifact ID、digest、类型和大小，不得到对象 key。

## 2. Ingestion 与脱敏

`ArtifactIngestionService` 是 Prompt、stdout/stderr、测试输出、构建结果和失败证据的统一入口。
文本先完成以下处理，再计算最终 digest 并上传：

- 精确替换本次 Run 实际注入的 Secret 值；
- Bearer、token/password/api-key、GitHub token 和数据库 URL 模式检测；
- 邮箱、显式身份值、用户主目录和临时 Worktree 路径脱敏；
- 超大输出有界截断并追加不含正文的截断标记；
- 二进制输入默认拒绝，要求执行器生成有界文本摘要。

原始数据保留默认关闭。即使调用方声称拥有高权限，部署策略未显式开启时也会拒绝。
Execution Gateway 把 stdout、stderr 和非零退出失败证据交给同一 ingestion；Artifact 上传失败
会把 Run 标记为 evidence 阶段失败，不能把缺证据的执行当作成功。

## 3. 独立 Review

`reviews` 保存结构化 verdict/findings、Reviewer 类型和版本、模型能力、推理强度、目标
Commit、输入 Artifact digest、Run 和时间。领域规则要求：

- Reviewer identity 与 Builder identity 不同；
- Review 必须绑定 40/64 位 Commit SHA；
- 每个输入 digest 必须属于同一个 Run；
- 相同 idempotency key 只重放完全相同的 Review；证据变化返回冲突；
- 只有目标 Commit 上的 `approved` Review 能进入交付编排。

工作台的 P9 证据面板展示脱敏 Artifact 摘要、独立 Review、Commit、Push、PR 和 Landing，
这些信息由 P8 Projector 从权威表重建。

## 4. Push 策略和凭证

每个 Repository 使用版本化 `delivery_policies`：

- `push_disabled`：默认值，只保留本地候选；
- `push_branch`：只推送受控 Issue 分支；
- `push_and_open_pr`：推送后创建或复用 PR。

策略固定 Repository、baseline branch、允许分支前缀和保护分支模式。任何直接写
`main`/release 等保护分支、跨 Repository、基线变化或前缀外分支都会在获取凭证前被拒绝。

`credential_references` 只保存 Secret Manager 外部引用和允许 scope，不保存 token。启用 Push
时 scope 必须精确等于当前动作所需的 `contents:write`，创建/合并 PR 时再加
`pull_requests:write`；多余 scope 也会拒绝。`SecretManagerCredentialBroker` 签发 1～15 分钟
lease，并在操作结束后 revoke。Git token 只进入子进程环境或 GitHub Authorization header，
不进入参数、日志、数据库或 API 响应。

## 5. Commit → Push → PR → Landing

`DeliveryOrchestrator` 和 `delivery_candidates` 使用显式状态：

```text
verified → committed → reviewed
  ├─ push_disabled → local_ready
  └─ enabled → branch_pushed → pr_open → landing → landed
```

每个外部操作使用稳定 operation key。数据库在每一步保存候选快照、Push receipt、PR external
ID、Landing SHA 和 AuditEvent。崩溃重试先读取 operation receipt；Git Push 同一 SHA/分支、
PR head/base 查询和已合并 PR 查询都是幂等的，不会重复创建外部结果。
即使崩溃发生在状态已持久化、总操作 receipt 尚未写入的窗口，`local_ready`、`landing` 和
`landed` 也会从权威状态继续或补写 receipt。Artifact、Review、Policy revision、Push/Landing
receipt 和 operation receipt 由数据库触发器拒绝 UPDATE/DELETE。

Landing 只接受 `push_and_open_pr`，并同时要求人工门禁和平台检查通过。实现不提供直接向保护
分支 Push 的路径；最终合并只能通过 PR 平台 API，并再次校验 PR head 仍等于已 Review 的 Commit。

## 6. 验证

```bash
cd prototype/web-ui
npm run test:p9
npm run test:p9:postgres
npm run db:check:drift
npm run typecheck
npm run lint
npm run build
```

P9 测试同时覆盖内存/文件对象契约、digest 不符、流中断、租户隔离、Secret/路径泄漏、
超大日志、二进制拒绝、Review 幂等与独立性、默认禁 Push、最小 scope、保护分支、崩溃重试，
并在仓库外临时目录创建真实裸 Git remote 验证 Commit 和 Push。
