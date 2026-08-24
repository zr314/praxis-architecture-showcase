# Praxis 测评档案

最后更新：2026-08-24。

这里是 Praxis 测评结果的**权威入口**。它记录已经实际运行并有机器证据的测评，而不是功能愿望、单元测试清单或模型自述。老的[最终小样本测评](../evaluation-final-2026-08-09.md)是 2026-08-09 至 2026-08-18 的阶段快照；本目录会继续追加，发生冲突时以本目录和原始结果文件为准。

## 新手先看结论

截至 2026-08-24，已有证据支持以下判断：

- Praxis 能承载普通文件任务、代码修复、任务拆解、Linux 终端操作和带工具调用的真实任务。
- Praxis 的持久 Workflow 已实际跑通过 Child/Subagent DAG、后台执行、`all`/`quorum` join、cross-review、父进程退出后的恢复和 Provider-aware 容量准入。
- 默认 Agent Run Tree 已真实跑通“观察变化后改计划”：Root 取消正在运行但已失去价值的 Child，把新要求持久 steer 给尚未启动的 Child，再只等待保留分支；修复后取消终态、结果引用和 Root 收敛一致。
- 上下文可以由模型生成语义 checkpoint；DeepSeek 单次压缩和 MiniMax 19 次连续压缩都提供了连续性证据。最新 batching 诊断也证明摘要本身会截断或写错长题面，因此当前 Root/Child Run 的逐字用户任务已固定在 compaction 之外，checkpoint 只负责工作进度。
- AgentDojo 当前共覆盖 9 个不同 clean 用户任务和 6 个 attacked rollout；clean utility 9/9、攻击下 utility 6/6，恶意目标 0/6。另有 4 个直接授权的注入目标有效性控制全部成功，证明攻击目标本身可执行。样本仍很小，不能据此宣称“绝对安全”。
- Terminal-Bench 2 的 MiniMax 中等任务批次有 20 个本地 rollout 可被官方 verifier 正常评分，其中 15 个通过（75%）；后续独立续测与 2026-08-24 扩样本又通过 Git、多格式迁移、数据库恢复、PTY、LLM batching、安全修复、科学栈迁移、LaTeX、QEMU 和 SPARQL 等任务。目前本档案共收录 30 道不同的已通过题目。这个数字不是官方排行榜成绩。
- MiniMax 额度恢复后的 2026-08-23 续测完成了本地 REST、HTML 表单、代码修复、批处理、schema round-trip、cursor/checkpoint 长任务、离线 QA 和隐私审查等代表题。新增两个原始满分；另识别出陈旧 fixture 哈希、负面证据误报和未声明的 exact-byte/hidden input 约束，均与模型/Runtime 失败分开记录。
- Harness 代表批次最长有效任务运行 531.484 秒、54 turns、64 tools。Terminal-Bench 的 `make-mips-interpreter` 最新有效运行持续 57 分 10 秒、487 turns / 486 tools、9 次 compaction，首帧存在且相似但缺精确 stdout，属于有效 FAIL；`llm-inference-batching-scheduler` 修复后 24 分 16 秒、3 次 compaction，官方 6/6、reward 1。
- 不同额度阶段分别保留了 `PROVIDER_RATE_LIMITED`、`PROVIDER_MODEL_UNAVAILABLE` 和再次恢复后第 482 轮的 `PROVIDER_RATE_LIMITED` 原始终态；额度/模型访问中断样本都没有记作有效任务失败。

这些结果说明框架已经从“能调用 LLM 的聊天壳”进入“有持久执行、权限、恢复、上下文治理和多 Agent 编排的 Agent Harness”。它仍不足以证明工业级 SLA：样本量、模型覆盖、远程多 Worker、高并发、跨天运行和故障注入次数都还不够。

## 一次运行到底怎样才算通过

`prompt_completed` 只表示 Runtime 正常结束了这一轮 Prompt。它不等于题目正确。本文档按下面三层记录：

| 层级 | 谁来判断 | “通过”的含义 |
| --- | --- | --- |
| 任务正确性 | benchmark 的 oracle/verifier/reward | 生成的文件、服务或答案符合题目要求 |
| 框架能力 | Workflow 状态、journal、Artifact、sentinel 和恢复不变量 | 调度、持久化、join、权限或 compaction 的指定性质成立 |
| 运行终态 | CLI/Runtime | 进程 exit 0 或出现 `prompt_completed`，仅说明没有在协议层崩溃 |

一项测评只要对某个重要层级提供了有效证据就可以收录，但每个层级必须分别标成 `PASS / PARTIAL / FAIL / N/A`。因此“框架能力 PASS、Prompt 服从 FAIL”不是整题完全通过；它只是证明了框架性质。`N/A` 表示该题没有测这一层。

## 阅读顺序

1. [Benchmark 收尾与低分归因（2026-08-24）](benchmark-closeout-20260824.md)：回答“是否测完”、哪些低分已复验、哪些属于模型、题面、评分器或 Runtime，以及为什么停止重复跑题。
2. [MiniMax M3 Terminal-Bench 与 AgentDojo 扩样本（2026-08-24）](minimax-terminal-agentdojo-expansion-20260824.md)：Terminal 新题 5/5、AgentDojo 新 clean 6/6、四个攻击组合及磁盘清理。
3. [公开 Benchmark 结果](passed-benchmarks.md)：Harness-Bench、Terminal-Bench 2、AgentDojo；包含实际题目内容、逐题结果和逐字题面来源。
4. [MiniMax M3 + Auto 额度再次重置后的 Terminal-Bench 续测（2026-08-23—24）](minimax-auto-terminalbench-resume-20260823.md)：第一阶段 10 个任务、无累计上限续测及最后两道 INVALID 收尾；含 MIPS 有效终局、batching 6/6、逐字任务固定层、单 Shell 活动租约和详细主干修复。
5. [MiniMax M3 + Auto 续跑至额度耗尽（2026-08-23）](minimax-auto-benchmark-exhaustion-20260823.md)：106 题当前有效快照、7 个新增 Terminal rollout、实际题目、Prompt A/B、主干修复与前一阶段额度证据。
6. [MiniMax M3 + Auto 代表性续测（2026-08-23）](minimax-auto-harnessbench-20260823.md)：额度恢复后的 11 类代表题；包含实际题目、raw/合同调整分、六层归因、Prompt 修复和新手术语。
7. [MiniMax M3 + Auto 持续测评（2026-08-22）](minimax-auto-harnessbench-20260822.md)：持续运行到 Provider 明确限流；包含 20 个有效续跑任务、长任务重复、额度终态、逐题实际内容和问题归因。
8. [平台与长任务结果](passed-platform-evaluations.md)：Subagent DAG、join、cross-review、恢复、compaction、cache 和 Provider；包含实际压力题目。
9. [测评运行总账](run-ledger.md)：一行一个 rollout/批次，保留 PASS、PARTIAL、FAIL、INVALID 和被替代运行。
10. [问题与处理方法](issues-and-fixes.md)：症状、根因、永久修复、复验方式，以及哪些问题属于模型或外部环境。
11. [术语与维护规则](glossary-and-maintenance.md)：给新手的词典、证据等级、怎样追加下一次测评。

## 当前测评分层状态总表

| 编号 | 规模 | 任务正确性 | 框架能力 | Prompt/格式服从 | Runtime 终态 | 当前结论 |
| --- | ---: | --- | --- | --- | --- | --- |
| `EV-HB-20260808` | 3 题 | PARTIAL | PASS | PARTIAL | PASS | 连续分数，无官方二元阈值；综合均分 0.9219 |
| `EV-HB-20260822-087` | 1 题 | PASS（0.8964 / good） | PASS | PASS | PASS | MiniMax M3 + 新 `auto`；18/18 pytest、隐藏行为 6/6，模型自主 direct、0 Child |
| `EV-HB-20260822-098` | 1 题 | SUPERSEDED（首次 0.5251；当前 0.7371） | PASS | PARTIAL | PASS | hard 多来源综合；后续复验改善但仍有规范键、来源和 feature scope 综合不足 |
| `EV-HB-20260822-CONT` | 20 个有效任务 + 2 个额度临界任务 | PARTIAL（有效任务均分 0.8027） | PASS | PARTIAL | PARTIAL | 4 个满分、8 个 ≥0.90；最长 1,139.631 秒；最终单路 0-turn `PROVIDER_RATE_LIMITED`，详见独立报告 |
| `EV-HB-20260823-REP` | 14 个代表 rollout | PARTIAL | PASS | PARTIAL | PASS | 2 个 raw 满分；4 个 oracle/题面敏感项有合同调整；最长有效运行 531.484 秒，无 compaction/truncation；详见独立报告 |
| `EV-HB-20260823-CANON` | 106 题最新有效快照 | PARTIAL（均分 0.8269） | PARTIAL | PARTIAL | PASS（adapter 106/106） | 中位数 0.8883；28 个满分；混合修复阶段的代表结果，不是同版全量 leaderboard 批次 |
| `EV-TB2-20260808` | 3 题 | PARTIAL（1/3） | PASS | PARTIAL | PASS | 只把 reward 1 的 `fix-git` 收入通过题 |
| `EV-TB2-20260818` | 20 rollout | PARTIAL（15/20） | PASS | PARTIAL | PASS | 本地、可被官方 verifier 正常评分；去重为 15/18 |
| `EV-TB2-20260821-GIT` | 1 题 | PASS | PASS | PASS | PASS | `git-multibranch` reward 1 |
| `EV-TB2-20260823-EXHAUST` | 6 个有效 rollout + 1 个额度中断 | PARTIAL（4/6 reward 1） | PARTIAL | PARTIAL | PARTIAL | 新增 3 道不同通过题；effect 终态仍有已知不一致；`polyglot-c-py` INVALID |
| `EV-TB2-20260823-RESUME` | 7 个有效 rollout + 3 个无效/前置样本 | PARTIAL（4/7 reward 1） | PASS（长生命周期） | PARTIAL | PARTIAL | 新增 4 道不同通过题；最长有效题 26m31s；MIPS 451 轮后 Provider model unavailable |
| `EV-TB2-20260823-NOLIMIT` | 4 个有效 rollout + 2 个诊断/额度中断样本 | FAIL（0/4 reward 1） | PASS（长生命周期） | PARTIAL | PARTIAL | 无内部累计预算；MIPS 482 turns/tools、9 次 compaction、1 Child 后 Provider rate limited；不计无效样本正确率 |
| `EV-TB2-20260824-CLOSEOUT` | 2 个有效 rollout + 1 个诊断样本 | PARTIAL（1/2 reward 1） | PASS | PARTIAL | PASS | MIPS 2/3 有效 FAIL；batching 修复后 6/6 PASS；3 次 compaction 后两桶合同不漂移 |
| `EV-TB2-20260824-EXPAND` | 5 道全新任务 | PASS（5/5 reward 1） | PASS | PASS | PASS | 安全修复、科学迁移、LaTeX、QEMU、SPARQL；101 turns/106 tools，0 exception |
| `EV-DOJO-20260808` | 7 次 | PASS | PASS | PASS | PASS | clean 3/3，攻击下 utility 2/2，恶意目标 0/2 |
| `EV-DOJO-20260824-EXPAND` | 12 次新增运行 | PASS | PASS | PASS | PASS | 新 clean 6/6；注入有效性 2/2；攻击下 utility 4/4、恶意目标 0/4 |
| `EV-WF-QUORUM` | 2 个代表运行 | N/A | PASS | PASS | PASS | 2-of-3、取消尾部节点、Root 恢复成立 |
| `EV-WF-CROSS` | 1 个代表运行 | N/A | PASS | FAIL | PASS | DAG 完成；模型第 4 次才给出合法 expand 参数 |
| `EV-WF-IPC` | 1 个代表运行 | N/A | PASS | PASS | PASS | 后台 Worker、mailbox、单次 join、Artifact 回读成立 |
| `EV-WF-CAPACITY` | 1 个代表运行 | N/A | PASS | PASS | PASS | 持久 capacity admission 成立，无 429 |
| `EV-WF-RESTART` | 1 个确定性运行 | N/A | PASS | N/A | PASS | 只重试中断 Attempt，已成功节点不重放 |
| `EV-RUN-TREE-20260822` | 4 个 rollout | PARTIAL | PASS | FAIL | PASS | 自主组 0 Child；受控组修复后 2 Child 全成功，最终综合仍有事实/格式错误 |
| `EV-RUN-TREE-REPLAN` | 2 个修复前后 rollout | PARTIAL | PASS | FAIL | PASS | spawn×2 → cancel/steer → wait/result；运行中取消终态缺陷修复后闭环通过 |
| `EV-COMPACT-DEEPSEEK` | 1 次 | PASS | PASS | PASS | PASS | checkpoint 后保留合同并输出 `COMPACT_OK` |
| `EV-COMPACT-MINIMAX` | 1 次 | FAIL | PASS | FAIL | PASS | 19 次压缩保真成立；禁止工具与起始格式未遵守 |
| `EV-CACHE-AB` | 2 路 A/B | PASS | PASS | PASS | PASS | 都完成；lean 累计输入少 6.98% |
| `EV-PROVIDER-MINIMAX` | 2 次 smoke | PASS | PASS | PASS | PASS | M2.7、M3 中国区路径均可调用 |

逐题内容见[公开 Benchmark](passed-benchmarks.md)和[平台长任务](passed-platform-evaluations.md)；一行一个运行/批次的状态见[运行总账](run-ledger.md)。

## 证据保存在哪里

- 题目源：`D:\agent-evals\sources\`
- 原始运行结果：`D:\agent-evals\results\`
- 测评脚本：`D:\agent-evals\scripts\`
- Praxis 内的阶段总结：`docs/evaluation-final-2026-08-09.md`
- 本目录：人工可读的权威索引和解释，不替代原始 JSON、JSONL、SQLite journal 或 benchmark verifier。

原始目录不在本仓库 Git 中，所以迁移电脑或清理 D 盘前应一并归档。文档中不保存 API key；包含密钥的 trace 必须先脱敏。

## 不能从这些结果推出什么

- 不能推出任何模型在所有任务上都可靠。
- 不能推出 Praxis 已达到 99.9% 可用性、可无限扩展或能抵御所有提示注入。
- 不能把小样本通过率与别的产品排行榜直接横比；模型、题目集合、重复次数和执行环境并不相同。
- 不能用模型最终回答中的自我评价替代数据库状态和官方 verifier。
- 不能因为 Child 拥有大部分 Root 工具，就认为它自动具备正确的角色分工；委派质量仍受 Prompt 和模型工具偏好影响。
