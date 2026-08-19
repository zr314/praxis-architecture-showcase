# ADR-007：统一 Auto Workflow 与多 Agent

状态：已接受并接入本地产品路径。

日期：2026-08-06。

## 决策

1. 新 Session 默认 `auto`；`solo/workflow` 仅为同一实现的 policy override。
2. 每条 Prompt 从第一步创建 durable Workflow 和根 AgentTask。
3. 根模型在 ReAct 内通过 `agent.delegate` 或 `workflow.expand` 提出拓扑变化；Runtime 最终准入。
4. Workflow、Node、Attempt、Task、Lease、Outbox、Timer、Signal、HumanTask 和 Profile 使用独立 SQLite authority。
5. Local Worker 复用受认证 Child Runtime；Child 继承被衰减的 Builtin/Skill/MCP/workspace 能力，但不能创建 descendant。
6. 可写 Child 在 Git worktree 中执行，父 Runtime 验证候选 commit 后 fast-forward。
7. 过期 Lease 按 effect/retry 恢复；unknown side effect 不自动重放。
8. Protocol/TUI 读取同一 Workflow projection；旧 CompactPlan 和 ProductSupervisor 不再属于产品路径。
9. `direct/supervisor` 只作为迁移输入映射为 `solo/workflow`。

## 原因

普通 Agent 应能自主判断委派价值，而用户不应先猜选哪套 Planner。与此同时，授权、预算、恢复和副作用一致性不能交给模型。统一 Workflow 既保留简单任务的单 Agent 低延迟，也允许执行对象在运行中安全增长。

## 后果

- 删除 ProductSupervisor 总控和 Direct/Supervisor 实例分叉。
- Session 与 Workflow 分为两个 authority，ID 和生命周期独立。
- 简单 Prompt 也会产生少量 Workflow SQLite 事务。
- 写 Child 需要 Git；主目录 dirty 时候选结果保留而不自动合并。
- 本地切片不等于 PostgreSQL、远程 Worker、完整 HITL/Timer 或 Saga 已交付。

详细领域设计见 [Planner Platform RFC](../planner-platform-rfc.md)，当前能力见 [Workflow 平台](../workflow-platform.md)。
