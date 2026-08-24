# Runtime Middleware

`@praxis/runtime/run` 提供可信、进程内的模型和 Tool 拦截面。它服务于 Runtime 宿主的策略、审计、缓存、
guardrail 与结果标准化，不通过模型或远程客户端配置，也不能扩大 Runtime 已授予的 Capability。

```ts
import {
  createRuntimeKernel,
  type RuntimeMiddleware,
} from '@praxis/runtime/run'

const audit: RuntimeMiddleware = {
  name: 'host-audit',
  beforeModel(context, request) {
    observeModelRequest(context, request)
    return {
      ...request,
      instructions: `${request.instructions}\nReturn concise evidence references.`,
    }
  },
  afterModel(context, result) {
    observeModelResult(context, result)
  },
  beforeTool(context) {
    const input = context.input as { path?: unknown }
    if (context.toolName === 'read' && input.path === 'legacy.txt') {
      return { input: { ...input, path: 'current.txt' } }
    }
  },
  afterTool(context, result) {
    observeToolResult(context, result)
    return result
  },
}

const runtime = createRuntimeKernel({
  middleware: [audit],
  middlewarePolicy: {
    hookTimeoutMs: 30_000,
    consecutiveFailureThreshold: 3,
    circuitCooldownMs: 30_000,
  },
})
runtime.start()
```

## 顺序和边界

| Hook | 顺序 | 执行位置 | 可返回内容 |
| --- | --- | --- | --- |
| `beforeModel` | 注册正序 | 每个逻辑模型回合、Provider Router 之前 | 更新后的 `ProviderRequest` |
| `afterModel` | 注册逆序 | Provider stream 完整校验并装配为一个 turn 后 | 只观察 |
| `beforeTool` | 注册正序 | Tool schema、prepare、权限和执行之前 | 新的 Tool `name/input` |
| `afterTool` | 注册逆序 | Tool 结果产生后、trace/event/Session commit 之前 | 更新后的 `ToolResult` |

`beforeTool` 的修改会重新经过 Tool 查找、schema 校验、target 解析和权限计算。因此 middleware 不能先批准旧目标，
再把调用改向新目标。`afterTool` 返回值会重新校验 `ToolResult` envelope；middleware 本身属于可信宿主代码，仍应避免
生成不符合 Tool output schema 的业务内容。

`beforeModel` 可以调整消息、instructions、Tool definitions、输出上限或 response format，但不能替换 Runtime 选定的
model 或 `AbortSignal`。Provider fallback 从更新后的逻辑请求派生；middleware context 中的 provider/model 表示本次
逻辑请求目标，不冒充最终 fallback 物理调用。

## 错误语义

Hook 抛错、返回非法 envelope、替换 model/signal，会产生
`RUNTIME_MIDDLEWARE_FAILED` / `configuration` 并 fail-closed；超过单 Hook deadline 会产生
`RUNTIME_MIDDLEWARE_TIMEOUT`。同一个 middleware 连续失败达到阈值后打开进程内熔断器，冷却期内以
`RUNTIME_MIDDLEWARE_CIRCUIT_OPEN` 拒绝调用；冷却结束只允许一个 half-open 探测，成功才关闭。错误只带稳定
middleware ID/名称和 hook 类型，不会把异常正文、请求或结果投影给远程客户端。

`context.signal` 始终是 Run 取消信号；`context.hookSignal` 是当前 Hook 的 deadline 信号。Hook 应把两者传给自身的
可取消 I/O。Runtime 会在 deadline 到达时停止等待并 fail-closed，但无法强制撤销不响应 `hookSignal` 的第三方代码已经
发出的外部副作用，因此有副作用的 middleware 仍需使用幂等键和可取消客户端。

默认策略是每 Hook 30 秒、连续 3 次失败打开、30 秒后探测；允许范围分别是 `1..300000 ms`、`1..100` 和
`1..3600000 ms`。指标采用饱和计数，pipeline 最多注册 128 个 middleware。

`RuntimeKernel.middlewareSnapshot()` 与 `runtime.doctor` 的 `middleware` 字段提供有界健康快照：每个 Hook 只保留调用、
成功、失败、超时、熔断拒绝、累计/最大耗时，不保留 Prompt、Tool input/output 或异常正文。`runtime.doctor` 还会生成
`runtime_middleware` check；任何 open/half-open circuit 记为 warning，不把 Runtime 整体误报为不可启动。

Middleware 收到的是请求和结果快照。多个 middleware 采用 onion 顺序：before 正序，after 逆序。

## Child Runtime 继承

默认 `childMiddleware` 为 `none`：父进程函数、闭包和宿主权限不会隐式进入独立 Child Runtime。需要继承时，middleware
必须声明稳定 `childId`，并由父、子共用的可信进程入口提供 factory registry：

```ts
import { runRuntime, type RuntimeMiddlewareRegistry } from '@praxis/runtime/run'

const registry: RuntimeMiddlewareRegistry = {
  'company.audit.v1': () => ({
    name: 'company-audit',
    childId: 'company.audit.v1',
    beforeTool(context) {
      recordToolBoundary(context)
      return undefined
    },
  }),
}

runRuntime({
  middleware: [registry['company.audit.v1']()],
  childMiddleware: { inheritance: 'registered', registry },
})
```

Root 只把至多 32 个唯一 ID 和归一化 deadline/circuit policy 写入经认证的 Child bootstrap profile，不序列化函数或配置
闭包。Child 进程按 ID 重新创建实例；registry 缺失、ID 未注册或 factory 非法时以
`CHILD_COMPOSITION_MIDDLEWARE_UNAVAILABLE` fail-closed。没有 `childId` 的本地 middleware 永不继承；仅设置
`childId` 也不够，必须同时显式选择 `inheritance: 'registered'`。

## 与 Agent SDK Middleware 的区别

- Agent SDK middleware 位于应用侧：Run 输入、事件、权限决策、typed state/output；
- Runtime middleware 位于执行侧：Provider 调用和 Tool 执行边界；
- Runtime policy、Capability snapshot、权限和 Workflow authority 始终拥有最终决定权。

两层可以同时使用，但不要在应用侧复制 Runtime 的权限或副作用账本。
