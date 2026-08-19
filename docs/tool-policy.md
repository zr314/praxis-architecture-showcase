# 工具策略 / Tool Policy

## 中文导读

Runtime 在授权前校验 Tool Input，在持久化或发送给 Provider 前校验 Output。每个 Tool
声明固定副作用类别、Canonical Target、Conflict Scope、并行安全标志、Output Budget、
Deadline 和取消行为。交互决策为“仅本次允许、始终允许、拒绝”；持久授权严格限定到
Workspace、Tool、Rule 与 Canonical Target，项目指令和模型输出不能创建授权。

每个 Tool Call 都产生带独立 Tool Call ID 的结果；同批次一个调用失败不会覆盖或吞掉其他
结果。`grep.pathPattern` 是跨平台首选字段；Deprecated `pattern` 只为兼容保留。`read`
使用零基、左闭右开范围，并显式返回 `returnedLines`、`rangeStart`、`rangeEnd` 与
`nextOffset`。

`edit` 对多行匹配把 CRLF/LF 视为等价，但保留原文件换行风格，仍要求唯一匹配并支持
`expectedDigest`。`write` 是 Whole-file 写入：`expectedDigest` 防止覆盖并发修改；
`createOnly: true` 使用排他创建，竞争或已有目标返回 `TOOL_ALREADY_EXISTS`。两种前置条件
不可同时使用。

Praxis 不自动创建 `.bak`，也不承诺通用 Undo。交互 Preview 有界且经过终端清洗，不进入
Trace/Audit。自动化只能使用审阅过的 `--policy-file`；不可信仓库不得 Auto-allow。
多行脚本通过 `stdin` 传给明确的子解释器，避免拼接平台专用 Pipeline。下方 JSON 示例是
唯一命令事实源。

## 新手怎样做权限决定 / Beginner permission checklist

看到权限面板时先不要只看“Agent 想完成什么”，而要逐项检查 Runtime 已准备好的实际动作：

1. **Tool：**是只读 `read/grep`，还是会写入/启动进程的 `write/edit/shell`；
2. **Target：**Canonical Path/CWD 是否正好属于预期工作区；
3. **Preview：**新内容或 Shell Command 是否与任务一致，是否含未知下载、删除或凭据；
4. **Scope：**优先 `allow_once`；只有目标和 Rule 足够精确、以后确实会重复时才 `allow_always`；
5. **Recovery：**写入前是否有 Git/Backup；外部 API、Package Publish、数据库写入如何恢复。

| Tool | 默认理解 | 新手建议 |
| --- | --- | --- |
| `read`、`glob`、`grep`、`ls`、`find` | 工作区内只读发现 | 仍检查是否越界或范围过大 |
| `artifact_read` | 读取 Runtime 已存的大结果 | Artifact 可能敏感，不要随意复制外发 |
| `edit` | 精确替换文件片段 | 看清目标、唯一匹配和 Preview，优先一次授权 |
| `write` | 创建或替换整个文件 | 特别确认 Whole-file、Digest/Create-only 和现有内容 |
| `shell` | 以当前用户权限启动 Shell | 将命令视为你亲自在终端执行；未知命令就拒绝 |

拒绝权限只会让当前 Tool Call 得到 denied result，不会损坏 Session。可以在下一条消息中要求 Agent 改成
只读方案、缩小目标或解释命令。项目里的 `AGENTS.md`、Skill 和模型输出都不能替你点击允许。

Policy controls whether Praxis executes an action; it does not make an allowed
program safe. Once a write or external side effect completes, cancellation does
not roll it back.

The Runtime validates Tool input before authorization and validates output
before persistence or Provider delivery. Tools declare a fixed side-effect
class, canonical target, conflict scope, parallel-safety flag, output budget,
deadline, and cancellation behavior.

Interactive decisions are allow once, allow always, or deny. Durable grants are
scoped to workspace, Tool, rule, and canonical target. Grants may expire and
can be revoked or migrated. Project instructions and model output cannot create
grants.

`edit` treats CRLF and LF as equivalent for multiline matches while preserving
the matched file's line-ending style. It still requires one unambiguous
occurrence and honors `expectedDigest`. Interactive edit permissions show only
a terminal-sanitized preview capped at three lines and 240 Unicode code points
per side; preview text is not added to traces or audit records.

## Tool 结果与发现契约 / Tool result and discovery contracts

Each requested Tool call produces one independent result, identified by its
own Tool call ID. A failure or validation error in one call does not replace,
merge, or suppress the results of other calls in the same batch.

`grep.pathPattern` is the preferred cross-platform workspace path glob; use
`/` separators on every platform. The deprecated `pattern` alias remains
accepted for compatibility. Supplying both is allowed only when their values
are equal; differing values are rejected as invalid input.

## Read 分页 / Read pagination

`read` returns `returnedLines`, `rangeStart`, `rangeEnd`, and `nextOffset` in
addition to its existing fields. `rangeStart` and `rangeEnd` are a zero-based,
half-open interval `[rangeStart, rangeEnd)` in the same coordinate system as
the requested offset, and `returnedLines` equals its length. `nextOffset` is
`rangeEnd` when further lines remain and `null` at the final page, so callers
can continue a read without inferring pagination from text content.

## Edit 与 Write 防护 / Edit and write safeguards

Successful edits explicitly summarize their matching mode and replacement line
ending. In particular, a CRLF/LF-equivalent match reports that normalized mode
and whether the replacement uses CRLF or LF.

`write` replaces whole-file content. A caller can supply `expectedDigest` to
require that the target exists and still has the specified raw-byte SHA-256
digest; a missing or changed target is rejected as stale input. Alternatively,
`createOnly: true` requires an absent target and uses exclusive creation; an
existing target, including a creation race, returns `TOOL_ALREADY_EXISTS`.
`expectedDigest` and `createOnly` cannot be combined. Successful writes report
before/after byte counts, whether a file was created, and raw-byte digests.

The write authorization panel labels the operation as whole-file content and
shows a bounded, terminal-sanitized preview of the proposed new content only.
It distinguishes CREATE ONLY from CREATE OR REPLACE and does not read existing
content merely to construct the preview.

Praxis deliberately creates no automatic `.bak` files and offers no general or
unconditional undo. Backups would pollute the workspace and duplicate
potentially sensitive contents; restoring without a digest guard would also be
unsafe after concurrent changes. A general diff or reversible-mutation receipt
is not part of the current Tool contract.

For automation, pass a reviewed JSON policy with `--policy-file`. Do not use an
auto-allow policy for untrusted repositories. Large outputs become
Runtime-owned artifacts; shell stdout/stderr updates are bounded and traces
never retain raw input or output.

The system prompt and `shell` Tool description identify the actual local shell:
Windows uses Windows PowerShell and other supported hosts use a POSIX shell.
Use the optional `stdin` field to send exact multiline UTF-8 input to a child
process without constructing a shell-specific pipeline. For example, this
feeds a multiline Python program to the child process:

```json
{
  "command": "python -",
  "stdin": "from pathlib import Path\nprint(Path.cwd())\n"
}
```

The following examples launch a child interpreter that reads the exact script
from standard input:

```json
{
  "command": "powershell.exe -NoProfile -NonInteractive -Command -",
  "stdin": "$lines = @('first', 'second')\n$lines | ForEach-Object { $_.ToUpperInvariant() }\n"
}
```

```json
{
  "command": "/bin/sh",
  "stdin": "printf '%s\\n' first second\n"
}
```

The outer shell remains platform-specific. `glob` supports recursive patterns
such as `**/*.py`; patterns and returned paths use `/` separators on every
platform.
