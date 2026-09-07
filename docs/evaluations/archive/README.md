# 版本化测评报告

English summary: immutable task histories and dated analysis; not current architecture.

本目录保留历史题目、原始成绩、失败归因和修复复验。文中“当前”“已完成”等词以报告注明的构建/日期为准。后续成功不能抹去旧失败，旧严格 P&R 也不等于现在默认 Working Plan。

入口汇总见[测评档案](../README.md)，每次运行登记见[总账](../run-ledger.md)。本轮新样本见[代表性低分复验](working-plan-low-score-20260905.md)。

## 全部报告

- [Werkzeug 项目经验实验：复核后第二批（2026-09-06）](werkzeug-project-memory-v2-20260906.md)

- [Werkzeug 跨版本项目经验实验（2026-09-06）](werkzeug-project-memory-20260906.md)

- [固定历史与操作经验机制实验（2026-09-06）](project-memory-mechanism-20260906.md)

- [Harness 审计：源码进程解析与写入幂等修复（2026-09-06）](harness-audit-fixes-20260906.md)

- [本地长期记忆：合同与进程验证（2026-09-06）](local-memory-validation-20260906.md)
- [Benchmark 收尾与低分归因（2026-08-24）](benchmark-closeout-20260824.md)
- [Compaction 与缓存历史验证](compaction-cache-validation-20260809.md)
- [Praxis 最终小样本测评与优化总结](evaluation-final-2026-08-09.md)
- [测评汇总历史快照（整理前）](evaluation-summary-snapshot-20260905.md)
- [MiniMax M3 + Auto：续跑至额度耗尽的最终记录](minimax-auto-benchmark-exhaustion-20260823.md)
- [MiniMax M3 + Auto 持续测评（2026-08-22）](minimax-auto-harnessbench-20260822.md)
- [MiniMax M3 + Auto 代表性续测（2026-08-23）](minimax-auto-harnessbench-20260823.md)
- [MiniMax M3 + Auto：额度再次重置后的 Terminal-Bench 续测](minimax-auto-terminalbench-resume-20260823.md)
- [MiniMax M3：Terminal-Bench 与 AgentDojo 扩样本（2026-08-24）](minimax-terminal-agentdojo-expansion-20260824.md)
- [2026-09-04：历史低分题继续做 Plan 对照](plan-low-score-expansion-20260904.md)
- [Plan-and-Review 收敛修复与复杂度判断](plan-review-convergence-20260905.md)
- [Plan-and-Review 通用优化：2026-09-05](plan-review-generalization-20260905.md)
- [审查范围与证据推论：修改及真实验证](plan-review-proof-audit-20260905.md)
- [Plan-and-Review 配额恢复续测（2026-09-04）](plan-review-quota-reset-20260904.md)
- [Plan-and-Review 通用优化后的真实复测](plan-review-rerun-20260905.md)
- [Plan-and-Review 与 Plan-and-Execute 对照测评](plan-review-vs-plan-execute.md)
- [Praxis Prompt 首批执行台账](prompt-execution-ledger-20260808.md)
- [2026-09-02 `auto` 与 ReviewPlan 真实测评](review-plan-validation-20260902.md)
- [Working Plan 咨询审查完善与复验](working-plan-advisory-improvement-20260905.md)
- [Working Plan 代表性低分题复验（2026-09-05）](working-plan-low-score-20260905.md)
- [轻量 Working Plan：首次真实 MiniMax 验证](working-plan-validation-20260905.md)

## 补充机器证据

[MiniMax Token Plan 新题型经验继承](project-recap-minimax-transfer-20260906.md)：三个新项目的 24 个配置、实际注入审计、流式提炼失败与日期边界错误。

[原文摘录记忆与新题复验](project-recap-extractive-20260906.md)：候选 ID 选择、读回过滤、实际曝光，以及异步 cleanup / 约束排程的分批对照。

[冻结策略后的错题型扩展](project-recap-frozen-expansion-20260906.md)：堆分配、HTML 片段过滤和闭包求值的新样本与实际注入审计。

[取消执行预算后的复验](project-recap-unlimited-20260906.md)：五类题共 40 个配置，保留原文摘录的正负迁移、提炼失败以及单独的数量门槛修复证据。

[Project recap 首轮真实 pilot](project-recap-live-pilot-20260906.md)：DeepSeek V4 Flash 的 20 个目标、全成本比较、可发现性偏差修复与空消融审计。

[Project recap 实验入口验证](project-recap-validation-20260906.md)记录确定性进程测试、全量回归与实验边界；不包含真实模型收益结论。

[旧 Prompt 静态验证 JSON](prompt-verification-20260808.json)从旧审计目录迁入，仅对应当时快照。更大的原始运行数据在各报告注明的外部评测路径，未随 Docker 环境或旧设计文档清理删除。
