# 协议客户端教程 / Protocol Client Tutorial

`@praxis/client` 是 Praxis Runtime v1 的类型化状态机，不是一个远程 HTTP SDK。它负责协议协商、
Schema 校验、事件 Sequence、同 Runtime 有界重连和常用 Session API；调用方仍需提供一个
`ProtocolConnection`，决定怎样启动/连接本地 Runtime。

如果你只是使用终端 Agent，不需要阅读本页。只有在编写 GUI、IDE 插件或另一个本地前端时才需要它。

## 先理解四层 / Understand the four layers

```text
你的 UI / automation
        |
        v
PraxisClient                 初始化、订阅、Session、Run、replay
        |
        v
ProtocolConnection           request()、notifications()、close()
        |
        v
本地 NDJSON transport         stdin/stdout 分帧、进程和超时
        |
        v
@praxis/runtime              唯一状态、授权与执行权威
```

仓库自己的 CLI 使用 `RuntimeProtocolConnection` 作为正式 Schema-aware transport，并在上面封装
`PraxisClient` 和 `NdjsonRuntimeBridge`。建议新客户端复用这条边界，不要再写一套 JSON codec、重连规则
或事件序列逻辑。

## 安装包 / Install packages

`@praxis/*` 当前只发布到项目私有 Verdaccio，不发布到 npmjs。有访问权时：

```sh
npm config set @praxis:registry http://127.0.0.1:4873/ --location=user
npm login --auth-type=legacy --registry http://127.0.0.1:4873/
npm install @praxis/client @praxis/protocol @praxis/runtime
```

在本 Monorepo 中开发则运行 `npm ci`，Workspace 会直接解析这些包。

## 第一步：提供连接工厂 / Provide a connection factory

客户端构造函数接收 `() => Promise<ProtocolConnection>`。进程型本地客户端可以使用 Runtime 导出的
正式 transport：

```ts
import { PraxisClient } from '@praxis/client'
import { RuntimeProtocolConnection } from '@praxis/runtime/process'

const runtimeCommand = process.execPath
const runtimeArgs = ['/absolute/path/to/@praxis/runtime/dist/entry.js']

const client = new PraxisClient(
  async () => new RuntimeProtocolConnection(runtimeCommand, runtimeArgs, {
    stderr: 'inherit',
  }),
  {
    reconnectAttempts: 1,
    client: { name: 'my-praxis-client', version: '0.1.0' },
    onRuntimeEpoch: ({ previousRuntimeId, runtimeId }) => {
      if (previousRuntimeId) {
        // 新 Runtime 不能继续旧进程中的活动 Run；从持久化 Session 重新加载 UI。
        console.warn(`Runtime restarted: ${previousRuntimeId} -> ${runtimeId}`)
      }
    },
  },
)
```

示例中的 Runtime Entry 路径必须由你的安装/打包方式明确提供，不能在库中猜测。Praxis CLI 自身需要同时
兼容源码 `tsx`、Node 构建产物和独立二进制，因此使用内部 `resolveLocalRuntimeLaunch()` 做启动选择。
应用开发者可以参考 [`apps/cli/src/bridge/localRuntime.ts`](../apps/cli/src/bridge/localRuntime.ts)，但不要
依赖未导出的 CLI 内部 API。

如果你提供自己的 Socket/IPC transport，它仍必须严格实现：

```ts
type ProtocolConnection = {
  request<T>(request: JsonRpcRequest): Promise<T>
  notifications(): AsyncIterable<EventNotification>
  close(): Promise<void>
}
```

自定义 Transport 不会把 Praxis 变成受支持的远程多用户服务；认证、租户隔离、背压和网络安全都不在
当前产品合同内。

## 第二步：连接并创建 Session / Connect and create a session

```ts
const initialized = await client.connect()
console.log(initialized.runtime.runtimeId)

const session = await client.createSession({
  cwd: process.cwd(),
  provider: 'mock',
  model: 'mock-v1',
  plannerMode: 'auto', // optional; Runtime default is auto
})

console.log(session.sessionId)
```

`connect()` 会自动发送 `initialize` 和 `events.subscribe`，并检查双方协议版本。不要在外层重复订阅。
第一次集成请始终使用 `mock/mock-v1`，确认 Session 和事件路径后再连接真实 Provider。
`plannerMode` 是 Session 元数据，不是单次 Prompt 参数；恢复现有 Session 时客户端应显示 Runtime 返回的
选择，不要用本地默认覆盖。若支持 Workflow UI，应先调用 `workflow.list/get` 恢复 projection，再渲染
实时 `workflow_update`；失败 Node 会携带 stable `errorCode`。不能把 Child progress 拼进父 assistant
transcript，也不要让模型根据自然语言猜测调度失败原因。

## 第三步：消费一次 Run / Consume one run

```ts
try {
  for await (const event of client.prompt({
    sessionId: session.sessionId,
    text: '请用一句话介绍这个工作区',
    budget: {
      maxTurns: 4,
      maxToolCalls: 8,
      maxTokens: 2_000,
    },
    timeoutMs: 60_000,
  })) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text)
        break
      case 'permission_request':
        // 新手客户端默认拒绝；实现 UI 后再让用户审阅精确目标。
        await client.decidePermission(event.requestId, {
          type: 'deny',
          reason: 'This client has no permission UI yet.',
        })
        break
      case 'prompt_completed':
      case 'prompt_failed':
      case 'prompt_aborted':
        console.log('\nterminal:', event.type, event.usage)
        break
    }
  }
} finally {
  await client.close()
}
```

`prompt()` 会先取得接受结果中的 `runId`，再过滤全局事件流，直到唯一终态。不要用“连接关闭”或“暂时
没有 Delta”推断成功。三个终态都可能包含 Runtime 生成的累计 `usage`；直接转发实际字段，不要按事件
数量补造 token、Tool 或 Subagent 用量。

## 第四步：恢复持久化 Transcript / Restore durable transcript

```ts
const sessions = await client.listSessions()
const selected = sessions[0]

if (selected) {
  const page = await client.transcriptSession(selected.sessionId, undefined, 200)
  render(page.messages)
  if (page.hasMore) showOlderMessagesButton()
}
```

`session.transcript` 使用排他 `before` Cursor，每页 1–500 条。普通 UI 应先读最新 200 条并明确提示更早
历史被省略；完整备份使用 `session.export`，不要为恢复界面加载整个 Export。

## 重连和 Runtime Epoch / Reconnection and epochs

Runtime 缓冲 2,048 个不含内容的事件 Envelope。同一个 `runtimeId` 重连时，`PraxisClient` 从下一个未见
Sequence 请求 Replay，即使断线前一个事件都没有收到也从 Sequence 1 开始。

以下情况必须区分：

- **传输短暂断开，同一 Runtime ID：**只读请求和事件流可在有界次数内重连并 Replay；
- **Sequence 缺口：**致命协议错误，不能跳过；
- **Runtime ID 变化：**新进程 Epoch；旧活动 Run Consumer 失效，从持久化 Session 重建界面；
- **mutation 请求响应丢失：**库不会自动重试非只读方法，以免重复副作用；Run 请求使用
  `clientRequestId` 由 Runtime 做幂等去重。

不要在外层无限重试。将 Runtime 重启、协议损坏和 Provider 失败显示成不同错误，用户才知道应该恢复
Session、修复 Transport，还是重新执行任务。

## 权限 UI 的最低要求 / Minimum permission UI

权限提示至少应显示 Runtime 提供的 Tool、canonical target、风险说明和有界 Preview。客户端只采集：

- `allow_once`：仅当前请求；
- `allow_always`：持久化 Runtime 推导出的精确 Rule；
- `deny`：拒绝。

客户端不能自行扩大 Rule，也不能把项目文本当作授权。由 child 上浮的 `permission_request` 会附带
parent/child 关联 ID，但仍复用普通 `permission.decide`；这些字段只用于显示和关联，不能扩大签名 Grant。

## 常见错误 / Common mistakes

| 错误 | 正确做法 |
| --- | --- |
| 自己发送 `initialize` 后又让 `PraxisClient.connect()` 初始化 | 只让 Client 状态机负责协商和订阅 |
| 将 stdout 日志与 NDJSON 混在一起 | Runtime stdout 只放协议，日志写 stderr |
| 收到一段文本就认定 Run 成功 | 等待 completed/failed/aborted 唯一终态 |
| 新 Runtime 继续消费旧活动 Run | 终止 Consumer，从持久化 Transcript 重建 |
| 自动批准所有权限 | 默认拒绝，做完明确的权限 UI 后再允许 |
| 无限重试 mutation | 保留 `clientRequestId`，遵循 Runtime 幂等合同 |
| 把本地 Server 当公网 API | 当前仅 Loopback、Token、单用户、每连接一个 Runtime child |

## 权威资料 / Sources of truth

- [Runtime 协议 v1](protocol.md)：生命周期、Method 和安全语义；
- [`packages/protocol/schemas`](../packages/protocol/schemas)：机器可读 Wire Schema；
- [`packages/client/src/index.ts`](../packages/client/src/index.ts)：Client 状态机；
- [`apps/cli/src/bridge`](../apps/cli/src/bridge)：产品客户端的组合方式；
- [兼容性策略](compatibility-policy.md)：Protocol/Schema 演进。

## English summary

`@praxis/client` is the typed state machine for the local Praxis Runtime v1
protocol. Supply a `ProtocolConnection`, let the client own initialization,
subscription, sequence validation, bounded same-Runtime replay, and Session
helpers, and consume each accepted Run through exactly one terminal event. A
new Runtime ID is a new epoch: invalidate active consumers and rebuild the UI
from bounded durable transcript pages. The package is transport-agnostic; it
does not turn the local single-user Runtime into a supported remote service.
