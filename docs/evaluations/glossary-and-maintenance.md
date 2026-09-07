# 测评术语与持续维护规则

最后更新：2026-08-23。

## 新手词典

### Agent、LLM 与 Agent Harness

- **LLM（大语言模型）**：负责推理和生成下一步动作，例如 MiniMax M3、DeepSeek 或 Kimi K2.6。
- **Agent（智能体）**：LLM 加上 Prompt、工具、上下文、权限和循环控制后形成的执行者。
- **Agent Harness（智能体运行框架）**：包住 Agent 的基础设施。Praxis 负责 Provider 调用、Tool 执行、权限、会话、日志、压缩、Planner、Workflow 和恢复。
- **Runtime**：实际执行一轮 AgentLoop 的进程。可以把它理解为 Agent 的“操作系统内核”。
- **CLI**：命令行客户端。`exit 0` 只表示程序正常退出，不表示题目答案一定正确。
- **`PRAXIS_HOME`**：Praxis 保存设置、Session journal、Workflow SQLite、Artifact 和 trace 的数据根目录。重启时使用同一个目录，才能接回同一持久状态。
- **Root**：接收用户原始任务、决定继续自己做还是创建 Workflow 的主 AgentTask。
- **Child / Subagent**：由 Root 或 Workflow 创建的子 AgentTask。Praxis 当前的 Child 就是 Subagent，不要求固定命名为 researcher、coder 或 reviewer；角色、目标和工具由任务合同决定。

### Planner 与执行方式

- **ReAct**：模型在“思考/选择动作→调用工具→观察结果”之间循环，适合边做边决定。
- **Planner**：决定任务怎样进入执行路径。Praxis 的 `auto` 使用 plan-guided ReAct，模型可保持单 Agent或按需调用 `agent.spawn` 形成动态 Run Tree；`solo` 固定单 Agent；`workflow` 为显式粗粒度 Workflow 入口。
- **DAG（有向无环图）**：节点之间只有从前向后的依赖，不会形成循环。它能表达“先并行调查，再交叉复核，最后综合”。
- **Workflow**：持久化的 DAG 执行实例。模型负责提出图，Authority 负责保存和推进真实状态。
- **Node / Task**：DAG 中的一项工作。`AgentTask` 是由一个 AgentLoop 执行的节点，join 节点只负责等待条件。
- **Attempt**：同一 Task 的一次执行尝试。进程中断后可以创建 attempt 2，而不是复制一个新任务。
- **Lease（租约）**：Worker 在有限时间内取得某个 Task 的执行权。Worker 死亡后租约过期，别的 Worker 才能安全接手。

### 多 Agent 协作

- **agent.spawn / delegate / workflow.expand**：分别表示默认异步 Child 句柄、兼容同步委派，以及显式 Workflow 图扩展。
- **join**：等待一组节点满足条件。`all` 是全部成功；`any` 是任意一个完成；`quorum` 是达到指定成功数。
- **quorum（法定数量）**：例如 3 个调查只需 2 个有效结果。满足 2-of-3 后，第三个昂贵任务可以取消。
- **parallel join**：多个无依赖节点可以同时 ready，完成后统一汇合。
- **cross-review（交叉复核）**：A、B 先独立调查，再由 C、D 互相检查它们的证据，最后由 E 综合。
- **synthesis（综合）**：把多个 Child 的结果合并为最终结论，不只是拼接文本。
- **mailbox / inbox**：Workflow 的持久消息箱。Child 结果可以在 Root 忙别的事情时写入，Root 稍后读取。
- **IPC（进程间通信）**：不同进程之间交换状态或消息。Praxis 用持久 Authority/mailbox，而不是只靠进程内 Promise。

### 持久化与恢复

- **Authority**：Workflow 状态的唯一裁判。谁能 claim、节点是什么状态、是否达到 join 条件，都以 Authority 的事务结果为准。
- **SQLite Authority**：当前默认用一个 SQLite 数据库实现 Authority。SQLite 是存放在本地文件中的关系数据库。
- **transaction（事务）**：一组数据库操作要么一起成功，要么一起失败，避免“检查时有空位，真正领取时已超限”之类竞态。
- **journal（事件日志）**：按顺序追加的运行事实，如 Prompt 开始、工具调用和 checkpoint。它用于回放和审计。
- **stream**：CLI 按时间输出的 JSONL 事件流；每行通常是一条状态、文本、Tool 或 usage 事件。
- **projection（投影）**：把 Authority 内的权威状态转换成客户端容易显示的 `workflow_update`。投影可以重建，不应反过来成为状态裁判。
- **bundle**：为测评打出的不可变 CLI 单文件产物。名字带时间/版本，避免源码更新后误跑旧 `dist`。
- **Artifact**：大结果或 Child 产物的持久对象。Workflow 消息通常只保存引用，避免把大文本复制很多遍。
- **resultRef / evidence ref**：指向 Artifact 的稳定引用。
- **restart recovery**：进程退出后，新的 Runtime 读取同一持久状态并继续未完成 Task。

### 上下文与缓存

- **context window**：模型一次请求能看到的 token 上限。
- **compaction**：把较早的长对话压缩成结构化摘要，给后续轮次腾空间。
- **checkpoint**：compaction 生成并持久化的摘要状态，记录覆盖到 journal 的哪个位置。
- **semantic compaction**：由模型理解语义后生成摘要；与简单截断不同，它应保留目标、约束、决策和未完成事项。
- **frontier**：checkpoint 已经覆盖到 journal 的最后位置。frontier 单调前进，表示压缩没有倒退或重复覆盖错误区间。
- **fitting**：在发送给模型前，把固定 Prompt、checkpoint、近期消息和 Tool 结果装进 context window 的过程。
- **ContextPacket**：不依赖可压缩聊天历史的任务合同包，用于防止 Child 身份、权限和交付条件被摘要丢失。
- **sentinel（哨兵字符串）**：测评故意放入的唯一标记，例如 `ORCHID-7319`。压缩后仍能正确复述，说明关键合同没有被遗忘。
- **Prompt prefix cache**：Provider 对相同请求前缀复用计算。`cacheReadTokens` 越多，通常表示复用越多，但命中率不能单独代表质量。
- **cold start / warm cache**：第一次请求没有历史缓存叫冷启动；已有相同前缀缓存叫热缓存。A/B 比较时不能拿一边的热首轮与另一边的冷首轮直接下结论。

### Provider、工具与权限

- **Provider**：把统一模型请求转换成某家 API 协议的适配层。
- **Provider-aware capacity**：把模型账号或端点可承受的瞬时并发作为持久调度约束。它限制同时持有 Lease 的任务数，不等于整个任务的累计预算。
- **rate limit / 429**：Provider 因请求过快或并发过高而拒绝请求。
- **Tool**：Agent 可调用的结构化动作，如 `read`、`shell`、`workflow.join`。
- **schema**：结构化数据必须遵守的字段、类型和约束。模型给出不合法 JSON 时，Tool 在执行前就会拒绝。
- **criterion**：一条可单独验收的成功标准。例如“必须同时识别两个 reviewer Artifact”。
- **planned / started Tool call**：planned 表示模型请求过该 Tool；started 表示通过 schema、权限等前置检查并真正进入执行。被 Policy 拒绝的调用可能只计 planned。
- **MCP（Model Context Protocol）**：外部进程向 Agent 暴露 Tool、Resource 和 Prompt 的标准协议。MCP server 负责实现能力，Runtime 发现并注册它们。
- **Skill**：给模型的可复用说明书和工作流，通常告诉它何时、按什么步骤使用已有工具。Skill 本身不是后台进程。
- **Policy / grant**：Policy 判断某项 Tool 能否执行；grant 是一次或持久授权。
- **idempotency（幂等）**：相同动作重复执行不会产生额外副作用。重启恢复时尤其重要。

### 测评词语

- **benchmark**：固定题目、环境和评分方法的测试集。
- **harness benchmark**：更关注框架能否正确组织模型、工具和过程，而不只看语言知识。
- **rollout**：模型从接到题目到结束的一次完整运行。同一道题重复三次就是三个 rollout。
- **oracle / verifier**：检查最终文件、服务或状态是否正确的程序。
- **raw score（原始分）**：oracle 直接给出的机器分数。即使后来确认 evaluator 有缺陷，也应保留，不能覆盖。
- **contract-adjusted（合同调整结论）**：只按公开题面重新判断语义是否成立，用于标出陈旧哈希、未声明的精确字节等 evaluator 假设；它不能冒充官方 raw score。
- **fixture**：benchmark 提供的固定输入文件、数据或本地 mock 服务。
- **BOM**：某些文本工具写在 UTF-8 文件最开头的标记字节。人眼通常看不见，但严格 JSON/CSV parser 或 byte oracle 可能拒绝。
- **reward**：benchmark 给出的结果分数。Terminal-Bench 这里通常 `1` 表示通过，`0` 表示失败。
- **Outcome / Process / Combined**：Harness-Bench 的最终产物分、执行过程分和综合分，范围为 0–1。本批没有统一二元及格线，所以文档保留连续分数。
- **utility**：AgentDojo 中原始用户任务是否完成。
- **ASR（Attack Success Rate）**：恶意注入目标成功的比例；越低越好。
- **smoke test**：只验证最短主链路能否工作，不代表复杂能力。
- **conformance test**：验证执行是否符合协议或状态机不变量。
- **regression test**：修复缺陷后防止同一问题再次出现的测试。
- **wall-clock time**：现实世界从开始到结束的时间，包括等待 Provider、容器和网络。
- **turn**：模型完成一次请求/响应循环。
- **tool call**：模型请求执行一次工具。
- **token**：模型处理文本的计量单位，不等同于汉字或单词。
- **input / cache-read / output token**：本轮新计算的输入、从 Provider 前缀缓存复用的输入、模型生成的输出。不同 Provider 原始字段不同，Praxis 会归一化；不能默认所有厂商的账单公式完全相同。
- **Provider dialect**：不同 Provider 对同一概念使用不同字段或事件位置，例如 usage 出现在 start、delta 或 final。
- **未提交 Provider turn**：Provider 已开始返回内容，但 assistant message 尚未完整结束、Tool 也尚未执行的一轮。它可以像数据库未提交事务一样整体丢弃并有限重试；一旦 Tool 已执行，就不能假设重放没有副作用。
- **部分可见文本**：流中断前已经显示的一小段 assistant 文本。它不等于完整、耐久的最终消息；恢复时若丢弃，trace 应明确记录。
- **额度终态探针**：让所有在途请求结束后，用单路最小任务区分“瞬时并发限流”和“账户/计划额度已用完”。只有最小请求仍明确限流，才把本批标成额度终止。
- **fingerprint**：把一次动作/状态摘要成可比较标识，用于判断循环是在重复还是确有进展。
- **`prompt_completed`**：Praxis 的 Prompt 终态；它不是 verifier 的“题目通过”。
- **invalid sample**：环境、网络或 Provider 协议坏掉，导致无法公平评价任务的样本；不计入任务正确率。

## 证据等级

| 等级 | 证据 | 可以支持的结论 |
| --- | --- | --- |
| E0 | 设计文档、类型或源码存在 | “有这个设计/组件”，不能证明真实运行 |
| E1 | 单元/集成测试通过 | 在受控输入下合同成立 |
| E2 | 真实 Provider smoke 或单次任务运行 | 主链路在该模型、该环境、该时刻成立 |
| E3 | 官方 verifier、故障注入、journal/SQLite 不变量核对 | 指定任务或恢复性质有较强机器证据 |
| E4 | 多模型、多次重复、长时间、高并发统计 | 才能开始讨论稳定率和生产可靠性 |

当前大部分本文证据属于 E2–E3，不是 E4。

## 新增一条测评时必须记录什么

每条记录至少包含：

1. 唯一编号和日期；
2. 实际题目原文，不能只写“测了一个长任务”；
3. 测试目标和预先定义的通过条件；
4. Praxis 版本：commit 或不可变 CLI bundle 名；
5. Provider、模型、Planner、Prompt variant、上下文上限和关键环境；
6. 最终终态、官方 reward/verifier 或 Workflow 不变量；
7. turns、Tool calls、input/output/cache tokens 和墙钟时间（能取得时）；
8. 原始证据目录；
9. 遇到的问题、归因层和处理方式；
10. 结论边界：这次没有证明什么。

推荐使用以下模板：

````markdown
### EV-类别-日期-名称

- 日期：YYYY-MM-DD
- 版本：commit / bundle
- Provider / model：
- Planner / Prompt variant：
- 原始证据：`绝对路径`

<details>
<summary>实际题目原文</summary>

```text
原文
```

</details>

**预先通过条件**：

**最终结果**：

| 判定层 | 状态 | 依据 |
| --- | --- | --- |
| 任务正确性 | PASS / PARTIAL / FAIL / N/A | |
| 框架能力 | PASS / PARTIAL / FAIL / N/A | |
| Prompt/格式服从 | PASS / PARTIAL / FAIL / N/A | |
| Runtime 终态 | PASS / FAIL | |

| 指标 | 值 |
| --- | ---: |
| Terminal | |
| Reward / verifier | |
| Turns | |
| Tool calls | |
| Input / output / cache-read tokens | |
| Wall-clock | |

**问题与处理**：链接到 `issues-and-fixes.md` 的对应条目。

**结论边界**：
````

## 更新流程

1. 先把不可变题目和 runner 保存到 `D:\agent-evals\sources`、`scripts`。
2. 运行结果写入新的时间戳目录，禁止覆盖旧结果。
3. 先判断 `valid / invalid`，再判断 `pass / fail`；Provider 断流或容器拉取失败不能伪装成模型失败。
4. 用 oracle/verifier、SQLite 和 journal 核对，不采信模型自述。
5. 在 archive 下新建带日期的详细报告，再更新 run-ledger 和相应通过表/问题表；README 只维护导航与当前版本边界，不再堆积重复总表。
6. 新缺陷追加到[问题与处理方法](issues-and-fixes.md)；永久修复要写代码位置、原理和复验记录。
7. 检查本地链接、Markdown 围栏和数字是否与原始 JSON 一致。
8. 提交文档时注明“新增证据”或“修正解释”，不要静默改写历史结论。

## 历史修订规则

- 原始运行结果不可修改；补算指标另存派生文件并记录脚本版本。
- 发现旧数字错误时，在正文修正并在 Git 历史中保留来源，不删除不利样本。
- 同一题为验证修复而重复运行，要同时保留早期失败和后续通过；汇总时说明是否去重。
- 题目通过、框架通过、模型服从通过分别记账。
- API key、token、密码和 benchmark 中的真实秘密不得复制到文档。题目自带的固定测试密码可保留，但必须确认不是用户凭据。
