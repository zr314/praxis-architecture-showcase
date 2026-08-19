# ADR-004：先用 JSONL 会话存储，再评估 SQLite / JSONL Session Store Before SQLite

状态 / Status: Phase 2 已接受；产品存储选择已由 ADR-006 的 V3 单权威规则接替 / Accepted for Phase 2; product selection is superseded by ADR-006's V3 single-authority rule

## 中文

**背景：**会话恢复首先需要 Crash-safe 的已提交消息，而不是复杂查询、并发或迁移。过早
引入 SQLite 会在消息 Commit Boundary 尚未验证时扩大实现面。

**决策：**Phase 2 使用原子 JSON 文件保存 Session Catalog，每个 Session 使用 JSONL
保存已提交 Conversation Entry；需要时通过临时文件与原子替换写入。未完成 Run 的 Delta
绝不视为已提交 Assistant Message。

**后果：**首个持久化实现便携、可检查。只有真实需求证明 Session Search、Concurrent
Writer 或 Migration Cost 后才重新评估 SQLite。

**当前结果（2026-08-04）：**这项阶段性决策已经达到目的。产品现使用 V3 Journal，仍默认 JSONL，
但可显式选择符合相同合同的 SQLite，并通过离线校验迁移切换单一 Authority。旧 v2 JSONL 只作为迁移
来源；禁止 JSONL/SQLite 双写。

Status: Accepted for Phase 2; superseded for current product selection by ADR-006.

## Context

Session recovery needs crash-safe committed messages before it needs complex
querying, concurrency, or migrations. Introducing SQLite now would increase the
surface area before the message commit boundary is proven.

## Decision

Phase 2 will store the session catalog in atomic JSON files and committed
conversation entries in per-session JSONL files. Writes use a temporary file
and atomic replacement where required. Incomplete Run deltas are never treated
as committed assistant messages.

## Consequences

The first persistence implementation remains portable and inspectable. SQLite
is reconsidered only when session search, concurrent writers, or migration cost
is demonstrated by an actual use case.

As of 2026-08-04, product sessions use V3 with JSONL as the default and SQLite
as an explicit contract-equivalent authority. Verified offline migration
switches the single authority; dual writes are forbidden. Legacy v2 JSONL is
only a migration source.
