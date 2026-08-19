# Supervisor 名称迁移

旧的产品 `supervisor` 模式已删除。旧配置值仍会迁移为统一 Workflow 的 `workflow` policy，但不会选择另一套 Planner。

Child 就是 Praxis 的 subagent：它是受认证的独立 Runtime/AgentLoop，不是旧 Supervisor 的固定 worker。默认 `auto` 下根模型可以直接调用 `agent.delegate` 或 `workflow.expand`，无需先切换到 `workflow`；`workflow` 只增加“非平凡副作用先图化”的 policy，`solo` 才明确禁用 Child。Root/Child 共用同一个 Agent harness，角色差异由 Prompt contract、ContextPacket 和 Capability Bundle 装配，不需要固定 coordinator/researcher/coder/reviewer/verifier 五套实现。

请阅读[统一 Workflow 与多 Agent](workflow-platform.md)与[Prompt 装配规则](prompt-assembly.md)。历史设计与迁移依据见 [Planner Platform RFC](planner-platform-rfc.md) 和 [ADR-006](adr/ADR-006-supervisor-subagent-boundaries.md)。
