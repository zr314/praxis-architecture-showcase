# Praxis 插件系统 / Praxis Plugin System

## 中文导读

Praxis 插件平台的核心原则是“安装不执行、启用需信任、能力按 Digest 发布、执行权仍归
Runtime”：

- 安装把源码校验并复制为不可变内容寻址版本，不执行任何插件代码。Workspace 选择精确版本
  与 Digest，可更新、回滚、禁用和卸载，且不会改变其他 Workspace。
- `PluginManager` 管理通用生命周期；`ExtensionService` 组装内置与外部能力；
  `RuntimeCapabilityRegistry` 是生产 Run 查找 Tool/Provider/Resource 的唯一权威。
- Manifest 是严格、版本化、拒绝未知字段的契约。授权采用封闭 Discriminated Union，
  覆盖文件系统、网络、环境、进程与资源；凭据名称需独立声明。
- `Skill` 与数据资源固定到 Origin/Digest，发现不会执行内容。模型调用 Skill 会形成类型化、
  可持久化、可分支、可导出和可压缩回放的记录。
- 本地 MCP stdio 只启用 `tools/list` 与 `tools/call`。完成协议协商、分页、Schema、Digest
  和健康检查后，Tool 才原子发布；崩溃或调用失败会隔离对应 Server 并移除能力。
- Praxis Process Tool/Provider 使用公开 `@praxis/plugin-protocol`。Tool 必须声明副作用
  与有界 Schema；Provider 必须声明模型和 Streaming/Tool/Modality/Output/Limit 能力。
- Tool 调用仍经过 Runtime Policy；Provider 仍经过 Runtime Routing、Credential、Budget、
  Retry、Cancellation 与 Persistence。插件永远拿不到 `RuntimeKernel`。
- Tool 不会因发现而自动成为 Slash Command。只有 Manifest 显式 mapping 才发布
  `plugin:<id>/<command>` 或 `mcp:<id>/<command>`；它仍经过 ToolRuntime、Policy、Deadline、Cancel、
  Output Schema 与 ArtifactStore，且不能覆盖内建命令或声明 Runtime mutation。
- Linux 只有在 `bubblewrap` 与 `prlimit` 均存在时报告强制隔离；其他平台为
  `trusted-only`，启用即表示明确批准运行所选不可变 Digest。
- CLI 暴露 Install/Inspect/Enable/Disable/Permissions/Doctor/Update/Rollback/Uninstall；
  每个状态变化都必须可检查、可诊断、可逆到已安装版本。
- 当前不支持 Marketplace、远程插件 URL、远程 MCP，以及 MCP
  Resources/Prompts/Sampling/Roots。它们需要独立安全决策和产品需求。

下方英文正文是 Manifest 字段、生命周期、监督、能力适配、策略和验收标准的规范记录。

## Purpose

Praxis is evolving from a fixed coding-agent harness into a general CLI Agent
platform. The approved extension architecture supports local process plugins
and MCP servers that can contribute Tool or Provider capabilities. Runtime
remains the authority for sessions, credentials, policy, budgets, cancellation,
and durable state.

This document describes the current extension surface. The concise
shipping/internal/future boundary lives in [project-status.md](project-status.md).

### Current shipping boundary

Praxis exposes installation, inspection, fixed-version workspace enablement,
permission review, update, rollback, and removal. Data-only Skills, local MCP
stdio Tools, Praxis process Tools, and streamed Process Providers are connected
to the shipping Runtime. Lifecycle status is live truth, and only healthy
capabilities from the selected immutable digest enter a per-run snapshot.
Explicit manifest mappings can expose compatible process or MCP Tools as
namespaced workflow commands; Tool discovery alone remains Tool-only.

## Scope

The target live plugin release supports:

- Local directories or executables with an explicit manifest.
- Immutable global installation and per-workspace enablement.
- Praxis process plugins for Tool and Provider capabilities.
- MCP stdio servers for Tool capabilities.
- Explicit, schema-checked, namespaced command mappings to existing Tools.
- Capability inspection, health checks, permission review, and lifecycle
  commands in the CLI.

It does not initially support remote URLs, installation scripts, a marketplace,
MCP Resources/Prompts/Sampling, or third-party Planner, Persistence, and Subagent
capabilities.

## Architecture

```text
CLI
  plugin install/list/inspect/enable/disable/doctor/uninstall
                         |
                         v
Runtime Extension Control Plane
  GlobalPluginCatalog       immutable installations
  WorkspacePluginConfig     explicit enablement and grants
  ManifestValidator         schema, compatibility, and integrity
  ExtensionSupervisor       launch, health, cancellation, and shutdown
  ProcessPluginAdapter      Praxis process protocol
  McpAdapter                MCP stdio Tool transport
                         |
                         v
Capability Registry
  Tool capabilities         Provider capabilities
  Explicit command mappings (Tool-backed workflows only)
                         |
                         v
PolicyEngine / ProviderRouter / AgentLoop

Resource Catalog
  Skills                     Prompt templates
                         |
                         v
Immutable Run Resource Snapshot / Prompt Composer / Session
```

In the target activation composition, built-in capabilities stay in process for efficiency, but the registry exposes
the same origin, descriptor, and health view for built-in and external
capabilities. External plugins never receive a `RuntimeKernel`, repository, or
unrestricted environment object.

## Manifest

Every installation contains `praxis-plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "example.mcp-tools",
  "name": "Example MCP Tools",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "server.mjs",
  "isolation": "mcp-stdio",
  "capabilities": [
    {
      "id": "example.mcp",
      "kind": "mcp"
    }
  ],
  "grants": [],
  "engines": {
    "praxis": "^0.2.0",
    "node": ">=22.13.0"
  }
}
```

Plugin IDs are globally unique; capability IDs are stable and local to their
plugin. Runtime publishes external capability IDs as
`<plugin-id>/<capability-id>` and keys each publication by that qualified ID
plus the immutable installation digest. Provider and MCP manifest kinds map to
the canonical Runtime kinds `llm-provider` and `mcp-server`; display names never
participate in lookup. The command must resolve inside the
installed plugin directory; interpreters require an explicit allowlist.
`isolation` selects `process`, `mcp-stdio`, or `data-only`. `entry` is required
for executable plugins and omitted for a package that contains only declared
data resources.

The MCP example intentionally has no `commands` field: discovery therefore
publishes only its Tool. A process plugin can opt in with this strict mapping:

```json
{
  "commands": [
    {
      "id": "echo",
      "title": "Echo value",
      "description": "Invoke the declared echo Tool.",
      "capability": "example.echo",
      "positional": ["value"],
      "sensitiveArguments": [],
      "persistence": "digest"
    }
  ]
}
```

For a process plugin, `capability` must name a declared `tool`. For an MCP
plugin, it must name a declared `mcp` server and each mapping must additionally
name the remote `tool`. Mapping IDs use the bounded unqualified command syntax,
but publication is always `plugin:<plugin-id>/<id>` or
`mcp:<plugin-id>/<id>`. A mapping cannot declare aliases, command kind, effect,
permissions, or output handling. Data-only plugins cannot declare mappings.

The manifest's discriminated `grants` array declares maximum requested access:
filesystem read or write paths, network hosts, environment names, process
commands, and bounded resource limits. A workspace may grant less, but never
more, without installing a new manifest version. Unknown grant types or fields
are rejected rather than preserved as ambient authority.

The five accepted shapes are:

```json
[
  { "type": "filesystem", "access": "read", "paths": ["${workspace}"] },
  { "type": "network", "hosts": ["api.example.com"] },
  { "type": "environment", "names": ["EXAMPLE_API_KEY"] },
  { "type": "process", "commands": ["node"] },
  { "type": "resource", "cpuMs": 5000, "memoryMb": 256, "processCount": 2 }
]
```

## Installation and Workspace Enablement

Global installations are immutable and versioned:

```text
~/.praxis/plugins/
  catalog.json
  example.search/1.0.0/
    praxis-plugin.json
    integrity.json
    ...
```

`plugin install <path>` validates the manifest, computes a content digest, and
copies the installation without executing plugin code. The same ID and version
cannot identify different content. Updates install a new version rather than
overwriting an existing directory.

Each workspace records only explicit enablement, a fixed version, and scoped
grants in `.praxis/plugins.json`. Installation never enables a plugin. Changing
versions requires an explicit workspace action and another permission review.

Inspection reports one lifecycle value: `installed`, `workspace-enabled`,
`starting`, `healthy`, `degraded`, `quarantined`, or `stopped`.
`workspace-enabled` is management state, not a claim that code is running.
Only a healthy capability from the workspace-selected digest may enter an
Agent-visible snapshot.

`plugin uninstall` refuses to remove an installation still referenced by a
known workspace unless the user explicitly resolves those references.

## Lifecycle and Supervision

Runtime performs the following sequence for each enabled plugin:

1. Reload and validate the manifest, compatibility range, command, and digest.
2. Construct the smallest environment and isolation profile allowed by the
   workspace grants.
3. Launch the process with stdin/stdout reserved for framed protocol traffic and
   stderr reserved for bounded diagnostics.
4. Exchange protocol version, plugin version, instance ID, capability digest,
   and health metadata.
5. Validate capability descriptors before registering them.
6. Enforce request deadlines, cancellation, concurrency, message size, and
   output limits.
7. On protocol or process failure, atomically quarantine and unpublish the
   affected plugin's capabilities, apply a bounded restart policy, and keep
   Runtime and other sessions alive.
8. Cancel outstanding calls and stop the plugin during workspace disablement or
   Runtime shutdown.

Replacement prevents new calls, starts and validates the selected candidate,
then atomically publishes only that digest and stops the previous instance. If
the selected candidate fails its health gate, Runtime removes the previous
publication too and marks the plugin quarantined; an explicit rollback is
required to make an older digest authoritative again.

Unknown messages, duplicate terminal events, sequence gaps, oversized frames,
and stdout contamination are protocol violations. They terminate or quarantine
the plugin and produce a redacted diagnostic event.

## Skills and Data Resources

The bounded data-only Skill path, MCP Tool activation, Praxis process Tool
activation, and Process Provider activation described in this section are
implemented in the shipping Runtime.

Skills, prompt templates, and themes are data resources. Discovery records a
canonical origin, relative resource root, immutable installation digest,
content digest, trust, and collision state without executing the resource.
Project resources are eligible only after project trust, and an unresolved
identity collision blocks activation until the user selects one origin.

The initial Skill contract follows the stable Agent Skills core:

- `name`
- `description`
- `license`
- `compatibility`
- `metadata`
- `disable-model-invocation`

Unknown descriptive metadata may be retained for inspection. Fields that could
change execution, Tool access, hooks, model choice, reasoning level, or process
authority fail closed until a separately accepted contract defines their
semantics.

Every run receives one immutable resource snapshot. Prompt composition exposes
only bounded Skill identity, name, description, and invocation metadata. A
first-class Runtime `SkillInvocationService` loads the complete bounded
`SKILL.md` content on demand; it does not expose arbitrary host paths to the
model or depend on the generic read Tool. Explicit user invocation remains
available for a Skill with `disable-model-invocation`, while model-selected
invocation is rejected.

A Skill invocation is persisted with its capability ID, origin, content digest,
arguments, and the exact injected content or artifact reference. Resume,
branch, export, and compaction replay that record instead of rereading mutable
workspace content. Skill scripts and assets remain inert: any requested Tool or
shell operation crosses the normal Runtime validation, permission, preview,
audit, timeout, and cancellation boundary. Enabling a Skill never grants Tool
authority.

Resource reload happens between runs or at an explicit development boundary.
It cannot mutate an active run's prompt or capability snapshot. The first live
release does not support Skill hooks, shell frontmatter, automatic model
changes, forked-agent execution, Tool preapproval, remote Skill search, or
path-triggered dynamic Skill activation.

## Tool Capabilities

MCP Tool plugins use `tools/list` for discovery and `tools/call` for execution.
Praxis process Tool plugins use equivalent versioned RPC methods. Runtime
validates every input and output against the registered schemas.

Every Tool call includes a correlation ID, deadline, cancellation ID, plugin
origin, and workspace scope. Its manifest descriptor declares a side-effect
class and structured permission templates. Runtime derives the policy request
from the validated descriptor and call arguments rather than accepting a
free-form rule chosen by the plugin. The plugin cannot approve its own call.

Descriptors are still claims made by plugin authors, not enforcement. The OS
isolation profile limits the process to the manifest's maximum access even when
a descriptor is incomplete or dishonest; without that backend the plugin is
reported as trusted-only.

Large results become bounded artifacts; the conversation receives only a
summary and artifact reference. Read-only calls may later run concurrently when
their descriptors and targets prove non-conflicting. Mutating calls remain
ordered by default.

### Tool-backed command mappings

Runtime never derives slash commands from MCP `tools/list` or a process Tool
handshake. For an explicit manifest mapping, publication additionally requires
workspace enablement, healthy live capability state, an unchanged installation
digest, an exact target Tool, and a closed flat input object with at most 16
string, integer, or boolean properties. Unsupported or drifting schemas remain
Tool-only rather than being widened.

Every external mapping is a trusted-workspace, session-required, idle-only
`workflow/job/bounded_job`. It has no alias, so a mapping named `compact`
publishes only as `plugin:<id>/compact` or `mcp:<id>/compact` and cannot replace
the Runtime's `/compact`. The core descriptor contract rejects `plugin` and
`mcp` sources that claim `runtime_mutation`.

Invocation first appends the normal privacy-projected command audit, then
prepares the exact Tool through `ToolRuntime`. Runtime records a content-free
Policy decision. If the Tool requires permission, the command accepts only an
existing durable grant; without one it records `ask`, returns
`COMMAND_EXTERNAL_PERMISSION_REQUIRED`, and does not invoke the Tool. A user can
establish that grant through the normal interactive Tool permission lifecycle.
There is no command-specific permission bypass.

ToolRuntime retains input/output schema validation, mutation coordination,
inline output limits, and any nested Tool artifacts. The command adapter adds a
bounded deadline and Runtime-shutdown cancellation, then stores the complete
bounded Tool result as
`application/vnd.praxis.external-command-result+json`. The command response is
only a completed bounded job containing that artifact ID. Timeout and
cancellation failures also leave a bounded failure artifact and return stable
errors. This surface does not add MCP brokers, launches, credentials, or Tools
to child Runtime capability bundles.

### MCP protocol and lifecycle boundary

The production MCP implementation supports local stdio transport and Tool
capabilities only. Official `@modelcontextprotocol/core` schemas validate
discovery, legacy initialization, Tool descriptors/results, and progress;
Praxis retains the bounded transport, policy, lifecycle, and publication
adapter. The compatibility matrix covers final `2026-07-28` discovery and the
selected `2025-06-18` legacy fallback. Successful negotiation requires one of
those exact revisions rather than any string returned by a server.

MCP Tool identities are origin-qualified, for example
`mcp__<plugin-id>__<server-id>__<tool-id>`. Server titles and descriptions are
bounded display metadata, not lookup authority. MCP annotations such as
read-only, destructive, idempotent, and open-world are untrusted hints. Runtime
keeps the conservative policy classification unless a reviewed Praxis
descriptor and enforced workspace grant justify a narrower classification.

The client supports paginated `tools/list` and negotiated Tool-list change
notifications. A changed list is completely fetched, schema-validated, and
collision-checked before an immutable capability snapshot is swapped between
model turns. It never mutates the Tool set during a Provider turn.

Tool inputs and outputs are schema-validated with bounded schema depth, size,
reference behavior, and validation time. Deadlines, abort, cancellation,
progress, structured content, and stable error categories cross the Runtime
Tool contract. Large text and binary, image, audio, resource-link, or structured
results become artifacts with a bounded Provider-visible summary.

The stdio parser enforces byte limits before an unbounded line or frame can
accumulate and decodes UTF-8 across arbitrary Buffer boundaries. Stderr is
bounded diagnostics; stdout accepts protocol traffic only. Disablement,
rollback, quarantine, and shutdown remove Tools before bounded graceful
termination and verified process-tree cleanup.

The first MCP implementation rejects remote transports, Resources, Prompts,
Sampling, Roots, elicitation, and unknown capabilities with explicit
unsupported-capability errors. Streamable HTTP, OAuth, registry discovery, MCP
Apps, Tasks, and other extensions require a later demand-backed design and
threat-model review.

## Provider Capabilities

Provider plugins use the Praxis process protocol because MCP Tool semantics do
not model Provider streaming, usage, authentication, or fallback. `initialize`
returns the Provider descriptor; `capability.invoke` starts one stream;
correlated `event` output carries normalized chunks; `capability.cancel`
cancels it; and `health.ping` gates publication.

Descriptors declare models, context limits, tool-call support, input modes, and
usage fields. Streams normalize text deltas, tool calls, usage, and one terminal
result. Raw SDK failures are converted to stable redacted Runtime errors at the
plugin boundary.

Runtime owns retry, rate limits, health state, circuit breaking, model fallback,
and exact usage or cost accounting. A plugin may not silently select another
provider or model.

Credentials are stored separately from sessions. Runtime injects only the
credential and environment names allowed by the manifest and workspace. A
plugin never inherits the complete Runtime environment.

## Protocol Packages

`@praxis/protocol` remains the CLI-to-Runtime contract.
`@praxis/plugin-protocol` owns the versioned plugin manifest, handshake, closed
v1 process RPC/event vocabulary, Tool execution descriptors, and Provider
capability descriptors. Runtime retains transport parsing, validation,
supervision, policy, and publication.

The MCP component is a deliberately narrow stdio Tool adapter backed by
official Core protocol schemas. Praxis-owned code still implements
byte-bounded framing, process supervision, Runtime policy, and atomic
capability snapshots; it is not a second general-purpose MCP SDK.

Protocol handshakes negotiate compatible major versions. Patch-compatible
changes may add optional fields only. New required fields or changed semantics
require a new protocol major and compatibility fixtures.

## Policy and Isolation

Runtime policy and operating-system isolation are separate layers:

- Capability policy controls registration, Tool authorization, credential
  injection, and workspace grants.
- An `IsolationBackend` enforces filesystem, network, and process access using
  a supported platform mechanism.

A manifest claim such as `filesystem: none` is not isolation by itself. When no
OS backend is available, Praxis must label the plugin `trusted-only` and require
an explicit trust override. It must not claim that an unrestricted local
process is sandboxed.

The target backends are a bubblewrap or container profile on Linux, a restricted
process or AppContainer profile on Windows, and an available sandbox or
container backend on macOS. Broad third-party distribution remains blocked
until supported platforms have tested enforcement or clearly documented
trusted-only behavior.

## CLI Contract

The management surface is:

```text
praxis plugin install <path>
praxis plugin list [--global|--workspace]
praxis plugin inspect <id>
praxis plugin enable <id> [--version]
praxis plugin disable <id>
praxis plugin update <id> --from <path>
praxis plugin uninstall <id>
praxis plugin permissions <id>
praxis plugin doctor [id]
```

Permission prompts identify plugin origin, version, risk, target, and proposed
scope. Non-interactive mode continues to deny requests by default and accepts
only an explicit structured policy file, never a blanket `--yes` grant.

## Evaluation and Diagnostics

Every external interaction is correlated as:

```text
traceId -> sessionId -> runId -> turnId -> toolCallId/pluginCallId
```

Traces may record timing, usage, retry, fallback, health, restart, permission,
and terminal categories. They never contain API keys, raw prompts, complete Tool
outputs, or unrestricted environment values.

Conformance fixtures cover valid handshakes, malformed frames, crash, timeout,
cancellation, health changes, schema violations, protocol contamination, and
shutdown. Native CI runs Process and MCP fixtures on Windows, Linux, and macOS.

## Target Activation Acceptance Criteria

- A local plugin can be installed without executing it and inspected before
  enablement.
- A globally installed plugin has no capability or permission in a workspace
  until explicitly enabled there.
- Runtime rejects incompatible, altered, or same-version/different-content
  installations.
- Tool and Provider plugins can stream or execute, cancel, report health, and
  shut down through bounded protocols.
- Every Tool side effect remains governed by Runtime policy.
- MCP and process Tools remain Tool-only unless an immutable manifest explicitly
  maps one to a schema-compatible namespaced workflow command.
- External commands cannot claim built-in aliases or Runtime mutation authority;
  mapped execution remains Policy-, deadline-, cancellation-, output-, and
  artifact-governed.
- Data-only Skills are progressively disclosed and replayable without granting
  Tool authority or exposing arbitrary host paths.
- Plugin crashes and protocol violations do not terminate Runtime or corrupt a
  session.
- Credentials and undeclared environment variables are unavailable to plugins.
- MCP Tool support is standards-based and unsupported MCP surfaces fail
  explicitly.
- Diagnostics are correlated and redacted.
- Praxis reports the real isolation state and never presents process separation
  alone as an OS sandbox.
