# Trace、诊断和测评源码导航

English summary: diagnostics explain a run; benchmark verifiers score task correctness.

apps/runtime/src 下的 trace/、evaluation/ 与 Artifact/Session/Workflow 存储提供观测和恢复依据。固定 scenario 验证特定框架性质；外部 benchmark 检查真实产物，二者不互相替代。

排查顺序：

1. 查看 Runtime 终态，区分 completed、failed、blocked、aborted。
2. 查看原始任务、实际 Tool 参数/结果和环境错误。
3. 查看本次 Prompt manifest、Plan、checkpoint 与证据截断。
4. 查看独立 Reviewer 输入/报告，判断意见是否真有证据。
5. 最后对照外部 verifier；模型自测或 advisory accepted 都不能覆盖官方失败。

普通 Trace 不应记录秘密和完整敏感 Prompt。ReviewCallStore 的本地诊断仅尽力脱敏且有界，不代表完整抓包。运行证据共享前仍需检查。

入口命令和恢复行为见[故障排查](../../../docs/troubleshooting.md)与[Session 恢复](../../../docs/session-recovery.md)。所有题目、分数、Token、问题处理与历史批次只在[测评档案](../../../docs/evaluations/README.md)维护；本页不重复抄表。
