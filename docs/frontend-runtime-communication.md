# 前端与 Runtime 后端通信完整手册

本文描述当前 Praxis CLI/TUI、`@praxis/client` 与 Runtime 后端之间已经规定好的公开通信合同。这里的“前端”指 CLI、TUI 或嵌入式宿主应用；“后端”指独立 `praxis-runtime` 进程。English summary: this is the complete public frontend-to-Runtime protocol v1 reference: 61 RPC methods, 21 event kinds, envelopes, ordering, replay, errors, and frontend consumption rules.

如果只想理解一次对话，先读[第 3 节](#3-一次-prompt-怎样通信)；开发客户端时必须同时阅读方法表、事件表和重连规则。术语见 [Runtime 名词表](runtime-glossary.md)。

## 1. 哪些通信属于本文

公开前后端链路是：

```text
CLI / TUI / host application
        │ RuntimeBridge 或 PraxisClient
        │ stdin:  NDJSON JSON-RPC request
        │ stdout: NDJSON response / event notification
        │ stderr: 人类诊断，不属于协议
        ▼
praxis-runtime process
```

本文不把以下内部链路混进来：Provider HTTP/SSE、Child bootstrap fd、父子 credential/MCP IPC、Workflow Authority HTTP、Plugin/MCP stdio。它们是后端内部协议，不是 UI 可以直接依赖的前后端 API。

权威来源按优先级为：

1. `packages/protocol/schemas/*.schema.json`：线上 JSON 是否合法；
2. `packages/protocol/src/schema.ts`：每个 method 对应哪一种 result；
3. `packages/protocol/src/constants.ts`：61 个 method 和 21 个 event 的闭集；
4. `apps/runtime/src/framework/runtimeKernel.ts`：后端 dispatch 与语义；
5. `packages/client`、`apps/cli/src/bridge`：客户端重连和便捷封装。

TypeScript 类型只是开发体验；类型与 JSON Schema 冲突时，应修复实现，不能绕过 Schema。

## 2. 线上的四种 JSON

传输是 UTF-8 NDJSON：一行一个完整 JSON 对象，以换行结束。Runtime stdout 只能写协议 JSON；日志只能写 stderr。CLI 的进程连接默认拒绝超过 256 KiB 的单行 Runtime stdout，内部配置允许的硬范围是 1 KiB 到 4 MiB。

### 2.1 请求 request

```json
{
  "jsonrpc": "2.0",
  "id": "17",
  "method": "session.inspect",
  "params": { "sessionId": "ses_123" }
}
```

- `jsonrpc` 固定为 `"2.0"`。
- `id` 是非空字符串，在同一连接的未完成请求中必须唯一；用于匹配响应，不等于 `runId`。
- `method` 必须是第 5 节的 61 个值之一。
- `params` 始终存在并且是对象；无参数方法发送 `{}`。
- 请求通常 `additionalProperties:false`，未知字段直接失败。

客户端没有发送 JSON-RPC notification 的公开入口；所有前端动作都是带 `id` 的 request。

### 2.2 成功响应 success

```json
{
  "jsonrpc": "2.0",
  "id": "17",
  "result": { "sessionId": "ses_123", "state": "idle" }
}
```

`id` 必须对应原请求。客户端不仅验证顶层 JSON，还根据原 `method` 验证 result 类型；例如 `session.inspect` 不能返回合法但属于 `models.list` 的结构。

### 2.3 失败响应 failure

```json
{
  "jsonrpc": "2.0",
  "id": "17",
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session not found.",
    "data": { "sessionId": "ses_123" },
    "retryable": false
  }
}
```

`error.code` 和 `error.message` 必有；`data`、`retryable` 可选。前端应按 `code` 和 `retryable` 决策，不能解析英文 message 猜语义。RPC failure 表示某个方法没被接受或没完成；它不同于已经启动 Run 后出现的 `prompt_failed`。

### 2.4 服务端事件 notification

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "subscriptionId": "sub-1",
    "sequence": 42,
    "timestamp": "2026-09-02T12:00:00.000Z",
    "sessionId": "ses_123",
    "runId": "run_456",
    "event": { "type": "text_delta", "runId": "run_456", "text": "完成" }
  }
}
```

notification 没有 `id`。`subscriptionId/sequence/timestamp/event` 必有，外层 `sessionId/runId` 可选；具体 event 自己也可能带 `runId`。客户端只消费当前 subscriptionId，并要求 sequence 严格连续。

## 3. 一次 Prompt 怎样通信

正常顺序：

```text
initialize request → initialize result
events.subscribe   → subscription result
session.create     → SessionInfo
session.prompt     → {runId, accepted:true}
                         │
                         ├─ prompt_started
                         ├─ thinking_delta / text_delta
                         ├─ tool_planning
                         ├─ permission_request ── permission.decide → {accepted:true}
                         ├─ tool_start / tool_update / tool_end
                         ├─ message_committed
                         └─ 恰好一个 Prompt 终态
```

Prompt 的四种终态是：

| event              | 是否成功 | 能否 follow-up         | 常见前端处理                   |
| ------------------ | -------- | ---------------------- | ------------------------------ |
| `prompt_completed` | 是       | 是                     | 显示最终文本和 usage           |
| `prompt_failed`    | 否       | 视 code                | 显示 code，非交互退出码 1      |
| `prompt_blocked`   | 否       | 是，`recoverable:true` | 显示阻塞原因，非交互退出码 2   |
| `prompt_aborted`   | 否       | 是                     | 显示中止原因，非交互退出码 130 |

`session.prompt` 的 RPC result 只是“Run 已接受”，不是任务完成。前端必须继续读取同一 `runId` 的事件，直到四种终态之一。

### 3.1 权限往返

Runtime 发出 `permission_request` 后暂停对应 Tool。前端使用事件里的 `requestId` 调：

```json
{
  "jsonrpc": "2.0",
  "id": "21",
  "method": "permission.decide",
  "params": { "requestId": "perm_1", "decision": { "type": "allow_once" } }
}
```

decision 只能是：

```json
{"type":"allow_once"}
{"type":"allow_always"}
{"type":"deny","reason":"可选说明"}
```

`allow_always` 会建立 Runtime 规则；它不是“这一次同意”的别名。未知、已处理或过期 requestId 会失败。

### 3.2 Steer 与 Abort

- `session.steer` 接受 `{sessionId,runId,text}`，成功返回 `{accepted:true,applyAt:"next_safe_boundary"}`，随后可看到 `steer_queued` 和 `steer_applied`。
- `session.abort` 接受必填 `runId`，可选 `sessionId/reason`，返回 `{accepted:true}`；最终仍以 `prompt_aborted` 事件为准。

## 4. 握手、订阅、顺序和重连

### 4.1 initialize

首个方法必须是 `initialize`：

```json
{
  "protocolVersion": 1,
  "supportedProtocolVersions": [1],
  "client": { "name": "praxis-cli", "version": "0.2.0" },
  "capabilities": {
    "interactivePermissions": true,
    "outputFormats": ["text", "json", "stream-json"]
  }
}
```

后端返回选中的 protocolVersion、Runtime 名称/版本/runtimeId，以及 `steer/eventReplay/traceExport/providerContractVersion/eventStreamVersion/providers/tools` capability。当前只支持协议 v1；不兼容返回 `PROTOCOL_VERSION_UNSUPPORTED`。

### 4.2 events.subscribe

```json
{ "sessionId": null, "fromSequence": null }
```

- `sessionId` 必须显式提供，可为字符串或 `null`。当前 v1 Runtime 保留这个字段但尚不做服务端过滤；官方客户端订阅全局流，因此发送 `null`。前端不能把字符串值误认为已经获得 Session 隔离流。
- `fromSequence` 必须显式提供，可为正整数或 `null`。
- 结果是 `{subscriptionId,nextSequence,replaySupported}`。
- Runtime 内存中保留最近 2,048 个事件。请求早于最老事件返回 `EVENT_REPLAY_EXPIRED` 和 `data.oldestSequence`。

### 4.3 sequence 规则

sequence 是 Runtime epoch 内的全局递增序号，不是每 Session 或每 Run 重新从 1 开始。客户端发现缺口、倒序或重复时 fail closed，不能静默跳过，否则可能漏掉权限请求或终态。

### 4.4 重连规则

官方 `PraxisClient` 默认最多重连一次：

- 同一个 `runtimeId`：用 `lastSequence + 1` 重新订阅并要求 replay；
- 新 `runtimeId`：视为新 epoch，从当前流开始，活动 Run 必须从 durable Session 恢复；
- event sequence gap：直接失败，不用重连掩盖；
- 普通 RPC 只自动重试客户端白名单内的只读/幂等读取；写请求不自动重发；
- 每个事件消费者默认有 4,096 项有界缓冲，慢消费者溢出时只失败该消费者。

当前自动重试白名单为：`auth.status`、`models.list`、`settings.get`、`runtime.doctor`、`plugin.list/inspect/permissions/doctor`、`session.list/search/inspect/resume/export/transcript/branch/plan`、`artifacts.list`、`trace.export`。这里的“可重试”是客户端实现属性，不代表业务对象完全不变。

## 5. 全部 61 个 RPC 方法

记号：`?` 表示可选；`{}` 表示必须发送空对象；`T[]` 表示数组。所有字段的长度、枚举、嵌套结构和 `additionalProperties` 仍以 JSON Schema 为准。

### 5.1 连接、认证、模型、设置、诊断与命令（11）

| method               | params                                                                                                                  | result                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `initialize`         | `protocolVersion, supportedProtocolVersions?, client{name,version}, capabilities{interactivePermissions,outputFormats}` | `InitializeResult`         |
| `events.subscribe`   | `sessionId`（string 或 null），`fromSequence`（integer 或 null）                                                         | `{subscriptionId,nextSequence,replaySupported}` |
| `auth.status`        | `provider`                                                                                                              | `AuthInfo`                 |
| `auth.login`         | `provider, mode:api_key\|browser, apiKey?`                                                                              | `{loginId}`                |
| `auth.logout`        | `provider`                                                                                                              | `{ok:true}`                |
| `models.list`        | `provider?`                                                                                                             | `ModelInfo[]`              |
| `settings.get`       | `{}`                                                                                                                    | `UserSettingsInfo`         |
| `settings.model.set` | `provider, model`                                                                                                       | `UserSettingsInfo`         |
| `runtime.doctor`     | `workspace?, deep?`                                                                                                     | `DoctorResult`             |
| `memory.manage`      | `workspace, action`；scope、mode、userAccess、id、query、limit、afterId、operationId、expectedRevision、memory/memories 按操作使用 | 项目配置、记忆记录/数组、写入回执或分页导出；详见[长期记忆](long-term-memory.md) |
| `commands.list`      | `workspace`                                                                                                             | `CommandCatalogSnapshotV1` |
| `commands.invoke`    | `schemaVersion, workspace, catalogSnapshotDigest, capabilityDigest, invocation, sessionId?`                             | `CommandInvokeResultV1`    |

`commands.invoke.invocation` 必须包含 `schemaVersion/invocationId/clientRequestId/descriptorId/descriptorDigest/command/arguments`，可带 `body`；digest 把调用绑定到刚取得的 catalog/capability snapshot。

### 5.2 Plugin（10）

| method               | params                        | result                 |
| -------------------- | ----------------------------- | ---------------------- |
| `plugin.install`     | `source`                      | `PluginStatus`         |
| `plugin.list`        | `workspace?`                  | `PluginStatus[]`       |
| `plugin.inspect`     | `id, version?`                | `PluginInspection`     |
| `plugin.enable`      | `workspace,id,version,grants` | `PluginStatus`         |
| `plugin.disable`     | `workspace,id`                | `{ok:true}`            |
| `plugin.permissions` | `workspace,id`                | `{requested,approved}` |
| `plugin.doctor`      | `{}`                          | `PluginDoctorEntry[]`  |
| `plugin.update`      | `workspace,source,grants`     | `PluginStatus`         |
| `plugin.rollback`    | `workspace,id`                | `PluginStatus`         |
| `plugin.uninstall`   | `id,version`                  | `{ok:true}`            |

grant 是闭合 union：filesystem `{type,access:read|write,paths}`、network `{type,hosts}`、environment `{type,names}`、process `{type,commands}`、resource `{type,cpuMs?,memoryMb?,processCount?}`。

### 5.3 Resource（4）

| method             | params                         | result           |
| ------------------ | ------------------------------ | ---------------- |
| `resource.list`    | `workspace`                    | `ResourceInfo[]` |
| `resource.inspect` | `workspace,id,includeContent?` | `ResourceInfo`   |
| `resource.enable`  | `workspace,id,projectTrusted?` | `ResourceInfo`   |
| `resource.disable` | `workspace,id`                 | `{ok:true}`      |

Resource kind 为 `skill|template|theme`；返回值还包含 provenance、metadata、enabled、collision，可选 content。

### 5.4 Session 查询与生命周期（15）

| method               | params                                                                                       | result                               |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `session.create`     | `cwd, plannerMode?, provider?, model?, name?, labels?, contextLimitTokens?, permissionMode?` | `SessionInfo`                        |
| `session.list`       | `{}`                                                                                         | `SessionInfo[]`                      |
| `session.search`     | `query`                                                                                      | `SessionInfo[]`                      |
| `session.inspect`    | `sessionId`                                                                                  | `SessionInfo`                        |
| `session.resume`     | `sessionId`                                                                                  | `SessionInfo`                        |
| `session.rename`     | `sessionId,name`                                                                             | `SessionInfo`                        |
| `session.configure`  | `sessionId,provider,model`                                                                   | `SessionInfo`                        |
| `session.close`      | `sessionId`                                                                                  | `{ok:true}`                          |
| `session.delete`     | `sessionId`                                                                                  | `{trashPath}`                        |
| `session.export`     | `sessionId`                                                                                  | `SessionExportResult`                |
| `session.transcript` | `sessionId,limit,before?`                                                                    | `SessionTranscriptResult`            |
| `session.fork`       | `sessionId,name?,throughMessage?`                                                            | `SessionInfo`                        |
| `session.branch`     | `sessionId`                                                                                  | `SessionInfo`                        |
| `session.compact`    | `sessionId`                                                                                  | `{compacted,checkpointId?}`          |
| `session.plan`       | `sessionId`                                                                                  | `{sessionId,plan,plannerGeneration,planPolicy,workingReviews,strictReviewPlan}` |

`session.transcript.limit` 为 1..500。`plannerMode` 接受 `auto|solo|workflow|direct|supervisor`，后两个是兼容别名。`SessionInfo.state` 为 `idle|running|closed`，并带 provider/model/cwd、可选 usage、父子 Session 和终态摘要。

### 5.5 Workflow 控制与观察（12）

| method                        | params                               | result                      |
| ----------------------------- | ------------------------------------ | --------------------------- |
| `workflow.get`                | `workflowId`                         | `WorkflowUpdateV1`          |
| `workflow.list`               | `sessionId?`                         | `WorkflowUpdateV1[]`        |
| `workflow.events`             | `workflowId,afterSequence?`          | durable event 数组          |
| `workflow.signal`             | `signalId,workflowId,name,payload`   | `{accepted:true}`           |
| `workflow.pause`              | `workflowId`                         | `WorkflowUpdateV1`          |
| `workflow.resume`             | `workflowId`                         | `WorkflowUpdateV1`          |
| `workflow.cancel`             | `workflowId,reason?`                 | `WorkflowUpdateV1`          |
| `workflow.terminate`          | `workflowId,reason?`                 | `WorkflowUpdateV1`          |
| `workflow.human-tasks.list`   | `workflowId,state?`                  | `WorkflowHumanTaskInfoV1[]` |
| `workflow.human-task.resolve` | `humanTaskId,decision,resolution`    | `WorkflowHumanTaskInfoV1`   |
| `workflow.retry-node`         | `workflowId,nodeId`                  | `WorkflowUpdateV1`          |
| `workflow.resolve-unknown`    | `workflowId,nodeId,resolution,code?` | `WorkflowUpdateV1`          |

HumanTask state 是 `waiting|allowed|denied|expired|cancelled`；resolve 的 decision 不能是 waiting。unknown resolution 是 `succeeded|failed|manual_intervention`。`workflow.signal.signalId` 是业务幂等键，不是 JSON-RPC id。

### 5.6 Run、Artifact、Trace、权限与关闭（8）

| method              | params                                                                                      | result                                    |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `artifacts.list`    | `{}`                                                                                        | `ArtifactInfo[]`                          |
| `session.prompt`    | `sessionId,text,clientRequestId,planPolicy?,commandInvocationId?,agent?,budget?,timeoutMs?` | `{runId,accepted:true}`                   |
| `session.follow_up` | 同 `session.prompt`                                                                         | `{runId,accepted:true}`                   |
| `session.steer`     | `sessionId,runId,text`                                                                      | `{accepted,applyAt:"next_safe_boundary"}` |
| `session.abort`     | `runId,sessionId?,reason?`                                                                  | `{accepted:true}`                         |
| `trace.export`      | `traceId,destination`                                                                       | `TraceExportResult`                       |
| `permission.decide` | `requestId,decision`                                                                        | `{accepted:true}`                         |
| `shutdown`          | `{}`                                                                                        | `{accepted:true}`                         |

`session.plan` 为持久状态的只读查询，optional 返回轻量清单、required 返回严格状态，缺少对应 Plan 时回退 Workflow projection。workingReviews 是咨询记录，strictReviewPlan 用于保留严格历史；不能把 accepted 标签当当前产物验收。新增字段仍由严格 Schema 声明，未知字段不自动放行。

Prompt 的 `planPolicy` 是 `optional|required`；`agent` 是 `{name?,instructions}`；`budget` 可含 `maxTurns/maxToolCalls/maxTokens`。`clientRequestId` 是 durable Run admission 幂等身份，不能每次网络重试都换一个新值。

## 6. 结果对象词典

| 类型                      | 主要字段                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AuthInfo`                | `status,provider,accountLabel?,credentialSource?,credentialVariable?,protection?`                          |
| `ModelInfo`               | `catalogVersion,provider,id,name,family,contextTokens?,outputTokens?,reasoningLevels,modalities,...`       |
| `UserSettingsInfo`        | `version:1`，`defaultModel` 为 `{provider,model}` 或 null                                                               |
| `DoctorResult`            | `ok,runtimeId,storeVersion,workspace?,providers,checks,middleware`                                         |
| `SessionInfo`             | `sessionId,state,cwd,provider,model` 加 planner、name、labels、usage、parent/leaf 等可选字段               |
| `SessionExportResult`     | `exportVersion,exportedAt,session,messages,memory`                                                         |
| `SessionTranscriptResult` | `sessionId,start,end,totalMessages,hasMore,messages`                                                       |
| `WorkflowUpdateV1`        | `workflowId,runId,sessionId,revision,sequence,state,topology,objective,nodes`，可带 parent 与 terminalCode |
| `ArtifactInfo`            | `artifactId,digest,mimeType,bytes,createdAt?`                                                              |
| `TraceExportResult`       | `traceId,path,recordCount,privacy`；privacy 明确列出包含/排除字段                                          |
| `PluginStatus`            | identity/version/digest/origin、grants、health、lifecycle、isolation、enabled、provenance                  |
| `ResourceInfo`            | identity/kind/path、provenance、metadata、enabled/collision、可选 content                                  |

命令 catalog/invoke 的完整嵌套类型来自 `@praxis/core-sdk`，Plugin manifest/grant 来自 `@praxis/plugin-protocol`；它们最终仍嵌入 methods Schema 做 wire validation。

## 7. 全部 21 个事件

下表中“字段”不重复列 `type`。

| event.type            | 必填字段                                | 可选字段                                                                 | 前端语义                                 |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `runtime_ready`       | `runtimeId`                             | —                                                                        | Runtime epoch 可用                       |
| `auth_login_action`   | `loginId,action`                        | `url,deviceCode`                                                         | 打开 URL 或展示设备码                    |
| `auth_status_changed` | `provider,status`                       | `accountLabel`                                                           | 刷新认证状态                             |
| `runtime_warning`     | `code,message`                          | —                                                                        | 非终态诊断                               |
| `prompt_started`      | `sessionId,runId,prompt`                | `promptKind`                                                             | Run 开始，promptKind 为 prompt/follow_up |
| `thinking_delta`      | `runId,text`                            | —                                                                        | 推理增量；不当作最终答案                 |
| `text_delta`          | `runId,text`                            | —                                                                        | Assistant 文本增量                       |
| `tool_planning`       | `runId,toolCallId,name,input`           | —                                                                        | Provider 已提出 Tool 调用                |
| `permission_request`  | `runId,requestId,toolCallId,tool,input` | `risk,target,rule,parentRunId,childRunId,childAgentRunId,childRequestId` | 等待前端决定                             |
| `tool_start`          | `runId,toolCallId,name,input`           | —                                                                        | Tool 真正开始                            |
| `tool_update`         | `runId,toolCallId,message`              | `stream,delta,bytes`                                                     | stdout/stderr 或普通进度                 |
| `tool_end`            | `runId,toolCallId,ok`                   | `summary,output,error`                                                   | Tool 终态                                |
| `steer_queued`        | `runId,steerId`                         | —                                                                        | steer 已排队                             |
| `steer_applied`       | `runId,steerId`                         | —                                                                        | steer 已进入下一安全边界                 |
| `message_committed`   | `runId,messageId`                       | `role`（user 或 assistant）                                              | 消息已经 durable，不等于 Run 完成       |
| `prompt_completed`    | `runId`                                 | `usage,stopReason`                                                       | 成功终态                                 |
| `prompt_failed`       | `runId,error`                           | `code,usage`                                                             | 失败终态                                 |
| `prompt_blocked`      | `runId,code,reason,recoverable:true`    | `usage`                                                                  | 可恢复的非成功终态                       |
| `prompt_aborted`      | `runId`                                 | `reason,usage`                                                           | 中止终态                                 |
| `supervisor_update`   | `update`                                | —                                                                        | v1 legacy Planner 兼容事件               |
| `workflow_update`     | `update`                                | `runId`                                                                  | 当前 Workflow projection 更新            |

`ToolError` 是 `{code,category,retryable}`，category 为 `validation|permission|not_found|execution|truncated`。`UsageSummary` 可含 turns、toolCalls、input/output/cache tokens、costUsd、subagents；缺失表示未知或不适用，不能当作 0。

## 8. 前端三层分别拿到什么

| 层                  | 面向对象             | 覆盖范围                                                                                    | 重要行为                                                                                |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Raw JSON-RPC        | 自己实现连接的集成方 | 全部 61 方法、21 事件                                                                       | 必须自行做 Schema、sequence、replay 和终态处理                                          |
| `PraxisClient`      | SDK 开发者           | create/resume/list/transcript、prompt/followUp、steer/abort、permission，加通用 `request()` | 校验 method-result、多 Run 分流、有界缓冲、一次重连                                     |
| CLI `RuntimeBridge` | TUI/CLI              | 大部分日常、Plugin、Resource、Session、Workflow 管理                                        | 把全局事件与 Run 队列分开；当前没有 `workflow.events/signal` 便捷方法，可走 Raw request |

TUI 会合并相邻 text/thinking/tool-update 增量以减少渲染量，隐藏 `message_committed` 等内部事件不等于协议丢弃；非交互 `stream-json` 会再包一层 `AutomationEnvelope {schemaVersion,sequence,kind,runId?,event}`，其中 kind 为 `start|delta|tool|permission|usage|terminal`。这个 AutomationEnvelope 是 CLI stdout 格式，不是 Runtime JSON-RPC wire。

## 9. 错误边界

连接/协议层常见 code：

- `NOT_INITIALIZED`：initialize 之前调用其他方法；
- `PROTOCOL_VERSION_UNSUPPORTED`：没有共同版本；
- `INVALID_PARAMS`：字段值虽到达 handler，但语义不合法；
- `METHOD_NOT_FOUND`：未知方法；
- `RUNTIME_SHUTTING_DOWN`：关闭期间拒绝新动作；
- `EVENT_REPLAY_EXPIRED`：请求的 sequence 已离开 2,048 项内存窗口；
- `CHILD_METHOD_NOT_ALLOWED`：受限 Child launch profile 禁止该方法。

业务 code 是开放字符串合同，例如 `SESSION_NOT_FOUND`、`RUN_NOT_ACTIVE`、`PERMISSION_REQUEST_NOT_FOUND`、`COMPACTION_BUSY`、`AUTH_REQUIRED`。新增稳定业务 code 不需要升级 JSON-RPC envelope；删除或改变既有 code 的语义需要兼容性评审。

以下情况是本地 transport error，不一定有 JSON-RPC error envelope：进程启动失败、stdin 写失败、请求超时、stdout 非法 UTF-8/JSON、stdout 单行过大、stdout 关闭、进程异常退出、event sequence gap、消费者缓冲溢出。发生这些错误后，不能假设写请求没在后端执行；用业务幂等键或 Session 状态恢复。

## 10. ID 不要混用

| ID                     | 作用                               |
| ---------------------- | ---------------------------------- |
| JSON-RPC `id`          | 一条连接上的 request/response 匹配 |
| `runtimeId`            | 判断是否还是同一 Runtime epoch     |
| `subscriptionId`       | 过滤当前事件订阅                   |
| `sequence`             | 检测事件缺失与 replay 起点         |
| `sessionId`            | durable 会话                       |
| `clientRequestId`      | Prompt/Run 准入幂等                |
| `runId`                | 一次前台 Prompt Run                |
| `messageId`            | durable transcript message         |
| `toolCallId`           | 一次模型 Tool call                 |
| permission `requestId` | 一次待审批动作                     |
| `steerId`              | 一次 steer 的 queued/applied 对应  |
| `workflowId/nodeId`    | 长时 Workflow 与节点               |
| `signalId`             | Workflow signal 去重身份           |
| `humanTaskId`          | 人工任务身份                       |
| `traceId/artifactId`   | 诊断与内容寻址结果                 |

## 11. 修改协议时必须同步什么

新增或修改 method：constants → TypeScript types → methods Schema → method-result map → Runtime dispatch → Raw/Bridge/SDK 暴露 → fixtures/tests → 本文。新增 event：constants → union type → events Schema → Runtime emitter → SDK terminal/routing 判断 → TUI/non-interactive renderer → tests → 本文。

自动合同测试会检查本文包含全部 61 个 method、21 个 event、四种 Prompt 终态和关键 envelope 字段。单独修改文档不能让协议生效；单独修改代码而不更新 Schema 也不能交付。

## 12. 源码入口

- Schema：`packages/protocol/schemas/protocol-v1.schema.json`、`methods-v1.schema.json`、`events-v1.schema.json`
- method/result 映射：`packages/protocol/src/schema.ts`
- 类型与 Bridge 接口：`packages/protocol/src/types.ts`
- 低层客户端：`packages/client/src/index.ts`
- CLI Bridge：`apps/cli/src/bridge/ndjsonBridge.ts`
- Runtime dispatch：`apps/runtime/src/framework/runtimeKernel.ts`
- 进程传输：`apps/runtime/src/process/ndjsonProcessConnection.ts`
- TUI 事件投影：`apps/cli/src/ui/eventState.ts`、`tuiModel.ts`
- 非交互输出：`apps/cli/src/render/nonInteractive.ts`
