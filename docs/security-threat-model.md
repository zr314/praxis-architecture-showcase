# Praxis 威胁模型 / Praxis Threat Model

> 新手先记住：权限面板回答“是否允许 Praxis 执行”，不是“执行后一定安全”。实际授权决策示例见
> [工具策略](tool-policy.md)；疑似漏洞请按根目录 [SECURITY](../SECURITY.md) 私下报告。

## 中文导读

Praxis 把用户 Prompt、项目指令、Tool 输出、插件 stdout、MCP 消息、Archive、Manifest 和
依赖元数据都视为不可信输入。只有 Runtime 拥有策略、凭据、预算、会话、重试、Fallback 与
审计权力；CLI 和扩展不能取得这些权限。

安装插件不会执行代码。安装会拒绝符号链接、源码树外路径、不兼容 Manifest、可变版本冲突
和无效签名；Workspace 启用是独立动作，固定到一个内容 Digest 并记录显式授权。

只有 Linux 同时具备 `bubblewrap` 和 `prlimit` 时才报告强制隔离；该后端限制挂载、网络、
环境、CPU、地址空间和进程数。Windows、macOS 或缺少这些依赖的 Linux 明确报告
`trusted-only`。进程边界本身绝不是 Sandbox，外部代码仍拥有 Praxis 用户进程的权限。

主要缓解措施包括：项目指令不能授权、所有路径按 Canonical Target 校验、扩展只接收已声明
环境/凭据、stdout 仅协议且有界、生命周期与并发均有界、依赖精确 Pin、CI 校验 Lockfile
与 Action SHA、插件使用 Ed25519 Provenance。当前范围外包括 Marketplace、远程插件 URL、
远程多用户托管，以及 MCP Resources/Prompts/Sampling/Roots。


## Trust boundaries

Praxis treats user prompts, project instructions, Tool output, plugin stdout,
MCP messages, archives, manifests, and dependency metadata as untrusted input.
The Runtime owns policy, credentials, budgets, session state, retry, fallback,
and audit records. The CLI and extensions do not acquire those authorities.

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

On Windows, macOS, and Linux hosts without those prerequisites, Praxis reports
`trusted-only`. A process boundary alone is never described as a sandbox.
Trusted-only execution requires explicit approval and external code retains the
authority of the Praxis user process.

## Threats and mitigations

- Project instructions cannot directly grant Tool or plugin permissions.
- Paths are canonicalized below the workspace; symlinks, junction-like escapes,
  drive-qualified paths, NULs, and archive traversal are rejected.
- Only manifest-declared credential and environment names cross an extension
  boundary. Credentials are encrypted at rest with a restrictive per-user key
  file fallback and never enter traces.
- Stdout is protocol-only and size bounded. Malformed or unsupported messages
  cause quarantine; stderr is bounded and diagnostic-only.
- Startup, health checks, calls, cancellation, concurrency, restarts, output,
  and shutdown are bounded. The Linux backend uses a new session and
  die-with-parent semantics for descendant cleanup.
- Direct dependencies are exact-pinned. CI disables lifecycle scripts, checks
  a reviewed allowlist, verifies lockfile integrity, and pins Actions to full
  commit SHAs. Scheduled jobs verify registry signatures and vulnerabilities.
- Signed plugin provenance uses trusted Ed25519 keys over the manifest and
  content tree. Updates remain immutable and rollback selects a prior digest.

## Out of scope

The local Runtime is single-user. Marketplace distribution, remote plugin
URLs, remote multi-user hosting, and MCP Resources, Prompts, Sampling, and Roots
are not trusted or supported by this release.
