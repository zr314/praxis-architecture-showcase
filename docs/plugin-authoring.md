# 插件开发：从零开始 / Plugin Authoring

> 本教程面向第一次写 Praxis 扩展的人。先完成最小 process Tool，再决定是否需要 MCP、Provider、
> Skill/template/theme 或 Slash Command mapping。完整运行时设计见 [插件系统](plugin-system.md)。

## 先选扩展类型

| 需求 | 应使用 |
| --- | --- |
| 一段可被模型调用的本地逻辑 | Praxis process Tool |
| 已有 MCP stdio server | MCP plugin |
| 新模型/服务的流式适配器 | Praxis process Provider |
| 纯文本说明或工作流 | Skill resource |
| 带参数的 Prompt | Prompt template resource |
| UI 主题数据 | Theme resource |

不要为了一个静态说明启动进程插件；data-only resource 更安全、更容易审查。

## 准备环境

从源码仓库开发：

```bash
npm ci
npm run build
npm run install:local
praxis --version
```

公共合同位于：

- `@praxis/plugin-sdk`：脚手架、合同断言和协议导出；
- `@praxis/plugin-protocol`：manifest、process RPC、descriptor 和生命周期类型；
- `examples/plugins/tool`：最小 process Tool；
- `examples/plugins/mcp-server`：最小 MCP stdio server；
- `examples/plugins/provider`：最小 streamed Process Provider。

## 路径 A：复制最小 Tool 示例

最直观的方法：

```bash
cp -R examples/plugins/tool ./my-echo-plugin
```

PowerShell：

```powershell
Copy-Item -Recurse .\examples\plugins\tool .\my-echo-plugin
```

然后修改 `praxis-plugin.json` 中的 `id`、`name`、`version` 和 capability ID。Plugin ID 推荐使用
反向域名或组织前缀，例如 `com.example.echo`，并保持全小写。

## 路径 B：使用 SDK 脚手架

`scaffoldPlugin(destination, options)` 只创建源码树，不安装、不启用、不执行插件：

```js
import { scaffoldPlugin } from '@praxis/plugin-sdk'

await scaffoldPlugin('./my-echo-plugin', {
  id: 'com.example.echo',
  name: 'Example Echo',
  version: '0.1.0',
  kind: 'tool',
})
```

目标目录必须不存在。生成后应包含：

```text
my-echo-plugin/
  praxis-plugin.json
  index.mjs
```

## 理解 Manifest

最小 process Tool manifest：

```json
{
  "manifestVersion": 1,
  "id": "com.example.echo",
  "name": "Example Echo",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "index.mjs",
  "isolation": "process",
  "capabilities": [{ "id": "echo", "kind": "tool" }],
  "grants": []
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `manifestVersion` | Manifest Schema 版本，当前是 `1` |
| `id` | 全局稳定插件 ID |
| `version` | 语义版本；安装后与内容 digest 一起固定 |
| `apiVersion` | Praxis 插件 API 版本 |
| `entry` | 包内相对入口；不能越过插件目录 |
| `isolation` | `process`、`mcp-stdio` 或 `data-only` |
| `capabilities` | Tool/MCP/Provider 或 data resource 声明 |
| `commands` | 可选，显式 Tool→namespaced command mapping |
| `grants` | 插件可能使用的最大权限，不代表已批准 |
| `credentials` | 可选，Provider 需要的凭据环境变量名 |

未知字段、路径穿越、重复 ID、错误 capability/isolation 组合都会在安装前拒绝。

## 实现 Process 协议

Process plugin 的 stdin/stdout 是一行一个 JSON 记录。stdout **只能**写协议；调试文本写 stderr，且 stderr
也会被字节上限约束。

必须处理：

1. `initialize`：返回 manifest 摘要和 capability descriptors；
2. `capability.invoke`：执行一次 Tool/Provider 调用；
3. `capability.cancel`：响应 Runtime 取消；
4. `health.ping`：返回相同 nonce；
5. `shutdown`：有界关闭。

Tool descriptor 必须包含严格输入/输出 Schema 和 execution 描述：

```js
const descriptor = {
  id: 'echo',
  kind: 'tool',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string', minLength: 1, maxLength: 4096 } },
    required: ['value'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  execution: {
    sideEffect: 'read',
    target: { kind: 'none' },
    parallelSafe: true,
    conflictScope: 'target',
    maxInlineBytes: 65536,
    timeoutMs: 5000,
  },
}
```

不要把有写入、网络或进程副作用的 Tool 声明成 `read`。Execution metadata 决定 Runtime 如何协调并发、
权限、deadline 和目标冲突。

## 安装和启用

在插件目录外运行：

```bash
praxis plugin install ./my-echo-plugin
praxis plugin list
praxis plugin inspect com.example.echo --version 0.1.0
```

安装阶段只读取、校验、复制并计算 digest，**绝不执行插件代码**。

启用按 Workspace 生效：

```bash
praxis plugin enable com.example.echo \
  --version 0.1.0 \
  --workspace . \
  --grants '[]'
```

PowerShell 可写成一行，JSON 外层使用单引号：

```powershell
praxis plugin enable com.example.echo --version 0.1.0 --workspace . --grants '[]'
```

检查：

```bash
praxis plugin permissions com.example.echo --workspace .
praxis plugin doctor
praxis doctor --workspace .
```

只有 enabled、healthy、digest 未漂移且 descriptor/schema 有效的能力才进入 Runtime capability snapshot。

## 申请最小权限

Manifest `grants` 是最大请求，Workspace enablement 的 `--grants` 是用户实际批准；实际能力只能是二者
交集。

常见 grant 类型：

- filesystem read/write paths；
- network hosts；
- environment names；
- process commands；
- bounded resources。

原则：

- 能只读就不申请写；
- 能限制子目录就不申请整个 workspace；
- 能列出主机就不申请任意网络；
- Credential 名称同时放入 `credentials` 和 environment grant；
- 不把 API key、token 或 password 写进 manifest、argv、stdout 或错误。

Process Provider 缺少任一声明凭据时必须保持 unauthenticated，不能偷偷读取未声明环境变量。

## 显式创建 Slash Command

Tool discovery 默认只创建 Tool。需要用户显式输入命令时，在 immutable manifest 中加入 `commands`：

```json
{
  "commands": [
    {
      "id": "echo",
      "title": "Echo value",
      "description": "Invoke the declared echo Tool.",
      "capability": "echo",
      "positional": ["value"],
      "sensitiveArguments": [],
      "persistence": "digest"
    }
  ]
}
```

发布后命令只能是：

```text
/plugin:com.example.echo/echo hello
```

MCP mapping 还必须声明 exact remote `tool`，并发布为 `/mcp:<plugin-id>/<command>`。Mapping 不能声明
alias、Runtime mutation、permission bypass 或自定义 output handler。Runtime 仍经过 command audit、Policy、
ToolRuntime、deadline、cancel 和 ArtifactStore。

为了能降级成 Slash Command，Tool input 必须是 closed flat object，最多 16 个 string/integer/boolean 字段。
更复杂的 Tool 仍可被模型调用，只是不进入命令目录。

## 使用 MCP server

MCP manifest：

```json
{
  "manifestVersion": 1,
  "id": "com.example.mcp",
  "name": "Example MCP",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "server.mjs",
  "isolation": "mcp-stdio",
  "capabilities": [{ "id": "server", "kind": "mcp" }],
  "grants": []
}
```

当前产品只支持本地 MCP stdio。Runtime 负责 initialize、`tools/list` 分页、Tool descriptor publication、
`tools/call`、progress、timeout、cancel、schema 和进程树关闭；未知或不支持的 server-initiated surface 会
fail closed。

## 使用 Process Provider

Provider descriptor 除 Schema 外还要声明：

- `defaultModel`；
- streaming 是否支持 text/reasoning/usage；
- Tool 模式和并行调用；
- text/vision/audio modalities；
- JSON Schema/citation output；
- context/output token limits。

Runtime 根据这些能力做模型准入、路由、预算、取消、usage 和 persistence。Plugin 永远拿不到
`RuntimeKernel`、Credential store 或任意 ambient state。

## 更新、回滚和卸载

修改源码后提高 `version`，再执行：

```bash
praxis plugin update ./my-echo-plugin --workspace . --grants '[]'
praxis plugin list --workspace .
praxis plugin rollback com.example.echo --workspace .
praxis plugin disable com.example.echo --workspace .
praxis plugin uninstall com.example.echo --version 0.1.0
```

生产安装内容不可变。不要直接修改 Praxis store 中的已安装目录；digest drift 会导致能力拒绝发布。

## 调试清单

插件没有出现时，依次检查：

```bash
praxis plugin list --workspace .
praxis plugin inspect <id> --version <version>
praxis plugin permissions <id> --workspace .
praxis plugin doctor
praxis doctor --workspace .
praxis --commands
```

重点看：

- 是否安装了正确版本；
- Workspace 是否启用；
- approved grants 是否是 manifest grants 的合法子集；
- health 是否为 healthy；
- stdout 是否混入日志；
- capability ID、Schema、digest 或 protocol revision 是否漂移；
- 平台是否只有 `trusted-only`。

## 安全提醒

Process boundary 不是 OS sandbox。Linux 只有 `bubblewrap` 与 `prlimit` 都可用时才报告 enforced isolation；
Windows、macOS 或缺少后端时为 `trusted-only`。显式启用意味着你信任该固定 digest 以当前用户权限运行。

## English summary

Start from `@praxis/plugin-sdk` and the Tool, MCP, or Provider examples.
Installation validates and content-addresses source without executing it;
workspace enablement approves a fixed version, digest, and grant subset.
Process stdout is protocol-only. Live publication requires healthy lifecycle,
schema and digest agreement. Tool-backed commands are explicit, namespaced,
and still cross command audit, Policy, ToolRuntime, deadline, cancellation, and
ArtifactStore. A process boundary is not automatically an OS sandbox.
