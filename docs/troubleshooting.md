# 故障排查 / Troubleshooting

## 中文导读

先运行 `praxis doctor`、`praxis auth status <provider>` 和 `praxis model current`；把占位符替换为
正在使用的 Provider ID，Mock 用户可跳过认证检查。收集机器可读证据时给管理命令添加 `--json`；
不要把凭据粘贴到 Prompt、Issue、Trace 或 Log。

- **认证失败：**核对 Provider ID 与环境变量名。Logout 无法清除父 Shell 的变量；若重启
  后仍认证，手工移除相应环境变量。
- **已保存模型不可用：**认证对应 Provider，检查 `praxis model list --provider <id>`。
  Praxis 会保留偏好并临时回退；只有明确运行 `praxis model set` 才替换偏好。
- **区域 Provider 拒绝 Key：**Qwen Token Plan 和 MiniMax 的国际/中国 ID 与凭据彼此
  隔离；选择匹配的 `*-cn`，Praxis 不会跨区重试。
- **本地或代理 Endpoint 失败：**检查 `PRAXIS_OPENAI_COMPATIBLE_URL`、模型名和 `/v1`
  后缀，并验证 Streaming 与 Tool-call 契约。企业代理应配置 Node 与证书信任，不要关闭
  TLS 校验。
- **Session 无法恢复：**保留整个 Praxis 数据目录和迁移备份。非尾部损坏会 Fail Closed，
  依照 [会话恢复](session-recovery.md) 离线处理。初始化错误会显示稳定错误码（例如
  `PERSISTENCE_INVALID_DATA`），不应再出现无法定位的 `[object Object]`；不要手工删除 authority 或源数据。
- **存储后端不匹配：**`--storage` 不执行转换。先退出所有共用数据根的 Runtime，再运行
  `praxis storage migrate jsonl|sqlite`；不要删除 `session-authority.json` 绕过检查。
- **SQLite 不可用：**当前 Node 必须提供 `node:sqlite`。升级 Node 或继续使用默认 JSONL；Praxis 不会
  静默回退并在错误后写另一份 authority。
- **Auto 没有启动 Child：**先用 `/planner` 确认当前 Session 不是 `solo`。默认 `auto` 把选择权交给根模型，
  不保证每轮创建 Child；用 `/plan` 查看是否出现 delegate/expand Node。
- **Delegate/Expand 失败：**以 `/plan` 或 WORKFLOW 面板中的真实 Node code 为准。Provider 限流和暂时性
  5xx 可以在 Budget 内重试；grant、Profile、Schema、revision 或 Git isolation 失败不会静默 fallback。
  `COMMAND_ARGUMENTS_INVALID` 是 Slash 参数错误，正确写法是 `/planner auto|solo|workflow`。
- **终端按键异常：**终端可能无法区分 Shift+Enter/Ctrl+Enter；可设置
  `PRAXIS_SUBMIT_KEY=ctrl-enter` 或用 Ctrl+E 外部编辑器。活动时 Ctrl+C 中止 Run，
  空闲时以 130 退出并恢复终端。
- **Tool 被拒绝：**检查精确规则与 Canonical Target；项目指令不能授予权限。
- **插件被隔离：**运行 `praxis plugin doctor`，检查有界 stderr、Digest、Isolation 与
  Protocol Version。`trusted-only` 不是 Sandbox，不运行不可信扩展。
- **打包或性能问题：**运行 `verify:supply-chain`、`verify:pack` 与 `release:check`；
  性能比较应使用 Mock Provider 和固定 Budget，不能用单次非受控运行下结论。

Start with:

```sh
praxis doctor
praxis auth status <provider>
praxis model current
```

Replace `<provider>` with the active ID, such as `kimi`, `openai`, or
`anthropic`. Skip the credential check when using `mock`.

Add `--json` to management commands when collecting machine-readable evidence.
Never paste credentials into a prompt, issue, trace, or log.

## 安装与命令找不到 / Installation and command discovery

### `praxis` 不是内部或外部命令 / command not found

在源码仓库根目录重新执行：

```sh
npm ci
npm run install:local
praxis --version
```

`install:local` 会先构建七个 Workspace，再把 `@praxis/cli` 链接为全局命令。若最后一条仍失败：

```sh
npm prefix --global
npm ls --global @praxis/cli
```

Windows 再运行 `Get-Command praxis -All`，Linux/macOS 运行 `command -v praxis`。确认 npm Global Prefix
对应的可执行目录在 `PATH` 中；关闭并重新打开终端，让新 `PATH` 生效。不要通过复制 `dist/cli.js` 到
任意系统目录来“修复”，那会失去 Runtime 和 Workspace 构建约束。

### `install:local` 构建失败

1. 确认 `node --version` 为 20 或更高；
2. 从仓库根目录运行，确保 `package-lock.json` 存在；
3. 先运行 `npm run check`，阅读第一个 TypeScript/格式错误；
4. 若依赖树异常，保留完整错误并重新运行 `npm ci`；不要随意删除 Lockfile；
5. 构建成功后再运行 `npm run install:local`。

### 命令存在但版本不对

```sh
praxis --version
npm ls --global @praxis/cli
```

如果修改源码后行为没有更新，再执行一次 `npm run install:local`。它刷新构建产物和全局链接。
从私有 Registry 安装的版本与源码链接是两种来源；排查时一次只保留一个明确来源。

## 一分钟分诊 / One-minute triage

| 症状 | 先运行 | 接着读 |
| --- | --- | --- |
| 找不到命令 | `npm run install:local` | 本节 |
| Key 或登录失败 | `praxis auth status <provider>` | [Provider 配置](provider-setup.md) |
| 模型没有按预期选择 | `praxis model current` | Provider 配置 |
| Session 找不到/损坏 | `praxis session list`、`praxis doctor` | [会话恢复](session-recovery.md) |
| `SESSION_STORE_SWITCH_REQUIRES_IMPORT` | 停止 Runtime 后运行 `praxis storage migrate <target>` | [会话恢复](session-recovery.md) |
| `SESSION_STORE_MIGRATION_RUNTIME_ACTIVE` | 关闭共用数据根的 TUI/server/CLI | [会话恢复](session-recovery.md) |
| Auto 没有启动 Child | `/planner`，确认不是 `solo` | [Workflow](workflow-platform.md) |
| `WORKFLOW_*` / `WORKSPACE_*` | `/plan`，查看真实 Node/terminal code | [Workflow](workflow-platform.md) |
| Tool 被拒绝 | 记录 rule 与 canonical target | [工具策略](tool-policy.md) |
| 插件不可用 | `praxis plugin doctor` | [插件系统](plugin-system.md) |
| 自动化返回非零 | 查看[退出码](cli-reference.md#exit-codes) | [CLI 参考](cli-reference.md) |

## 认证与模型选择 / Authentication and model selection

- **Authentication fails:** confirm the Provider ID and environment-variable
  name in [Provider setup](provider-setup.md). `auth status` distinguishes
  stored, environment, and unauthenticated sources without showing a key.
- **Logout appears ineffective after restart:** `auth logout` removed the
  stored credential, but it cannot unset a variable in the parent shell.
  Remove the Provider variable there, such as `MOONSHOT_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY`,
  `QWEN_TOKEN_PLAN_CN_API_KEY`, `MINIMAX_API_KEY`, or `MINIMAX_CN_API_KEY`.
- **A saved model is unavailable:** run `praxis model current`, authenticate
  its Provider, and inspect `praxis model list --provider <id>`. Praxis keeps
  the saved preference but temporarily falls back when the Provider or catalog
  entry is unavailable. Use `praxis model set` to replace it deliberately.
- **Kimi or another account rejects one catalog model:** this can be an account
  entitlement or regional availability issue. Choose another listed model;
  Praxis reports this as `PROVIDER_MODEL_UNAVAILABLE` rather than deleting the
  preference.

## Endpoint、代理与流式错误 / Endpoint, proxy, and streaming errors

- **Local model unavailable:** verify
  `PRAXIS_OPENAI_COMPATIBLE_URL` and `PRAXIS_OPENAI_COMPATIBLE_MODEL`, then test
  that endpoint's OpenAI-compatible streaming and Tool-call behavior.
- **OpenAI-compatible proxy fails:** check whether the URL needs the `/v1`
  suffix. `OPENAI_BASE_URL` affects `openai-chat` and is also a fallback for
  the local adapter; `PRAXIS_OPENAI_COMPATIBLE_URL` is more specific.
- **Regional Provider rejects a key:** Qwen Token Plan and MiniMax use different
  Provider IDs and credentials for international and China endpoints. Select
  the matching `*-cn` ID; Praxis never retries a regional credential against
  the other region.
- **Corporate proxy/TLS failure:** Praxis does not implement a separate proxy
  bypass. Configure the Node process and certificate trust according to your
  organization, then use `doctor`. Do not disable TLS verification.
- **Repeated retry/circuit messages:** preserve the error category and
  rate-limit metadata. Runtime, not the Provider SDK, owns retry and circuit
  behavior.

## 设置与会话恢复 / Settings and session recovery

- **Corrupted `settings.json`:** stop Praxis, back up the file, then rename it.
  Invalid JSON is treated as no preference; choose a model again to create a
  valid file. Credentials are separate and must not be deleted.
- **Session will not resume:** preserve the entire Praxis data directory and
  migration backup. A corrupt non-tail record fails closed. Follow
  [session recovery](session-recovery.md).
- **Delete recovery:** session delete moves history and memory to trash and
  reports the exact path. There is no automatic restore command in this
  release.

## 启动和 TUI 卡顿 / Startup and TUI latency

- **升级后的第一次启动较慢：**旧版 JSONL Store 没有增量 Catalog 状态标记。新版会且只会在第一次
  启动时重放全部 Commit，生成已校验的 `catalog.json`、`catalog-state.json`、
  `catalog-delta.jsonl`、Projection 和 pending 恢复索引。让这次升级完整结束；后续普通启动只读取
  快速路径，不再扫描全部会话。
- **每次启动都慢：**先确认运行的是刚构建/安装的版本，并运行 `praxis doctor --json`。不要删除或手工
  修改 `session-journal-v3` 中的 Catalog、Projection、delta、state 或 pending 文件。若快速路径报告
  损坏，先停止所有共享该数据目录的 Runtime、备份整个 `PRAXIS_HOME`，再运行一次
  `praxis doctor --deep`。该命令会故意做全量重放，所以本身可能较慢。
- **输入或 Spinner 卡顿：**新版 TUI 把 Transcript 与 Composer 分成独立 memo 树，稳定历史进入终端原生
  scrollback，80 ms Spinner tick 只刷新 Footer。若仍能稳定复现，记录终端尺寸、会话消息量、
  当前版本，以及卡顿发生在空闲输入还是模型流式输出阶段；不要用 `doctor --deep` 的运行时间衡量交互
  延迟。
- **Workflow 失败原因不清楚：**TUI 的 `WORKFLOW` 面板直接读取 SQLite projection；Child 期限耗尽时应显示
  结构化 deadline code。如果只看到模型生成的失败说明而没有该错误码，请先确认客户端与 Runtime
  来自同一次构建。

## 终端输入 / Terminal input

- **Shift+Enter inserts or sends unexpectedly:** terminals differ in whether
  they report Shift+Enter. Set `PRAXIS_SUBMIT_KEY=ctrl-enter` to use Ctrl+Enter
  for submit and Enter for newline.
- **Ctrl+Enter is indistinguishable from Enter:** use the default bindings or
  an external editor with Ctrl+E. This terminal limitation cannot be inferred
  reliably at runtime.
- **No external editor opens:** set `VISUAL` or `EDITOR` to an executable
  command.
- **Ctrl+C:** one press aborts an active run and leaves the TUI open; one press
  while idle exits with code 130 and restores terminal state.

## 工具与扩展 / Tools and extensions

- **Tool denied:** inspect the exact requested rule and canonical target.
  Update a policy deliberately; project instructions cannot grant access.
- **Plugin quarantined:** run `praxis plugin doctor`, inspect bounded stderr,
  digest, isolation status, and protocol version. Disable it before rollback.
- **`trusted-only`:** the host lacks an enforced isolation backend. Linux needs
  `bubblewrap` and `prlimit` for the enforced path. On Windows and macOS, or
  when those tools are absent, do not run untrusted extensions. A supervised
  process boundary is not an OS sandbox.

## 打包与性能 / Packaging and performance

- Run `npm run verify:supply-chain`, `npm run verify:pack`, and
  `npm run release:check -- --tag v<version>` from a release checkout.
- Reproduce performance issues with the Mock Provider and compare the fixed
  metrics in `performance-budgets.json`; do not infer improvements from one
  uncontrolled run.
## 远程 Workflow Authority

若启动时报 `WORKFLOW_AUTHORITY_TOKEN_REQUIRED`，请为 Authority 和 Worker 设置相同的、至少 32 字符的 `PRAXIS_WORKFLOW_AUTHORITY_TOKEN`。服务端设置 `PRAXIS_WORKFLOW_AUTHORITY_LISTEN=HOST:PORT`，远程端设置 `PRAXIS_WORKFLOW_AUTHORITY_URL=http://HOST:PORT`；不要在同一进程同时设置 URL 和 LISTEN。

`WORKFLOW_AUTHORITY_UNAUTHORIZED` 表示 token 不一致；`WORKFLOW_AUTHORITY_REMOTE_FAILED` 表示网络或 Authority 不可用。租约到期后安全 Task 会由恢复 pump 重试；未知副作用仍需 `workflow.resolve-unknown`，网络恢复不能自动证明外部动作未发生。
