# Praxis 威胁模型 / Praxis Threat Model

> 新手先记住：权限面板回答“是否允许 Praxis 执行”，不是“执行后一定安全”。实际授权决策示例见
> [工具策略](tool-policy.md)；疑似漏洞请按根目录 [SECURITY](../SECURITY.md) 私下报告。

## 中文导读

Praxis 把用户 Prompt、项目指令、Tool 输出、插件 stdout、MCP 消息、Archive、Manifest 和
依赖元数据都视为不可信输入。Runtime 实施并持久化策略、凭据、预算、会话、重试、Fallback 与
审计。可信 Host/CLI 可以表达用户的管理授权，例如更改记忆模式或批准工具；普通模型工具、项目内容和扩展不能自行扩权。

安装插件不会执行代码。安装会拒绝符号链接、源码树外路径、不兼容 Manifest、可变版本冲突
和无效签名；Workspace 启用是独立动作，固定到一个内容 Digest 并记录显式授权。

Process 插件的 Linux 后端只有同时发现 `bubblewrap` 和 `prlimit` 才报告 supported；该后端准备挂载、网络、
环境、CPU、地址空间和进程数限制。缺少依赖时报告 unavailable，启动拒绝为 `ISOLATION_UNAVAILABLE`，
不会自动降级。Windows、macOS 默认使用 degraded 的 `trusted-only` 后端，要求显式信任。
进程边界本身不是 Sandbox；只有实际经过隔离后端的启动才受其约束。

内置 Shell 和 MCP stdio 当前直接启动子进程，没有接入上述 bubblewrap 后端。Shell 的工作目录校验、
Child 命令策略和 MCP 授权/环境过滤是应用层控制，不能据此宣称它们拥有 OS 文件系统或网络沙箱。
Git worktree/目录快照隔离工作成果，也不隔离任意进程的系统访问。源码见
[IsolationBackend](../apps/runtime/src/security/isolationBackend.ts)、[Shell](../apps/runtime/src/tools/shellTool.ts)
和 [MCP 启动](../apps/runtime/src/extensions/mcpStdioClient.ts)。

主要缓解措施包括：项目指令不能授权、所有路径按 Canonical Target 校验、扩展只接收已声明
环境/凭据、stdout 仅协议且有界、控制面 deadline 与瞬时并发受控、依赖精确 Pin、CI 校验 Lockfile
与 Action SHA、插件使用 Ed25519 Provenance。当前范围外包括 Marketplace、远程插件 URL、
远程多用户托管，以及 MCP Resources/Prompts/Sampling/Roots。


## Trust boundaries

Praxis treats user prompts, project instructions, Tool output, plugin stdout,
MCP messages, archives, manifests, and dependency metadata as untrusted input.
The Runtime enforces and persists policy, credentials, budgets, session state,
retry, fallback, and audit records. A trusted Host or CLI may express user-authorized
management decisions, such as changing memory mode or approving a tool. Model tools,
project content, and extensions cannot grant themselves additional authority.

An installed plugin is not executed during installation. Installation rejects
symbolic links, paths outside the source tree, incompatible manifests, mutable
version collisions, and invalid signatures. Workspace enablement is separate,
fixed to one content digest, and records explicit grants.

## Isolation claims

On Linux, Praxis reports enforced isolation only when both bubblewrap and
`prlimit` are available. That backend creates a new session and namespaces,
uses explicit read-only or writable bind mounts, removes ambient environment
variables, unshares networking unless granted, and applies CPU, address-space,
and process-count limits.

On Linux without those prerequisites, the default backend reports `unavailable`
and rejects Process plugin launch with `ISOLATION_UNAVAILABLE`; it does not automatically fall back.
On Windows and macOS, the default backend reports degraded `trusted-only`.
A process boundary alone is never described as a sandbox.
Trusted-only execution requires explicit approval and external code retains the
authority of the Praxis user process.

The built-in Shell and MCP stdio client currently spawn processes directly, outside
the Process plugin isolation backend. Their application-level permissions and
environment controls are not OS sandbox enforcement. A worktree or managed
directory snapshot isolates work products, not arbitrary process access.

## Threats and mitigations

- Project instructions cannot directly grant Tool or plugin permissions.
- Paths are canonicalized below the workspace; symlinks, junction-like escapes,
  drive-qualified paths, NULs, and archive traversal are rejected.
- Only manifest-declared credential and environment names cross an extension
  boundary. Credentials are encrypted at rest with a restrictive per-user key
  file fallback and never enter traces.
- Stdout is protocol-only and size bounded. Malformed or unsupported messages
  cause quarantine; stderr is bounded and diagnostic-only.
- Startup, health checks, cancellation, concurrency, restarts, output, and
  shutdown have control-plane bounds. Long-running calls follow their explicit
  deadlines; there is no implicit cumulative Run lifetime limit. The Linux
  backend uses a new session and die-with-parent semantics for descendant cleanup.
- Direct dependencies are exact-pinned and repository npm configuration disables
  lifecycle scripts. Ordinary CI installs the lockfile and runs check/test/build;
  Actions are pinned to full commit SHAs. Dedicated security/release workflows
  handle supply-chain allowlists, signatures and vulnerability checks.
- Signed plugin provenance uses trusted Ed25519 keys over the manifest and
  content tree. Updates remain immutable and rollback selects a prior digest.

## Out of scope

The local Runtime is single-user. Marketplace distribution, remote plugin
URLs, remote multi-user hosting, and MCP Resources, Prompts, Sampling, and Roots
are not trusted or supported by this release.
