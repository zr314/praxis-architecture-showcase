# 架构决策记录 / Architecture Decision Records

这些 ADR 记录约束 Praxis 公共协议和本地 Runtime 架构的 `v0.1` 决策。后续决策可以替代
ADR，但必须明确指出被替代的记录及原因。

These ADRs record the v0.1 decisions that constrain Praxis's public protocol
and local Runtime architecture. A later decision may supersede an ADR, but must
state which record it replaces and why.

ADR 解释“为什么长期采用某个方向”，不负责声明某项功能是否已经向普通用户开放。判断当前能力时，
以[项目状态](../project-status.md)为准；理解当前代码组合时，再阅读[架构](../architecture.md)。特别是
ADR-006 已被 ADR-007 取代。当前产品统一使用默认 `auto` Workflow；旧 `direct/supervisor` 只作迁移别名。

ADRs explain durable decisions, not product availability. Use
[Project Status](../project-status.md) for the shipping boundary.

- [ADR-001：独立本地 Runtime 进程 / Independent Local Runtime Process](ADR-001-independent-runtime-process.md)
- [ADR-002：基于 Stdio 的 NDJSON JSON-RPC 风格协议 / NDJSON JSON-RPC-Style Stdio Protocol](ADR-002-ndjson-json-rpc-stdio.md)
- [ADR-003：TypeScript 优先 Runtime / TypeScript-First Runtime](ADR-003-typescript-first-runtime.md)
- [ADR-004：先用 JSONL 会话存储，再评估 SQLite / JSONL Session Store Before SQLite](ADR-004-jsonl-before-sqlite.md)
- [ADR-005：Kimi API 与 API Key 认证 / Kimi API with API-Key Authentication](ADR-005-kimi-api-key-auth.md)
- [ADR-006：Supervisor 与 Subagent 执行边界 / Supervisor and Subagent Execution Boundaries](ADR-006-supervisor-subagent-boundaries.md)
- [ADR-007：统一 Auto Workflow 与多 Agent](ADR-007-unified-auto-workflow.md)
