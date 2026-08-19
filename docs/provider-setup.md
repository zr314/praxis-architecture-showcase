# Provider 配置 / Provider Setup

Praxis 通过统一流式契约规范化所有内置 Provider。TUI 使用 `/login` 和 `/model`；脚本使用
`praxis auth` 和 `praxis model`。下表中的 Provider ID、环境变量和 Endpoint 是精确值，
不翻译。

Praxis normalizes built-in Providers through one streaming contract. Use
`/login` and `/model` in the TUI, or `praxis auth` and `praxis model` in scripts.

## 新手先选哪个 / Which Provider should a beginner choose?

如果你只是确认安装是否成功，选 `mock`：它完全离线、结果确定，也不会产生 API 费用。如果你已经
拥有某家服务的 Key，就选择与账号区域完全一致的 Provider；不要仅凭模型名称猜测区域。

| 你的情况 | 建议 | 原因 |
| --- | --- | --- |
| 第一次运行、尚无 Key | `mock/mock-v1` | 验证 CLI、Runtime、协议和会话主链，不访问网络 |
| DeepSeek API | `deepseek/deepseek-v4-flash` | V4 Flash 成本较低，支持思考模式和 Tool calls |
| Kimi 中国站账号 | `kimi` | 使用 Moonshot 中国 Endpoint |
| OpenAI 官方 Responses API | `openai` | 使用原生 Responses 适配器 |
| OpenAI Chat 兼容网关 | `openai-chat` | 可用 `OPENAI_BASE_URL` 指定网关 |
| Ollama、LM Studio、vLLM | `openai-compatible` | 默认连接本机 `127.0.0.1:11434/v1` |
| Qwen/MiniMax | 与账号区域匹配的普通或 `-cn` ID | Praxis 不会拿一个区域的 Key 去另一区域重试 |

不确定时，先完成这个离线测试：

```sh
praxis --provider mock --model mock-v1 --print "provider smoke"
```

成功时会输出一段 Mock 文本并以退出码 `0` 结束。它只能证明本地主链正常，不能证明真实 Provider
的账号、网络和模型权限正常。

| Provider ID | API family | Credential or endpoint |
| --- | --- | --- |
| `deepseek` | OpenAI-compatible chat | `DEEPSEEK_API_KEY`; `https://api.deepseek.com` |
| `kimi` | OpenAI-compatible chat | `MOONSHOT_API_KEY`; `https://api.moonshot.cn/v1` |
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI Responses | `OPENAI_API_KEY` |
| `openai-chat` | OpenAI-compatible chat | `OPENAI_API_KEY`; optional `OPENAI_BASE_URL` |
| `qwen-token-plan` | OpenAI-compatible chat | `QWEN_TOKEN_PLAN_API_KEY`; Alibaba Cloud international Token Plan |
| `qwen-token-plan-cn` | OpenAI-compatible chat | `QWEN_TOKEN_PLAN_CN_API_KEY`; Alibaba Cloud China Token Plan |
| `minimax` | Anthropic Messages-compatible | `MINIMAX_API_KEY`; MiniMax international |
| `minimax-cn` | Anthropic Messages-compatible | `MINIMAX_CN_API_KEY`; MiniMax China |
| `openai-compatible` | Local OpenAI-compatible chat | optional `PRAXIS_OPENAI_COMPATIBLE_API_KEY`; default `http://127.0.0.1:11434/v1` |
| `mock` | deterministic local adapter | none |

For the local adapter, override the endpoint and model with
`PRAXIS_OPENAI_COMPATIBLE_URL` and `PRAXIS_OPENAI_COMPATIBLE_MODEL`. Ollama,
LM Studio, and vLLM are usable only when their endpoint matches the supported
OpenAI chat streaming and Tool-call contract.

本地适配器通过上述两个 `PRAXIS_OPENAI_COMPATIBLE_*` 变量覆盖 Endpoint 和模型。Ollama、
LM Studio 与 vLLM 只有在兼容当前 OpenAI Chat Streaming 和 Tool-call 契约时才能使用。

## 安全连接 / Connect securely

推荐的交互命令不会把 API Key 暴露在 Shell 历史中。输入框关闭终端 Echo，只接受一行有界
内容。Praxis 故意不提供 `--api-key <value>`，因为参数可能出现在 Shell History 和进程
列表。

The recommended interactive command does not expose the key in shell history:

```sh
praxis auth login kimi
```

The prompt disables terminal echo and accepts one bounded line. Praxis
intentionally has no `--api-key <value>` option because command-line arguments
can appear in shell history and process listings.

For automation, pass exactly one line on standard input:

自动化场景从 stdin 传入恰好一行：

```powershell
Get-Content -Raw .\moonshot-key.txt | praxis auth login kimi --stdin
```

```sh
printf '%s\n' "$MOONSHOT_API_KEY" | praxis auth login kimi --stdin
```

The same command accepts every built-in Provider ID, for example:

```sh
praxis auth login openai
praxis auth login deepseek
praxis auth login openai-chat
praxis auth login anthropic
praxis auth login qwen-token-plan
praxis auth login qwen-token-plan-cn
praxis auth login minimax
praxis auth login minimax-cn
```

`openai-compatible` usually points at a local service and can run without a Key. Configure its Endpoint/model before
starting Praxis:

```powershell
$env:PRAXIS_OPENAI_COMPATIBLE_URL='http://127.0.0.1:11434/v1'
$env:PRAXIS_OPENAI_COMPATIBLE_MODEL='your-local-model-id'
praxis --provider openai-compatible --model $env:PRAXIS_OPENAI_COMPATIBLE_MODEL --print "local smoke"
```

For non-interactive secret input, the same Provider IDs work with stdin:

```sh
printf '%s\n' "$QWEN_TOKEN_PLAN_CN_API_KEY" | praxis auth login qwen-token-plan-cn --stdin
printf '%s\n' "$MINIMAX_CN_API_KEY" | praxis auth login minimax-cn --stdin
```

DeepSeek 的当前静态目录只包含仍在服务的 `deepseek-v4-flash` 和
`deepseek-v4-pro`。旧名 `deepseek-chat`、`deepseek-reasoner` 已于
2026-07-24 退役，不会作为可选模型暴露。V4 思考模式的 Tool-call 历史要求回传
`reasoning_content`；Praxis 的专用适配器会保留该字段，结构化 planner/verifier
需要强制 Tool choice 时则自动切到非思考模式。

```sh
praxis auth status deepseek
praxis model list --provider deepseek
praxis --provider deepseek --model deepseek-v4-flash --print "只回复 connected"
```

Never enable shell tracing around these commands. Prefer a secret manager over
a plaintext key file.

这些命令周围绝不能开启 Shell Trace；优先使用 Secret Manager，不要长期保存明文 Key。

### 第一次连接检查清单 / First connection checklist

以 Kimi 为例，其他 Provider 只需替换 ID：

```sh
praxis auth login kimi
praxis auth status kimi
praxis model list --provider kimi
praxis model set kimi <复制上一步列出的-model-id>
praxis model current
praxis --provider kimi --print "只回复 connected"
```

逐步判断：

1. `auth status` 应显示凭据来源，但绝不会回显 Key；
2. `model list` 只证明本地 Catalog 认识这些模型，不保证你的账号有权限；
3. `model current` 应显示刚选的 Provider/模型；
4. 最后一条命令才同时验证网络、凭据、模型权限和流式适配；
5. 若失败，先保留错误类别，再运行 `praxis doctor`，然后查阅[故障排查](troubleshooting.md)。

Do not paste a key into a prompt or diagnostic report. `auth status` is the safe
way to report where a credential came from without revealing it.

## 凭据优先级与持久化 / Credential precedence and persistence

凭据解析与模型选择彼此独立，顺序为：当前登录操作显式提供的凭据、Provider Scope 的加密
存储、对应环境变量，最后为未认证。加密存储位于
`${PRAXIS_HOME:-~/.praxis}/credentials.json`。

Credential resolution is independent from model selection:

1. A credential supplied to the current login/configuration operation.
2. The Provider-scoped encrypted credential in
   `${PRAXIS_HOME:-~/.praxis}/credentials.json`.
3. The Provider environment variable listed above.
4. Unauthenticated, if none exists.

Interactive login saves the credential encrypted with AES-256-GCM. The current
portable backend is `aes-256-gcm-key-file`; its separate `credential.key` is
restricted to the current OS user where POSIX permissions are available. This
is encrypted at rest but is not an OS keychain or protection against malware
running as the same user. Check the active backend without revealing the key:

```sh
praxis auth status kimi
```

`praxis auth logout kimi` removes only the stored Kimi credential and clears it
from that Runtime. It cannot edit the parent shell. If `MOONSHOT_API_KEY`
remains set, the next Praxis process can authenticate from the environment
until the variable is unset.

交互登录以 AES-256-GCM 加密保存凭据。当前便携后端使用独立 `credential.key`；它提供
静态加密，但不是 OS Keychain，也不能防御同一用户权限下的恶意软件。Logout 只移除存储
凭据，不能清除父 Shell 中仍然存在的环境变量。

## 模型优先级与恢复 / Model precedence and restoration

新 Session 按以下顺序选择 Provider/模型：显式参数；仍存在且已认证的 `settings.json`
偏好；已认证默认 Provider 的默认模型；最后 `mock/mock-v1`。

New sessions choose Provider/model state in this order:

1. Explicit `--provider` and/or `--model` invocation options.
2. The saved Provider/model pair in `settings.json`, but only when its catalog
   entry still exists and its Provider is authenticated.
3. The default model of an authenticated default Provider (Kimi when connected).
4. `mock/mock-v1` as the offline fallback.

Selecting a model in the TUI or running `praxis model set <provider> <model>`
updates the non-secret preference. If the saved entry is removed, unavailable,
or unauthenticated, Praxis emits one bounded warning, uses an available
default, and leaves the saved value unchanged so reconnecting can restore it.

TUI 选择或 `praxis model set` 会更新非秘密偏好。保存项被删除、暂不可用或未认证时，Praxis
只发出一条有界 Warning，临时使用可用默认值，并保留原偏好以便重新连接后恢复。

Inspect and change the preference:

```sh
praxis model current
praxis model list --provider kimi
praxis model set kimi kimi-k2.6
```

## Catalog 与诊断 / Catalog and diagnostics

Praxis 使用经审阅、构建时固定的静态模型 Catalog，启动时不下载或信任远程模型列表。Qwen
Token Plan 与 MiniMax 使用独立国际/中国 Provider ID，凭据和区域 Endpoint 不会隐式切换。
MiniMax 的区域 Provider ID、endpoint、凭据环境变量与默认模型集中定义在 `apps/runtime/src/providers/minimaxConfig.ts`；新增或调整区域时从该表派生 Provider factory、credential resolution 和 model catalog 注册，避免多处手工同步。

Praxis uses a reviewed, build-time static model catalog. It does not download
or trust a remote model list at startup. Entries record their API family,
source, retrieval date, aliases, lifecycle, context/output ceilings, reasoning
levels, and modalities. The Kimi snapshot includes all reviewed Moonshot China
entries, not only the default. Qwen Token Plan and MiniMax use separate
international and China Provider IDs so credentials and regional endpoints
never switch implicitly. Their reviewed snapshots follow Pi's generated
`2026-07-27` catalogs; Praxis includes five Qwen-native Token Plan models and
three direct MiniMax models whose compatibility is covered by the current
adapters.

Run:

```sh
praxis doctor
praxis model list
```

Runtime owns retries, circuit breaking, fallback, rate-limit metadata, budgets,
and usage. Provider SDK retries are disabled so a single layer controls those
semantics. Framework fallback routes, when configured by an embedding
application, use explicit `{ provider, model }` targets. Runtime recomputes
effective capabilities, tokenization, context selection, and output headroom
for each target; the shipping CLI does not configure a fallback route.

重试、Circuit Breaker、Fallback、Rate-limit Metadata、预算和用量都归 Runtime 所有。
Provider SDK 重试被关闭，确保只有一层控制语义。当前 CLI 不配置生产 Fallback Route。

`praxis model list` reports capabilities supported by both the catalog model
and its active adapter. The current built-in HTTP adapters are text/tool
adapters: historical reasoning and citation blocks are preserved with explicit
text markers, while unresolved image or audio references fail visibly instead
of being dropped. Reasoning levels remain informational until a selected level
is carried by every protocol and persistence layer.

Catalog maintainers update the snapshot by reviewing the matching Pi/models.dev
source, copying exact API IDs and verified limits, recording the retrieval
date, and running the offline Provider contract suite. The optional live Kimi
smoke uses `PRAXIS_LIVE_KIMI_API_KEY`, a 16-output-token ceiling, and a
20-second timeout; it is separate from mandatory offline gates.

维护 Catalog 时需审阅对应 Pi/models.dev 来源、复制精确 API ID 与验证后的上限、记录获取
日期并运行离线 Provider 契约。可选 Kimi Live Smoke 有独立 Token/Timeout 上限，不属于
强制离线门禁。
