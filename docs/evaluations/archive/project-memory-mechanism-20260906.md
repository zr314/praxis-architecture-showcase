# 固定历史、操作经验与代码执行：机制实验（2026-09-06）

English summary: a frozen-history pilot comparing rules, procedures and length-matched irrelevant text with executable public regressions. Extraction failures remain in the denominator; this is not a public benchmark score.

本批计划 30 个目标配置，全部结算；21 次实际执行、21 次最终程序通过，其余因记忆提炼失败阻断。无记忆 6/6。所有实际执行都通过，正确率达到本批样本的上限，未检出记忆准确率收益。

实验入口和实现已完成；提炼协议仍暴露兼容性与语义质量问题。只有两个独立项目，每组重复三次，不能将 30 配置当成 30 道独立新题。A/B 在不同项目分别失败，无法完成原计划的同项目提炼方差比较。

## 协议与边界

- 模型：minimax-cn / MiniMax-M3，MiniMax Token Plan 订阅凭据。
- 两个原创项目：heap-program 与 gcode-program；各先执行一次真实的预置缺陷修复。Host 先测出 starter 失败，模型修复后再次独立执行公开回归。不是宣称模型首次写出了 starter 缺陷。
- 两份公开历史及所有快照均于 2026-09-06T09:00:31.231Z 冻结，之后才运行目标。保存 15 个关键实现文件的副本与哈希，不等同于完整工作区镜像。
- 主要四组 none/rules/procedure_a/irrelevant 共 24 配置；procedure_b 是 6 配置的额外探针。A/B 分别调用一次，来源相同；不重试直到成功。
- 各目标使用新 Session、独立目录和空程序，目录名不透露组别。模型均可读取相同当前规则、输入、策略、公开旧回归，用 write 编写同步 solve(input, policy)，用 evaluate 执行。
- 目标输入或策略改变，Host 对两个公开回归和三个目标检查整体评分。模型能看到当前输入的执行结果，不能看到目标隐藏期望值。所有检查通过且 Runtime completed 才算成功。
- 组别做部分顺序轮换，项目间并发 2，没有模型 seed 控制。无 Run 轮次、工具次数、累计 Token、截止时间预算；单个纯程序测试保留 10 秒计算看门狗。
- 操作经验使用 When/Do/Check。完整快照保留引用和适用范围；compact 渲染只注入 id/content 等必要正文。各记忆组上限 1200 本地估计 Token，无关文字匹配 A 的渲染字节/本地 tokenizer 长度，不保证厂商 Token 一致；规则组实际长度也未严格匹配。

## 正确率和可用性

| 组别 | 计划配置 | 实际执行 | 最终通过 | 提炼阻断 |
| --- | --- | --- | --- | --- |
| 无记忆 | 6 | 6 | 6 | 0 |
| 规则摘要 | 6 | 6 | 6 | 0 |
| 操作经验 A | 6 | 3 | 3 | 3 |
| 等长无关文字 | 6 | 3 | 3 | 3 |
| 操作经验 B（探针） | 6 | 3 | 3 | 3 |

提炼失败必须计入系统可用性，但不应描述成模型在目标中答错。A 对 none/rules/irrelevant 的完整实际配对只剩 heap-program 三次；B 在 heap 被阻断，A 在 G-code 被阻断，因此 A/B 的同项目作答配对为零。不能把两个项目有效的一份各自拼成“操作经验 6/6”去声称预注册 A 组胜出。

## 执行开销（分项目，不混合缺失样本）

| 项目 | 组别 | 通过/实际执行 | 工具尝试 | 输入 Token | 输出 Token | 缓存读取 Token |
| --- | --- | --- | --- | --- | --- | --- |
| heap-program | 无记忆 | 3/3 | 26 | 18998 | 8880 | 78208 |
| heap-program | 规则摘要 | 3/3 | 23 | 69896 | 11043 | 78087 |
| heap-program | 操作经验 A | 3/3 | 26 | 90303 | 11850 | 89389 |
| heap-program | 等长无关文字 | 3/3 | 26 | 25320 | 12218 | 84608 |
| heap-program | 操作经验 B（探针） | 0/0 | 0 | 0 | 0 | 0 |
| gcode-program | 无记忆 | 3/3 | 26 | 55398 | 25154 | 70912 |
| gcode-program | 规则摘要 | 3/3 | 22 | 22355 | 8067 | 55808 |
| gcode-program | 操作经验 A | 0/0 | 0 | 0 | 0 | 0 |
| gcode-program | 等长无关文字 | 0/0 | 0 | 0 | 0 | 0 |
| gcode-program | 操作经验 B（探针） | 3/3 | 24 | 20367 | 7101 | 57984 |

以上为实际目标执行开销，不含下表学习与提炼。Provider 分开报告输入、输出、缓存读取；缓存写入与美元费用缺失，不当成零。0/0 表示未启动，不是零成本解题。工具数包含失败尝试；时间受模型响应、缓存、顺序、压缩与并发影响，不作为单独因果证据。

heap 三次配对中，操作经验 A 与无记忆均用 26 次工具尝试，输入 Token 为 90303 对 18998，输出为 11850 对 8880，没有节省。G-code 有效经验 B 的目标输入/输出为 20367/7101，低于无记忆的 55398/25154；但规则摘要也降至 22355/8067。B 再加自身一次提炼后，已知输入/输出为 59277/8548，输入已高于无记忆，且缓存费用未知。两题都不能支持稳定的整体效率提升。

| 共同学习项目 | 最终公开回归 | 工具尝试 | 输入 Token | 输出 Token | 缓存读取 Token |
| --- | --- | --- | --- | --- | --- |
| heap-program | 2/2 | 10 | 10140 | 2627 | 24064 |
| gcode-program | 2/2 | 22 | 59835 | 19099 | 130336 |

| 项目 | 提炼调用 | 结果 | 输入 Token | 输出 Token | 缓存读取 Token |
| --- | --- | --- | --- | --- | --- |
| heap-program | procedure_a | completed | 15148 | 814 | 未知 |
| heap-program | procedure_b | extraction_error | 172 | 817 | 14976 |
| gcode-program | procedure_a | extraction_error | 38917 | 961 | 未知 |
| gcode-program | procedure_b | completed | 38910 | 1447 | 未知 |

rules 和 irrelevant 由 Host 确定性构造，没有提炼模型调用。每项目的共同学习仅发生一次，不能按每组相加当实际账单。A/B 的提炼成本各自独立，冻结快照跨三次重复复用。

## 从实际轨迹观察到的问题

1. **真实执行与自述分离。** G-code 学习最终程序通过 2/2，助手却声称测试期望值原来错误、后来被纠正。Host 前后期望数组 digest 相同，工作区也没有修改测试的能力。模型把错误 starter 的 actual 与 expected 混淆，压缩摘要还保留了错误解释。通过验证的是程序输出，不是这段叙事。
2. **引用有效不等于经验正确。** heap A 的 n3 建议 placement、alignment、heapBytes 都是 numeric，但 placement 实际为字符串；此笔记被注入。G-code B 的 n4 建议手工追踪自洽后把分歧归因于 fixture bug，这不足以证明测试错误；它有历史验证引用，却因预算被省略，未进入目标请求。不能用本批通过结果替这条未暴露的笔记背书。
3. **输出合同造成了缺失样本。** heap B 返回四条笔记，其中一条漏引最终验证消息，整份被拒绝；G-code A 返回 Markdown JSON 围栏，被 v1 的纯 JSON 解析拒绝。四次提炼只有两次产出有效快照。无关组依赖 A 的长度，因此 G-code 无关组三次也被连带阻断。
4. **工具与任务难度形成上限效应。** 当前规则、公开回归和代码执行已让无记忆组全部通过。与之前手工输出 JSON 的 v5 不同，本批还改变了任务输出、反馈、输入和学习方式，不能直接把新旧差值归因于代码执行，更不能归因于记忆。

## 实际注入

| 项目 | 组别 | 本地估计 Token | 注入 ID | 省略 ID |
| --- | --- | --- | --- | --- |
| heap-program | 无记忆 | 0 | 无 | 无 |
| heap-program | 规则摘要 | 878 | n0, n1, n2, n3, n4, n5, n6, n7, n8 | 无 |
| heap-program | 操作经验 A | 1170 | n0, n1, n3 | n2 |
| heap-program | 等长无关文字 | 1170 | n0, n1, n3 | n2 |
| gcode-program | 无记忆 | 0 | 无 | 无 |
| gcode-program | 规则摘要 | 925 | n0, n1, n2, n3, n4, n5, n6, n7 | 无 |
| gcode-program | 操作经验 B（探针） | 1198 | n0, n1 | n2, n3, n4 |

审计校验了冻结历史、快照绑定、源码副本哈希、目标开始晚于冻结、各组工具一致、实际请求 digest 与 manifest 一致、首次注入与预先渲染一致，以及历史测试期望未变化。结果见 analysis.json。上述校验不能证明每句笔记语义正确，也不等同于对所有未测输入的形式化验证。

## 已完成的代码与验证

- 新增独立机制实验入口、学习/提炼冻结、重复运行、等长无关对照、公开程序执行及 Host 隐藏评分。
- 增加可选 compact 渲染；完整审计资料保留在快照，默认产品记忆格式不变。
- 本批冻结实现全量测试 1195 项：1190 通过、5 跳过、0 失败；format/lint/typecheck/build 通过。
- 批次结束后已实现 procedure-v2：兼容一层完整 Markdown JSON 围栏，拒绝周围额外正文；失败保存公开文本原文；提示明确每条必须引用最终验证。严格字段和来源校验不变。新增 Mock/解析验证通过，不回填本批失败，也不声称 v2 已改善 live 成绩。v1 的 G-code 失败未保存原始文本全文，不能宣称已成功回放那份原始提交。

下一步应把“经验存储”与“经验已验证”分开：记录可执行检查、实际运行的输入/代码版本及结果，让每条经验的适用范围可以检验。需要采用基线仍有错误、但历史程序与当前任务确实相关的独立留出任务；先预定题集与比较，再运行，避免反复选题直到出现正收益。

## 复现与证据

`npm run eval:memory-mechanism -- --output artifacts/new-memory-mechanism --provider minimax-cn --model MiniMax-M3 --repeats 3 --concurrency 2`。此命令使用运行时的当前实现，不承诺复现旧随机输出；v1 实现副本在下列 source/。

本批目录：`artifacts/recap-mechanism-minimax-20260906/`，包含 preregistered.json、prepared.json、frozen.json、results.json、analysis.json、学习/提炼回执、每目标的 launch/events/episode/result，以及 source/。离线分析脚本为 `artifacts/analyze-memory-mechanism.mts`；审计未运行新的模型调用。

相关：[研究协议](../../research/project-recap-experiment.md)、[完整模型请求目录 M13](../../model-request-catalog.md)、[前一批无执行预算实验](project-recap-unlimited-20260906.md)。
