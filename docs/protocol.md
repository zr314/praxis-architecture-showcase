# Runtime Protocol v1

Praxis CLI 与 Runtime 通过 stdin/stdout 上的 NDJSON JSON-RPC 2.0 通信。每行一个完整 JSON 对象；stdout 不允许混入日志。协议常量、TypeScript 类型和 JSON Schema 位于 `packages/protocol`。

## 初始化

客户端先发送 `initialize`，声明 protocol version、client 与 capabilities，再调用 `events.subscribe`。版本不兼容必须 fail closed。

## Session

主要方法：`session.create/list/search/inspect/resume/configure/close/delete/export/transcript/fork/branch/compact/plan/prompt/follow_up/steer/abort`。

`session.create.plannerMode` 接受 `auto|solo|workflow`；`direct|supervisor` 是兼容输入，Runtime 持久化归一化后的新值。省略时默认 `auto`。

`session.plan` 是兼容查询，返回该 Session 最新 Workflow projection 和 `plannerGeneration: null`。它不返回 CompactPlan，也不触发一次新的 Planner 调用。

## Workflow

当前方法：

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `workflow.get` | `workflowId` | `WorkflowUpdateV1` |
| `workflow.list` | 可选 `sessionId` | projection 数组，最近更新优先 |
| `workflow.events` | `workflowId`、可选 `afterSequence` | 持久事件数组 |
| `workflow.signal` | `signalId/workflowId/name/payload` | `{accepted}`；相同 signalId 去重 |
| `workflow.pause/resume` | `workflowId` | 更新后的 `WorkflowUpdateV1` |
| `workflow.cancel/terminate` | `workflowId`、可选 `reason` | 幂等终态 projection |
| `workflow.human-tasks.list` | `workflowId`、可选 `state` | HumanTask 数组 |
| `workflow.human-task.resolve` | `humanTaskId/decision/resolution` | 已决议 HumanTask |
| `workflow.retry-node` | `workflowId/nodeId` | 新 Attempt 的 projection；只接受可重试 failed 节点 |
| `workflow.resolve-unknown` | `workflowId/nodeId/resolution`、可选 `code` | 人工判定后的 projection |

`WorkflowUpdateV1` 包含 workflow/run/session ID、revision、sequence、state、topology、objective、节点列表和 terminalCode。客户端必须把 ID 分开，不要把 Session Run 与 Workflow Run 或 Attempt 混为一谈。

## 事件

订阅通知为：

```json
{"jsonrpc":"2.0","method":"event","params":{"subscriptionId":"...","sequence":1,"timestamp":"...","sessionId":"...","runId":"...","event":{}}}
```

常见 `SessionEvent`：prompt started/text/thinking、Tool planning/start/update/end、permission request、message committed、prompt terminal、runtime warning 和 `workflow_update`。

新产品路径只以 `workflow_update` 投影执行状态。`supervisor_update` 仍在 v1 Schema 中，用于旧 Session/客户端兼容，不应被新客户端当作当前 Planner authority。

## 错误

JSON-RPC error 和 terminal event 都带稳定 code。Provider 429/5xx、Workflow admission、Lease、persistence、permission 和 budget 错误不可由客户端根据自然语言推断。TUI 应显示 code，例如 `WORKFLOW_AGENT_BUDGET_EXHAUSTED`、`WORKFLOW_LEASE_LOST`、`WORKSPACE_BASE_STALE`。

## Schema

- `schemas/protocol-v1.schema.json`：顶层 union。
- `schemas/methods-v1.schema.json`：request/result。
- `schemas/events-v1.schema.json`：notification/event。
- `src/schema.ts`：AJV validation 与 method-result 映射。

新增 method 时必须同步 constants、types、JSON Schema、Runtime dispatch、Bridge 和测试；只改 TypeScript 类型不算完成。

## 安全边界

协议 params 全部视为不可信输入。路径、Provider、Plugin grant、Permission decision、Workflow signal 和 command arguments 在 Runtime 内再次校验。Child bootstrap 使用受限 method allowlist，不继承完整父协议面。

客户端实现指南见 [Protocol Client](protocol-client.md)。
