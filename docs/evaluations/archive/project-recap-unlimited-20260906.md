# 取消执行预算后的记忆对照与新题扩展

日期：2026-09-06。English summary: unlimited solo execution, a frozen memory comparison across five original task families, and a separately verified extraction-count fix.

## 结论

使用 MiniMax Token Plan（minimax-cn / MiniMax-M3）完成预登记的 40 个目标配置：38 个实际启动、38 个正常完成。无记忆 **9/20**，原文摘录记忆 **10/20**。配对 4 胜、3 负、13 平。提炼失败阻止启动的配置计入分母，不删除。

| 原创题型 | none | extractive-v2 | 记忆组提炼阻塞 |
| --- | --- | --- | --- |
| heap-placement | 3/4 | 2/4 | 0 |
| html-fragment-policy | 2/4 | 1/4 | 2 |
| closure-binding | 3/4 | 2/4 | 0 |
| gcode-state | 1/4 | 4/4 | 0 |
| byte-machine | 0/4 | 1/4 | 0 |

这批结果仍不足以证明记忆有稳定收益。三个旧题型本次为 none 8/12、记忆 5/12；[上一批有限预算](project-recap-frozen-expansion-20260906.md)为 6/12 对 8/12。不能只保留前一批正向样本，也不能把本次变化全部归因于取消轮次限制。

## 实际取消了什么

- eval:recap 默认 unlimited：不发 Run budget、累计 Token 上限或 timeoutMs；不设提炼 AbortSignal.timeout、父进程 watchdog、RPC 请求定时器。
- 可信 Host 通过 unbudgetedSoloRuns，仅让没有显式预算/截止时间的本地 solo prompt 直接执行 AgentLoop。Session 日志、提示词、压缩、工具权限和终态事件保留；该模式不进入要求预算的统一 Workflow 包装层。
- 普通产品入口和显式 bounded 模式仍保留原预算。unlimited 不是把上限改成一个很大的数字。
- 记忆注入仍为 1500 Token；模型上下文和单次输出大小保持原设置。这些是上下文实验控制项，不是累计执行中止条件。

manifest 中 executionLimits=null、executionRoute=host-solo-agent-loop。所有 v5 组使用相同路线；与 v4 比较还同时改变了包装层，并重新生成探索前缀，所以不是单独改变预算的严格因果实验。没有继续旧失败 Session，也没有覆盖旧结果。

本批实际目标最大 6 轮，没有轮次预算中断。新采样没有重现上一批的 16 轮循环，不能据此声称取消预算已经救回那两个旧失败。独立进程测试验证了连续 20 次工具调用后仍能正常完成，并验证显式 4 轮预算仍会终止。

## 选题与失败分析

旧题：堆分配、HTML 片段过滤、闭包求值。新增 gcode-state 和 byte-machine，每个项目两个政策变体，每个变体两次重复；总共五个独立项目，不是 40 道独立题。

从本地真实 reward=0 且 exception=null 的记录选取新领域：gcode-to-text 的产物存在但文字不匹配；make-mips-interpreter 的画面存在与相似度检查通过，但启动 stdout 校验失败。新任务分别做 G-code 模态状态跟踪、有限指令的字节序/符号扩展模拟。它们不是原版 OCR 或 DOOM 评测，不声称字节算术导致了原题 stdout 失败。

探索阶段的 incidents 是人工编写的代表性错误说明，不是模型亲自失败后的反思。所有目标均提供当前规则文件，无记忆组有完整求解信息；提炼不读取后续输入和答案。

- 堆分配有错误在第 3 轮就结束。一次记忆组遗漏相邻空闲块合并，但相关 n4 笔记确实全部注入；这是规则执行错误，不能归因于空记忆。
- 闭包题三次错误均只在 outputs[7] 输出 25，正确值为 22；两组都出现，上一批的闭包优势没有稳定复现。
- G-code 第一轮无记忆两次失败，记忆两次通过：无记忆分别漏算后续指令对最终状态的影响、把 M82 后绝对 E 当作相对 E。第二轮与最终结果一起纳入上表。
- HTML 一次提炼返回 16 个合法候选 ID，旧接口规定最多 8 个，两个对应记忆目标因此未启动。该失败与无限执行预算无关，公开原始提交和已知 usage 均保留。

## 数量门槛修复（不回填本批成绩）

40 个 v5 配置全都使用冻结的 extractive-v2。完成后新增 extractive-v3：移除固定 8 条选择上限，允许按重要性排列源候选中的唯一 ID，Host 仍从原文回填完整笔记，并按真实 Token 预算选择。候选集现有最多 256 个；schema 的数量上界由实际候选集决定。未知 ID、重复 ID、额外字段仍拒绝；structured 等旧策略的笔记合同不变。

直接回放本批保存的 16-ID 失败提交，无新增模型调用：16 条原文笔记验证通过，实际注入 11 条、1475 Token，其余 5 条在 manifest 中明确记录。没有重新抽取直到成功，没有把这次接口修复当成目标答案正确，也没有把两次旧缺测改记为通过。v3 的端到端准确率尚未另做 live 对照。

## 成本与曝光

| 指标 | none | extractive-v2 |
| --- | --- | --- |
| 正常完成/计划配置 | 20/20 | 18/20 |
| 工具调用尝试 | 85 | 81 |
| 目标 input Token | 83,736 | 85,431 |
| 目标 output Token | 40,193 | 42,441 |
| 目标 cache-read Token | 111,463 | 144,596 |
| 目标 cache-write Token | 未知 | 未知 |
| 去重提炼 input Token | 0 | 7,855 |
| 去重提炼 output Token | 0 | 324 |

每个实际执行的记忆目标都验证了真实请求里的注入 digest/count，全部请求均有非空记忆。两组共同完成的 18 对中：none 8/18、记忆 10/18；工具调用 76→81，目标 input 75,595→85,431，output 37,457→42,441，cache-read 97,255→144,596。记忆组在这个条件子集的成功数更高，但执行资源也更多，尚未显示效率收益；该子集排除了提炼失败，不能替代全部配置的端到端成绩。

目标 Token 合计只统计实际启动的目标；两个提炼失败的目标未发起模型请求，执行成本确定为零，提炼成本仍计入。共同探索开销单独记录，实际调用未报告的缓存与费用不当成零，Token Plan 未按美元估价。墙钟还受串行顺序、缓存和本机测试负载影响，不作速度结论。

## 验证与证据

预算与新题修改的全量检查：1190 项，1185 通过、5 跳过、0 失败；build/check 通过。数量门槛修复后另跑 24 项相关测试、15 项文档测试，全部通过，build/check 也通过。前面的全量测试是预算改动检查点，不冒称覆盖后续修改。

- 参数冻结：artifacts/recap-v5-preregistered-20260906.json。
- 原始目录：artifacts/recap-minimax-v5-20260906-{case}/，每个包含 manifest、source、快照、独立 trial、公开 events 和实际 context manifests。
- 对照汇总：artifacts/recap-v5-analysis.json；完整性：artifacts/recap-v5-integrity-audit.json；答案差异：artifacts/recap-v5-error-analysis.json。
- v5 关键源码保存到 artifacts/recap-v5-source/，与每个 manifest 中的实现 digest 相符；这是关键文件归档，不是完整 checkout。
- 数量门槛原始输出回放：artifacts/recap-extractive-v3-replay.json。
- 使用说明：[同项目经验继承实验](../../research/project-recap-experiment.md)。
