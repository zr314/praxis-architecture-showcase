# 冻结记忆策略后的新错题型扩展（2026-09-06）

English summary: a prospectively fixed comparison of no memory versus extractive-v2 on three additional task families. Historical failures select topics; these original controlled fixtures are not official Terminal-Bench scores. All outcomes and actual memory exposure are retained.

## 选题与边界

[上一轮开发实验](project-recap-extractive-20260906.md)为 extractive 6/8、none 5/8，异步题改善、更新排程题退步。本轮保持提炼 Prompt、候选过滤、预算装配和目标 Runtime 不变，只添加题目注册与参考答案检查。运行前文件 `artifacts/recap-holdout-preregistered-20260906.json` 保存了与上一轮一致的关键代码 hash、选题证据和参数。

检查 `D:\agent-evals\results\harbor-minimax-medium` 的 result.json 和 verifier 日志，选择 reward=0 且 exception_info 为空的记录，没有把限流等运行异常当作纯答错。

| 历史题目 | 核验的历史失败 | 新项目及边界 |
| --- | --- | --- |
| custom-memory-heap-crash | 2026-08-23 auto-custom-memory-resume-v2：Release 打印计算结束后以 -11 退出，另五项通过 | heap-placement：字节堆对齐、碎片、释放合并；first-fit 切换 best-fit。不修复或复现原 C++/libstdc++ 崩溃 |
| filter-js-from-html | 2026-08-18 filter-js-v6-serial：危险内容过滤、正常 HTML 不变两项均失败 | html-fragment-policy：已分词片段过滤及原文拼接；更新 data 图片例外。不是完整浏览器 sanitizer |
| schemelike-metacircular-eval | 2026-09-02 auto-review-plan-batch-v1：61/63 子测试通过，两项 advanced-features 输出不匹配 | closure-binding：词法闭包、引用捕获、可变状态；parallel let 切换 sequential。不是自举解释器验收 |

具体历史记录路径保存在预登记文件。新题 incidents.txt 为人为编写的典型错误机制；探索阶段只读规则、政策和事故说明，不等于模型亲自经历了那些失败。提炼器没有未来输入、题面或标准答案。

## 固定设计

三个项目 × reuse/updated 两个目标 × 两次重复 × none/extractive 两组 = 24 个目标配置，另有六个探索 Session 和六次提炼。仅六个固定目标，重复采样不是新增独立题目，同项目的政策变体共用输入，也不独立。

固定 minimax-cn / MiniMax-M3，使用 Token Plan 订阅凭据。每目标最多 16 turns、128000 累计原始 Token、180 秒，记忆预算 1500。每组独立进程、Session 和工作区，配对共享冻结学习历史和完全相同的目标文件。主指标为 Runtime 完成且 JSON 精确匹配；保留提炼失败、曝光和分项 usage，不挑成功重跑，不改策略迎合新题。

独立校验程序分别使用逐字节占用数组、片段检测拼接、带环境链的解释器核对手写答案。另检查套件可被 canonical digest 冻结，避免共享对象引用导致运行前失败。19 项相关回归通过，补充冻结用例后新题文件 4 项通过，合计 20 项不同的相关用例；类型检查和构建检查点通过。

## 结果

24 个目标全部启动并结算，22 个正常结束，2 个达到 16-turn 上限。没有提炼失败、额度回退或成功后替换旧失败。

| 项目 | none | extractive-v2 | 主要观察 |
| --- | ---: | ---: | --- |
| heap-placement | 2/4 | 2/4 | 一次 first-fit 从对变错，一次 best-fit 从错变对，总分持平 |
| html-fragment-policy | 2/4 | 2/4 | 两组各一次轮次耗尽；另有不同重复上的拼接反例与改善 |
| closure-binding | 2/4 | 4/4 | 两次 parallel let/闭包相关求值从错变对；sequential 两组均对 |
| **合计** | **6/12** | **8/12** | **4 胜、2 负、6 平，净多答对 2 次** |

端到端正确率为 50% 和 66.7%，样本差为 16.7 个百分点。none 的 reuse/updated 各 3/6，extractive 各 4/6。这里仍只有六个固定目标、每题两次重复，不能据此声称统计显著或普遍泛化。改善主要集中在一个项目，两个其他项目的总分没有提升。

六次 extractive 提炼全部合法；12 个记忆目标的每次模型请求都带有记忆，digest 与实际消息匹配，预算未超过 1500。结束后的完整性检查确认：配对输入与学习历史一致、运行实现未漂移、记忆策略与预登记及上一轮版本相同。

### 错误审查

闭包 reuse 的无记忆输出在 set! 将 x 改为 7 后，仍给出基于初始 x=10 的函数结果 12，而不是 9；摘录组正确处理了环境引用。另一次无记忆输出也未完全遵循对应绑定语义。这个例子支持“保留容易遗漏的语义规则可能有帮助”，但不能单凭个例将因果拆分到某一条笔记。

堆题的部分错误分配了与尚未释放对象重叠的区间，或将非连续空闲空间当作连续块。HTML 第一轮 updated 的摘录组虽然 removed 清单正确，html 却漏拼应保留的 data-note 属性。这些是状态跟踪或输出构造错误，不能单靠“有记忆”保证消失。

HTML 第二轮 reuse 两组均反复写入、读回，达到 AGENT_TURN_LIMIT_EXCEEDED，而不是正常完成后被判错。模型怀疑工具在解码 HTML 实体。独立核对发现：每次 write 参数的字节 hash 与写入结果一致，后续 read 的原始文件 digest 也一致；读回文本与 ReadTool 的分页逻辑行视图一致。差异仅有该接口既定的末尾换行省略，HTML 实体变化已存在于模型提交的写入参数中，没有发现 Runtime 改写实体的证据。没有为此修改工具或重跑目标。

### 资源指标

| 指标 | none | extractive-v2 |
| --- | ---: | ---: |
| 目标工具调用 | 65 | 64 |
| 目标执行 inputTokens | 53907 | 62471 |
| 目标执行 outputTokens | 18800 | 22390 |
| 目标执行 cacheReadTokens | 216273 | 231125 |
| 额外提炼次数 | 0 | 6 |
| 额外提炼 inputTokens | 0 | 3818 |
| 额外提炼 outputTokens | 0 | 180 |

轮次耗尽的实际使用量也计入上表；共同探索另留在 learningEpisodes。工具调用只少 1 次，记忆组的执行输入、输出及缓存读取反而更高，不能称为整体 Token 效率提升。目标累计墙钟约 395.7 秒对 365.6 秒，extractive 还需约 9.8 秒提炼；运行顺序和服务端波动限制了速度结论。缺失缓存写入字段保持未知，不能推导完整账单。

这次在未调参的新任务上再次观察到小幅净收益，较上一轮单独的开发样本多了一份证据；同时保留了退步样本和工具循环。对于面试展示，更准确的结论是“可审计地测量记忆何时有帮助及其代价”，不是“长期记忆总能提高 Agent 能力”。

## 复现与产物

```powershell
npm run eval:recap -- --mode live --provider minimax-cn --model MiniMax-M3 --case heap-placement --strategies none,extractive --repeats 2 --memory-tokens 1500 --max-turns 16 --max-tokens 128000 --timeout-ms 180000 --output artifacts/recap-heap-new
```

另外两个 case 为 html-fragment-policy 和 closure-binding。实现为 `apps/runtime/src/evaluation/recap/holdoutCases.ts`，独立参考测试为 `test/recap-holdout-cases.test.ts`。本轮输出目录为 `artifacts/recap-minimax-holdout-20260906-<case>/`。汇总为 `artifacts/recap-holdout-analysis.json`，完整性与配对审计为 `artifacts/recap-holdout-integrity-audit.json`，HTML 读写核验为 `artifacts/recap-holdout-html-roundtrip-audit.json`。15 项文档合同检查通过。

旧批次成绩不修改。MiniMax 缺失的缓存写入和费用字段保留未知；input+output 不能冒充完整成本，额外提炼和执行开销需分别报告。
