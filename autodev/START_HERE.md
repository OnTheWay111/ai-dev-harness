# AutoDev Harness 0.4.16：快速开始

AutoDev 源码现由 AI Dev Harness 根仓库统一管理。本目录包含运行源码、安装元数据、
使用指南、PostgreSQL 初始化脚本和测试；虚拟环境、构建产物与本机配置不纳入 Git。

## 1. 前置条件

- macOS 或 Linux
- Python 3.11 或以上
- Git
- 至少一个 Builder CLI 和一个不同厂商的 Reviewer CLI，例如 Claude Code 与 Codex
- 一个已经初始化并有基线分支的 Git 项目

## 2. 安装

在本目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"

autodev --version
autodev --help
```

看到版本 `0.4.16` 即表示安装成功。

运行源码测试：

```bash
python -m unittest discover -s tests -v
```

## 3. 先用默认文件模式跑通

默认文件模式不需要 PostgreSQL。把 `/work/my-service` 换成自己的 Git 项目：

```bash
autodev init \
  --repo /work/my-service \
  --project-id my-service \
  --name "My Service"

cd /work/my-service
autodev doctor
```

人工检查 `.autodev/project.yaml`、任务队列中的真实验证命令和 Agent 配置后，
先做 dry-run：

```bash
autodev run-one --task <任务ID> --dry-run
```

确认无误后再执行真实任务：

```bash
autodev run-one --task <任务ID>
```

完整接入、队列、失败恢复、多项目运行和 Dashboard 用法见：

`docs/autodev_harness_user_guide.md`

## 4. 可选：启用 PostgreSQL

普通文件模式不需要下面这些步骤。只有要使用 PostgreSQL shadow/database 模式时才执行。

先安装数据库可选依赖：

```bash
python -m pip install ".[postgres]"
```

由 PostgreSQL 集群管理员创建数据库和最小权限角色：

```bash
export AUTODEV_MIGRATOR_PASSWORD='替换为迁移角色密码'
export AUTODEV_APP_PASSWORD='替换为运行角色密码'

psql -X -v ON_ERROR_STOP=1 \
  -v database_name=autodev_dev \
  -v migrator_role=autodev_migrator \
  -v app_role=autodev_app \
  -f scripts/bootstrap_postgres.sql postgres

unset AUTODEV_MIGRATOR_PASSWORD AUTODEV_APP_PASSWORD
```

再使用迁移角色连接串创建表并检查数据库版本：

```bash
export AUTODEV_DATABASE_URL='postgresql+psycopg://autodev_migrator:<密码>@127.0.0.1:5432/autodev_dev'
autodev database upgrade
autodev database current
autodev database check
unset AUTODEV_DATABASE_URL
```

正常 Harness 和 Dashboard 进程应改用 `autodev_app` 运行角色连接串。不要把密码或连接串写进
YAML、脚本或聊天记录。数据库 shadow/cutover 的完整安全流程见根目录 `README.md`；
不要跳过 freeze、digest 和 receipt 闸口直接切换正式数据权威。
