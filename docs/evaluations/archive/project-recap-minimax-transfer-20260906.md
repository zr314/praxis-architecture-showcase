# MiniMax Token Plan：新题型经验继承 pilot

日期：2026-09-06，Asia/Shanghai。English summary: MiniMax M3 subscription-key evaluation on three new controlled task families. Structured notes passed 5/6 targets, cold start passed 4/6. Oversized narrative summaries and one incomplete provider stream prevent a clean four-way semantic comparison.

## 运行范围与结果

本次按用户要求切换到 `minimax-cn / MiniMax-M3`，使用 `D:\agent-evals\.env.minimax` 中现有订阅 Key；Token Plan 查询接口确认成功，未回退 DeepSeek 或按量 Key。套餐 Key 的用途见 [MiniMax 官方接入说明](https://platform.minimaxi.com/docs/token-plan/quickstart)。运行后账号窗口剩余 96%、周剩余 57%；这是账号共享额度快照，不是单独实验账单。

避开 KV/榜单，新增三个原创连续任务项目。每个有 reuse / updated 两个目标、四个基础组、一次重复，计划 24 个配置；22 个实际执行，14 个正确、8 个答案错误，2 个因同一次 compact 提炼失败而未执行。

| 组 | 正确 / 计划目标 | 实际执行 | 实际注入记忆的目标 | 工具尝试 |
| --- | --- | --- | --- | --- |
| none | 4/6 | 6 | 0（基线） | 36 |
| compact | 1/6 | 4 | 0 | 27 |
| 普通 recap | 4/6 | 6 | 2 | 37 |
| structured | 5/6 | 6 | 6 | 36 |

| 新项目 | none | compact | recap | structured |
| --- | --- | --- | --- | --- |
| journal-recovery | 2/2 | 两个目标均被提炼失败阻塞 | 2/2 | 2/2 |
| shape-batching | 1/2 | 0/2 | 2/2 | 2/2 |
| log-date-windows | 1/2 | 1/2 | 0/2 | 1/2 |

structured 比 none 多通过一个目标，是后续配对重复的线索；6 个目标、一次重复不足以证明普遍提升。compact 的低分也不能解释为其摘要语义更差，因为没有一个目标实际收到 compact 内容。不存在“记忆一定提升准确率”的结论，也没有证据说明此次工具调用更省。

## 选题依据及评分边界

只读检查了 MiniMax 历史 result.json。db-wal-recovery 5 条记录有 5 次 reward=0、3 次异常；llm-inference-batching-scheduler 4 条有 2 次 reward=0、1 次 reward=1、3 次异常；log-summary-date-ranges 2 条有 1 次 reward=1、1 次异常。reward 与异常可能重叠，记录来自不同运行配置，不能作为当前版本失败率。

| 参考题型 | 本次新任务 | 不涵盖的原版工作 |
| --- | --- | --- |
| db-wal-recovery | 交错事务、未提交/中止、校验失败、checkpoint、持久化 cutoff | 原版 SQLite WAL 二进制解密与修复 |
| llm-inference-batching-scheduler | 独立对齐 S/G、严格分组、容量、排序、批次编号；变更对齐和容量 | 大规模成本/延迟优化与原版阈值 |
| log-summary-date-ranges | 月界、7/30 日闭区间、未来日志、severity；文件日期切换为 UTC 事件日期 | 原版数据和 CSV verifier |

这些是借鉴题型后新建的受控实验，**不是原版 Terminal-Bench 成绩**。没有把原版答案或未来目标数据送给提炼器。任务定义在 `evaluation/recap/transferCases.ts`；三个独立参考计算测试核对了手写预期答案。默认无 case 的旧入口规模不变，新项目通过 `--case` 显式选择。

## 找到的具体错误

1. **批处理沿用题，compact 配置答错**：r08 的 prompt_len=129，在 64 对齐下应得到 S=192、batch=b006；输出却是 S=128、batch=b005。该配置实际无记忆注入，不能归因为旧摘要。
2. **批处理变更题，none 和 compact 配置答错**：当前对齐为 128，部分请求仍输出 S=64。普通 recap 和 structured 在这个目标上通过；仍需要独立重复验证差异。
3. **日志时区变更题，四组全错**：none 的七日计数漏项；structured 的七日计数正确，但 30 日 INFO 为 3，正确值为 4，漏掉文件名为 1 月 30 日、事件 UTC 日期为 1 月 31 日的记录。这是后续值得持续测的边界场景。
4. **探索阶段就出现错误派生事实**：公开历史 m5/m7 把 2026-03-01 的七日起点算成 2 月 24 日、30 日起点算成 2 月 1 日；正确起点是 2 月 23 日、1 月 31 日。摘要保存了这些错误，说明合法 message 引用不能证明事实正确。structured 中错误具体日期位于 n9，本轮因预算被省略；实际保留了 today-6 / today-29 的一般规则。此观察支持设计“规则 vs 未验证派生值”的后续实验，不构成本轮对该保留策略的因果证明。

## 实际注入与可靠性限制

| 项目 | compact | recap | structured |
| --- | --- | --- | --- |
| journal-recovery | 提炼失败，目标未运行 | 0 Token，整条超限省略 | 1393 Token |
| shape-batching | 0 Token，整条超限省略 | 1197 Token | 1489 Token |
| log-date-windows | 0 Token，整条超限省略 | 0 Token，整条超限省略 | 1360 Token |

上限均为 1500 Token；MiniMax 使用当前 Runtime 的 conservative tokenizer 估算预算。生成模型的 Token 目标提示不保证摘要在注入端估算下可放入。structured 可以按完整条目选取，普通摘要作为单条超限时整条被省略。这解释了**注入覆盖差异**，不能直接解释所有正确率差异。

事务恢复的 compact 提炼报 `PROVIDER_STREAM_INVALID`。在全部任务之后，使用相同冻结历史额外进行一次诊断调用，复现 `Provider stream ended while Tool call 0 was active`：工具参数流尚未闭合就结束。诊断记录仅含 chunk 类型、长度与终态信息；未用于替换原始失败，不把它当作第二次独立 benchmark 样本。上游提前结束还是更深层传输问题尚未确定，未放宽协议校验伪造成功。生产 CompactionService 的 fallback 不属于此生成器对照组。

本轮不运行此前为空的 failure 消融。现在也不应直接从这四组表格得出“结构化优于普通摘要”的语义结论；应先使各摘要组都能实际注入，再冻结前缀和规则做配对复验。

## Token 口径

MiniMax 的 Anthropic 兼容接口把普通输入、缓存读取、缓存写入分开返回，不能直接沿用前一轮 DeepSeek 的 input+output 口径。[官方字段定义](https://platform.minimaxi.com/docs/api-reference/anthropic-api-compatible-cache)说明总输入需相加三个输入部分。

| 完整执行的组 | 原始 inputTokens | outputTokens | cacheReadTokens |
| --- | --- | --- | --- |
| none | 32,663 | 8,413 | 40,597 |
| recap | 28,673 | 8,584 | 53,193 |
| structured | 30,444 | 8,231 | 58,107 |

部分请求没有返回 cacheWriteTokens，失败提炼的 usage 也不完整，所以保留 null，不补 0，不报告精确总 Token 或美元节省。上表只列目标执行，不含共同探索、提炼、额外诊断；compact 有未运行目标，不作为完整成本对照。历史原始 usage 不被回写修改，派生分析单独保存。

## 复现与证据

```powershell
npm run eval:recap -- --mode live --provider minimax-cn --model MiniMax-M3 --case shape-batching --repeats 1 --max-turns 16 --max-tokens 128000 --timeout-ms 180000 --output artifacts/minimax-shape-new
```

把 case 换成 `journal-recovery` 或 `log-date-windows` 可运行其他新项目；输出目录必须不存在。凭据仅从环境读取。

- 原始三批目录：`artifacts/recap-minimax-20260906-{journal-recovery,shape-batching,log-date-windows}/`，各自包含完整 manifest、来源前缀、快照、逐目标输出和装配记录。
- 派生总表：`artifacts/recap-minimax-20260906-summary.json`，脚本 `artifacts/analyze-minimax-transfer.mjs`。
- 选题路径与 hash：`artifacts/recap-minimax-task-selection-20260906.json`。
- 额外诊断：`artifacts/recap-minimax-compact-probe.json`，没有覆盖原始 trial。
- Token Plan 末次账号快照：`artifacts/recap-minimax-20260906-quota-after.json`。
- 新题及实验回归：9/9 通过；`npm run check`、`npm run build` 通过。日志为 `.tmp/recap-minimax-tests.log`、`.tmp/recap-minimax-check.log`、`.tmp/recap-minimax-build.log`。

下一轮优先解决超预算导致空注入的可比性，再固定日志时区边界与批处理对齐目标做重复；经验应保留什么，需要以实际注入集合和可执行判分验证。
