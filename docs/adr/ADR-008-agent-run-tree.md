# ADR-008：默认 Agent Run Tree，显式 Workflow 降为可选上层

状态：已接受；第一阶段已接入，递归 Child broker 待接入。

日期：2026-08-22。

## 决策

1. 通用 `auto` 不再要求根模型设计 Workflow DAG，而以 plan-guided ReAct 作为认知循环。
2. 模型通过 `agent.spawn/wait/result/cancel/steer` 操作持久 Child 句柄；Runtime 只解释生命周期、等待、取消、指令和结果，不解释或持久化模型完整自然语言路线。
3. `workflow.expand/loop/subworkflow` 等显式图工具只在 `workflow` policy 下提供，用于已知阶段、审批、Timer、批处理和固定 Join 等粗粒度业务编排。
4. 当前内部仍使用 Workflow Authority 作为 execution container，复用 Node、Attempt、Task、Lease、mailbox、Artifact 和恢复语义；这属于迁移期物理实现，不是模型面对的规划抽象。
5. `agent.spawn` 创建的探索/审查 Child 不是外层成功条件：所有 Child 必须进入终态，但可选 Child 的失败或取消不自动否定 Root 结果。
6. Plan 留在各 Agent 自己的 Session/上下文中；结构化持久事实只有 Parent/Child 身份、状态、Wait、Instruction、Result 和 Artifact 引用。
7. Child 递归委派必须通过父 Runtime 的认证 broker、能力衰减、祖先预算和结构化并发实现；不得允许嵌套 CLI 或让 Child 直接修改外层业务 DAG。

## 原因

完整 DAG Schema 把节点 ID、依赖、Join、GraphPatch 和资源装配成本转移给了 LLM，容易导致无效调用、过早冻结路线和形式化委派。通用任务更适合随 Observation 滚动修订短期 Plan；只有真实并行分支才在执行历史中自然形成拓扑。

## 第一阶段产品行为

- `auto`：普通 Tool + Agent Run Tree 工具；不暴露显式 Workflow 图工具。
- `solo`：普通 Tool；禁止 Child。
- `workflow`：Run Tree 工具 + 兼容的完整 Workflow 工具。
- 运行中 steer 先写 durable instruction；活跃 Child 在下一安全边界接收，尚未启动的 Child 在 bootstrap 前读取。
- `agent.wait` 提供 all/any/quorum Durable Future 语义，但模型不创建 Join Node。

## 尚未完成

- Child 进程还不能调用 `agent.spawn` 创建后代；当前 bootstrap 仍 fail-closed。
- 内部 execution container 仍使用 `WorkflowSpec` 追加 Child Node，尚未拆成独立的 `AgentRun/WaitGroup` 投影。
- 新 Run Tree 与普通 ReAct 的质量、Token、墙钟和错误路线恢复 A/B 尚未形成正式测评证据。

这些边界必须在文档和简历中如实保留，不能把第一阶段描述成任意递归多智能体已经交付。
