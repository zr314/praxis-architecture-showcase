# Changelog

All notable changes are recorded here. This project follows Keep a Changelog
and semantic versioning.

## Unreleased

## [0.2.0] - 2026-08-10

Praxis 0.2 consolidates the production-shaped Agent Runtime, durable Workflow,
authenticated Child Runtime, extension, storage, Prompt, CLI, and documentation
paths into one coherent release boundary.

### Added

- Activated digest-pinned Skills, local MCP stdio Tools, supervised Praxis
  process Tools, and streamed Process Providers through one live Runtime
  capability registry.
- Added typed layered commands for Runtime operations, context inspection,
  compaction, Prompt/Skill resources, and explicit namespaced Tool-backed
  workflows.
- Added internal development/test building blocks for authenticated child
  Runtimes, capability attenuation, durable V3 journals with JSONL/SQLite
  parity, bounded fixed/serial/DAG supervision, recovery, verification,
  replanning, and isolated workspace writes.
- Moved product Sessions to one V3 authority, with JSONL as the default,
  explicit SQLite selection, verified offline migration, source backups, and
  no live switching or dual writes.
- Added one durable Workflow path for every Prompt: the default `auto` root
  can work directly or autonomously call delegate, handoff, graph expansion,
  explicit loops, durable waits, and subworkflows. `solo/workflow` are policy
  overrides; `direct/supervisor` are migration aliases only.
- Added persistent Workflow Node/Attempt/Task/Lease state, conditional edges,
  `all/any/quorum` joins, background recovery, HumanTask/Timer wake, immutable
  execution snapshots, authenticated Authority/Artifact RPC, and receipt-based
  external effect reservations.
- Added real authenticated Child Runtime processes with attenuated Tool/Skill/
  MCP/workspace capabilities, Provider credential brokering, isolated Git or
  directory-snapshot writes, structured `praxis_submit_child_result` terminal
  submission, bounded Artifact closure, and evidence manifests.
- Added portable semantic compaction, optional OpenAI Responses native compact,
  Provider-only reasoning/Tool-result editing, Run-stable ContextView cache
  prefixes, and versioned Prompt program manifests.
- Added built-in DeepSeek V4 and regional MiniMax Provider families; MiniMax
  region IDs, endpoints, credential variables, and default models share one
  configuration source.

### Changed

- Reduced pull-request CI from four duplicate full source matrices plus two
  package jobs to one Ubuntu/Node 24 packaging gate. It checks supply-chain
  policy, builds and verifies package manifests, imports every public Workspace,
  and runs the packaged CLI smoke. Feature-branch pushes no longer duplicate PR
  runs and superseded runs are cancelled. Full and focused compatibility tests,
  static checks, and deterministic evaluations remain available locally without
  blocking ordinary PRs. The smaller CI contract protects package ordering,
  read-only permissions, secret isolation, imports, and smoke execution. The
  minimum Node version is now 22.13 because durable Workflow storage uses
  built-in `node:sqlite`.
- GitHub Release verification uses the same package-first boundary: supply-chain
  policy, `package:npm`, synchronized release metadata, four native binary
  builds, checksums, SBOM, provenance, and packaged artifact checks. Platform
  integration suites remain explicit diagnostics instead of publication gates.
- Standalone binaries use Bun's built-in SQLite through the Runtime storage
  adapter, including Node-compatible missing-row semantics, so durable Workflow
  storage initializes without an external Node installation.
- Updated the pinned checkout, setup-node, upload-artifact, and
  download-artifact Actions to their current major releases, and refreshed
  `fast-uri` to the audited 3.1.5 transitive release.
- New Sessions default to `auto`. `--planner` and idle-only `/planner` select
  `auto|solo|workflow`; `/storage` inspects the authority and `storage migrate`
  performs offline backend cutover.
- External extensions enter a Run only when the selected immutable digest is
  enabled, healthy, schema-compatible, and permitted for that workspace.
- The v4 long-lifecycle product path no longer installs implicit cumulative
  turn, Tool, token, wall-clock, Child-count, depth, loop, or graph-evolution
  budgets. Explicit user/CLI/organization/Proposal limits, cancellation,
  context bounds, protocol validation, and worker-pool concurrency still apply.
- `iron-law-lean-v1` is the single default Prompt program; `baseline-v1`
  remains an explicit rollback/A-B option. Dynamic facts, Skill catalog, and
  project guidance are context rather than duplicate policy blocks.

### Documentation

- Added a beginner-oriented module map covering all seven workspaces, every
  Runtime/CLI source domain, public package boundaries, real dependency
  direction, common vertical change paths, and the evidence boundary between
  industry-shaped architecture and proven industrial reliability.
- Rebuilt the README as the complete product feature map and added detailed
  beginner paths for installation, Provider selection, Session recovery,
  permissions, plugin authoring, protocol clients, and troubleshooting.
- Replaced completed implementation plans, oversized TODO backlogs, and mixed
  current/future roadmaps with one current project-status boundary and a
  concise Supervisor product/internal boundary guide.
- Synchronized architecture, extension, release, contributor, security, and
  private-registry documentation around the shipping product boundary.
- Added a canonical final small-sample evaluation report covering Harness-Bench,
  Harbor / Terminal-Bench, AgentDojo, real Child quorum/cross-review, long-task
  recovery, DeepSeek compaction/cache, MiniMax smoke, permanent fixes, and the
  remaining restart-consistency/statistical evidence boundary.

### Migration

- Upgrade to Node.js 22.13 or later before installing Praxis 0.2; durable
  Workflow storage now relies on built-in `node:sqlite`.
- Stop every Praxis process before changing the Session V3 authority. Use
  `praxis storage migrate jsonl|sqlite`; the command verifies the target,
  records a recovery copy under `migration-backups/`, and activates one
  authority without dual writes.

### Known limitations

- The architecture is industry-shaped, but the current evidence remains a
  bounded local and small-sample evaluation rather than a large-scale
  reliability claim.
- Process supervision is not an OS sandbox. Untrusted process extensions need
  the documented platform isolation backend; unsupported hosts remain
  `trusted-only`.

## [0.1.0] - 2026-07-30

First stable Praxis release.

### Added

- The complete interactive and automation command surface, Provider/model
  selection, encrypted credentials, durable session v2, managed extension
  metadata and lifecycle commands, deterministic evaluations, privacy-bounded
  traces, and the native release pipeline introduced by the release candidate.
- CRLF/LF-safe multiline edits with overlapping-match rejection and bounded
  terminal-safe permission previews.
- Explicit read pagination ranges, preferred `grep.pathPattern`, and guarded
  whole-file writes with digest/create-only preconditions and permission
  previews.

### Changed

- Tool batches retain one independently identified result per Tool call even
  when successful and failed read-only calls settle together.
- Edit summaries now identify CRLF/LF-equivalent matching, the replacement line
  ending, and preservation of untouched regions.
- Shell documentation now shows multiline Python, Windows PowerShell, and POSIX
  stdin requests without embedding multiline data in shell quoting.
- Run terminal events now follow durable final memory, usage, and terminal-state
  persistence; finalization failures close the in-memory session and surface one
  redacted persistence failure.
- Runtime and CLI protocol ingress now use the published JSON Schema codec.
  Session creation rejects unknown catalog models, and advertised Anthropic
  output limits match the request adapter.

### Security and privacy

- `write.expectedDigest` detects stale existing targets and `write.createOnly`
  uses exclusive creation. Both remain protected by Runtime-owned high-risk
  authorization.
- Write previews are sanitized and bounded in memory; traces and audit records
  do not gain raw preview content.
- Tool authorization, durable grants, conflict keys, and execution use the same
  canonical target, so workspace junction and symlink aliases cannot bypass an
  outside-read permission decision.
- Linux extensions are enforced only when the documented isolation
  prerequisites exist. Windows, macOS, and unsupported Linux hosts remain
  explicitly `trusted-only`.

### Migration

- Existing `grep.pattern` remains accepted as a deprecated compatibility alias;
  use `pathPattern` in new integrations.
- Existing read and write inputs remain valid. New pagination and digest fields
  are additive.
- Session and credential migrations from the release candidate remain
  forward-only with the documented backup and recovery behavior.

### Known limitations

- Praxis does not create automatic `.bak` files and does not provide a general
  undo operation. Use digest preconditions and repository history where
  available.
- Some terminals cannot distinguish Shift+Enter or Ctrl+Enter; configurable
  alternatives and the external editor remain available.
- Provider catalog entries do not guarantee account or regional entitlement.
- Plugin install, inspect, enable, update, rollback, and uninstall are
  management operations in `v0.1.0`; the default Runtime activates built-ins
  only and does not execute installed external plugin code.
- Provider fallback and reasoning levels are framework/catalog metadata in the
  first release, not configurable production routes or per-session controls.

## [0.1.0-rc.1] - 2026-07-29

First public release candidate.

### Added

- A complete `praxis` command surface for interactive work, print automation,
  Provider authentication, model preferences, session management, diagnostics,
  trace export, and managed plugin operations.
- A daily-driver Ink TUI with a visible grapheme-safe block cursor, multiline
  editing, history draft restoration, searchable Provider/model/session
  pickers, masked credential entry, permission prompts, context pressure, and
  bounded 80/120/160-column layouts.
- Reviewed static catalogs for Kimi, Anthropic, OpenAI Responses, OpenAI Chat,
  local OpenAI-compatible endpoints, and Mock, including the complete reviewed
  Kimi snapshot and per-model capability/output ceilings.
- Encrypted Provider credentials, separately persisted Provider/model
  preferences, durable session v2 recovery/export/trash, and typed JSON or
  stream-JSON automation contracts.
- Immutable managed plugins, Process Providers, MCP Tool extensions,
  provenance verification, supervision/quarantine/rollback, and truthful
  isolation reporting.
- Deterministic evaluations, privacy-bounded traces, package/install smokes,
  supply-chain policy, SBOM/checksum/provenance release stages, and native
  Windows/Linux/macOS artifact matrices.

### Changed

- Bare `praxis` is now the primary installed entry point. Provider connection,
  model selection, and session history are discoverable without memorizing
  slash syntax.
- Ctrl+C aborts an active run but keeps the TUI open; Ctrl+C while idle exits
  and restores terminal state. Forward Delete and Backspace have distinct
  grapheme-safe behavior.
- Explicit invocation selection overrides an available saved model preference;
  authenticated defaults and `mock/mock-v1` provide bounded fallback.

### Security and privacy

- Interactive and stdin login accept one bounded secret line and never expose
  an API-key argument. Credentials use AES-256-GCM with a separate
  user-restricted key file and report the active protection backend.
- Trace files exclude prompts, credentials, environment values, and raw Tool
  input/output. Session history, memory, artifacts, and policy metadata remain
  sensitive local data and are not encrypted.
- Linux extensions use enforced isolation only when `bubblewrap` and `prlimit`
  are available. Windows, macOS, and unsupported Linux hosts report
  `trusted-only`; a supervised process boundary is not an OS sandbox.

### Migration

- Legacy session data migrates to session v2 with checksums and a backup.
  Truncated tail records are recoverable; earlier corruption fails closed.
- Legacy plaintext credential-store records are rewritten to encrypted v2 on
  read. Back up `credentials.json` and `credential.key` together.
- Invalid `settings.json` is treated as no saved preference; selecting a model
  creates a valid replacement without deleting credentials.

### Known limitations

- This is an RC, not a completed public publication. npm/GitHub release and
  post-release installation verification require explicit release
  authorization.
- Provider catalog availability does not guarantee account entitlement for
  every model or region.
- Some terminals cannot distinguish Shift+Enter or Ctrl+Enter. Use
  `PRAXIS_SUBMIT_KEY=ctrl-enter` or Ctrl+E with `VISUAL`/`EDITOR`.
- Session deletion is recoverable trash, but this release has no automatic
  restore command.
- The portable credential backend is not an OS keychain and does not protect
  against code already running as the same OS user.
