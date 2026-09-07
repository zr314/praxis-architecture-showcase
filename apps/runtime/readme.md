# Praxis Runtime 源码导航

English summary: source entry points for the current Runtime, not a second architecture specification.

Runtime 是独立进程，管理 Session、Provider、工具、权限、持久执行和扩展。先读[架构](../../docs/architecture.md)、[Working Plan](../../docs/working-plan.md)，再按下表追源码。

| 先看什么 | 源码 | 要理解的问题 |
| --- | --- | --- |
| 接入与组装 | src/entry.ts、src/framework/runtimeKernel.ts | session.prompt 如何连接服务？ |
| Run 生命周期 | src/session/runCoordinator.ts、src/session/sessionService.ts | 如何启动、结束、取消和恢复？ |
| 执行底座 | src/workflow/autoWorkflowPlanner.ts、workflowOrchestrator.ts、sqliteWorkflowAuthority.ts | AutoWorkflowPlannerV1、SqliteWorkflowAuthorityV1 如何保存 Task/Lease？ |
| 模型循环 | src/loop/index.ts | 一轮 Provider 与 Tool 如何闭环？ |
| 默认计划 | src/working-plan/workingPlanService.ts、tools.ts、advisoryReviewer.ts | 可编辑记忆与快照咨询为何不约束执行？ |
| 严格验收 | src/review-plan/ | required 的 Attempt、证据、ReviewCallStore 和完成门 |
| Child | src/subagent/childRuntimeHost.ts、src/workflow/localWorkflowAgentWorker.ts | ChildRuntimeHost、Capability Bundle、credential broker 和写隔离 |
| 存储与上下文 | src/session-db/、src/prompt/、src/memory/ | SessionJournalV3、JSONL/SQLite、Projection、压缩和任务保护 |
| 跨 Session 记忆 | src/long-term-memory/、src/prompt/memoryContext.ts | 默认 off 的项目记忆、显式授权、关键词召回与撤销；见[操作合同](../../docs/long-term-memory.md) |
| 工具和扩展 | src/tools/、src/extensions/、src/plugin/ | Schema、授权、Skill/MCP/Process activation |

普通 Session 的 JSONL 与 SQLite 不双写；Workflow SQLite 另存执行事实，事务使用 BEGIN IMMEDIATE。doctor --deep 用于完整校验，不是每轮重放。默认 optional 不要求 Plan Item Attempt；required 保留严格约束。

Child 当前不能再创建 Child。Git 写入由父侧校验候选后 fast-forward；非 Git 使用 DirectoryWorkspaceIsolationManagerV1，受管内容在 workflow-snapshots 下。显式 workflow 才暴露 agent.delegate、workflow.expand 等图工具，不能把它们描述为默认 auto 的要求。

## 分域导航

1. [Kernel 与 Loop](docs/01-kernel-and-loop.md)
2. [Session 与上下文](docs/02-session-memory-prompt.md)
3. [Provider](docs/03-providers-and-routing.md)
4. [Tool 与安全](docs/04-tools-policy-security.md)
5. [扩展与 Child](docs/05-extensions-plugins-subagents.md)
6. [观测和测评](docs/06-trace-evaluation-operations.md)

这些页面只解释源码落点。架构规则、Prompt 全文、配置参数和测评分数分别引用主文档，避免同一事实维护多份。
