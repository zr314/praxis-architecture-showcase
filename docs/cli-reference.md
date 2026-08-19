# CLI 参考 / CLI Reference

> 中文导读说明用户如何选择命令；下方英文参考保留 CLI Token、参数和表格的精确拼写。
> The Chinese guide explains how to choose an operation. The English reference
> below preserves the exact CLI tokens, options, and tables.

## 中文导读

- 直接运行 `praxis` 进入交互式 TUI；使用 `--print` 运行一次性任务，使用
  `--output-format stream-json` 获取自动化事件流。
- 凭据由 `praxis auth status|login|logout` 管理；模型由
  `praxis model list|current|set` 管理。API Key 不允许放进命令行参数。
- 会话由 `praxis session list|search|show|rename|fork|branch|export|delete`
  管理。`branch` 指 Praxis 会话树，不是 Git 分支。
- 新 Session 默认使用统一 `auto` Workflow 和 V3 JSONL，无需先执行 `/planner auto`；TUI 右侧
  `PLANNER` 显示实际策略。`--planner`/`/planner` 只在需要时覆盖 `auto|solo|workflow` policy，
  `--storage` 选择 Session 后端；Workflow authority 固定使用独立 SQLite。
- `praxis doctor` 检查 Runtime、Provider、凭据、目录和扩展状态；
  `praxis trace export` 只导出脱敏诊断记录。
- 插件命令覆盖安装、检查、启用、禁用、权限、诊断、更新、回滚和卸载；资源命令只处理
  已显式信任并固定 Digest 的 Skill/数据资源。
- TUI 中输入 `/` 可发现 Slash Command；`/provider`、`/model`、`/session` 等命令打开
  可搜索选择器。`Ctrl+C` 中止活动 Run，空闲时退出。
- 默认 Enter 提交、Shift+Enter 换行；若终端不能区分，可设置
  `PRAXIS_SUBMIT_KEY=ctrl-enter`。
- 退出码 `0/1/2/3/4/5/130` 分别覆盖成功、Runtime/Provider/存储或 Run 失败、参数错误、认证、策略、
  deadline/timeout/cancellation/abort，以及用户在 print/TUI 中中止。精确映射见下方表格。
- 选择优先级为显式参数、可用的已保存偏好、已认证 Provider 默认值、最后
  `mock/mock-v1`。
- 所有持久化数据位于 `PRAXIS_HOME`；凭据、设置、会话历史、策略审计和 Trace 分开保存，
  原始 Prompt 和工具 Payload 不进入 Trace。

This reference describes the current command installed as `praxis`.
Run `praxis --help` or `<command> --help` for the authoritative local synopsis.

## Global invocation

```text
praxis [options] [command]
```

With no command and no `--print`, Praxis opens the interactive TUI.

| Option | Meaning |
| --- | --- |
| `-V`, `--version` | Print the CLI package version. |
| `-p`, `--print <prompt>` | Run one prompt without the TUI. |
| `--output-format <text\|json\|stream-json>` | Select print-mode output; default `text`. |
| `--provider <id>` | Select the new session Provider and save the resulting preference. |
| `--model <id>` | Select the new session model and save the resulting preference. |
| `--session <id>` | Resume an exact durable session without overriding its persisted Planner. |
| `--planner <auto\|solo\|workflow>` | Override the initial mode policy for a newly created session. Omit it for the default `auto`. Legacy `direct/supervisor` map to `solo/workflow`. |
| `--storage <jsonl\|sqlite>` | V3 backend this Runtime expects; default `jsonl` on a new data root. |
| `--context-tokens <count>` | Positive session context-token limit. |
| `--max-turns <count>` | Positive Provider-turn budget. |
| `--max-tool-calls <count>` | Non-negative Tool-call budget. |
| `--max-tokens <count>` | Positive total run-token budget. |
| `--timeout-ms <milliseconds>` | Positive run deadline. |
| `--policy-file <path>` | Reviewed non-interactive Tool policy JSON. |
| `-h`, `--help` | Show help. |

Put global session/print options before a subcommand. Provider/model options
under `model list` are subcommand options, not session selection.

## Management commands

Management commands print human-readable text by default. Commands with
`--json` emit exactly one JSON value and no decorative text. Plugin, resource,
and trace-export commands use JSON output directly.

### Credentials

```text
praxis auth status [provider] [--json]
praxis auth login [provider] [--stdin] [--json]
praxis auth logout [provider] [--json]
```

The Provider defaults to `kimi`. Interactive login reads one masked line;
`--stdin` reads one bounded line without echoing it. No API-key argument exists.

### Models

```text
praxis model list [--provider <id>] [--json]
praxis model current [--json]
praxis model set <provider> <model> [--json]
```

`model list` reports the reviewed static catalog. `model set` requires an exact
catalog entry and an authenticated Provider and persists the non-secret pair.

### Sessions

```text
praxis session list [--workspace <path>] [--json]
praxis session search <query> [--json]
praxis session show <id> [--json]
praxis session rename <id> <name> [--json]
praxis session fork <id> [--name <name>] [--through-message <count>] [--json]
praxis session branch <id> [--json]
praxis session export <id> --output <path> [--force] [--json]
praxis session delete <id> [--yes] [--json]
```

`session list --workspace` compares the exact canonical workspace. Delete creates
one new portable V3 export at the reported trash path, then journals a tombstone;
it does not move an existing export, and there is no one-command restore. In a
non-interactive process `--yes` is mandatory.

### Session storage

```text
praxis storage migrate <target> [--home <path>] [--json]
```

`<target>` must be `jsonl` or `sqlite`.

This is an offline, verified, single-authority migration. Stop every Praxis
Runtime using the data root first. The command refuses live Runtime leases,
exports the source, imports and checksums an isolated target, retains the old
authority under `migration-backups/`, then atomically activates the target.
It never enables live switching or dual writes. `--storage` alone does not
migrate an existing authority; a mismatch fails closed.

### Diagnostics and traces

```text
praxis doctor [--workspace <path>] [--deep] [--json]
praxis trace export <traceId> --output <directory>
```

普通 `doctor` 只检查启动快速路径和当前服务健康，不扫描全部历史。`doctor --deep`
会显式重放并校验所有 SessionJournal Commit：JSONL 会重建 Projection、Catalog 基表和恢复索引，
SQLite 会执行 `PRAGMA integrity_check` 并核对持久化 Projection。数据量大时该命令会明显变慢，
应在没有其他 Runtime 使用同一 `PRAXIS_HOME` 时运行。

Doctor checks Runtime, Provider, storage, and isolation health. Trace export
contains bounded diagnostic records and an exclusion manifest; it does not
contain prompts, credentials, environment values, or raw Tool payloads.

### Extensions

```text
praxis plugin install <source>
praxis plugin list [--workspace <path>]
praxis plugin inspect <id> [--version <version>]
praxis plugin enable <id> --version <version> [--workspace <path>] [--grants <json>]
praxis plugin disable <id> [--workspace <path>]
praxis plugin permissions <id> [--workspace <path>]
praxis plugin doctor
praxis plugin update <source> [--workspace <path>] [--grants <json>]
praxis plugin rollback <id> [--workspace <path>]
praxis plugin uninstall <id> --version <version>
```

`--grants` must be a JSON array of strict filesystem, network, environment,
process, or resource grant objects; unknown types and fields are rejected
before approval. Installations are immutable and
content-addressed; enablement is per canonical workspace and fixed version.
`trusted-only` means the host cannot enforce the requested OS isolation.
On such a host, the explicit `plugin enable` or `plugin update` action is the
approval to execute that selected process-plugin digest with user-process
authority; installation alone never executes it.
Inspection distinguishes `installed`, `workspace-enabled`, `starting`,
`healthy`, `degraded`, `quarantined`, and `stopped`. Enabled local MCP stdio
Tools and Praxis process Tool/Provider plugins are started and health-gated by
Runtime; only `healthy` capabilities from the selected digest enter a run
snapshot. Process Tool calls still cross Runtime policy, and Process Provider
streams still cross Runtime routing, usage, budget, cancellation, and Session
finalization. Quarantine removes a plugin without reconnecting until an
explicit enable, update, or rollback creates a new selection. Data-only Skills
can be activated through the resource commands below.

### Skills and data resources

```text
praxis resource list [--workspace <path>]
praxis resource inspect <id> [--workspace <path>] [--content]
praxis resource enable <id> [--workspace <path>] [--trust-project]
praxis resource disable <id> [--workspace <path>]
```

Project Skills are discovered from `.praxis/skills`, `.agents/skills`, and
`.claude/skills`. Enabling one requires `--trust-project` and persists its exact
origin and SHA-256 content digest; a changed file is not silently substituted.
Unresolved IDs are rejected rather than resolved by search order. Installed
data-only plugins expose only paths declared in their manifest.

An enabled Skill is disclosed to the model by bounded identity, name,
description, and invocation metadata. Use `$<name> [arguments]` at the start of
a prompt for explicit invocation. Full content is loaded through the dedicated
`skill` Tool from the immutable run snapshot, not through generic file access.
`disable-model-invocation: true` blocks model-selected invocation while keeping
explicit `$skill` invocation available.

## Slash commands

Type `/` in the TUI to browse these commands.

| Command | Behavior |
| --- | --- |
| `/new [name]` | Create a clean session using the current Provider/model. |
| `/resume <id>` | Resume an exact session. |
| `/session [query]` | Open searchable resume history. |
| `/provider [id]` | Browse Providers or open one Provider's models. |
| `/login [provider]` | Open isolated masked credential entry. |
| `/logout [provider]` | Remove a stored credential. |
| `/model [provider/model]` | Browse or select an exact model. |
| `/compact [focus]` | Compact current session context without deleting original history. |
| `/context` | Show checkpoint range, token estimates, and compaction provenance. |
| `/plan` | Show the current plan JSON. |
| `/planner [auto\|solo\|workflow]` | With no argument, inspect the active policy; with an argument, override the next run. New sessions already default to `auto`; idle sessions only. |
| `/storage` | Read the process-wide V3 backend/root; live switching is disabled. |
| `/artifacts` | List stored artifacts. |
| `/copy` | Copy the latest assistant response. |
| `/export <path>` | Export the current session JSON. |
| `/doctor` | Show workspace diagnostics. |

Arguments containing spaces may use single or double quotes. Unknown commands
do not execute a prompt; they return the discoverable command list.

Enabled prompt templates and Skills add only namespaced
`/prompt:<name>` and `/skill:<name>` commands. They are digest-pinned when
listed and re-enter the normal PromptEnvelope/Planner path when invoked.

Enabled healthy plugins may add explicit namespaced commands such as
`/plugin:example.echo-tool/echo hello`. MCP and process Tool discovery does not
create slash commands by default. A mapped command is listed only when its
installed manifest declares the mapping and the live Tool schema is compatible;
its result is a bounded job whose ID is the stored result artifact. Mappings
never receive an unqualified alias and cannot replace built-in commands.

## Keybindings

### Editor

| Key | Action |
| --- | --- |
| Enter | Submit by default; accept a highlighted slash completion first. |
| Shift+Enter | Insert newline by default. |
| Left/Right | Move by grapheme; Ctrl/Alt+Left/Right moves by word when reported by the terminal. |
| Up/Down | Move within multiline input, then browse history; navigate slash suggestions when visible. |
| Home/End | Move to the current logical line edge. |
| Backspace | Delete the previous grapheme. |
| Delete | Delete the next grapheme. |
| Tab | Accept slash completion. |
| Ctrl+E | Edit the draft with `VISUAL` or `EDITOR`. |
| Ctrl+L | Open the model picker while idle. |
| Ctrl+P / Ctrl+Shift+P | Cycle available models forward/backward while idle. |
| Ctrl+C | Abort an active run; close a picker; or exit while idle. |

Set `PRAXIS_SUBMIT_KEY=ctrl-enter` to make Ctrl+Enter submit and Enter insert a
newline. Some terminals collapse Shift+Enter or Ctrl+Enter to plain Enter;
choose the binding the terminal can distinguish or use Ctrl+E.

### Run log

Praxis stays on the terminal's main screen and never captures the mouse. The
memoized Transcript grows into native terminal scrollback while Composer and
Spinner update in a separate footer subtree, so the mouse wheel and normal text
selection continue to work during streaming. Durable history is still owned by
the SessionJournal; use `/transcript`, Session resume/export, or another protocol
client if the terminal emulator has discarded old scrollback. `/copy` is
available when selecting text is inconvenient.

Interactive runs allow 128 cumulative Provider turns and 512 Tool calls by default. Planner,
child Runtime, and parent synthesis usage share this ceiling. A
non-interactive run can override those limits with `--max-turns` and
`--max-tool-calls`.

### Pickers and permissions

Provider, model, and session pickers use Up/Down, PageUp/PageDown, Home/End,
typing to search, Backspace to edit/go back, Enter to select, and Escape to
close or return. Model view uses Tab to toggle available/all entries.

The credential view is isolated from normal editor history: text is masked,
Ctrl+U clears it, Escape returns and clears memory, and Enter connects.

Permission prompts use `A` (allow once), `W` (persist the exact Runtime-derived
rule), and `D` (deny).

## Output formats

- `text` prints only accumulated assistant text and a final newline.
- `json` prints one object:
  `{ "schemaVersion": 1, "kind": "result", "text": "...", "terminal": {...} }`.
- `stream-json` prints one JSON object per line. Every envelope contains
  `schemaVersion: 1`, a strictly increasing `sequence`, `kind`, and `event`;
  terminal completion with usage emits both `usage` and `terminal` envelopes.

Non-interactive Tool requests default to deny. A policy file must match the
exact Tool and target; see [Tool policy](tool-policy.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command or run completed successfully. |
| `1` | Runtime/Provider/storage failure, failed prompt, or unhealthy doctor result. |
| `2` | CLI usage or invalid-parameter error. |
| `3` | Authentication/secure-input requirement. |
| `4` | Permission or policy denial surfaced as a command error. |
| `5` | Deadline, timeout, cancellation, or abort surfaced as a command error. |
| `130` | User cancellation or an aborted print/TUI run. |

No stable contract relies on localized human-readable error prose. Scripts
should use the exit code plus `--json` or `stream-json`.

## Selection precedence

Credentials:

```text
current login/configuration value
  -> encrypted Provider-scoped store
  -> Provider environment variable
  -> unauthenticated
```

New-session Provider/model selection:

```text
explicit invocation
  -> available saved preference
  -> authenticated default Provider/model
  -> mock/mock-v1
```

Credential storage and model preference storage are deliberately separate.

## Data and configuration

The data root is `PRAXIS_HOME` when set, otherwise `~/.praxis` (the current
user profile on Windows). Files and directories are created on demand.

| Path under the data root | May contain | Secret treatment |
| --- | --- | --- |
| `session-authority.json` | Checksummed selection of the one V3 backend | Operational metadata |
| `session-journal-v3/` | Default JSONL commits, projections, catalog, and journal artifacts | Sensitive content; not encrypted |
| `session-journal-v3.sqlite` | Explicit SQLite authority, mutually exclusive with JSONL | Sensitive content; not encrypted |
| `migration-backups/` | Legacy-v2 and backend-cutover recovery copies | Sensitive content; not encrypted |
| `artifacts/*.json` | Arbitrary generated or oversized Tool output | Sensitive content; not encrypted |
| `settings.json` | Last selected Provider/model and timestamp | Non-secret preference; not encrypted |
| `credentials.json` | Credential metadata plus AES-256-GCM nonce/ciphertext/tag | Encrypted at rest |
| `credential.key` | Local encryption key | Secret; user-restricted file, separate from ciphertext |
| `policy-grants.json` | Persisted exact authorization rules | Security-sensitive metadata; not encrypted |
| `policy-audit.jsonl` | Redacted authorization decisions and targets | Security-sensitive metadata; no raw credential |
| `traces/YYYY-MM-DD/*.jsonl` | Bounded timing/status/error metadata | Excludes prompts, credentials, environment, and raw Tool payloads |
| `extensions/` | Installed plugin code, manifests, digests, workspace enablement/grants | Executable and security-sensitive; not encrypted |
| `trash/session-journal-v3/` | Portable export written before a session tombstone | Same sensitivity as the source Session |
| `locks/` | Session writers, Runtime leases, and migration ownership | Operational metadata |

The key-file backend is portable encryption, not an OS keychain and not a
sandbox. Back up or remove the whole data root according to its most sensitive
content.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PRAXIS_HOME` | Override the Runtime data directory. |
| `PRAXIS_PLANNER_MODE` | Initial policy for new sessions (`auto`, `solo`, or `workflow`); normally set by `--planner`. |
| `PRAXIS_PROMPT_VARIANT` | Prompt program override (`iron-law-lean-v1` default; `baseline-v1` rollback/A-B). Unknown values are rejected. |
| `PRAXIS_SESSION_STORE` | Expected V3 authority (`jsonl` or `sqlite`); normally set by `--storage`. |
| `PRAXIS_SUBMIT_KEY` | Set to `ctrl-enter` to swap submit/newline bindings. |
| `MOONSHOT_API_KEY` | Kimi fallback credential. |
| `DEEPSEEK_API_KEY` | DeepSeek fallback credential. |
| `PRAXIS_DEEPSEEK_BASE_URL` | DeepSeek endpoint; defaults to `https://api.deepseek.com`. |
| `ANTHROPIC_API_KEY` | Anthropic fallback credential. |
| `OPENAI_API_KEY` | OpenAI Responses and `openai-chat` fallback credential. |
| `QWEN_TOKEN_PLAN_API_KEY` | Qwen Token Plan international credential. |
| `QWEN_TOKEN_PLAN_CN_API_KEY` | Qwen Token Plan China credential. |
| `MINIMAX_API_KEY` | MiniMax international credential. |
| `MINIMAX_CN_API_KEY` | MiniMax China credential. |
| `OPENAI_BASE_URL` | `openai-chat` endpoint; local-adapter fallback endpoint. |
| `OPENAI_CHAT_MODEL` | `openai-chat` default model. |
| `PRAXIS_OPENAI_COMPATIBLE_URL` | Local OpenAI-compatible endpoint. |
| `PRAXIS_OPENAI_COMPATIBLE_MODEL` | Local OpenAI-compatible model ID. |
| `PRAXIS_OPENAI_COMPATIBLE_API_KEY` | Optional local/proxy credential. |
| `VISUAL`, `EDITOR` | External editor command, in that order. |

Praxis does not load `.env` files. Environment credentials are process input;
they are not copied into the encrypted store unless the user explicitly logs
in with that value.
