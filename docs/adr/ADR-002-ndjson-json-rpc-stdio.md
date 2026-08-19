# ADR-002：基于 Stdio 的 NDJSON JSON-RPC 风格协议 / NDJSON JSON-RPC-Style Stdio Protocol

状态 / Status: 已接受 / Accepted

## 中文

**背景：**本地进程边界需要 Streaming、Request Correlation 与 Cancellation，同时要在
Windows/Linux 上易于调试且不开放端口。

**决策：**在 stdin/stdout 上传输 UTF-8 NDJSON。每行是 JSON-RPC 风格的 Request、
Result、Error 或 `event` Notification。stdout 仅用于协议，诊断写入 stderr。Request
使用连接内唯一字符串 ID，每个 Subscription 的 Event Sequence 严格递增。

**后果：**Bridge 必须处理 Buffer、协议损坏、Response Race、子进程退出和 Backpressure。
`schemas/` 定义合法 Wire Fixture；引入代码生成前，应用 TypeScript 类型仍手工维护。

Status: Accepted

## Context

The local process boundary needs streaming, request correlation, cancellation,
and a format that is debuggable on Windows and Linux without opening a port.

## Decision

Use UTF-8 NDJSON over stdin/stdout. Each line is a JSON-RPC-style request,
result, error, or `event` notification. stdout is protocol-only; diagnostics go
to stderr. Requests use connection-unique string IDs, while every subscription
has a strictly increasing event sequence.

## Consequences

The Bridge must handle buffering, protocol corruption, response races, child
exit, and backpressure. The protocol schemas in `schemas/` define valid wire
fixtures; application TypeScript types remain hand-maintained until generation
is introduced.
