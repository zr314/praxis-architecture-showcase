# 本地长期记忆

核对日期：2026-09-06。English summary: opt-in local cross-session memory with explicit writes, project isolation, bounded recall and conservative revocation. No cloud service, embedding model or vector database is used.

这是当前源码的操作合同。未来自动提炼、适用条件验证和更强检索见[路线图](long-term-memory-roadmap.md)，不能当作已完成能力。

## 1. 开始使用

安装当前构建后，在项目目录执行：

```powershell
praxis memory mode explicit
praxis memory put project.audience "这个项目主要由我个人本地使用，暂不建设云端服务。" --kind decision
praxis memory list
praxis --planner solo
```

尚未更新本地安装时，可在源码仓库用 `npm run dev -- memory ...` 运行相应管理命令；它不会替换已安装的二进制。启用后新建 Session 即可使用，不需要恢复保存记忆的旧 Session。

新项目默认 `off`。CLI 的 `memory put` 是明确保存请求，直接执行；模型的 `memory.upsert/forget` 必须走一次真实权限询问。即使用户选了 allow_always，记忆写入也按本次授权记录，不创建以后自动学习的许可。非交互运行若没有对应许可会拒绝，不能假装已保存。

记忆内容属于低权限上下文，不改变 Tool Policy、不证明任务完成，也不修改 AGENTS.md、PRAXIS.md 或 Skill。

## 2. 命令

所有管理命令支持 `--workspace <目录>` 和 `--json`。管理入口由可信本地 Host 调用；即使模式 off，用户仍可列出、导出、修改和删除已存内容。

| 命令 | 作用 |
| --- | --- |
| `memory status` | 查看 projectId、登记根目录、mode、userAccess |
| `memory mode off/read-only/explicit` | 关闭、只读或启用显式记忆；不调用模型 |
| `memory list [--query <文本>]` | 最多返回 50 条；需要完整遍历时使用分页 export |
| `memory get <id>` | 查看记录、来源、revision 和适用提示 |
| `memory put <key> <content> [--revision N]` | 创建或纠正；默认 revision=0 只创建，更新必须携带当前 revision |
| `memory forget <id> --revision N` | 删除指定版本；不能用旧 revision 覆盖并发操作 |
| `memory user-access allow/deny` | 当前项目是否允许读取本机 user scope；新项目默认 deny |
| `memory rebind <projectId>` | 目录搬迁后显式绑定旧身份；不合并已启用或已有项目记忆的目标 |
| `memory export [--after <nextCursor>]` | 每页至多 50 条 JSON；存在 nextCursor 时需继续取下一页 |
| `memory import <file>` | 显式导入 JSON 的 memories；至多 50 条/256 KiB，create-only，整批事务提交 |

`put` 另支持 `--kind preference|feedback|decision|reference|experience`、`--applies <条件提示>`、`--expires <未来时间戳>`。正文上限 **4096 UTF-8 字节**，条件提示 512 字节，key 128 字节，每个 scope 至多 2000 条。超限报错，不静默截断保存。

`--scope user` 用于明确的跨项目通用偏好；默认 scope 是 project。模型只能修改 project 记忆，不能通过工具参数晋升到 user scope。管理命令可修改 user 内容，但其他项目仍需逐项目允许读取。

```powershell
praxis memory put delivery.language "解释使用中文，先给结论。" --scope user
praxis memory user-access allow
```

导出按 ID 游标分页，不是并发写入期间的冻结全库快照；做迁移时先停止记忆写入。过期记录保留在导出中，重新导入前需明确调整/移除已过期条目，不能把过期时间静默清空。导入不信任原 projectId、来源或授权，按显式目标 scope 重新建立本地记录；同 key 冲突使整批回滚。

## 3. 范围和存储

- 路径：配置的 PRAXIS_HOME 下 `memory/memory-v1.sqlite`，单一权威；Session 继续使用原来的 JSONL 或 SQLite。
- Git 使用 realpath 后的 common directory 注册随机 projectId：同仓库 worktree 共享，独立 clone 不按 remote URL 合并。
- 非 Git 在已注册根目录内的子目录复用该项目。搬迁用 rebind；首次登记前不能推断用户心中的任意项目根，请用正确 workspace 初始化。
- Child 不打开父级记忆库，也不获得 memory.* 工具。本版未新增自动继承记忆 Packet；父级仍可在普通任务描述中提供必要背景，但不是记忆库共享授权。
- SQLite 事务、expectedRevision 和 operationId 保证有界条件下的原子修改、冲突检测和重复请求回执。没有自动全文历史副本，也没有后台同步。

Namespace 校验不是 OS 沙箱。拥有同一 OS 用户文件访问权限的 Shell/程序仍可能直接读取数据库；数据库没有额外加密。秘密检测只是有限模式过滤，不是完备 DLP，禁止保存令牌、Cookie、密码或密钥。

## 4. 怎样进入模型上下文

每个新 Run 检索一次：项目状态和过期过滤后，按 key/正文/条件提示做英文词、中文片段的确定性匹配；preference/feedback 可作为少量常用背景，即使任务没有同词也参与候选。

候选快照在 Run 内稳定；有 user 读取许可时最多预留 2 条 user 候选，总计最多 8 条。实际发送在 ContextView 之后、checkpoint/最近消息之前，最多约 1500 Token，且只用正常上下文选择后的剩余预算。放不下时略去整条，绝不挤掉原任务、政策或完整 Tool 配对。随着历史增长，实际发送子集可能缩减，不能宣称字节前缀永远不变。

memory.search/get 可按需读取；写入返回明确回执，普通编辑下一 Run 重新召回。`applicability` 当前是展示给模型的条件提示，**不是自动的文件摘要或环境验证器**。并发冲突只检测同 scope/key 的 revision；没有跨 key 语义冲突识别或自动合并。

Prompt manifest 记录 memory snapshot/project ID、选择的记录 ID/revision、digest 和 Token；Trace 有 memory.retrieve/write/conflict/revoke 的受限标识和用量字段。模型工具事件仍走正常 Tool Trace，默认不在这些 Trace 注解中保存正文。模型返回的工具内容和对话历史仍可能持久化于 Session Journal。

## 5. 忘记、关闭与故障

forget 删除当前正文，留下非正文 tombstone 和幂等回执。记录被读取/成为检索候选时，库会登记 Session exposure。删除后这些 Session 及其 fork 不能再发起模型请求，返回 `MEMORY_CONTEXT_REVOKED`，要求新建 Session。**本版选择保守阻止旧会话重放，而不是修改原始 Journal 或声称安全重写所有摘要。** 候选未最终发送也可能被保守标记。

关闭已启用项目、撤销 user 读取许可也会使相应已暴露会话失效；过期内容不再召回，已暴露会话的继续发送也受检查。不相关的新 Session 可以正常运行。

不保证清除：原始用户消息、历史 ToolResult、Artifact、checkpoint 原件、SQLite WAL/备份、导出文件、已发送请求和外部副本。在途请求无法追回，模型或用户重新表述同一事实也不属于可证明的全文擦除。没有自动提炼，因此本版不会后台重新学习；用户再次显式保存是新的授权。

首次使用记忆失败时，空的新 Session 可以无记忆运行并收到警告。已有历史的 Session 若无法检查撤销状态则保守拒绝继续，避免把失效内容重新发送；可修复本地库或新建 Session。显式保存失败必须向用户报错。嵌入 Host 可配置 `memoryService:false`，这由可信 Host 负责，不接受模型参数控制。

## 6. 源码与验证

- [领域合同](../packages/core-sdk/src/long-term-memory.ts)：scope、mode、记录、回执与管理参数。
- [项目身份](../apps/runtime/src/long-term-memory/projectIdentity.ts)、[MemoryService](../apps/runtime/src/long-term-memory/memoryService.ts)：本地身份、SQLite、事务、隔离与撤销。
- [工具](../apps/runtime/src/long-term-memory/tools.ts)、[Runtime 接入](../apps/runtime/src/framework/runtimeKernel.ts)：实际调用、授权、Run 快照和发送前检查。
- [上下文渲染](../apps/runtime/src/prompt/memoryContext.ts)、[PromptAssembler](../apps/runtime/src/prompt/promptAssembler.ts)：转义、预算、manifest。
- [单元/合同测试](../test/long-term-memory.test.ts)、[真实进程/CLI 测试](../test/long-term-memory-runtime.test.ts)：重启、新 Session、JSONL/SQLite、隔离、批准写入、删除/fork 和故障事务。

真实进程测试使用确定性 Mock Provider 验证接线，不是对记忆语义质量的 benchmark 结论。没有运行付费 Provider 或改动已安装程序。
