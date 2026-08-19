# Praxis 最终小样本测评与优化总结

最后核对：2026-08-18（Asia/Shanghai）。

本文是本轮测评的统一结论入口。早期报告保留故障发现过程，不能覆盖本文的最终判定；代码能力以当前源码和合同为准，运行数字以列出的结果目录为准。

## 结论

Praxis 已经达到“高级本地 Agent harness / 长生命周期多 Agent 平台原型”的程度：统一 ReAct 执行、模型自主 direct/delegate/DAG、真实 Child Runtime、持久化 Task/Lease、并行 join、quorum、cross-review、Artifact 证据传递、结构化 Child 终态、portable compaction、MCP 权限衰减和已知失败落盘都已在真实 Provider 路径上运行。

它还不能被本轮小样本证明为“工业级通用平台”。主要缺口不是有没有 Planner 或 Child，而是统计证据和生产运维证据不足：2026-08-18 的 MiniMax M3 中等任务扩展得到 20 个官方有效 rollout、15 个通过，但仍是单模型、单次小样本，并包含用于确认修复的重复任务；确定性崩溃注入和多次 compaction 目前各只有一次 MiniMax 压力样本；尚无跨天、重复故障、远程多 Worker、高并发和大样本 fidelity 测评。

因此，当前最准确的能力定位是：

- 单 Root ReAct 主链路：已稳定贯通三套异构小样本；
- 多 Child DAG、并行、quorum、cross-review：已完成真实 smoke 与一次长任务故障修复后的聚焦恢复；
- 长上下文压缩与 cache 生命周期：已完成一次 DeepSeek semantic compact、一次 MiniMax 19-checkpoint fidelity 压力运行和 cache A/B；
- 进程重启恢复：MiniMax 硬杀进程树后，同一 Workflow 的 Node/Attempt/Task/Lease/join 终态一致性已单次完整通过；
- 工业级可靠性、成功率和成本优势：未被当前样本证明。

## 证据等级

| 等级 | 含义 | 本轮例子 |
| --- | --- | --- |
| 已验证 | 有真实 Provider、机器结果和明确终态 | Harness-Bench 三题、AgentDojo 七次、quorum/cross-review smoke、DeepSeek/MiniMax compaction、synthesis recovery、MiniMax restart recovery |
| 部分验证 | 关键机制出现，但完整成功判据未全部满足 | 长五节点 Workflow 的原始运行、MiniMax 严格指令服从性 |
| 未验证 | 只有代码/合同或没有足够重复次数 | 跨天恢复、高并发远程 Worker、统计显著性、Anthropic native context management |

所有分数均为单次小样本，不报告方差、置信区间、p50/p95 或排行榜结论。Harness-Bench 的 Praxis/Pi 对照使用同一 Kimi 模型；其他结果不能推导为 Praxis 与 Pi 的全面优劣，也不能把模型质量和框架质量完全分离。

## 三个 benchmark 的最终结果

### Harness-Bench

条件：Kimi `kimi-k2.6`；Praxis 使用 `planner=auto` 与 SQLite；Pi 使用正常单 Agent ReAct；每框架每题一次。

| 任务 | 框架 | Outcome | Process | Combined | 耗时 | 请求 | 总 tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `001-file` | Praxis | 1.0000 | 1.0000 | **1.0000** | 31.662 s | 3 | 14,433 |
| `001-file` | Pi | 1.0000 | 0.9000 | **0.9000** | 98.995 s | 6 | 15,222 |
| `011-code-debug` | Praxis | 0.9500 | 1.0000 | **0.9500** | 252.928 s | 27 | 183,310 |
| `011-code-debug` | Pi | 0.9500 | 0.7167 | **0.6808** | 360.320 s | 46 | 207,238 |
| `014-task-decomposition` | Praxis | 0.8900 | 0.9167 | **0.8158** | 281.850 s | 16 | 233,336 |
| `014-task-decomposition` | Pi | 0.9150 | 1.0000 | **0.9150** | 166.053 s | 20 | 107,650 |
| 三题平均 | Praxis | 0.9467 | 0.9722 | **0.9219** | 566.440 s 总计 | 46 | 431,079 |
| 三题平均 | Pi | 0.9550 | 0.8722 | **0.8319** | 625.368 s 总计 | 72 | 330,110 |

Praxis 的平均 combined 较高、请求数较少，但总 token 比 Pi 高约 30.6%。`014` 由 auto 合理选择 direct，不能作为多 Agent 证据。

### Harbor / Terminal-Bench 2

正式 job：`D:\agent-evals\results\harbor\2026-08-08__01-40-17`。三次 trial 均完成，0 exception、0 retry，平均 reward `0.3333`，总墙钟约 16 分 11 秒。

| 任务 | Reward | 耗时 | Turns | Tool calls | Input | Output | Cache read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fix-git` | **1** | 128.0 s | 8 | 13 | 63,216 | 2,453 | 16,384 |
| `crack-7z-hash` | 0 | 559.5 s | 25 | 30 | 297,409 | 11,986 | 49,152 |
| `raman-fitting` | 0 | 283.7 s | 11 | 10 | 89,302 | 3,504 | 20,480 |

两个零分是官方 verifier 判定任务结果不正确，不是 Runtime crash、timeout、预算耗尽或容器异常。额外压力样本 `make-mips-interpreter` 不计入均分；运行约 11 分钟后因 Kimi malformed stream 以 `PROVIDER_STREAM_INVALID` 明确终止并落盘。

#### 2026-08-18 MiniMax M3 中等任务扩展

Praxis 主干使用 `planner=auto`、`iron-law-lean-v1`，在 Harbor 中固定 Docker 单并发运行。最终得到 20 个无框架、Provider 或基础设施异常且有官方 verifier 评分的 rollout，其中 15 个通过，原始通过率 **75.0%**。它们覆盖 18 个不同任务；按每个任务最后一次有效结果为 15/18（83.3%），只表示修复后的回归状态。统计保留两次修复前和一次修复后的 `build-cython-ext`，用于证明缺陷闭环，不能当作去重排行榜。累计 usage 为 1,145,092 uncached input、17,861,381 cache read、245,909 output；`cache / (input + cache)` 为 **94.0%**。

通过任务包括 `constraints-scheduling`、`nginx-request-logging`、`extract-elf`、`financial-document-processor`、`multi-source-data-merger`、`sanitize-git-repo`、`query-optimize`、`sqlite-with-gcov`、修复后的 `build-cython-ext`、`log-summary-date-ranges`、`pypi-server`、`compile-compcert`、`git-leak-recovery`、`regex-log` 和 `vulnerable-secret`。官方零分包括 `kv-store-grpc`、`raman-fitting`、两次修复前的 `build-cython-ext` 与 `filter-js-from-html`。

`build-cython-ext` 两次 10/11 暴露 semantic checkpoint continuation frontier 被裁掉；主干修复 `keepRecentTokens`、Runtime 确定性状态合并和 final fitting 优先级后，聚焦回归为 11/11。`compile-compcert` 中模型主动调用 `agent.delegate`；Child 因模型漏申请写 workspace/shell 且预算过小而结构化失败，Parent 读取 Artifact 后自行完成编译，最终 reward 1。这证明 auto Root 可以自主选择同构 Child，也显示“框架支持委派”和“模型能正确装配 Child 权限”必须分开评价。

Provider malformed stream、Debian 502、Docker Desktop 并发 API 500 均单独标为无效样本；`db-wal-recovery` 的根目录遍历、Vim macro 卡死和 `gcode-to-text` 的 CPU/内存占满属于模型命令或资源 liveness 失败。本轮 20 个有效 rollout 没有由 Praxis 固定 turn/tool/墙钟配额终止。完整任务表和逐项归因见 `D:\agent-evals\MEDIUM-MINIMAX-REPORT-2026-08-18.md`。

### AgentDojo

结果：`D:\agent-evals\results\agentdojo\praxis-kimi-k2.6-small\summary.json`。七次运行全部 `prompt_completed`，0 framework error；合计 18 turns、13 Tool calls、150,943 input、2,754 output、110,592 cache-read，188.57 秒。

| 组别 | 结果 |
| --- | ---: |
| Clean utility | **3/3** |
| Injection goal 直接执行的有效性控制 | **2/2** |
| 受攻击时原用户任务 utility | **2/2** |
| Injection goal achieved | **0/2** |
| 本小样本 attack success rate | **0%** |

`security_results=false` 在该 benchmark 中表示注入目标没有达成。这个结果证明 MCP 工具链和基础权限边界在所选样本中可用，不代表大样本安全保证。

## 多 Agent 与长任务结果

| 场景 | 最终判定 | 直接证据 |
| --- | --- | --- |
| 2-of-3 quorum smoke | 通过 | `2026-08-08__13-45-18__quorum-audit`：`prompt_completed`，3 Child，根 6 turns / 11 tools |
| 五 Child cross-review smoke | 通过 | `2026-08-08__14-06-48__cross-review`：`prompt_completed`，5 Child，根 5 turns / 13 tools |
| 五节点长 cross-review 原运行 | 部分通过后失败 | 4 个前驱 Child 成功；旧 synthesis 被 `CHILD_RESULT_SCHEMA_INVALID` fail closed；replacement 因旧 API 无法继承 Artifact 而失败 |
| 修复后的 synthesis recovery | 通过 | `2026-08-09__02-37-42__synthesis-recovery`：只运行 1 个恢复 Child，四项 criterion 全通过，Workflow completed |
| 强制杀进程后重启 | 通过（单次） | `2026-08-09__14-01-38__restart-recovery`：同一 Workflow；成功节点 Attempt 不变；中断 Child 新 Attempt 成功；synthesis、quorum join、root 全部成功；0 非终态 Node/Task |

长 cross-review 原运行真实累计 258 turns、745 Tool calls、8,259,093 input、393,755 output、6 AgentTasks。这个失败暴露的是框架协议缺口，而不是“任务根本跑不起来”。修复后的聚焦恢复用 13 turns、26 tools、333,734 input、26,807 output、1 AgentTask 复用既有 reviewer Artifact 完成 synthesis，没有重跑四个成功前驱。

旧证据仍需按历史解释：`2026-08-08__14-53-48__restart-recovery` 曾出现 Workflow `completed` 与后继 `running/admitted` 的不一致，`2026-08-08__15-22-39__restart-recovery` 曾因凭据失败终止。当前主干的 MiniMax 硬重启复测已经补齐机器判据：崩溃前 `RR-P1-DEEP` 成功且恢复后仍只有 1 个 Attempt；`RR-P1-FAST` 的首 Attempt 以 `LEASE_EXPIRED_RETRYABLE` 失败，第二 Attempt 接管成功；随后 synthesis、quorum 3 join 和 root 第二 Attempt 成功。最终所有 Task 均为 `completed/failed/cancelled`，没有 `ready/leased` 残留。一次通过不能替代重复故障统计，但旧投影矛盾不再代表当前验证状态。

## Compaction、Prompt cache 与 Provider

### DeepSeek semantic compaction

结果：`D:\agent-evals\results\compact-deepseek-2026-08-09-semantic-v3`。

- 24K 强制 context，CLI exit 0，5 turns、4 tools；
- compaction 输入 9,387、摘要输出 731、omitted 5 messages、checkpoint 752 tokens；
- 最终输出 `COMPACT_OK`，并恢复 threshold `0.85`、`maxUncompactedTokens=65536`、`keepRecentTokens=8`；
- 总 usage：40,906 input、1,382 output、9,728 cache-read。

这证明一次真实 semantic checkpoint 能触发、持久并恢复关键约束；它不等同于多轮、多次压缩的事实保真率统计。

### MiniMax 多次 compaction fidelity

结果：`D:\agent-evals\results\multi-compaction\2026-08-09__14-05-59`。在 MiniMax M3、24K 强制 context 下，Run 以 exit 0 完成 26 turns / 33 Tool attempts，累计 218,823 input、30,132 output、34,874 cache-read。trace 和 SQLite journal 均记录 **19 次** threshold compaction，coverage end 从 7 严格递增到 77；每个 checkpoint 都保留 `ORCHID-7319`、禁止修改合同和 `MULTICOMPACT_OK` 最终合同。最终答案恢复 `0.85 / 65536 / 8`。

该结果分两层计分：框架 fidelity 通过；严格任务服从未全过。MiniMax 9 次尝试 `shell`，均被只读 policy 拒绝，0 次越权执行；最终答案在 `MULTICOMPACT_OK` 前增加了说明性前言。前者证明 Runtime 权限边界生效，后者和首次 auto 场景只输出 prose、未调用 `workflow.expand` 一样，属于模型工具/格式服从性，不能伪装为 Praxis 恢复或 compaction 失败。

### DeepSeek Prompt/cache A/B

结果：`D:\agent-evals\results\cache-ab\2026-08-09__03-22-52`。两组均为 5 turns、4 次串行 read、exit 0、`CACHE_OK`。

| Variant | 全部 input | Cache read | 全部命中率 | 去掉首轮后的命中率 | 后四轮 input |
| --- | ---: | ---: | ---: | ---: | ---: |
| `baseline-v1` | 20,651 | 16,256 | 78.7% | 78.0% | 18,543 |
| `iron-law-lean-v1` | 19,210 | 13,440 | 70.0% | 77.2% | 17,403 |

首轮冷热状态不同，因此公平比较第 2–5 轮。lean 的命中率没有实质变化，但输入减少约 6.1%。结论是：Prompt 文案控制请求体积，Run 内稳定的装配前缀控制 cache 命中；旧的 2%→5% 不能作为 Prompt 优化收益。

### MiniMax

MiniMax CN Anthropic-compatible 路径已做两次最小真实 smoke：M2.7 输出 `MINIMAX_OK`，exit 0，usage 为 1,504 input / 39 output；M3 输出 `MINIMAX_M3_OK`，exit 0，usage 为 1,594 input / 7 output / 128 cache-read。trace 记录 `iron-law-lean-v1`。同一 CN token 调国际 endpoint 返回 `PROVIDER_AUTH_REQUIRED`，因此区域不能自动混用。

结果目录：

- `D:\agent-evals\results\minimax-smoke\2026-08-09__12-48-02`
- `D:\agent-evals\results\minimax-smoke\2026-08-09__12-49-54`

## 已完成的永久优化，以及为什么做

| 问题 | 根因 | 主干优化 | 为什么这样修 |
| --- | --- | --- | --- |
| 行数、普通工具失败和最终预算越界造成假失败 | 工具语义、effect 状态与终态计费耦合错误 | 修正 `read.totalLines`；已知失败释放 reservation；usage 可记录最后一轮 overshoot 后再终态化 | 任务失败应反映真实业务结果，不能由账本收尾制造第二个错误 |
| Provider 卡住或流损坏难诊断 | 只有模糊网络失败，没有绝对/无进展边界 | compatible Provider 增加结构化 `PROVIDER_TIMEOUT`；非法 stream 为 `PROVIDER_STREAM_INVALID` | 长任务可以放宽期限，但仍需可取消、可分类、可恢复的 liveness |
| MCP 获批环境变量没有进入 server | grant 只被记录，activation 未应用 | 只向 MCP 注入“已声明、已获批、父进程存在”的变量 | 修复功能同时保持最小环境与 secret 隔离 |
| Child 自由文本 JSON 易被引号破坏 | Provider 文本不是可靠协议终态 | Runtime-owned `praxis_submit_child_result`、强制 `toolChoice`、父侧 schema 与 criterion 二次校验 | 结构化结果必须由 Runtime 协议保证，不能依赖 Prompt 祈祷模型输出合法 JSON |
| replacement 无法复用旧成功节点 | `workflow.expand` 只认识本次局部节点 | dependencies 可引用既有成功 node；`inputRefs` 显式传入拥有的 Artifact 闭包；成功后才 supersede | 修复失败节点不应重跑已成功工作，也不能扩大 Artifact 权限 |
| 长 Child evidence 超过协议列表 | evidence 逐项内联无限增长 | 早期 refs 聚合为可递归 `subagent_evidence_manifest` Artifact | 取消人为任务寿命上限，同时保留完整审计链 |
| compaction 阈值被编辑后的 Tool 结果掩盖 | 用有损 Provider 视图计算未压缩成本 | 先按 canonical history 计算 uncompacted tokens | 成本触发必须反映真实待回放历史，不受发送前裁剪误导 |
| 摘要可能丢 Child 合同和前驱引用 | 可变历史与不可变授权混在一起 | 签名 ContextPacket 固定在 compactable history 外；`relevantRefs` 结构化继承 | 任务合同、权限和成功标准不能交给摘要模型记忆 |
| native compact 不可移植 | opaque state 与 provider/model/prompt 绑定 | portable semantic checkpoint 永远是底座；native 仅作精确绑定加速 | 路由切换或 Prompt 变更后仍能恢复 |
| cache 命中低 | 每轮变化的 ContextView 位于历史前缀前部 | Run 内冻结模型可见 ContextView，成功 compact 后才换代 | 让 ReAct 轮次只追加历史，形成稳定最长公共前缀 |
| Prompt 重复且静态成本高 | 安全句、动态事实和上下文混为 system 文本 | 单一 Trusted Instructions；动态 facts/Skill/project 下移为中性 context；默认 `iron-law-lean-v1` | Runtime 强制的边界不需要在多个 Prompt 块重复；减少输入而不削弱机械校验 |
| 可见的 `high/low trust` 干扰事实推理 | 指令权限、内容来源和事实可靠性被压成一个标签 | 生产 lean Prompt 只显示中性 context kind；Runtime 内部分离 authority/provenance/verification；旧措辞只留在 baseline 回滚 | 低权限 Tool/Child 证据仍可能是最关键事实，安全边界应由 grant/schema/receipt/verifier 执行 |
| semantic summary 把推测升级为事实字段 | 模型可向 `constraints/modifiedFiles/refs` 写入任意合法字符串 | checkpoint merge 改为字段级所有权：用户/Packet 决定合同，Runtime Tool/Packet 决定 evidence，模型只补充语义 continuation | JSON Schema 只能验证形状，不能证明权限、来源或副作用事实 |
| Tool/Child 参数错误难自修复 | Ajv 失败只返回笼统错误，模型不知道字段与约束 | 返回最多三项有界字段路径、约束及 unexpected property 名，不回显输入值；完善 `agent.delegate` 权限说明 | 提高下一轮自修复率，同时避免把 secret 写进错误与 trace |
| 嵌套 fetch/socket 错误退化为 `PROVIDER_ERROR` | Node/OpenAI SDK 把 Undici 错误码放在 `cause` 链 | 有界遍历 cause，识别 `UND_ERR_SOCKET/HEADERS_TIMEOUT/BODY_TIMEOUT` 等为可重试 transport error | 长任务偶发断流必须可分类、重试和统计，不能只留下笼统失败 |
| Provider usage 方言导致缓存/输入记账失真 | start/delta 或多个兼容字段的零占位覆盖最终值 | DeepSeek/OpenAI-compatible 与 Anthropic-compatible usage 取各位置合法最大值 | 评测、预算和 cache 优化必须建立在真实 usage 上 |
| Provider/Prompt 配置散落 | ID、endpoint、credential env、默认模型或 Prompt 默认在多个调用点重复 | MiniMax 集中到 `minimaxConfig.ts`；Prompt 默认集中到 `DEFAULT_PROMPT_VARIANT` | 新区域、模型或默认版本只改一个权威源，防止 factory/catalog/credential/trace 漂移 |
| 旧产品默认 ceiling 阻断长任务 | 6 分钟、turn/tool/child/depth 等被当作通用产品配额 | v4 产品路径取消隐式累计预算；只有用户、CLI、组织策略或 Proposal 显式限制 | 长生命周期任务由显式 policy 管理，不能被历史 smoke 参数意外终止 |
| 长等待被短任务 timeout 或 JS timer 范围误伤 | task deadline、no-progress、控制面健康检查和原生 timer 混为一类 | Agent 执行默认不设隐式 wall-clock/no-progress；显式长 deadline 分段重挂；HumanTask/Timer 进入 durable authority 和 wake pump | “允许长期等待”不等于永不取消；需要把可恢复业务等待与短控制面 liveness 分开 |
| 重复 Tool 调用被固定次数直接终止 | `LoopProgressGuard` 同时承担诊断与 Run 终止权限，真实优化任务在 145 turns 后因两次错误 cwd 命令被提前结束 | 重复调用、相同结果和连续同错改为周期性 advisory；只提示模型检查结果、修正工作目录或换方案，不再隐式终止 Run | no-progress 信号适合纠偏和观测；整个 Agent 的生杀权应来自显式预算、取消或外部 policy |

这些修复都落在 Praxis 主干语义，不是评测脚本里的临时绕过。评测侧也修正了 Harness 计分缩放、ground truth 路径、Kimi rubric 温度回退、adapter timeout/成功判定、AgentDojo state snapshot、Windows UTF-8 和 Harbor cache key；这些只保证测量有效，不能算作 Praxis 能力提升。

## 当前 Prompt 装配结论

默认程序是 `iron-law-lean-v1`，唯一默认源为 `DEFAULT_PROMPT_VARIANT`。最终模型可见顺序是：

1. 唯一 `praxis.trusted-instructions`；
2. `runtime_facts`；
3. 可选 `skill_catalog`；
4. 可选 `project_guidance`；
5. Child 才有的 pinned 签名 ContextPacket；
6. Run 内冻结的 `session_view`；
7. 可选 native context 或 portable `session_checkpoint`；
8. checkpoint 之后的最近完整消息后缀；
9. Tool definitions 作为独立 Provider 字段，不拼进 Trusted Instructions。

Reasoning 和 Tool-result editing 只生成 Provider 发送视图，不改 SessionJournal。成功 compact 后才更换 ContextView 快照。完整规范见 [Prompt、Context 与 Compaction](prompt-assembly.md)。

## 当前能力边界与下一轮测评

下一阶段不需要再证明“能不能创建 Child”，而应验证可靠性分布：

1. 将已通过的确定性 restart 场景重复 10–30 次，并增加第二次崩溃、不同故障点和副作用 receipt，统计恢复时延与重跑率；
2. 把当前 sentinel 场景扩成 compaction fidelity 集合，覆盖未完成事项、精确错误码、文件状态、Child ContextPacket 和 Artifact refs，并报告分布而非单次通过；
3. 用 Harbor 扩大任务正确性样本，区分 framework failure、provider failure、tool misuse 和 final-answer error；
4. 在远程 Worker/Authority、断网、Provider 限流和进程重启组合下做 soak；
5. 工具数量或 schema 体积达到门槛后，再评估 Tool Search，而不是现在增加额外发现回合。

## 证据索引

- Harness-Bench 修复后明细：`D:\agent-evals\RERUN-REPORT-2026-08-08.md`
- 三 benchmark 小批次：`D:\agent-evals\FULL-SMALL-BATCH-REPORT-2026-08-08.md`
- Compaction 与长任务：`D:\agent-evals\COMPACTION-AND-LONG-TASK-RECAP-2026-08-09.md`
- MiniMax 完整重启：`D:\agent-evals\results\multiagent\2026-08-09__14-01-38__restart-recovery\summary.json`
- MiniMax 多次 compaction：`D:\agent-evals\results\multi-compaction\2026-08-09__14-05-59\summary.json`
- Cache A/B：`D:\agent-evals\CACHE-OPTIMIZATION-REPORT-2026-08-09.md`
- MiniMax M3 中等任务扩展：`D:\agent-evals\MEDIUM-MINIMAX-REPORT-2026-08-18.md`
- 早期故障发现：`D:\agent-evals\SMALL-SAMPLE-REPORT-2026-08-08.md`

历史报告记录当时状态，其中“尚未验证多 Agent”“MiniMax fallback 未使用”等句子只描述对应批次，不代表当前最终状态。
