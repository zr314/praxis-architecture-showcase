# 长期记忆摘录策略与新题复验（2026-09-06）

English summary: a development experiment comparing no memory, structured recap, and bounded source excerpts on new cancellation and scheduling simulations. Extraction reliability, actual exposure, task accuracy, and usage are reported separately; these are not Terminal-Bench scores.

## 改动与问题来源

上一批 MiniMax 三类新题发现：普通/compact 大笔记可能完全超出注入预算；探索阶段助手算错的日期会被摘要继承。引用 message ID 只能证明来源，不证明正确。

本轮增加 `extractive` 组合策略。当前 extractive-v2 从成功 read 的公开原文中生成最多 256 个候选：按行和英文句末切分，单元上限 440 UTF-8 字节，重复内容合并，超长单元跳过。排除公开历史中显式 write/edit 路径的读回。模型仅返回 1..8 个候选 ID 并排序，Host 回填原文与引用，按原有 tokenizer 和剩余预算选择完整笔记。无额外摘要重写或自动重试。

这个策略限制新编造的内容进入记忆，但不能判断源文件是否正确。路径过滤也不是通用污点追踪，无法覆盖未记录的修改。它舍弃仅存在于助手回答中的经验，可能牺牲有效推导；没有新增自动检索、自动失效或产品记忆库写入。生成、证据过滤、粒度同时变化，不能将效果单独归因于其中一个因素。

## 新题与协议

参考本地 `D:\agent-evals\sources\terminal-bench-2\terminal-bench-2` 的 cancel-async-tasks 和 constraints-scheduling 题面，另写两类原创模拟，未执行原题的 Python/ICS 验收。

| 项目 | reuse | updated |
| --- | --- | --- |
| async-cleanup | fail-fast、兄弟任务取消、cleanup 占用并发槽 | 切换 drain，继续调度队列但等 cleanup 释放槽 |
| meeting-constraints | 半开区间、后置 buffer、午休、偏好日优先、重叠备选 | 更新时长、buffer 和排序规则，以最早时间优先 |

每项目 2 个目标 × 2 次重复 × 3 组（none / structured / extractive）= 12 次目标，合计每批 24 次。每次重复重新探索，所有组共享本次冻结历史；各目标另开进程、Session 和工作区。当前规则和完整文件清单各组一致，提炼器没有未来输入、题面或 grader。独立逐 tick 模拟和穷举网格先核验手写答案。

Provider 固定 minimax-cn / MiniMax-M3，使用 `.env.minimax` 中 Token Plan 订阅凭据。每 Session 上限 16 turns、128000 累计原始 Token、180 秒，记忆预算 1500。默认入门套件仍为原来两个项目，新题和 extractive 必须显式选择。

主指标为 Runtime completed 且 JSON 完全匹配；同时统计提炼失败、实际携带记忆的请求、工具调用以及分项 usage。重复两次不等于增加独立题目，当前只有 4 个目标。

## v3 开发批次：失败完整保留

| 组 | 计划目标 | 已执行 | 匹配答案 | 提炼失败阻断 | 实际使用记忆 |
| --- | ---: | ---: | ---: | ---: | ---: |
| none | 8 | 8 | 3 | 0 | 0 |
| structured | 8 | 6 | 3 | 2 | 6 |
| extractive-v1 | 8 | 2 | 1 | 6 | 2 |

**此表不能用来断言记忆提升或退化。** 异步旧题没有明确取消时 end 字段的定义；一个无记忆答案给出 null，而标准答案期望取消时间。该差异有合理歧义。其他错误还包括 drain 中提前释放 cleanup 占用的并发槽，以及排程边界/排序错误。

旧 extractive 接口要求 candidateId + kind，三次提交出现类别/数量不合法等问题；严格校验阻断六个目标。structured 的一次 ProviderStreamProtocolError 阻断两个目标，未降低流校验标准或伪造成功。

两个仅加强类别提示的额外诊断仍失败；随后简化成 candidateIds 的诊断返回了可解析 ID 列表。诊断不计入目标正确率、不替换任何原始失败，已知 usage 单独留档。

v3 原始产物：`artifacts/recap-minimax-v3-20260906-async-cleanup/`、`artifacts/recap-minimax-v3-20260906-meeting-constraints/`；汇总 `artifacts/recap-v3-analysis-final.json`。诊断文件为 `recap-v3-schema-diagnostic.json`、`recap-v3-ids-diagnostic.json`、`recap-v3-ids-content-diagnostic.json`，均位于 artifacts。

## v4 复验

v4 明确取消时 end 为取消时间，采用 extractive-v2，重新运行全部三组，不复用 v3 的成功基线。预先记录参数和分析边界：`artifacts/recap-v4-minimax-preregistered-20260906.json`。这属于看过 v3 结果后的开发集复验，不能称为未见测试集。

24 个目标全部结算：20 个执行完成，其中 15 个匹配、5 个答错；4 个目标因两次 structured 提炼失败而未执行。

| 组 | 计划目标 | 已执行 | 匹配答案 | 提炼失败阻断 | 实际使用记忆 |
| --- | ---: | ---: | ---: | ---: | ---: |
| none | 8 | 8 | 5 | 0 | 0 |
| structured | 8 | 4 | 4 | 4 | 4 |
| extractive-v2 | 8 | 8 | 6 | 0 | 8 |

structured 两次失败分别为 unexpected fields 和空对象缺少 notes；已执行的四个目标全部正确。因此 4/8 是包含提炼可用性的端到端成绩，不代表它只有 50% 的解题能力。extractive 四次提炼均合法，八个目标都实际注入记忆，manifest 与真实消息 digest 一致。旧 v3 的失败没有被抹去，v3/v4 也不合并作一个正确率。

| 项目 | none | structured（含阻断） | extractive-v2 |
| --- | ---: | ---: | ---: |
| async-cleanup | 2/4 | 2/4 | 4/4 |
| meeting-constraints | 3/4 | 2/4 | 2/4 |
| reuse 合计 | 3/4 | 2/4 | 4/4 |
| updated 合计 | 2/4 | 2/4 | 2/4 |

extractive 对 none 的八个配对中，3 胜、2 负、3 同对，净多答对 1 次。这个开发样本不支持统计显著性或普遍泛化结论。尤其 updated 合计没有提升：异步 drain 两次从错变对，排程规则更新却两次从对变错。

具体错误证据：无记忆组两次 drain 都过早派发队列任务，违反 cleanup 占用槽位。extractive 的排程 updated 第一次漏掉 day=1 的合法 [750,780)；第二次又把与已有忙碌区间冲突的 [765,795) 列为候选。第一次的注入 manifest 确认 8 条笔记全部进入请求，包括“半开区间，端点相接不冲突”。这是规则已经提供后仍推算错误，不能归因于预算没装进记忆，也不能仅凭分数断定是旧策略造成负迁移。

### 开销

| 组 | 目标工具调用合计 | 4 次提炼 outputTokens | 目标执行 inputTokens | 目标执行 outputTokens | 目标执行 cacheReadTokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| none | 32 | 0（无调用） | 27134 | 13476 | 58112 |
| structured | 17（仅 4 个执行目标） | 6139 | 不完整 | 不完整 | 不完整 |
| extractive-v2 | 33 | 262 | 38579 | 15628 | 67322 |

extractive 的提炼输出比 structured 少约 95.7%，这是输出 Token 指标，不是完整账单降幅。目标工具调用从 32 到 33，执行输入、输出及缓存读取也更高，当前没有展示整体效率收益。目标执行累计墙钟约 178.6 秒（none）和 178.7 秒（extractive），还未计入额外提炼；它受运行顺序和服务端负载影响，不作为稳定速度结论。

v4 原始产物：`artifacts/recap-minimax-v4-20260906-async-cleanup/`、`artifacts/recap-minimax-v4-20260906-meeting-constraints/`。汇总 `artifacts/recap-v4-analysis.json`；可运行 `node artifacts/analyze-recap-v3.mjs <async目录> <meeting目录>` 重新生成，脚本名沿用开发批次，默认输出文件为 v4-analysis.json。结束后的 `recap-v4-integrity-audit.json` 确认两批关键实现 hash 未漂移、各配对历史/输入 digest 一致、摘录组每次模型请求均带记忆；首请求记忆为 1219..1230 Token，未超过 1500 上限。

本轮可信的成果是：更简洁的提炼合同、受限原文来源、去重与完整条目预算，以及从候选到实际模型请求的审计。准确率净收益仍小且题型相反。下一项值得验证的是“什么条件下应该不用历史记忆”，而不是继续把更多摘要默认加入上下文。

## 验证与阅读方式

v3 完成全量测试：1181 项中 1176 通过、5 跳过、0 失败。v4 修改后，15 项针对性测试通过，涵盖真实进程六组 smoke、原文证据与读回过滤、预算、原有提炼器、两类新题和三类旧题的独立参考答案；随后新增纯 JSON / Tool 两种 ID 提交的回归，摘录文件全部 5 项通过（合计 16 项不同的相关用例）。类型检查、构建和 15 项文档合同测试通过。全量测试数字属于 v3 检查点，不冒充 v4 重跑全量的结果。

MiniMax 原始 input_tokens 不包含 cache read/write，且部分响应没有 cacheWriteTokens。未知字段保持缺失/null；不能用 input+output 当完整消耗，也不能据此声称美元费用下降。共同探索和提炼需分别计入，提炼按项目/重复只算一次；诊断费用另列。

实现与运行命令见[实验协议](../../research/project-recap-experiment.md)和[模型请求目录 M12](../../model-request-catalog.md#17-m12实验-project-recap)。
