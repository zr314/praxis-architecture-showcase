# Session、存储与 Prompt 源码导航

English summary: one conversation authority, separate execution facts, and bounded model views.

SessionJournalV3 通过 JSONL 或 SQLite 实现同一领域合同，一次运行不双写。JSONL 的 Catalog/Projection 是快速启动视图；完整重放在 doctor --deep 等显式校验中执行。Workflow SQLite 保存 Task/Lease/effect，不是第三种聊天后端。

| 源码域 | 阅读重点 |
| --- | --- |
| session-db/ | V3 repository、JSONL/SQLite、迁移、查询和恢复 |
| session/ | SessionService、RunCoordinator 和运行状态 |
| packages/core-sdk/src/session-journal.ts | 消息、checkpoint、Working Plan 和严格 Plan 的事件归约 |
| prompt/promptRegistry.ts | 默认 iron-law-lean-v1、版本和共享预算 |
| prompt/systemPromptComposer.ts | 指令、运行事实、Skill 和项目指导 |
| prompt/promptAssembler.ts | pinned/dynamic context、窗口、发送视图、manifest |
| memory/compactionService.ts | 安全切分、semantic checkpoint、native 附加状态 |
| memory/providerCompactionSummaryGenerator.ts | 隔离摘要请求和字段来源合并 |

Runtime 路径相对 apps/runtime/src。Working Plan 和审查引用保存在 Session Journal；独立 Reviewer 调用另有 SQLite ReviewCallStore。普通计划不是 Workflow authority。

SessionMemory 是会话内上下文，不是跨 Session 长期记忆。AGENTS.md/PRAXIS.md、Artifact、checkpoint 各有作用，不能因都在磁盘上就合称“自动学习”。

本地跨 Session 的 MemoryService、memory.* 工具和显式授权已经独立接线，见[当前合同](../../../docs/long-term-memory.md)；自动提炼等后续工作见[路线图](../../../docs/long-term-memory-roadmap.md)。

当前规则统一见[Session 恢复](../../../docs/session-recovery.md)、[Working Plan](../../../docs/working-plan.md)、[Prompt 装配](../../../docs/prompt-assembly.md)和[模型请求目录](../../../docs/model-request-catalog.md)。
