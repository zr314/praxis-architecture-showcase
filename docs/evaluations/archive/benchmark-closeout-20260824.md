# Benchmark 收尾与低分归因（2026-08-24）

## 1. 收尾结论

本阶段预先选定的三类小样本测评已经完成。随后按用户要求又扩大了 Terminal-Bench 与 AgentDojo；新增结果见[扩样本报告](minimax-terminal-agentdojo-expansion-20260824.md)：Terminal 新题 5/5，AgentDojo 新 clean 6/6、攻击下 utility 4/4、恶意目标 0/4。

| 测评 | 已完成范围 | 当前结论 |
| --- | --- | --- |
| Harness-Bench | 001–106 的最新有效代表快照，以及若干修复前后复验 | 106/106 都有可用 adapter 结果；当前快照均分 0.8269、中位数 0.8883、28 个满分、51 个不低于 0.90。它混合了不同修复阶段，不是同一 commit 的官方排行榜批次。 |
| Terminal-Bench 2 / Harbor | 既定中等样本、长任务收尾和五道新增异构题 | 当前档案有 30 道不同的 reward 1 题；新增五题 5/5、0 exception。 |
| AgentDojo | 历史 7 次 + 2026-08-24 新增 12 次 | 9 个不同 clean 用户任务全过；攻击下 utility 6/6，恶意目标 0/6。样本仍不能外推为“绝对安全”。 |

这里的“完成”指**既定本地小样本计划有终局和机器证据**，不表示把三个上游仓库的全部题目做成正式 leaderboard 提交。Harness-Bench 的 `003-browser`、`006-access-bilibili` 没有在当前 Web/Browser 工具面上做新的同版复验；远程浏览器、登录态和公开互联网仍是明确覆盖空白。

## 2. 本轮实际发生的修复后复验

### 2.1 已经提升，不再重复刷分

| 题目 | 旧结果 | 最新有效结果 | 说明 |
| --- | ---: | ---: | --- |
| HB-078 `local-api-cursor-retry-ledger` | 0.2593 | **0.7778** | `read.hasBom`、PowerShell 编码事实和最终验收合同加入后，JSON、精确 CSV header、inventory、checkpoint 和服务器侧 retry 都通过。剩余问题是模型在正式脚本前探测 API，提前消耗一次性 429，最终 ledger/report 没保留该证据。 |
| HB-098 `three-source-decision-record-synthesis` | 0.5251 | **0.7371** | 后续运行提高了决策、来源和 action 覆盖，但仍只命中部分规范值；属于多来源结构化综合质量，不是 Runtime 中断。 |
| HB-099 `privacy-dsar-intake-review` | 0.6000 | **1.0000** | 首次运行把完整 PII 写进 audit；后续有效运行通过全部 oracle。单次前后对比说明问题可被模型纠正，但不能仅凭两次样本断言 Prompt 对所有隐私任务都稳定有效。 |
| Terminal `llm-inference-batching-scheduler` | INVALID，checkpoint 合同被截断并混淆 | **reward 1，6/6** | Runtime 把当前 Root/Child 的逐字任务固定在 compaction 之外，并为单条 shell 活动增加默认安全租约；修复后经历 3 次 compaction，B1/B2 合同保持正确。 |

HB-078 最新机器证据是 `D:\agent-evals\results\harnessbench\praxis-auto-minimax\unknown-api\078-local-api-cursor-retry-ledger.json`：92.447 秒、13 turns、17 tools。它已经是通用修复后的复验；再运行同题不会验证新的主干变化，只会增加模型随机方差，所以本轮不再重跑。

### 2.2 不应靠重跑掩盖的评分问题

- HB-023 的 source hash 已陈旧，业务检查全部通过；raw 0.9474，按公开合同为 1.0。
- HB-080 唯一差异是题面未要求的 CSV 末尾换行；raw 0.8261，按公开合同为 1.0。
- HB-088 同时包含陈旧 fixture MD5 和超出公开 `base_url` 合同的隐藏输入。正确动作是版本化 evaluator/题面后 regrade，而不是让 Agent 猜隐藏实现。
- HB-096 的 negative-evidence 扫描把正确的否定说明误判成采用禁用事实；raw 0.65，按公开合同为 1.0。
- Terminal `make-mips-interpreter` 的题面要求启动 DOOM、保存帧并检查首帧；它没有公开要求 stdout 必须逐字包含 `I_InitGraphics: DOOM screen size: w x h: 320 x 200`。最终运行已通过“文件存在”和“图像相似”，只在这个 verifier 实现条件上失败。raw reward 仍保留为 0，但不能把它写成模型遗漏了公开验收条款。

## 3. 当前低分项逐类分析

### 3.1 模型的实现或数据推理错误

这些 rollout 的 Runtime 都正常结束，未发现 Tool、权限、Planner 或 compaction 造成的证据。直接重跑只能测模型方差；除非主干新增机械校验器，否则不属于“修复后必须复验”。

| 题目 | 当前代表分/结果 | 主要错误 | 为什么不立即重跑 |
| --- | ---: | --- | --- |
| HB-086 SQL migration | 0.1600 | migration 引用了不存在的 `_billing_already_migrated` 列，迁移和 rollback 都不能执行 | 明确的 SQL 实现错误，没有对应 Runtime 修复 |
| HB-077 archive defense | 0.2759 | 安全文件虽被抽取，但 logical path/archive chain 与精确 manifest 合同不一致，导致高权重整组失败 | 产物规范化错误；框架正确执行了文件工具 |
| HB-092 schema drift | 0.3269 | 只识别 3/6 drift，reject 结构类型错误，汇总计数随之错误 | 数据语义推理与 schema 输出错误 |
| HB-090 time-series attribution | 0.3729 | anomaly 集合、归因优先级和影响汇总不符合 truth | 算法/阈值理解错误 |
| HB-073 research repro | 0.4600 | 没有正确记录 `analysis_driver_unusable` 等关键阻断项，且给出过强复现结论 | 证据审计质量错误 |
| HB-074 grading feedback | 0.5200 | 精确评分与反馈覆盖不符合 rubric | 模型评分推理错误 |
| HB-031 citation check | 0.5556 | 漏报 Claim B/D，修订引用仍包含 retired source | 跨文档核对不完整 |
| HB-055 funnel analysis | 0.5792 | 修改/丢失 fixture，阶段用户集合、去重和 cohort 指标错误 | 数据处理实现错误，且违反输入不可变 |
| Terminal `cancel-async-tasks` | 5/6，reward 0 | SIGINT 时正在运行任务没有执行 cleanup | asyncio 实现错误 |
| Terminal `db-wal-recovery` | 5/7，reward 0 | 对 WAL 中 id=1 的更新值解释错误 | 数据库取证错误 |
| Terminal `custom-memory-heap-crash` | 5/6，reward 0 | Release 析构阶段 SIGSEGV | C++ 生命周期实现错误 |
| Terminal `raman-fitting` | 1/3，reward 0 | 误读坐标/第一列语义，拟合结果偏离目标 | 科学数据理解错误 |
| Terminal `kv-store-grpc` | 5/7，reward 0 | proto 响应漏显式 `value` 字段 | 接口实现遗漏 |
| Terminal `mteb-leaderboard` | 1/2，reward 0 | 历史 cutoff 检索答案错误 | 知识/检索错误；当前又没有 Web Search |
| Terminal `gcode-to-text` | 1/2，reward 0 | 得到可读图案但识别出错误文本 | 视觉/几何识别错误 |

### 3.2 题面、隐藏测试和模型错误混合

| 题目 | 结果 | 分层结论 |
| --- | ---: | --- |
| HB-041 frontend state | 最好 0.5962 | 三次 rollout 依次卡在优惠券、legacy JSON string、redo 空 future；既有模型边界实现不足，也有隐藏语义未公开。最终验收 Prompt 已复验，但失败点随 rollout 改变，继续单次重跑没有统计意义。 |
| HB-079 normalization | 0.4102 | 题面未给 canonical normalized schema/summary 类型；模型又只查文件和 hash，没有验证业务语义。应先版本化任务合同。 |
| HB-093 sessionization | 0.5918 | 跨 session campaign attribution 和 summary 字段类型未完整定义，同时模型确有一次 bot 计数错误。 |
| HB-088 API client | raw 0.5000 | 公开 pytest、真实 API、实现与报告通过；主要扣分来自 evaluator 哈希和 hidden `base_url`。 |
| MIPS interpreter | 2/3，reward 0 | 核心帧产物通过；唯一失败是题面未公开的精确 stdout 条件。保留 raw FAIL，同时单独记录合同差异。 |

## 4. 低分与 Planner、Prompt、compaction 的关系

- **Planner**：这些低分 Harness 任务大多由 Root direct 完成。没有证据表明“没有 spawn Child”本身导致失败；对共享工作区的短任务，强制拆 Child 反而会增加同步成本。是否委派仍应由模型按收益决定。
- **Prompt**：PowerShell 方言、BOM 风险、自主推进和最终验收合同确实减少了一类可预防错误，但不能机械保证业务算法、隐私和 exact schema 正确。HB-078/098/099 的前后变化是正向证据，也同时显示单次 rollout 方差很大。
- **Compaction**：本轮大多数 Harness 低分题根本没有触发 compaction，不能把低分归因给摘要。真正捕获到 compaction 合同漂移的是 batching；修复后 3 次压缩仍 6/6 通过。MIPS 经历 9 次 compaction 后仍生成正确首帧，也说明长生命周期连续性成立。
- **Runtime**：已修复的确定性问题包括 Provider 未提交 turn 的事务式恢复、BOM 可观察性、逐字任务固定层、默认 shell 活动租约、取消终态和 retry/quorum 原子性。这些都有单元/专项或真实 benchmark 复验。其余任务分数不应通过加入题目特判来“修框架”。

## 5. 停止条件和后续基线

本轮停止时没有 Praxis、Harbor 或 benchmark 进程仍在运行。继续测评应开新批次，并至少满足一个条件：

1. Web Search/Browser 接入后补 `003/006` 的同版能力覆盖；
2. 对同一模型、同一 commit、同一 Prompt 做每题至少 3 次 paired rollout，报告均值、方差和成功率；
3. 新增 Runtime-owned artifact validator，再复验 BOM/schema/header/PII 等可机械检查的产物合同；
4. 进行远程多 Worker、跨天恢复和更强故障注入，而不是重复已经有有效终局的题。

术语：`rollout` 是模型完成一道题的一次运行；`oracle/verifier` 是机器评分程序；`raw score` 是评分器原始分；`contract-adjusted` 是只按公开题面重新解释的结果；`SUPERSEDED` 表示旧结果真实存在，但已有同题更强的新代表；`INVALID` 表示外部中断导致不能公平计分，不等于任务答案错误。
