# ADR-001：独立本地 Runtime 进程 / Independent Local Runtime Process

状态 / Status: 已接受 / Accepted

## 中文

**背景：**终端 UI、Provider、本地工具、权限和会话状态具有不同生命周期。UI 崩溃不能定义
Runtime 数据模型，未来替换为 Rust Runtime 也不应要求重写 UI。

**决策：**Runtime 作为一个本地子进程运行。CLI 负责启动、监控、优雅关闭和终端渲染；
Runtime 负责会话、Provider 凭据、Tool 执行、权限与持久化。

**后果：**进程边界增加协议和生命周期工作，但获得稳定且语言无关的契约。`v0.1` 是一个
CLI 对应一个本地 Runtime，不提供 TCP Listener、远程客户端或多用户服务。

Status: Accepted

## Context

The terminal UI, Provider integration, local tools, permissions, and session
state have different lifecycles. A UI crash must not define the Runtime's data
model, and a future Rust Runtime must not require a UI rewrite.

## Decision

Praxis runs its Runtime as one local child process. The CLI owns process launch,
monitoring, graceful shutdown, and terminal rendering. The Runtime owns session
state, Provider credentials, tool execution, permissions, and persistence.

## Consequences

The process boundary adds protocol and lifecycle work, but preserves a stable
language-independent contract. v0.1 has one CLI connected to one local Runtime;
there is no TCP listener, remote client, or multi-user service.
