# 测评汇总历史快照（整理前）

> 2026-09-05 文档整理时保留的索引与汇总数字。下文“当前”指各批次当时的维护状态；不作为新构建的统一成绩。English summary: retained historical evaluation totals.

最后更新：2026-09-05。

当前代码已切换为[轻量 Working Plan](../../working-plan.md)，而本目录历史 P&R 成绩对应严格 ReviewPlan。[首次真实 MiniMax 验证](working-plan-validation-20260905.md)已结束：KV 官方 5/7、reward 0，Runtime 13 轮正常收尾，但咨询 Review 三次校验失败后 unavailable。清单/降级机制通过不等于任务通过；必须记录 policy 与冻结构建，不能把新的 optional Plan 与旧严格 P&R 混成一个实验组。

随后完成[咨询合同与证据配对改进](working-plan-advisory-improvement-20260905.md)：全量本地 1135 通过、5 跳过、0 失败；MiniMax 同题 17 轮正常完成，Review 一次响应有效，但误接受了错误接口，官方仍 5/7、reward 0。机制修复有证据，任务提分没有证据，新的语义错误接受保留为待改进项。

这里是 Praxis 测评结果的**权威入口**。它记录已经实际运行并有机器证据的测评，而不是功能愿望、单元测试清单或模型自述。带日期的过程报告和早期阶段快照已移入[测评归档](README.md)；发生冲突时，以本页的维护表、运行总账和原始结果为准。

2026-09-05：[Plan-and-Review 通用优化记录](plan-review-generalization-20260905.md)说明本轮代码改动、本地回归与历史归因更正。它不是新增 benchmark 成绩，旧题分数不变。

通用优化后的 MTEB / KV-store [真实复测](plan-review-rerun-20260905.md)已停止：MTEB 两臂均 1/2、reward 0，KV P&R 环境安装失败，KV P&E 未启动。随后 [proof-audit 验证](plan-review-proof-audit-20260905.md)也已结束：KV P&R 官方 7/7、reward 1，但 blocked 后 Runtime 空转直到额度耗尽，不能算正常完成；其余三次未启动。[收敛修复与设计判断](plan-review-convergence-20260905.md)记录本次通用修改与验证边界。两批都不重跑 ReAct，未完成项不计成绩。

## 新手先看结论

截至 2026-09-04，已有证据支持以下判断：

- Praxis 能承载普通文件任务、代码修复、任务拆解、Linux 终端操作和带工具调用的真实任务。
- Praxis 的持久 Workflow 已实际跑通过 Child/Subagent DAG、后台执行、`all`/`quorum` join、cross-review、父进程退出后的恢复和 Provider-aware 容量准入。
- 默认 Agent Run Tree 已真实跑通“观察变化后改计划”：Root 取消正在运行但已失去价值的 Child，把新要求持久 steer 给尚未启动的 Child，再只等待保留分支；修复后取消终态、结果引用和 Root 收敛一致。
- 上下文可以由模型生成语义 checkpoint；DeepSeek 单次压缩和 MiniMax 19 次连续压缩都提供了连续性证据。最新 batching 诊断也证明摘要本身会截断或写错长题面，因此当前 Root/Child Run 的逐字用户任务已固定在 compaction 之外，checkpoint 只负责工作进度。
- AgentDojo 当前共覆盖 9 个不同 clean 用户任务和 6 个 attacked rollout；clean utility 9/9、攻击下 utility 6/6，恶意目标 0/6。另有 4 个直接授权的注入目标有效性控制全部成功，证明攻击目标本身可执行。样本仍很小，不能据此宣称“绝对安全”。
- Terminal-Bench 2 的 MiniMax 中等任务批次有 20 个本地 rollout 可被官方 verifier 正常评分，其中 15 个通过（75%）；后续独立续测与扩样本又通过 Git、多格式迁移、数据库恢复、PTY、LLM batching、安全修复、科学栈迁移、LaTeX、QEMU、SPARQL、Scheme、异步取消、gRPC、pMARS 和 C++ 堆内存修复等任务。目前本档案共收录 35 道不同的已通过题目；这是跨版本成功覆盖数，不是固定批次成功率或官方排行榜成绩。
- MiniMax 额度恢复后的 2026-08-23 续测完成了本地 REST、HTML 表单、代码修复、批处理、schema round-trip、cursor/checkpoint 长任务、离线 QA 和隐私审查等代表题。新增两个原始满分；另识别出陈旧 fixture 哈希、负面证据误报和未声明的 exact-byte/hidden input 约束，均与模型/Runtime 失败分开记录。
- Harness 代表批次最长有效任务运行 531.484 秒、54 turns、64 tools。Terminal-Bench 的 `make-mips-interpreter` 最新有效运行持续 57 分 10 秒、487 turns / 486 tools、9 次 compaction，首帧存在且相似但缺精确 stdout，属于有效 FAIL；`llm-inference-batching-scheduler` 修复后 24 分 16 秒、3 次 compaction，官方 6/6、reward 1。
- 不同额度阶段分别保留了 `PROVIDER_RATE_LIMITED`、`PROVIDER_MODEL_UNAVAILABLE` 和再次恢复后第 482 轮的 `PROVIDER_RATE_LIMITED` 原始终态；额度/模型访问中断样本都没有记作有效任务失败。
- 2026-09-02 新 ReviewPlan 批次增加 3 道此前未记录的 Terminal-Bench 2 题：官方 reward 都是 0，但分别达到 8/9、2/4、61/63；三题的 `auto` 都保持 Direct。随后的真实 MiniMax 控制样本发现并修复 Plan Schema、Reviewer structured-output、usage 持久化和终态 replan 四类缺陷，最终完整走通 Item Review 与 Final Review。
- 2026-09-04 增加 Direct/ReAct、Plan-and-Execute、Plan-and-Review 三臂比较，Direct 直接复用。四个三臂交集题所选结果为 P&R 4/4、P&E 3/4、历史 Direct 0/4；题目刻意选自历史失败，版本不同且包括修复重试，不是严格 Pass@1 或总体提升。DB-WAL 的 P&R 仍缺有效终态；C++ 旧 P&R 诊断又发现摘要截断与路径误报，修复复验后 6/6。pMARS/C++ 的 P&E、P&R 同分，但 P&R 未缓存输入分别约 24.6/33.1 倍。C++ 还暴露了 Reviewer 证据误用 2 KiB 描述符上限的问题，主干已修正并离线核对；成功不能掩盖成本和可靠性缺口。

这些结果说明框架已经从“能调用 LLM 的聊天壳”进入“有持久执行、权限、恢复、上下文治理和多 Agent 编排的 Agent Harness”。它仍不足以证明工业级 SLA：样本量、模型覆盖、远程多 Worker、高并发、跨天运行和故障注入次数都还不够。

## 一次运行到底怎样才算通过

最新低分续测补充：G-code P&E 为诊断 INVALID；MTEB 的 P&E/P&R 均 1/2、reward 0，Reviewer 接受了不充分的历史时间证据。加入 MTEB 后，所选三臂交集为 5 题，P&R 4/5、P&E 3/5、历史 Direct 0/5，仍是偏置选样和跨版本代表，不是严格通过率提升。T74 还确认 terminal 未汇总独立 Reviewer token；旧 token 比值不代表全量调用费用。详见[本轮完整记录](plan-low-score-expansion-20260904.md)。

`prompt_completed` 只表示 Runtime 正常结束了这一轮 Prompt。它不等于题目正确。本文档按下面三层记录：

| 层级 | 谁来判断 | “通过”的含义 |
| --- | --- | --- |
| 任务正确性 | benchmark 的 oracle/verifier/reward | 生成的文件、服务或答案符合题目要求 |
| 框架能力 | Workflow 状态、journal、Artifact、sentinel 和恢复不变量 | 调度、持久化、join、权限或 compaction 的指定性质成立 |
| 运行终态 | CLI/Runtime | 进程 exit 0 或出现 `prompt_completed`，仅说明没有在协议层崩溃 |

一项测评只要对某个重要层级提供了有效证据就可以收录，但每个层级必须分别标成 `PASS / PARTIAL / FAIL / N/A`。因此“框架能力 PASS、Prompt 服从 FAIL”不是整题完全通过；它只是证明了框架性质。`N/A` 表示该题没有测这一层。

## 阅读顺序

1. [公开 Benchmark 结果](../passed-benchmarks.md)：Harness-Bench、Terminal-Bench 2 与 AgentDojo 的维护表。
2. [平台与长任务结果](../passed-platform-evaluations.md)：显式 Workflow/Run Tree、恢复、compaction、cache 和 Provider。
3. [测评运行总账](../run-ledger.md)：一行一个 rollout 或批次，保留 PASS、PARTIAL、FAIL、INVALID 和被替代运行。
4. [问题与处理方法](../issues-and-fixes.md)：症状、根因、永久修复和复验方式。
5. [术语与维护规则](../glossary-and-maintenance.md)：证据等级与后续更新流程。
6. [按日期归档的过程报告](README.md)：只在需要追溯某次运行时阅读。
7. [2026-09-02 `auto` 与 ReviewPlan 真实测评](review-plan-validation-20260902.md)：新 Planner 上线后的公开题、缺陷闭环和真实 Reviewer 生命周期。
8. [Plan-and-Review 与 Plan-and-Execute 对照测评](plan-review-vs-plan-execute.md)：策略定义、实际题面、真实结果、历史 Direct 复用、无效样本判定与配对指标。
9. [2026-09-04 配额恢复续测](plan-review-quota-reset-20260904.md)：DB-WAL 诊断、pMARS 三臂对照、通用 Prompt/错误信息修正与冻结证据探针。
10. [2026-09-04 历史低分题扩展](plan-low-score-expansion-20260904.md)：拉曼拟合、G-code 还原与 MTEB 检索的 P&E / P&R 配对，保留实际题面与进行状态；不重跑 ReAct。

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
| `EV-WF-CROSS` | 1 个代表运行 | N/A | PASS | FAIL | PASS | 旧显式 `workflow.expand` 路径完成；模型第 4 次才给出合法参数，不代表当前 `auto` 暴露 DAG |
| `EV-WF-IPC` | 1 个代表运行 | N/A | PASS | PASS | PASS | 后台 Worker、mailbox、单次 join、Artifact 回读成立 |
| `EV-WF-CAPACITY` | 1 个代表运行 | N/A | PASS | PASS | PASS | 持久 capacity admission 成立，无 429 |
| `EV-WF-RESTART` | 1 个确定性运行 | N/A | PASS | N/A | PASS | 只重试中断 Attempt，已成功节点不重放 |
| `EV-RUN-TREE-20260822` | 4 个 rollout | PARTIAL | PASS | FAIL | PASS | 自主组 0 Child；受控组修复后 2 Child 全成功，最终综合仍有事实/格式错误 |
| `EV-RUN-TREE-REPLAN` | 2 个修复前后 rollout | PARTIAL | PASS | FAIL | PASS | spawn×2 → cancel/steer → wait/result；运行中取消终态缺陷修复后闭环通过 |
| `EV-COMPACT-DEEPSEEK` | 1 次 | PASS | PASS | PASS | PASS | checkpoint 后保留合同并输出 `COMPACT_OK` |
| `EV-COMPACT-MINIMAX` | 1 次 | FAIL | PASS | FAIL | PASS | 19 次压缩保真成立；禁止工具与起始格式未遵守 |
| `EV-CACHE-AB` | 2 路 A/B | PASS | PASS | PASS | PASS | 都完成；lean 累计输入少 6.98% |
| `EV-PROVIDER-MINIMAX` | 2 次 smoke | PASS | PASS | PASS | PASS | M2.7、M3 中国区路径均可调用 |
| `EV-TB2-20260902-PLAN-AUTO` | 3 道全新任务 | FAIL（0/3 reward 1；子项 8/9、2/4、61/63） | PASS（Direct 长生命周期） | PARTIAL（0/3 创建 Plan） | PASS | 全部有效评分；最长题 336 Provider turns、335 Tool calls、7 次 compaction |
| `EV-REVIEWPLAN-20260902` | 3 个递进控制样本 | N/A | PASS（修复后） | PASS（required 样本） | PASS | v1/v2 定位四类缺陷；v3 Plan completed、两次 Review 均单次 accepted |
| `EV-PLAN-ABC-20260904` | 3 题；2 题三臂完整 | PARTIAL（完整交集 P&R 2/2、P&E 1/2、Direct 0/2） | PASS（修复后） | PARTIAL | PARTIAL | 复用历史 Direct；KV 出现 P&R 纠偏增益；DB-WAL r1 暴露并修复预算所有权缺陷，r2 因 Provider 配额 invalid |
| `EV-PLAN-RESET-20260904` | 3 道旧题；6 个新增 rollout | 4 PASS + 2 INVALID 诊断 | PARTIAL（暴露摘要/证据装配缺陷，主干修正） | PARTIAL | 4 正常完成、2 人工诊断中止 | pMARS 与 C++ 两种 Plan 都通过；历史 ReAct 不重跑；不是固定版本 Pass@1；详见配额恢复续测 |

逐题内容见[公开 Benchmark](../passed-benchmarks.md)和[平台长任务](../passed-platform-evaluations.md)；一行一个运行/批次的状态见[运行总账](../run-ledger.md)。

## 证据保存在哪里

- 仓库内：本目录的维护表、[运行总账](../run-ledger.md)、问题记录和[过程归档](README.md)。
- 仓库外：原始 JSON、JSONL、SQLite journal、benchmark verifier 输出和环境快照；具体根目录由评测操作者记录，不写死为某台机器路径。
- 安全边界：文档不保存 API key；Trace 和外部归档在共享前必须脱敏。

人工可读文档用于导航和解释，不能替代原始机器证据。

## 三套公开 benchmark 与生产控制面的边界

Harness-Bench、Harbor / Terminal-Bench 2、AgentDojo 覆盖的是固定数据集上的离线行为证据：分别侧重
workspace 结果与轨迹、容器任务的官方 verifier/reward、以及 MCP 工具下的 utility/prompt injection。
Harbor 配对脚本还能比较 Direct/ReAct、Plan-and-Execute 与 Plan-and-Review 的 reward、usage、耗时和 `plan.*` 调用污染；已有可比 Direct 结果优先复用，避免为了控制臂重复消耗 Provider token。

它们不覆盖集中式生产观测、在线评测或灰度控制面。原始 trace/stream/reward 能作为未来能力的数据输入，
但当前没有跨实例 collector/query/retention/SLO，没有从真实生产 trace 抽样并异步评分的流水线，也没有
version registry、tenant/cohort 流量分桶、shadow/canary、自动停止或回滚。固定题集离线 A/B 只能作为发布前
门禁，不能当作生产 canary。

## 不能从这些结果推出什么

- 不能推出任何模型在所有任务上都可靠。
- 不能推出 Praxis 已达到 99.9% 可用性、可无限扩展或能抵御所有提示注入。
- 不能把小样本通过率与别的产品排行榜直接横比；模型、题目集合、重复次数和执行环境并不相同。
- 不能用模型最终回答中的自我评价替代数据库状态和官方 verifier。
- 不能因为 Child 拥有大部分 Root 工具，就认为它自动具备正确的角色分工；委派质量仍受 Prompt 和模型工具偏好影响。
- 不能用本地 JSONL 和 benchmark 汇总宣称已有集中式生产可观测平台。
- 不能把固定题集的离线 grader/A-B 宣称成在线评测或真实流量灰度控制面。
