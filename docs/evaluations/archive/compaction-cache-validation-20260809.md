# Compaction 与缓存历史验证

> 历史测评记录：保留当时的构建、结果和限制，不声明当前默认行为。现行规则见[Prompt 装配](../../prompt-assembly.md)。旧设计链接已改指现行说明。

English summary: recorded validation results from August 2026, not current architecture.

## 9. 验证门禁

已完成定向 contract 验证：typecheck；OpenAI compact endpoint/opaque replay；native exact binding 与跨 Provider fallback；semantic/native journal persistence；reasoning 编辑不改 canonical history；checkpoint 中性 envelope；JSONL 恢复；Child standalone compact 的授权、计费、IPC 往返与 secret 隔离。最新一组共 74 项，73 pass、0 fail、1 个需显式 API key 的网络 smoke skip。

进入长任务测评时至少记录：每轮 context state、native/semantic fallback 原因、压缩次数、压缩前后 token、被清理 reasoning/tool tokens、约束/待办/错误召回、重启后首轮成功率、总 input/cache/output token 与 wall time。只有这些指标稳定，才能说 compaction 改善了长生命周期能力，而不只是“某次请求没超窗”。

随后真实 DeepSeek 24K 强制 context 运行已 exit 0：一次 `context.compacted` 使用 9,387 input、731 summary output，覆盖 5 条消息，checkpoint 752 tokens；最终恢复预设 threshold、64K 未压缩阈值和 keep-recent 参数并输出 `COMPACT_OK`。MiniMax M3 的后续压力运行以 26 turns、19 次 threshold compaction 完成；journal coverage 严格递增，每个 checkpoint 都保留 sentinel、禁止项和最终合同，最终恢复相同三个参数。MiniMax 的 9 次 `shell` 尝试均被只读 policy 拒绝，且最终 marker 前有说明性前言，因此报告同时保留“框架 fidelity 通过”和“严格模型服从未全过”两层结论。

## 10. Prefix cache 生命周期验证（2026-08-09）

此前 ContextView 直接从 SessionJournal projection 每轮重建，其中 `revision`、`recentEntryRange`、result/artifact refs 和 omission 会随每条消息变化。它又位于完整对话历史之前，所以 Provider 最长公共前缀在 ContextView 处中断；精简 Trusted Instructions 只能减少 miss token，不能修复命中率。

现在 ContextView 以 Run 为生命周期冻结，成功 compact 后才换代。DeepSeek V4 Flash 的五轮串行 read A/B 结果如下：

| Variant | 全部输入 | cache read | 全部命中率 | 排除首轮后的命中率 |
| --- | ---: | ---: | ---: | ---: |
| `baseline-v1` | 20,651 | 16,256 | 78.7% | 78.0% |
| `iron-law-lean-v1` | 19,210 | 13,440 | 70.0% | 77.2% |

baseline 首轮命中 85% 来自同账户此前请求留下的热前缀；lean 首轮是冷启动 0%，因此跨 variant 比较必须排除首轮。两条路径均完成 5 turns/4 tools 并输出 `CACHE_OK`。证据保存在 `D:\agent-evals\results\cache-ab\2026-08-09__03-22-52`。

显式 manual compact 也与自动阈值分离：短会话只要存在较早的完整安全 turn，就压缩该前缀并保留最近完整 turn；`threshold/overflow` 继续使用 keep-recent token 策略。
