# Kernel、Planner 与 AgentLoop 源码导航

English summary: composition, durable execution, and autonomous model turns.

| 源码（相对 ../src） | 责任 |
| --- | --- |
| framework/runtimeKernel.ts | 创建服务，分发 RPC，按 optional/required 注入工具和快照 |
| session/runCoordinator.ts | Session/Run 生命周期和终态 |
| workflow/autoWorkflowPlanner.ts | AutoWorkflowPlannerV1 建立持久 Root 执行容器 |
| workflow/workflowOrchestrator.ts | 确定性准入、调度和执行状态推进 |
| workflow/sqliteWorkflowAuthority.ts | SqliteWorkflowAuthorityV1 的事务、Task、Lease、mailbox |
| loop/index.ts | 组装请求、处理 stream、执行 Tool、usage、steer、compaction、收尾 |
| working-plan/ | 默认清单与 advisory-v1 |
| review-plan/ | 显式 required 的严格合同 |

不要把内部 Workflow Node 等同于模型的计划。auto/solo 共用 AgentLoop；auto 可派 Child，solo 不可派。显式 workflow 的 agent.delegate/workflow.expand 是兼容图接口。

ChildRuntimeHost 通过正式启动、认证、Capability Bundle 和 credential broker 建立 Child；Child 不能创建 Child。写隔离的父级合并校验不可由 Prompt 绕过。

完整流程见[运行全链路](../../../docs/agent-runtime-lifecycle.md)，状态归属见[架构](../../../docs/architecture.md)，不要在本页另存一份状态机。
