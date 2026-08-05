# AI Dev Harness

一套以“完成原始目标”为核心的 AI 开发 Harness 设计。

当前项目处于方案阶段，核心流程已经收敛为七个阶段：

1. 目标定义
2. 自适应澄清
3. 最小方案与过度设计评审
4. 产出规格
5. Issue 拆分
6. 调度执行
7. 集成交付

完整方案见：

- [七阶段 Harness 方案](docs/7-stage-harness.md)
- [开源项目与本地 AutoDev 评估](docs/project-evaluation.md)
- [Production V1 方案](docs/production-v1-plan.md)
- [Web UI 交互设计说明](docs/web-ui-design.md)
- [P11 软件供应链安全](docs/p11-supply-chain.md)
- [可交互 Web UI 原型](prototype/web-ui)
- [AutoDev 执行引擎源码](autodev)

## 仓库布局

- `prototype/web-ui/`：AI Dev Harness 控制面、规划与审批工作台。
- `autodev/`：AutoDev 0.4.16 执行、队列、验证、恢复及原子 Import 服务。
- `docs/`：跨控制面与执行面的协议、路线图和兼容性证据。

所有目录都由根仓库统一版本管理；禁止在 `prototype/web-ui/`、`autodev/` 或其他
子目录创建嵌套 `.git`。AutoDev 的 `.venv/`、构建目录、缓存和安装元数据均被排除。

## 核心原则

- Issue 完成不等于目标完成。
- 方案规模应与任务规模和风险匹配。
- 默认只实现达成验收标准所必需的内容。
- 人工审批是风险门禁，不是所有任务的固定仪式。
- 并行执行必须同时考虑依赖关系和代码冲突。
- 最终交付必须回到原始目标和验收标准进行验证。
