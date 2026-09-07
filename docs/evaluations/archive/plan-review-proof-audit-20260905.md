# 审查范围与证据推论：修改及真实验证

> 版本化测评记录：题面、结果和归因对应本文注明的构建与策略，不代表当前默认模式或同版全量成绩。

日期：2026-09-05。用户授权修改后直接验证，仍不运行 ReAct。

## 为什么修改

上一批 T75/T76 的 MTEB：P&E 21分35秒、P&R 6分14秒，都官方 1/2、reward 0。P&R 进行了 4 次冻结补读、2 次 needs_fix、1 次 replan、4 次 accepted，但仍用当前榜单按发布日期筛选，代替指定月份的历史排名。它还把局部“查询资料”步骤当成整题验收，要求提前写最终文件。T77 KV P&R 在 Debian 软件包下载阶段 NetworkConnectionError，未调用模型；T78 未启动。队列停止不是额度耗尽，也不是所有任务完成。

## 通用修改

| 修改 | 通俗解释 | 代码 |
| --- | --- | --- |
| scopeContext | 给审查者看各步骤分工；当前步骤不提前承担后续步骤工作 | reviewSemantics.ts / reviewCoordinator.ts |
| mechanicalProofBoundaries | “文件存在”的检查只证明存在，不自动证明内容或业务正确 | reviewSemantics.ts / tools/shared.ts |
| proof audit | 每个判定说明观察、证据如何支持要求、还有哪些关键假设；存在未解决假设不能同时 passed | semanticReviewer.ts |
| 历史冻结上下文 | 复用当前 Plan 已验收步骤的证据，保留来源；不当作本次机械检查结果 | reviewCoordinator.ts |

没有新增 DAG、Reviewer 角色、额外强制模型调用或任务专用答案。现有最多审查尝试数与补读次数不变。当前分支为 `codex/praxis-current-architecture-docs`，包含用户未提交修改，不冒称干净主干。

proof 是简短的证据支持解释，不索取模型内部思维链。新 Provider response 必须包含它；原始 response 保留结构，验证后解释并入已有 finding.reason，从而不改变 journal / Plan decision 格式。旧记录兼容不代表新请求可以省略。已有准备围栏、用量统计、有限重试和 blocked 处理保持生效。

历史证据只取当前 revision 中仍被保留的 accepted Item。最多使用 64 个剩余槽位，与本次证据共用内容预算。不会重新读取原文件路径，也不会自动合并失败/废弃 Attempt。历史结论是否仍适用依赖语义判断；Runtime 能保证引用边界，不能保证历史结论真实。

## 本地验证

- 7 个相关测试文件，共 45/45 通过，包含 5 项新增边界回归。
- 另补 PlanControl、ReviewPlan domain/events、文档契约 4 个文件，30/30 通过；本轮合计 11 文件、75/75。文档契约包含 Reviewer 完整 Prompt 与请求目录核对。
- 覆盖：缺 proof 拒绝、关键假设与 passed 矛盾拒绝、旧 decision 读取兼容、机械证明范围、步骤职责，以及真实协调器中的历史证据复用与当前缺失文件拒绝。
- 完整 `npm run check`（format、lint、typecheck）与 build 通过，无 lint 警告。未以旧 CI 成绩代替本次验证。
- 第一轮新集成测试使用了非规范时间字符串，触发 SESSION_ENTRY_INVALID；修正测试 fixture 的 ISO 时间后通过，没有修改生产校验规则。

这些测试证明机制按约定运行，不证明真实任务成功率提高。模型如果遗漏关键假设，仍可能错误接受；机械语义边界的解释同样不能替代领域 oracle（可靠的外部验收器）。

## 真实 MiniMax 验证

- 固定包：`D:\agent-evals\artifacts\praxis-cli-proof-audit-20260905.mjs`。
- SHA-256：`3f42c168b79259deb3ee4287265876070dcbe7862e5da8422a89c8cd87d611a3`。
- 同模型 `minimax-cn/MiniMax-M3`、`iron-law-lean-v1`、`solo`；P&R required，P&E optional + 原有文字计划控制；全新 Session/容器；timeout multiplier 10，Harbor retries 0。
- 两道原题完整内容见[上一批原题记录](plan-review-rerun-20260905.md)。只交付原题，不向执行模型提供旧答案、诊断或隐藏测试。
- 本轮先 KV P&R，再 KV P&E，再 MTEB P&E/P&R，最多四次；环境/Provider 异常停止后续派发。

| 题目 | 模式 | Job（位于 D:\agent-evals\results\harbor-minimax-medium） | 状态 |
| --- | --- | --- | --- |
| kv-store-grpc | P&R | minimax-m3-proof-audit-20260905-plan-review-kv-r1 | 已结束；官方 7/7、reward 1；Runtime 失败，不能算正常完成 |
| kv-store-grpc | P&E | minimax-m3-proof-audit-20260905-plan-execute-kv-r1 | 队列已停止，未运行 |
| mteb-leaderboard | P&E | minimax-m3-proof-audit-20260905-plan-execute-mteb-r1 | 队列已停止，未运行 |
| mteb-leaderboard | P&R | minimax-m3-proof-audit-20260905-plan-review-mteb-r1 | 队列已停止，未运行 |

队列脚本 `D:\agent-evals\scripts\continue-proof-audit-20260905.ps1`，历史启动 PID 22060（已结束）。状态输出 `D:\agent-evals\results\proof-audit-20260905-queue.stdout.log`，错误输出同目录 `proof-audit-20260905-queue.stderr.log`。第一条 Trial 为 `kv-store-grpc__JAqTE6o`。队列在北京时间 2026-09-05 02:47 左右因额度错误停止，不再派发后续题目。

中途观察：一项语义 Review 三次 REVIEW_RESPONSE_INVALID 后按原逻辑 blocked；随后另一次包版本审查成功，raw response 实际包含 observation/inference/unresolvedAssumptions，并明确不验收其他 Item。说明新协议有真实可用响应，但不能声称协议稳定性已充分验证；最终归因需结合完整轨迹，不能单凭通用错误码认定是模型遗漏 proof。

### 最终结果与归因

Agent 阶段约 64 分 30 秒。官方 verifier 最后执行 7/7 通过、reward 1，但 Runtime 终态为 `prompt_failed / PROVIDER_RATE_LIMITED`，Harbor 记录 `ApiRateLimitError`。产物正确性 PASS，框架收尾 FAIL；这是带有效产物分数的异常 rollout，不能用它证明 P&R 正常完成或可靠性提升。

Root 共 815 轮、53 次工具调用；第 53 轮后连续 762 轮不再调用工具，只重复解释 Plan 已被阻塞。6 个 Item 已 accepted，最终 Plan revision 2 blocked。直接原因是 Runtime 每次最终回答后仍注入同一 blocked 提示并继续循环，因此末尾完成检查一直不可达。额度耗尽是这次重复消耗的终止条件，不是全部问题的根因。

共 15 次 compaction。terminal 汇总 input 2,092,902、output 436,218、cache-read 22,961,876 tokens；Root trace 自身 input 1,334,801、output 384,891、cache-read 22,513,829，两者统计范围不同，不能相加。压缩有额外成本，但本题已有明确的无进展循环证据，不能把全部消耗归因于压缩。

Review call store 共 14 个 attempt：5 个已保存有效 decision，9 个仍停留 provider_started。旧代码没有保存无效响应诊断，所以不能断言这 9 次全部由缺 proof 或输出截断导致。已保存响应证明 Reviewer 至少一次因为“Agent 参与生成”过度否定可检查的 proto 内容；它要求进一步运行时描述符检查，之后接受。这是审查尺度问题，不是官方测试证实的实现错误。

通用修复及工业界对照见[收敛修复记录](plan-review-convergence-20260905.md)。上述分数属于修复前冻结包，新代码尚未获得新的真实 MiniMax 成绩。
