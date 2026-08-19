# ADR-006：Supervisor 与 Subagent 执行边界

状态：**已被 ADR-007 取代**。

ADR-006 曾决定把动态 DAG、一级 Child、Capability Bundle、V3 Journal 与隔离 Git 写入接到显式 `supervisor` 模式，同时让 `direct` 保持默认。该纵向切片证明了 Child Runtime、权限衰减、deadline、验证和受控 merge 可行，但产品分叉让普通 Agent 无法按需委派，也把生命周期集中在一个 ProductSupervisor 总控类。

仍然有效并被 ADR-007 继承的安全原则：

- Child 必须使用正式 Runtime bootstrap 与认证通道；
- Provider credential 使用短期 broker handle；
- Capability 只能从父向子收窄；
- deadline 同时包含总期限与无进展期限；
- 可写 Child 使用隔离 worktree 和父侧候选提交验证；
- 未知副作用失联不能盲重试；
- Artifact/Journal/receipt 才是可恢复事实，自然语言摘要不是。

不再有效的产品决策：显式 Supervisor、Direct 默认、固定深度一与 `12/3/1` 路由上限、ProductSupervisor 总控、Supervisor Journal 作为新执行 authority。

替代决策见 [ADR-007](ADR-007-unified-auto-workflow.md)。
