# 测评档案

这里保留实际题目、结果、问题和处理证据。English summary: versioned results, not a single current-version leaderboard.

## 先分清三种“通过”

| 层级 | 判断依据 | 不能替代什么 |
| --- | --- | --- |
| 任务正确性 | 官方 verifier/reward | 不能用模型自测或 Review accepted 代替 |
| 框架能力 | Journal、Task/Lease、Child、权限、恢复不变量 | 框架正常不表示题目正确 |
| Runtime 终态 | prompt_completed/failed/blocked/aborted | completed 只表示执行正常收尾 |

## 长期维护的五份记录

1. [公开 Benchmark](passed-benchmarks.md)：Harness-Bench、Terminal-Bench、AgentDojo 的题目与结果。
2. [平台与长任务实验](passed-platform-evaluations.md)：Child、quorum、恢复、compaction、缓存和 Provider。
3. [运行总账](run-ledger.md)：按 rollout/批次登记，包含失败和无效样本，不只选通过项。
4. [问题与处理](issues-and-fixes.md)：证据、归因、修改位置、复验和剩余边界。
5. [术语与维护规则](glossary-and-maintenance.md)：评分分母、Token 口径、证据等级和更新流程。

完整带日期的过程报告统一放在[archive](archive/README.md)。历史汇总数字另存[整理前快照](archive/evaluation-summary-snapshot-20260905.md)，不在入口复制几十行容易失效的“当前成绩”。

[取消执行预算后的记忆复验](archive/project-recap-unlimited-20260906.md)：MiniMax Token Plan，五类原创题 40 个配置；区分目标错误、提炼阻塞及候选数量门槛修复，未证明稳定的整体效率收益。

## 当前计划版本与真实证据

[固定历史与操作经验机制实验](archive/project-memory-mechanism-20260906.md)：30 配置全部结算，21 次实际执行全部通过（无记忆 6/6），9 配置被提炼失败阻断；未检出准确率收益，操作经验的成本方向因项目而异。

当前默认是 optional Working Plan + advisory-v1；Host required 仍是严格 ReviewPlan。历史 Direct/ReAct、P&E、严格 P&R 和现在的轻量 Plan 必须分开记录。

- [严格 P&R 与 P&E 历史比较](archive/plan-review-vs-plan-execute.md)：包括历史 Direct 复用；不是当前轻量版本的因果对照。
- [轻量 Plan 首次真实验证](archive/working-plan-validation-20260905.md)：KV 5/7，咨询旧合同耗尽但 Runtime 收尾。
- [advisory-v1 复验](archive/working-plan-advisory-improvement-20260905.md)：单次有效 Review，但语义错误接受，KV 仍 5/7。
- [本轮代表性低分题](archive/working-plan-low-score-20260905.md)：同一冻结构建，串行三题，不重跑 ReAct；状态随真实结果更新。

当前没有证据证明新 Plan 普遍优于 ReAct 或 P&E。单题成功、局部子检查改善、Review 协议成功都应分别说明。

## 保存和更新约定

本地长期记忆的新增验证见[2026-09-06 合同与进程测试](archive/local-memory-validation-20260906.md)。这是隔离目录中的确定性接入测试，不使用真实 Provider，不计入上面的公开 benchmark 成绩。

独立 recap 实验入口见[2026-09-06 验证记录](archive/project-recap-validation-20260906.md)。[首轮真实模型 pilot](archive/project-recap-live-pilot-20260906.md)完成了 20 个目标，全部正确，但记忆组总 Token 更高；failure 消融没有实际删除内容，不能据此判断失败经验的作用。

[MiniMax Token Plan 新题型 pilot](archive/project-recap-minimax-transfer-20260906.md)扩展到事务恢复、形状批处理和时区日志：structured 5/6、none 4/6；部分其他摘要组因超限而未注入，不能直接作四组语义优劣结论。

[原文摘录记忆与新题复验](archive/project-recap-extractive-20260906.md)：在异步 cleanup 和约束排程题比较 none / structured / extractive，保留提炼失败，并澄清题面后独立复验。

[冻结策略后的错题型扩展](archive/project-recap-frozen-expansion-20260906.md)：选择有真实验收失败的另外三类历史题型，固定记忆策略后新增受控样本，逐项目报告收益与反例。

源码审计另发现并修复了 Child 混用旧 dist、A→B→A 写入误去重两项缺陷，见[复现与修复记录](archive/harness-audit-fixes-20260906.md)。这是框架回归，不是新的任务质量提升成绩。

仓库保存通俗说明、原始题面和可追溯标识；原始 JSON/JSONL、SQLite、Artifact 和 verifier 日志位于外部评测工作区，报告记录相对路径和冻结 hash。删除 Docker 环境不等于删除测评记录。

历史测评保留原始结果和当时限制；过时的非测评设计文档已清理。旧 Prompt 审计中的实际实验台账和 cache/compaction 数字已移入本目录归档，没有随草案一起删除。

新增结果先核验机器证据，再更新详细报告、总账，以及有变化的通过表/问题表。不要把进行中记为失败或通过，不用后来修复覆盖早期事实，不写 API key。
