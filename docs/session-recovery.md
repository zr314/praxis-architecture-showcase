# 会话恢复 / Session Recovery

产品 Session 统一由 `${PRAXIS_HOME:-~/.praxis}` 下的 `SessionJournalV3` 保存。默认 JSONL 后端使用
带 Checksum 的追加式 commit；显式 SQLite 后端使用 WAL、FULL synchronous 和事务。两者重放相同的
Session、Message、Memory/Compaction、Plan、Usage 与 Artifact Reference 领域事件，但任一时刻只能有
一个 authority。旧 v2 JSONL 首次启动时会先校验并在隔离 staging 构造 V3，成功后才备份源数据、安装
V3 并发布 authority。校验或构造失败不会留下半成品 authority，也不会为同一失败重复创建备份。

Product sessions use one `SessionJournalV3` authority. JSONL is the default;
SQLite is an explicit alternative. They implement the same commit/reducer
contract and are never dual-written. Legacy v2 data is validated and staged
before the source backup is created; only then is V3 installed and its authority
published. A validation or staging failure publishes neither partial authority
nor repeated backups.

## 新手先理解三个词 / Three terms first

| 名称 | 它是什么 | 它不是什么 |
| --- | --- | --- |
| Session | 一段可长期保存、继续对话的记录 | 不是 Git Branch，也不是文件系统快照 |
| Run | Session 中一次 Prompt 或 follow-up 的执行 | Run 结束不代表 Session 被删除 |
| Compaction checkpoint | 为模型上下文生成的持久摘要 | 不删除原始历史，也不撤销文件修改 |

正常退出后，Praxis **不会自动猜测要恢复哪一个旧 Session**。再次运行 `praxis` 通常创建新
Session；要继续旧工作，请用 `/session` 或精确 `--session <id>`。先记住：恢复对话只恢复 Agent
记忆与记录，之前已经写入的文件、Git 状态和 Shell 副作用仍以磁盘上的当前状态为准。

## 第一次恢复演练 / First recovery walkthrough

建议先用 Mock Provider 做一次无风险练习：

```sh
praxis --provider mock --model mock-v1 --print "记住标记 beginner-recovery"
praxis session search "beginner-recovery"
praxis session show <搜索结果中的-id>
praxis --session <同一个-id> --print "刚才的标记是什么？"
```

预期结果：第二条命令能找到 Session，`show` 能显示元数据，最后一条命令在同一 Session 中创建
新的 Run，并继续使用该 Session 已持久化的 `mock/mock-v1`；恢复已有 Session 时，命令行的
`--provider`/`--model` 不会覆盖其配置。若 Search 没找到，先确认两个命令是否使用相同的
`PRAXIS_HOME` 和操作系统用户。

## 查找与恢复 / Find and resume

在 TUI 使用可搜索的 `/session`，或通过以下命令在不打开会话的情况下检查：

Use the searchable `/session` picker in the TUI, or inspect sessions without
opening one:

```sh
praxis session list
praxis session list --workspace .
praxis session search "release"
praxis session show <id>
```

Resume an exact ID:

按精确 ID 恢复：

```sh
praxis --session <id>
```

When a run is active, choosing another session in the TUI requires a second
Enter before Praxis aborts the run and switches sessions.

活动 Run 中选择另一个 Session 时，Praxis 要求第二次 Enter，确认后才会中止 Run 并切换。

## 重命名、派生、分支与导出 / Rename, fork, branch, and export

```sh
praxis session rename <id> "release investigation"
praxis session fork <id> --name "alternate approach"
praxis session branch <id>
praxis session export <id> --output .\exports\session.json
```

`branch` resolves a Praxis session tree to its active leaf; it is not a Git
branch. Export refuses to overwrite an existing file unless `--force` is
present. `/compact` creates a semantic checkpoint while retaining critical
facts and a recent transcript suffix.

`branch` 解析 Praxis 会话树的活动叶子，不是 Git Branch。Export 默认拒绝覆盖已有文件，
除非传入 `--force`。`/compact` 创建语义 Checkpoint，同时保留关键事实和最近 Transcript。

## 删除与恢复 / Delete and recover

交互删除必须输入完整 Session ID；自动化必须显式添加 `--yes`：

Interactive deletion requires typing the exact session ID. Automation must add
`--yes`:

```sh
praxis session delete <id> --yes
```

Deletion first writes a portable V3 session export under
`${PRAXIS_HOME:-~/.praxis}/trash/session-journal-v3/`, then appends a durable
`session.deleted` tombstone and reports the export path. Praxis currently has
no restore command.

删除会先在 `trash/session-journal-v3/` 写一份可移植 V3 Session 导出，再追加持久化
`session.deleted` tombstone，并报告导出路径。当前没有 Restore 命令。需要恢复时，先停止所有 Praxis
进程并备份整个数据目录，再离线校验导出、commit identity 和 authority；Runtime 持有存储时不可编辑。

本文故意不提供一条通用的 `copy`/`mv` 恢复命令：Journal Commit、Catalog Projection、版本、Checksum 和
Writer 状态必须作为一个整体判断，复制错一部分可能把可恢复证据变成新的损坏。新手应优先使用删除前 Export
或完整 `PRAXIS_HOME` 备份；没有已验证备份时，保留 Trash 和数据目录原样，交给熟悉当前存储版本的
维护者离线处理。

There is intentionally no generic copy-paste restore command. Manual recovery
is storage-version-specific and must preserve journal, projection, checksum,
and writer invariants as one unit.

对新手最安全的做法是：不确定是否还需要时先 `export`，确认导出文件存在后再删除。`delete`
不会删除或移动工作区源码，也不会把 History/Memory 从 Journal 中搬走；它先把完整 V3 Commit 历史
写入 Trash 导出，再以 tombstone 从正常查询中隐藏 Session。Trash 仍可能包含敏感 Prompt 和 Tool 结果，
不应提交到 Git。

## 选择和迁移 JSONL / SQLite

新用户不传任何参数时使用 V3 JSONL：

```sh
praxis --provider mock --print "hello"
```

空数据根可以直接显式选择 SQLite：

```sh
praxis --storage sqlite --provider mock --print "hello"
```

一旦 `${PRAXIS_HOME}/session-authority.json` 认领后端，`--storage` 不能在线改写它。已有 JSONL 要切到
SQLite（或反向切回）时：

1. 退出 TUI、server 和其他共用该 `PRAXIS_HOME` 的 Runtime；
2. 建议先备份整个 `PRAXIS_HOME`；
3. 运行离线迁移；
4. 阅读报告中的 session/commit/entry 数量和旧 authority 备份路径；
5. 再用目标 `--storage` 启动。

```sh
praxis storage migrate sqlite
praxis storage migrate jsonl --json
praxis storage migrate sqlite --home /path/to/praxis-home
```

迁移持有独占 migration lock，拒绝活动 Runtime lease；崩溃遗留且 PID 已不存在的 lease 会被清理。流程先
导出 Source，在隔离 staging root 导入 Target，再用相同时间戳重新导出并比较 Checksum，随后备份旧
authority/backend、安装 Target 和原子写新 marker。失败时回滚为旧 authority。它不会保留在线 mirror，
也没有“两个后端自动同步”的模式。`/storage` 只读显示当前后端和数据根，不能切换。

## 损坏与 Writer 冲突 / Corruption and writer conflicts

若 `praxis doctor` 报告损坏，先停止共用该 `PRAXIS_HOME` 的所有进程并复制完整数据目录；随后运行
`praxis doctor --deep`。普通启动只验证 Catalog/Projection 快速路径和遗留的 pending 修复标记，
不会为发现潜在的静默历史损坏而重放全部 Commit。
不要手工删除中间 JSONL Commit 或重写 Checksum；JSONL 只有最后一条 Partial Line 可以在下次读取时
自动修复。SQLite 损坏也必须从已验证备份或可移植导出恢复，不能通过手改表伪造 Projection。

If `praxis doctor` reports corruption:

1. Stop every Praxis process using that `PRAXIS_HOME`.
2. Copy the whole data directory, including migration backups and trash.
3. Do not remove a middle JSONL record or rewrite checksums by hand.
4. A final partial line may be repaired automatically on the next read. Any
   earlier checksum or sequence failure needs offline investigation or restore
   from a known-good backup.

Writer lock errors mean another process owns the same session mutation path.
Close the other process and retry. Do not delete `.lock` files while the owner
may still be alive.

Writer Lock 错误表示另一个进程拥有同一 Session Mutation Path。关闭对应进程后重试；Owner
仍可能存活时不要删除 `.lock` 文件。
