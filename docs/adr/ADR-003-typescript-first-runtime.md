# ADR-003：TypeScript 优先 Runtime / TypeScript-First Runtime

状态 / Status: `v0.1` 已接受 / Accepted for `v0.1`

## 中文

**背景：**项目已有 TypeScript CLI，近期目标是稳定 Agent、Tool、Session 与协议行为，而
不是优先优化 Native 性能或发布嵌入式 Library。

**决策：**`v0.1` Runtime 使用 Node.js 22.13+ 的 TypeScript 实现，同时保持进程和协议语言
无关，使未来 Rust Runtime 可以在不改变 CLI 契约的前提下替换实现。

**后果：**项目复用同一语言和测试工具并提高迭代速度。只有 Profiling 或发行需求证明必要
时才重新评估 Rust；它不是 Provider、Session、Permission 或 Tool 工作的前置条件。

Status: Accepted for v0.1

## Context

The project is a learning tool with an existing TypeScript CLI. The immediate
goal is to stabilize agent, tool, session, and protocol behavior rather than
optimize native performance or publish an embeddable library.

## Decision

Implement the v0.1 Runtime in TypeScript on Node.js 22.13 or later. Keep the
Runtime process boundary and protocol language-neutral so a future Rust Runtime
can replace this implementation without changing the CLI contract.

## Consequences

The project gains one language, shared test tooling, and faster iteration. Rust
is deferred until profiling or distribution requirements demonstrate a concrete
need; it is not a prerequisite for Provider, session, permission, or tool work.
