# 同项目经验继承：首轮真实模型 pilot

日期：2026-09-06（Asia/Shanghai）。English summary: all 20 controlled trials passed with DeepSeek V4 Flash, but inherited recaps increased measured tokens in this small pilot. The failure-category ablation removed no content and cannot support a causal claim.

## 结论

本轮没有观察到记忆的净收益：四个基础组在 4 个目标上都正确；计入提炼后，compact、普通 recap、structured 的 Token 比 none 高 42.7%–43.3%，工具尝试次数未减少。只含 2 个原创小项目、4 个固定目标、一次重复，有明显准确率天花板；不能推广为“长任务不需要记忆”。

failure 消融没有实际删掉笔记：两份 structured 快照都把历史事故归入 fact，failure 条目数为 0。四个目标的 structured 与消融组首轮注入 digest 完全相同。因此两组之间的数值差异是相同上下文下的运行波动，不能归因于删除失败经验。

## 有效批次

- 模型：现有 `D:\agent-evals\.env` 配置的 `deepseek / deepseek-v4-flash`；仅将对应凭据加载到本次进程，不修改持久配置。
- 协议：`controlled-project-recap-v2`；每组获得相同输入文件名清单、相同当前文件、相同工具与预算，评分答案只在父进程。
- 2 个探索 Session、6 次提炼、20 个目标 Session；所有目标 completed、JSON grader 通过，无失败工具调用。
- 每个项目包含 reuse / updated；更新目标分别改变字段 schema、榜单得分方向。所有组均正确处理当前规则，未观察到旧规则导致错误。
- 最大 12 turns、24 tools、64000 累计 Token、120000ms / Session；继承内容上限 1500 Token。

| 组 | 正确目标 | 工具尝试 | 执行 Token | 提炼 Token | 合计 Token | 对 none 增幅 |
| --- | --- | --- | --- | --- | --- | --- |
| none | 4/4 | 16 | 46,298 | 0 | 46,298 | — |
| compact | 4/4 | 16 | 58,127 | 8,148 | 66,275 | +43.1% |
| recap | 4/4 | 17 | 59,398 | 6,686 | 66,084 | +42.7% |
| structured | 4/4 | 16 | 59,101 | 7,234 | 66,335 | +43.3% |
| structured-without-failure | 4/4 | 16 | 59,593 | 7,234 | 66,827 | +44.3% |

Token 为 Provider 返回的 input + output，不是美元费用；缓存读取已包含在输入 Token 中，不能再相加。表内不含共同探索的 21,834 Token；各组提炼按项目仅计一次。消融复用 structured 的真实提炼调用，表中重复列出费用用于独立策略预算比较，不代表再次付费。

有效批次实际合计 **300,503 input + 25,916 output = 326,419 Token**，含共同探索和全部目标，提炼去重。Provider 未返回 costUsd，美元成本未知。这个数字不包含下述废弃开发批次；其中中止时的在途调用无法完整核算，不能把有效批次 Token 当作本次全部付费调用账单。

## 实际注入审计

| 项目 | compact 注入 Token | recap 注入 Token | structured 注入 Token | failure 源笔记数 |
| --- | --- | --- | --- | --- |
| kv-contract | 799 | 556 | 931 | 0 |
| ranking-contract | 617 | 558 | 772 | 0 |

所有继承笔记均在预算内，没有因为裁剪而造成空组；实际请求中的 digest 与 manifest 一致。failure 消融为空的原因是分类，而不是 Token 裁剪。

逐条阅读还发现摘要混入了阶段性信息：旧 workspace 标识、曾写入 answer.json、写入摘要与字节数、未来任务尚未知、探索阶段的权限。这些内容和后续解题规则混在一起，增加输入负担。它们是下一轮删除实验的候选；本轮尚未做对应消融，不能声称删除后一定更好。

此次目标保留了很短且完整的规则文件，none 几次读取就能求解；经验组仍需检查当前规则，因而没有明显节省探索。这是对结果的机制解释，不是统计因果证明。

## 首批偏差与修复

最初的 v1 批次在记录 5 个结果后停止并标记 `invalid_for_effect_comparison`。无记忆组没有目录枚举工具，题面又未列出规则文件名；它尝试猜 contract.json / README.md 等，最终耗尽工具预算。继承组从摘要得知文件名，这会把可发现性差异混进经验收益。

修复由 `recapEpisodePrompt` 对所有组追加相同输入清单、相对路径规则和工具边界，目标规则和评分答案没有改变。另将普通 recap 的工具 schema 收紧为最多一个 fact 笔记，与既有校验一致；增加校验原因及公开候选的失败记录。v1 的普通 recap 曾校验失败，旧日志只保存 TypeError，无法确定确切违反哪项规则；不把推测当作根因。

新批次重做探索和全部组，不挑选旧的成功 rollout 拼接。修复后 `project-recap.test.ts` **6/6 通过**，`npm run check` 与 `npm run build` 均通过。

## 下一轮要验证什么

1. 将“信息类型”与“是否来自失败”分开标注；事实也可以描述失败。消融运行前核验目标集合非空，运行后核验实际注入确实改变。
2. 冻结当前探索前缀，对同一份笔记比较：全部保留、删除阶段性执行记录、仅保留项目规则及失效条件。保留失败结果和全成本，不能只展示省 Token 的 rollout。
3. 扩充到有更多探索成本的真实项目连续维护任务，包含规则变更和经验不适用条件；开发集调参后使用新目标评测，并做配对重复。当前 4 个目标的重复不能当成更多独立题目。

这些是根据 pilot 提出的下一步假设，尚无实验证据说明哪种保留策略最优。

## 证据

有效产物：仓库根目录 `artifacts/recap-live-deepseek-20260906-pilot-v2/`，包含 manifest、所有快照、source、逐组 events / episode / context-manifests、results.json 和 analysis.json。派生分析脚本为 `artifacts/analyze-recap-pilot.mjs`，会同时核验实际注入与消融是否变化。

- suiteDigest：`sha256:0896c08bc51b5c3000aebf94a5c93d951e037d8e0d24748278df3084d6a592a4`
- 关键实现摘要：`sha256:3ea069b0121d942f110e58d77e7bd26ecab56347a5ff66d244155868abdaa6ab`
- 废弃批次：`artifacts/recap-live-deepseek-20260906-pilot/disposition.json` 及未覆盖的原始结果。
- 检查日志：`.tmp/recap-live-fix-tests.log`、`.tmp/recap-live-v2-check.log`、`.tmp/recap-live-v2-build.log`。

实验合同与运行命令见[同项目经验继承实验](../../research/project-recap-experiment.md)。
