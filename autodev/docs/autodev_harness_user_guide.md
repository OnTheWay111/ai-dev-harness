# AutoDev Harness 使用与团队交接指南

> 适用版本：AutoDev Harness 0.4.16 及以上
>
> 适用对象：第一次接手 Harness 的开发同学、需要把新 Git 项目接入自动开发流程的项目负责人

## 1. 它解决什么问题

AutoDev Harness 是运行在开发机上的项目执行器。它把一次功能开发拆成可追踪的本地流水线：

```text
领取任务 → Builder 开发 → 项目验证 → 独立 Reviewer 评审
        → 落地到集成分支 → 更新任务队列 → 留存运行证据
```

它的几个基本原则：

- 每个项目保留自己的配置、任务队列、运行记录和 Git 分支，Harness 不替项目保存业务真相。
- Builder 和 Reviewer 默认使用不同厂商的模型，避免同一个模型既开发又给自己验收。
- 每个任务在独立 Git worktree 中执行，通过验证和独立评审后才进入项目的落地通道。
- 默认不 push、不发送真实通知、不写外部系统；这些能力必须由项目负责人显式开启。
- 一台机器可以同时运行多个项目。本文重点给出 3 个项目并行的推荐配置。

## 2. 先理解两个“并行”

这两个概念不要混用：

| 场景 | 正确做法 | 不要这样做 |
| --- | --- | --- |
| 3 个不同项目同时开发 | 每个项目启动 1 个 `run-loop`，由主机容量策略统一限制总 Worker 数 | 不要让 3 个项目共用同一份项目配置或任务队列 |
| 1 个项目同时处理 2～3 个任务 | 仍只启动 1 个 `run-loop`，设置 `execution.max_parallel_tasks: 2` 或 `3` | 不要在同一个项目启动多个 `run-loop` |

每个项目始终只有一个权威 Supervisor。单项目并行上限是 3；多项目实际同时运行多少 Worker，由机器级 `host.yaml` 决定。

## 3. 安装

### 3.1 前置条件

- macOS 或 Linux 开发机。
- Python 3.11 或以上。
- 已安装 Git。
- 至少一个可用的 Builder CLI 和一个不同厂商的 Reviewer CLI，例如 Claude Code 与 Codex。
- 待接入的代码目录必须是 Git 仓库，并且已有可用的基线分支。

### 3.2 推荐方式：安装版本化 wheel

从项目维护者或内部制品位置取得已发布的 wheel，在独立虚拟环境中安装：

```bash
python3 -m venv ~/.venvs/autodev
source ~/.venvs/autodev/bin/activate
python -m pip install --upgrade pip
python -m pip install /path/to/autodev_harness-0.4.16-py3-none-any.whl

autodev --version
autodev --help
```

不要把同一版本号的 wheel 用不同内容重复覆盖。升级时取得新的版本化 wheel，然后执行：

```bash
source ~/.venvs/autodev/bin/activate
python -m pip install --force-reinstall --no-deps /path/to/new-autodev-wheel.whl
autodev --version
```

只有使用 PostgreSQL 存储模式的机器才需要可选依赖：

```bash
python -m pip install "/path/to/autodev-wheel.whl[postgres]"
```

普通项目使用默认文件模式，不需要安装数据库依赖。

### 3.3 Harness 贡献者：源码开发安装

只有要修改 Harness 本身时才使用 editable 安装：

```bash
git clone <autodev-harness 仓库地址>
cd autodev-harness
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
python -m pytest
```

## 4. 把一个新项目接入 Harness

以下示例假设项目位于 `/work/my-service`。

### 4.1 生成安全草稿

```bash
source ~/.venvs/autodev/bin/activate

autodev init \
  --repo /work/my-service \
  --project-id my-service \
  --name "My Service" \
  --register
```

命令会生成或建议这些文件：

```text
.autodev/project.yaml          项目配置
tasks/agent_task_queue.yaml    项目任务队列
docs/autodev-governance.md     项目验收与治理规则
AGENTS.md                      Agent 的项目级说明
.claude/settings.local.json.example
.autodev/gitignore.suggested
```

`init` 默认是幂等的：已有文件不会被覆盖。只有明确需要重建草稿时才使用 `--force`。

### 4.2 必须人工检查的配置

打开 `.autodev/project.yaml`，至少确认以下内容。

#### 项目与 Git 基线

```yaml
project:
  id: my-service
  name: My Service
  repo_root: /work/my-service

branch:
  enabled: true
  base_ref: main
  commit_per_task: true
  push: false
```

- `repo_root` 必须指向当前项目的真实 Git 根目录。
- `base_ref` 必须是已提交、可解析的分支或 ref。
- 初次接入保持 `push: false`，先在本地跑通全链路。

#### Builder 与独立 Reviewer

默认配置是 Claude Builder + Codex Reviewer：

```yaml
agent:
  builder: claude
  evaluator: codex_check
  allow_same_agent: false
```

也可以改为 Codex Builder + Claude Reviewer：

```yaml
agent:
  builder: codex
  evaluator: claude_check
  allow_same_agent: false
```

配置中的命令、模型名和超时要与本机实际安装及账号额度匹配。不要为了临时绕过限流，把 Builder 和 Reviewer 永久改成同一厂商。

#### 项目验证命令

脚手架只提供 `git diff --check`。接入人必须补上项目真实的测试、静态检查或构建命令，例如：

```yaml
verify:
  default:
    - git diff --check
    - python -m pytest
    - python -m ruff check .
  command_timeout_minutes: 15
```

命令应当能从项目根目录执行，退出码为 0 才表示通过。不要把需要人工输入或永不退出的命令放进这里。

#### 项目治理规则

把项目必须遵守的约束写进 `docs/autodev-governance.md`，再加入配置：

```yaml
governance:
  mode: generic
  reference_docs:
    - docs/autodev-governance.md
```

典型内容包括：

- P0/P1 评审问题必须修复后才能继续。
- 哪些目录、接口或数据结构不能擅自改动。
- 必须运行哪些验证。
- 哪些外部写入必须等待人工授权。

#### 安全默认值

首次使用保持：

```yaml
branch:
  push: false

notifications:
  mode: dry_run

safety:
  external_write_policy: dry_run_only

policy:
  forbid_real_external_write: true
```

只有项目负责人明确批准并补齐守卫后，才能逐项放开。

### 4.3 把脚手架提交到基线分支

Harness 要求基线是明确的 Git commit。检查生成内容后提交：

```bash
cd /work/my-service
git status --short
git add .autodev tasks docs/autodev-governance.md AGENTS.md
git commit -m "chore: initialize autodev harness"
```

如果 `.autodev/gitignore.suggested` 中的规则适合项目，再人工合并到项目的 `.gitignore`，不要机械覆盖原文件。

## 5. 添加和批准任务

推荐通过 CLI 新增任务，让队列结构保持合法。`--acceptance`、`--verify` 和 `--depends-on` 可以重复传入：

```bash
cd /work/my-service

autodev queue propose \
  --title "为订单查询增加分页" \
  --goal "列表接口支持稳定的游标分页" \
  --acceptance "默认返回 20 条" \
  --acceptance "翻页期间不重复、不漏数据" \
  --verify "python -m pytest tests/test_order_list.py" \
  --source-ref "docs/order-pagination.md" \
  --priority P1 \
  --area api \
  --proposed-by teammate
```

新任务先进入 `proposed`，不会被 Worker 自动领取。负责人审核目标、验收标准和验证命令后批准：

```bash
autodev queue approve <任务ID> \
  --approver project-owner \
  --note "范围和验收标准已确认"
```

查看队列：

```bash
autodev queue summary
autodev queue next
```

依赖任务尚未完成、任务未批准或处于 blocked 时，不会作为下一条可执行任务返回。

## 6. 第一次运行

### 6.1 先做静态体检

```bash
cd /work/my-service
autodev doctor
```

`doctor` 默认只检查配置和本地前置条件，不调用模型、不消耗额度。只有确实要测试 Agent CLI 时才显式运行动态探针：

```bash
autodev doctor --probe-agent claude --yes
autodev doctor --probe-agent codex_check --yes
```

### 6.2 先 dry-run

```bash
autodev run-one --task <任务ID> --dry-run
```

dry-run 会生成 Prompt 和 Run 文件，但不调用 Builder。先检查任务上下文、治理规则和验证命令是否完整。

### 6.3 执行一个真实任务

```bash
autodev run-one --task <任务ID>
```

也可以不指定任务，让 Harness 领取下一条 dependency-ready 任务：

```bash
autodev run-one
```

正常流程会依次留下 Builder、Verify、Review、Git checkpoint 和队列状态证据。运行失败时先看 Run 详情，不要直接把任务手工标为完成。

### 6.4 连续处理任务

```bash
autodev run-loop --max-tasks 3 --max-minutes 180
```

- `--max-tasks` 是本轮最多处理多少个最终任务，不是并行数。
- `--max-minutes` 是本轮总时长上限。
- 同一项目同一时间只启动一个 `run-loop`。
- 需要暂停下一条任务时，创建配置中指定的 `.autodev/STOP`。
- 需要给下一轮补充方向时，编辑 `.autodev/STEER.md`。

## 7. 三个项目并行运行

### 7.1 推荐的起步配置

第一次让 3 个项目并行时，建议每个项目内部先保持串行：

```yaml
# 三个项目各自的 .autodev/project.yaml
queue:
  max_in_progress: 1

execution:
  max_parallel_tasks: 1
  stop_behavior: drain
  circuit_breaker: cancel_and_requeue
```

三个项目各自的 `tasks/agent_task_queue.yaml` 也保持：

```yaml
schema_version: 1
policy:
  max_in_progress: 1
tasks: []
```

然后创建机器级容量策略：

```yaml
# ~/.config/autodev/host.yaml
schema_version: 1
host:
  max_active_workers: 3
  provider_limits:
    claude: 3
    codex: 3
  fairness: fifo_per_project
  global_stop_file: ~/.config/autodev/STOP
```

含义：

- `max_active_workers: 3`：整台机器最多同时运行 3 个任务 Worker。
- `provider_limits`：每个模型供应商最多占用多少并发。这里的数字必须按账号真实额度设置。
- 如果 Claude 额度只允许 2 个并发，就把 `claude` 设为 `2`；第 3 个项目会公平等待，不会越过容量上限。
- `global_stop_file`：紧急时创建该文件，所有项目都停止领取新任务。
- 主机策略控制的是总容量，不会把 3 个项目的数据、分支或队列混在一起。

### 7.2 注册三个项目

如果初始化时没有使用 `--register`，可以重新执行幂等初始化并注册，或者在首次初始化时直接注册：

```bash
autodev init --repo /work/project-a --project-id project-a --name "Project A" --register
autodev init --repo /work/project-b --project-id project-b --name "Project B" --register
autodev init --repo /work/project-c --project-id project-c --name "Project C" --register

autodev registry list
```

注册表只保存项目入口，项目自身的 `.autodev/project.yaml` 和任务队列仍是权威数据。

### 7.3 启动三个 Supervisor

分别在三个终端启动：

```bash
# 终端 A
autodev run-loop \
  --project /work/project-a/.autodev/project.yaml \
  --max-tasks 3 \
  --max-minutes 180
```

```bash
# 终端 B
autodev run-loop \
  --project /work/project-b/.autodev/project.yaml \
  --max-tasks 3 \
  --max-minutes 180
```

```bash
# 终端 C
autodev run-loop \
  --project /work/project-c/.autodev/project.yaml \
  --max-tasks 3 \
  --max-minutes 180
```

此时是“3 个项目 × 每项目 1 个 Supervisor × 每项目最多 1 个 Worker”。主机 Broker 会统一执行全局 Worker 上限、Provider 上限和项目间公平排队。

### 7.4 单项目也需要并行时

如果 Project A 有多个互不依赖的任务，可把它的三个限制同时改成 `2` 或 `3`：

```yaml
# project-a/.autodev/project.yaml
queue:
  max_in_progress: 2
execution:
  max_parallel_tasks: 2
```

```yaml
# project-a/tasks/agent_task_queue.yaml
policy:
  max_in_progress: 2
```

然后仍然只启动一个 Supervisor：

```bash
autodev run-loop \
  --project /work/project-a/.autodev/project.yaml \
  --parallel 2
```

`--parallel` 不能超过项目配置的 `execution.max_parallel_tasks`。即使三个项目各自允许多个 Worker，整机实际运行数仍受 `host.max_active_workers` 限制；要提高整机上限，应先确认 CPU、内存、模型账号额度和 Git 落地吞吐。

## 8. Dashboard

### 8.1 启动单项目只读页面

```bash
autodev dashboard \
  --project /work/my-service/.autodev/project.yaml \
  --serve \
  --host 127.0.0.1 \
  --port 8765
```

### 8.2 启动多项目总览

三个项目都注册后：

```bash
autodev dashboard \
  --registry ~/.config/autodev/projects.yaml \
  --serve \
  --host 127.0.0.1 \
  --port 8765 \
  --refresh-seconds 5
```

浏览器打开 `http://127.0.0.1:8765/`。页面是只读的，可以查看：

- 整机 Worker 与 Provider 容量。
- 各项目队列、运行中任务和落地通道。
- Runs 历史、阶段流程、Builder/Reviewer 映射与产物。
- 已完成任务列表和分页历史。

页面不负责批准任务、恢复任务或执行写操作；这些动作仍通过 CLI 完成。

## 9. 常用运维命令

### 查看状态

```bash
autodev status
autodev queue summary
autodev registry list
```

### 恢复 blocked 任务

先确认阻塞原因已经处理：

```bash
autodev queue resume <任务ID> --note "根因已修复，允许重试"
```

如果任务已用尽失败预算，必须经过人工复核后显式重置：

```bash
autodev queue resume <任务ID> \
  --reset-failure-budget \
  --note "已复核根因与修复方案"
```

### 从失败候选继续

```bash
autodev run-one \
  --task <任务ID> \
  --retry-from <失败Run ID>
```

Harness 会恢复失败 Run 的候选补丁和评审证据，然后重新执行正常验证、独立评审与落地闸口。

### 外部人工接管

如果同学不用 Harness Worker，而是手工或用外部 Agent 开发，必须先领取任务，Dashboard 才能正确显示正在处理：

```bash
autodev queue claim <任务ID> \
  --owner teammate \
  --note "人工接管修复"
```

完成后优先让 Harness 正常验证和收口。确需手工更新队列时，要保留审计说明；不要用 `--skip-verify` 绕过正常验收。

### 定时窗口

先 dry-run 检查是否会触发：

```bash
autodev schedule --window "22:00-07:00" --dry-run
```

确认后再去掉 `--dry-run`。Harness 不会因为查看 help、status、doctor 或 queue 就自动启动 Agent。

## 10. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| `doctor` 报配置错误 | `repo_root`、`base_ref`、Agent 命令、verify 命令是否真实存在 |
| 并行启动失败 | 是否存在 `~/.config/autodev/host.yaml`；项目和队列的三个并行限制是否一致 |
| 第 3 个项目一直等待 | `max_active_workers` 或对应 `provider_limits` 是否已满；这是容量保护，不是任务丢失 |
| 有任务但 `queue next` 为空 | 任务是否仍是 proposed、被依赖阻塞或处于 blocked |
| Dashboard 不显示外部开发者 | 外部 Worker 是否先执行了 `queue claim` |
| Run 评审失败 | 查看评审产物，修复后使用 `queue resume` 和 `run-one --retry-from` |
| 主分支有未提交改动 | 先人工确认来源；不要用破坏性 Git 命令清理，避免覆盖同事工作 |
| 模型限流或额度不足 | 调低 `provider_limits`/并行数，等待额度恢复；不要静默切成同厂商自评 |
| 需要立即停止所有项目 | 创建 `~/.config/autodev/STOP`，确认 Worker 收口后再处理根因 |

## 11. 交给另一位同学前的检查清单

- [ ] 已提供明确版本的 wheel，以及该版本的发布说明。
- [ ] 对方能运行 `autodev --version`、`autodev doctor`。
- [ ] 新项目的脚手架和队列已提交到正确的 `base_ref`。
- [ ] `verify.default` 是项目真实可执行的验收命令，不只剩 `git diff --check`。
- [ ] Builder 与 Reviewer 是不同厂商，命令和账号均可用。
- [ ] `branch.push`、真实通知和外部写入仍保持关闭，或已有明确书面授权与守卫。
- [ ] 3 项目并行时，每个项目只有一个 Supervisor，主机 `host.yaml` 已按真实额度设置。
- [ ] 已演练 `STOP`、blocked 恢复和失败 Run 重试。
- [ ] 已启动只读 Dashboard，并确认三个项目能分别看到自己的队列与 Run。

完成以上检查后，另一个同学就可以独立完成：新增任务、审核批准、单任务试跑、持续执行、观察 Dashboard、恢复失败任务，以及在一台机器上安全地并行运行三个项目。
