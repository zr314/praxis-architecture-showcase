# Praxis

> 公开源码快照 · 2026-09-07。包含当前 Runtime、SDK、CLI、测试与文档；历史 benchmark 的原始运行产物保存在独立本地评测环境，未随仓库分发。Public source snapshot with reproducible local tests; historical benchmark artifacts are maintained separately.

Praxis 是 TypeScript 编写的本地 Agent Harness：CLI/TUI 负责交互，独立 Runtime 负责模型循环、工具权限、上下文、持久恢复和多 Agent 协作。它提供通用执行底座，不保证模型一定选对路线或完成任务。English summary: a local agent runtime with durable execution and model-owned working plans.

新 Session 默认使用 `auto`。模型可以直接 ReAct，也可以维护可随时修改的 Working Plan，再按需创建 Child。**默认 Plan 是工作清单，不是执行许可证；Review 是咨询，不是强制验收。** Host 显式设置 `planPolicy=required` 才启用严格 ReviewPlan。

## 快速开始

需要 Node.js 22.13+ 和 npm。Git 工作区的 Child 写入使用 Git worktree；非 Git 目录也支持受管快照隔离，不要求把用户目录初始化为仓库。

```powershell
git clone https://github.com/zr314/praxis-architecture-showcase.git praxis
cd praxis
npm ci
npm run build
npm run install:local
praxis --version
praxis auth login kimi
praxis
```

也可以使用其他 Provider，或使用不消耗真实 API 的 mock。见[快速入门](docs/quickstart.md)和[Provider 配置](docs/provider-setup.md)。

## 核心能力

| 模块 | 当前行为 |
| --- | --- |
| 自主执行 | Root AgentLoop 流式调用 Provider，执行获准的 Tool，再根据结果继续行动 |
| 轻量 Working Plan | `plan.create/update/progress/review/abandon`；执行中可改路线，done 仅代表自报进度 |
| 多 Agent | `agent.spawn/wait/result/cancel/steer`；独立 Child 进程与上下文，持久等待和结果；Child 当前不能再派 Child |
| 执行恢复 | SQLite WorkflowAuthority 保存 Task、Lease、mailbox、effect 和执行快照；未知副作用不盲目重放 |
| 会话存储 | SessionJournalV3 可选 JSONL 或 SQLite，单一权威、不双写；支持恢复、分支与压缩 |
| 本地长期记忆 | 默认关闭；启用后跨 Session 召回项目记忆，显式授权写入、版本检查和撤销；见[使用合同](docs/long-term-memory.md) |
| Prompt 与上下文 | 默认 `iron-law-lean-v1`，固定指令与动态状态分离；逐字任务合同不被 compact 丢弃 |
| 扩展与安全 | Builtin、Skills、MCP stdio、Process 插件统一经过工具权限；Child 能力只能收窄 |
| 接入与观测 | NDJSON JSON-RPC、Agent SDK、可信 Host middleware、Trace、Usage 与诊断 |

`auto` 和 `solo` 使用相同执行底座；`solo` 禁止 Child。显式 `workflow` 是保留的 legacy 业务图接口，额外开放 `agent.delegate` 等工具，默认不要求模型编写 DAG。`direct/supervisor` 分别是 `solo/workflow` 的兼容别名。

```powershell
praxis --print "解释这个项目的入口" --output-format text
praxis --planner solo --print "完成修改并验证" --output-format text
praxis doctor
praxis doctor --deep
```

## 从哪里读起

1. [文档索引](docs/README.md)：使用指南、架构、接口参考、测评记录四类入口。
2. [当前架构](docs/architecture.md)：组件关系和存储边界。
3. [Working Plan](docs/working-plan.md)：默认计划、咨询 Review 和能力边界。
4. [运行全链路](docs/agent-runtime-lifecycle.md)：一次请求怎样执行、失败和恢复。
5. [测评档案](docs/evaluations/README.md)：真实题目、分数、问题与处理；历史成绩不冒充当前版本成绩。

源码职责见[模块地图](docs/module-map.md)。运行时 Prompt 的规则见[装配说明](docs/prompt-assembly.md)，精确文本与请求字段见[模型请求目录](docs/model-request-catalog.md)。

## 开发

```powershell
npm run check
npm test
npm run build
```

普通 CI 为 `npm ci → check → test → build`。发布、原生构建与供应链检查使用专用工作流。见[贡献指南](CONTRIBUTING.md)。

源码进程和顶层测试共用 `tsconfig.source.json` 的 Workspace 映射；源码测试不要求先更新 `dist`。安装和打包仍需构建，见[贡献指南](CONTRIBUTING.md#开发循环--development-loop)。

当前 Child 不再派生 Child；没有内置公共 Web Search、完整浏览器或多租户高可用服务。跨 Session 记忆已提供本地显式版本，尚无自动学习和语义检索；模型审查可能错误接受。实现边界见[项目状态](docs/project-status.md)。

License: Apache-2.0。
