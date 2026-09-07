# Agent SDK 教程 / Agent SDK Tutorial

`@praxis/client` 现在同时提供两层 API。新手术语见 [Runtime 名词表](runtime-glossary.md)：

- `PraxisClient`：Runtime NDJSON 协议、事件 Sequence、replay 和 Session 控制；
- `defineAgent`：面向应用的 `run / stream / resume / abort`、typed state/output 和 middleware。

Agent SDK 不复制 Runtime。Session、权限、Tool、Workflow、持久化与模型调用仍由独立 Praxis Runtime
负责，SDK 只提供适合嵌入应用的编程模型。

## 定义并运行 Agent

先按[协议客户端教程](protocol-client.md)创建一个 `PraxisClient`，然后把它交给 `defineAgent`：

```ts
import { defineAgent, PraxisClient } from '@praxis/client'
import { RuntimeProtocolConnection } from '@praxis/runtime/process'

const client = new PraxisClient(
  async () =>
    new RuntimeProtocolConnection(process.execPath, [
      '/absolute/path/to/@praxis/runtime/dist/entry.js',
    ]),
)

const reviewer = defineAgent({
  client,
  name: 'change-reviewer',
  instructions: [
    'Review the requested code change.',
    'Return JSON with summary, risks, and recommendedTests.',
  ].join('\n'),
  cwd: process.cwd(),
  provider: 'openai',
  model: 'gpt-5.4',
  plannerMode: 'auto',
  initialState: () => ({ reviewCount: 0 }),
  parseOutput: (text) => JSON.parse(text) as {
    summary: string
    risks: string[]
    recommendedTests: string[]
  },
})

const result = await reviewer.run('Review the current working tree.')

if (result.status === 'completed') {
  console.log(result.output)
} else {
  console.error(result.status, result.error)
}
```

需要强制 Plan + Review 时，传入受信 Run policy：

默认省略 policy（optional）使用[轻量 Working Plan](working-plan.md)：计划可编辑、进度可自报、Review 按需咨询，不自动成为执行门槛。下面的 required 示例才保留严格验收；不能再把普通 `plan.create` 等同于开启该模式。

```ts
const result = await reviewer.run({
  input: 'Implement and verify the change.',
  planPolicy: 'required',
})

if (result.status === 'blocked') {
  console.error(result.error?.code, result.error?.message)
  // 外部条件修复后，可在同一 Session follow-up。
}
```

`instructions` 作为当前 Run 的 host-application instructions 进入 Runtime Trusted Instructions，
但始终低于 Runtime policy、权限和用户请求。它不是拼接到用户 Prompt 的低信任文本。恢复同一 Session
时，SDK 会在每次 follow-up 重新声明同一 Agent 配置，所以配置不会依赖客户端进程内的历史状态。

## 流式事件和取消

`stream()` 返回 `AsyncGenerator<SessionEvent, AgentRunResult>`。普通 `for await` 消费事件；如果需要
最终结构化结果，使用 `run()`，或者手动读取 Generator 的 terminal return value。

```ts
const controller = new AbortController()

for await (const event of reviewer.stream({
  input: 'Inspect the repository.',
  signal: controller.signal,
})) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
  if (event.type === 'prompt_started') {
    console.log('run:', event.runId)
  }
}

// controller.abort() 会在 runId 可用后调用 session.abort。
// 已知 runId 时也可以直接调用：
await reviewer.abort('r-known-run-id')
```

Runtime 终态 `prompt_completed / prompt_failed / prompt_blocked / prompt_aborted` 分别映射为
`completed / failed / blocked / aborted`。`blocked` 是可恢复非成功，不会执行 `parseOutput`。业务失败以 `AgentRunResult.status` 返回；transport、middleware 和
`parseOutput` 错误会 reject Promise。

## 恢复 Session

```ts
const existing = await reviewer.resume('s-existing-session')
const result = await existing.run('Continue from the saved context.')

console.log(existing.sessionId, result.status)
```

恢复调用使用 Runtime 的 `session.resume`，后续输入使用 `session.follow_up`，不会在 SDK 中伪造或重放
Transcript。

## Middleware

Middleware 用于应用级输入、状态、权限和结果策略：

```ts
const agent = defineAgent({
  client,
  cwd: process.cwd(),
  initialState: () => ({ attempts: 0 }),
  middleware: [
    {
      name: 'application-policy',
      beforeRun(context) {
        return {
          state: { attempts: context.state.attempts + 1 },
          metadata: { requestStartedAt: Date.now() },
        }
      },
      onPermissionRequest(_context, event) {
        if (event.risk === 'low' && event.tool === 'read') {
          return { type: 'allow_once' }
        }
        return { type: 'deny', reason: 'Application policy denied this Tool.' }
      },
      onEvent(_context, event) {
        observe(event)
      },
      afterRun(_context, result) {
        return result
      },
      onError(_context, error) {
        report(error)
      },
    },
  ],
})
```

执行顺序是：`beforeRun` 正序、`onEvent/onPermissionRequest` 正序、`afterRun/onError` 逆序。
第一个返回 `PermissionDecision` 的 middleware 拥有该次权限决策；没有 middleware 决策时，事件仍会
交给调用方，由 UI 或其他客户端逻辑调用 `decidePermission`。

`state` 当前是一次 SDK Run 的 typed host state，不会自动写入 Runtime Session。需要跨进程或跨请求
持久化时，应由应用存储，并在下一次 `run()` 通过 `state` 传回。Runtime 内部的 Session memory、
checkpoint 和 Workflow state 是另一层合同。

## 并发 Run

`PraxisClient` 使用一个后台通知泵，并按 `runId` 把交错事件路由到独立的有界队列。因此多个 Agent Run 可以共享
同一个连接：

```ts
const [review, tests] = await Promise.all([
  reviewer.run('Review the current changes.'),
  reviewer.run('Recommend focused tests.'),
])
```

请求返回 `runId` 前到达的事件会进入短期 backlog，避免快速 Runtime 造成 `prompt_started` 或终态丢失。每个消费者
默认最多缓冲 4,096 个事件；可通过 `new PraxisClient(factory, { eventBufferCapacity })` 调整。慢消费者超限只终止自己的流并抛出
`EventBufferOverflowError`，不会让其他 Run 竞争通知迭代器。

自定义 `AgentClient` 必须显式声明 `supportsConcurrentRuns: true`，Agent SDK 才会并发使用它；未声明的旧实现仍使用
`AgentClientBusyError` fail-fast，防止把不具备 multiplexer 的连接误当成并发安全。

## 当前未承诺的能力

- 应用 middleware 与 Runtime middleware 是两层合同；进程内模型/Tool 拦截见
  [Runtime Middleware](runtime-middleware.md)；
- `state` 尚无 reducer、共享 blackboard 或长期语义 memory；
- SDK 不负责启动远程多租户服务、认证终端用户或部署 Runtime；
- `instructions` 不允许扩大 Tool、凭证、网络、工作区或 Workflow 权限。

这些边界使第一版 SDK 可以稳定建立在现有 Runtime 权威上，而不产生第二套 Agent 执行语义。
