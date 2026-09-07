# Werkzeug 项目经验实验：复核后第二批

> 公开快照说明：下文标注的本地产物保存在独立评测环境，未随此仓库分发。Local evaluation artifacts referenced below are not included in this public source snapshot.

日期：2026-09-06。English summary: a newly registered cohort following the aborted first run. Frozen history A is reused unchanged; all memories are regenerated once before targets. The revised runner records host-observed file changes, main-loop usage, and public events incrementally. Passing offline checks does not establish memory effectiveness.

## 与旧批次的边界

[第一批](werkzeug-project-memory-20260906.md) 保持中止，540 次主循环请求的异常样本不与本批混算。本批使用相同历史 A 的完整公开轨迹，不复制 B 的探索或补丁；none / compact / structured 仍各三次，按循环顺序串行执行。提炼各调用一次，失败不重试、不择优替换。

新批次预注册（本地产物：`artifacts/werkzeug-memory-minimax-20260906-v2/preregistered.json`） 保存实现、题面、源码与镜像标识。截至 2026-09-06 23:48（Asia/Shanghai），3/9 个配置已落盘，第 4 个 `1-compact` 的运行进程仍在；最终状态以该目录的结果记录为准。

## 复核发现和修改

1. 去除仓库任务继承的小题 32K Session 覆盖。Runtime 使用所选模型的上下文容量，但默认 64 Ki-token 未压缩重放软阈值仍保留；这不是彻底关闭压缩。执行时必须核对实际请求 manifest。
2. `repo_shell` 每次执行前后由宿主比较 `src` 与 `tests` 的文件哈希，记录新增、修改和删除。即使命令最终失败，已经写入的文件也进入压缩的修改证据。拒绝符号链接的文件审计，不把 Shell 命令中出现的路径自动当成写入证明。
3. 压缩器保留实际验证命令、退出码和输出尾部，并要求区分工具观察与模型假设。命令成功不等于整个任务已通过。此修改能改善证据保留，不能保证语义摘要不会出错。
4. 保持无效压缩输出的拒绝行为；若完整流仍提供终止 usage，则保留已知消耗。每次主循环模型返回和公开事件即时落盘，中断后不再只剩最终汇总缺失。主循环 usage 文件不包含辅助压缩或失败流，不能单独冒充完整账单。
5. 独立复测原 A 的 compact 调用成功，但该输出实际需要约 2944 个保守估算 Token，在原 2400 上限下会完全不注入。这是独立的离线/诊断发现，不是旧失败已经修复的证明。本批三组统一 4096 注入上限，提炼目标仍为 1200；提前检查真实选中笔记，目标中核对实际曝光。
6. 隐藏 pytest 增加每项 10 秒计算看门狗，整体评分仍有 180 秒上限。它限制评分进程的挂起，不限制模型任务轮次。任务本身仍无总轮次、工具数、Token 或总时长预算，Shell 单命令 180 秒。

## 执行前验证

TypeScript 类型检查通过；包含流错误计费、真实文件变化回执、摘要状态保留、Session 压缩、实验隔离和断点保留的 34 项测试通过。

新评分环境预检（本地产物：`artifacts/werkzeug-preflight-20260906-v3/preflight.json`）：官方 3.1.4 为 164 通过 / 62 失败；3.1.5 为 147 通过 / 79 失败；3.1.7 为 226 通过 / 0 失败；各另有 1 个既定 skip。主验收范围与旧批一致，仅增加单项挂起防护，没有根据目标分数删题。

## 结果解释

首轮三组的补丁均通过独立评分（226 通过、0 失败、1 个既定 skip），但记忆组消耗更高。English interim results: all three first-repeat patches pass the independent checks. Both memory arms have a recorded infrastructure error after a model completion event; this is distinct from patch correctness. No memory benefit has been established.

| 首轮组别 | 独立检查 | 运行器状态 | 工具调用 | Episode 时间（分钟） | 目标输入 + 输出 Token | 加一次提炼的 Token | 缓存读取 Token |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 226 通过 | completed | 64 | 10.7 | 116,833 | 116,833 | 1,106,949 |
| compact | 226 通过 | infrastructure_error | 223 | 60.4 | 341,679 | 377,140 | 4,822,246 |
| structured | 226 通过 | infrastructure_error | 173 | 32.8 | 533,570 | 563,817 | 3,924,096 |

来源：none（本地产物：`artifacts/werkzeug-memory-minimax-20260906-v2/0-none.json`）、compact（本地产物：`artifacts/werkzeug-memory-minimax-20260906-v2/0-compact.json`）、structured（本地产物：`artifacts/werkzeug-memory-minimax-20260906-v2/0-structured.json`）。表中时间包含 Episode 收尾，不包括随后独立评分；Token 来自 `prompt_completed.usage`，不是完整金额账单，缓存单列。共同历史 A 的输入 50,548、输出 7,710、缓存读取 216,833 也未计入此表。

两个记忆组的公开事件均以 `prompt_completed` / `end_turn` 结束，随后 Episode 被记为基础设施错误。compact 导出 200 条消息，structured 导出 0 条；`runner.ts` 在完成事件后分页取 transcript，并在共用 catch 中覆盖状态。现有证据指向完成后的轨迹读取/收尾问题，错误记录只有 `Error`，不足以确定具体根因。原始 `passed: false` 是“运行器完成且评分通过”的合取结果，不能当成补丁答错；原始记录保留，不追改为成功。

compact 共发起 48 条含 pytest 的工具命令，none 为 13 条，显示验证开销值得进一步拆解；structured 为 5 条，不能把它的全部额外成本也归因于重复测试。首轮每组仅一个样本，尚不能确定多余探索由历史内容、会话压缩还是模型随机性造成。现阶段只支持“这轮没有观察到记忆的准确率或效率收益”，不支持长期记忆普遍无效的结论。

本批尚未产生完整组间结论。全部实际配置、失败和阻塞均保留。成本至少分别报告目标输入/输出/缓存、提炼消耗及共同历史工作成本；相同目标的三个随机重复不能用于摊薄一次提炼成本。若三组都通过，主要看正确修复的探索与成本；如果某组提炼失败，应区分流水线可靠性和已执行目标的修复正确性。

## 2026-09-07：按修复阶段复核

English trajectory audit: reconstructed early patches show a different exploratory signal from total episode cost. The structured arm reaches a passing source patch at tool 14, versus tool 19 for no memory, then continues for 159 tool calls without changing source. This is one repeat and does not establish a causal memory benefit or an end-to-end saving.

此前“没有观察到收益”的结论只适用于最终正确率和整个 Episode 消耗，不能概括修复前的效率。新增加的 [轨迹分析器](../../../evals/werkzeug/trajectory.mjs) 读取完整公开事件和宿主文件修改回执，不依赖缺失的 transcript 页，也不把 `pytest` 退出 0 或模型宣称完成当作独立评分。

在全新的离线容器中，重放观察到的源码修改命令，随后使用冻结的 226 项评分。none 第 19 次、structured 第 14 次、compact 第 64 次生成的源码，均与各自最后独立评分的源码逐文件完全一致。compact 第 40 次首个补丁为 92 通过 / 134 失败，第 45 次为 225 通过 / 1 失败；第 64 次为 226 通过。

| 首轮组别 | 复验通过的早期源码所在工具序号 | 截至生成该补丁的主循环输入 + 输出 | 随后的工具调用 | 随后的主循环输入 + 输出 |
| --- | --- | --- | --- | --- |
| none | 19 | 39,304 | 45 | 39,404 |
| compact | 64 | 92,238 | 159 | 161,216 |
| structured | 14 | 25,026 | 159 | 287,952 |

证据：首个补丁复验（本地产物：`artifacts/werkzeug-first-patch-audit-20260906/results.json`）、compact 中间补丁复验（本地产物：`artifacts/werkzeug-compact-patch-audit-20260907/results.json`）、完整工具时间线分析（本地产物：`artifacts/werkzeug-memory-minimax-20260906-v2/trajectory-analysis.json`）。这次分析没有新的模型调用，也没有改变目标、评分或覆盖原结果。

表中 Token 是按助手消息序号与成功主循环 usage 对齐的输入、输出计数，包含产生补丁的那次模型返回，但不含缓存和辅助压缩调用，不能与此前整个 Episode 的总数混用。structured 修复前主循环 Token 比 none 少约 36%，工具调用少约 26%；加入一次提炼 30,247 Token 后，修复前该口径变为 55,273，仍高于 none 的 39,304。因此只能说存在“更早找到合格补丁”的迹象，不能宣称首次使用更省钱。

none 曾在第 55 次移除补丁、第 57 次恢复，这是验证回归测试的负对照；所以“最后一次源码修改”会把它误判成第 57 次才修好。structured 在第 14 次后没有源码修改；compact 第 64 次后仍有源码修改及恢复。修好后的工具调用包含必要的回归测试编写和验证，不能全部称作浪费。旧记录没有逐次源码快照，重构只提供命令边界的源码证据，不声称精确的首次修复时间，也不代表当时全部交付要求已经完成。

运行状态更新：第 4 个配置 `1-compact` 已落盘，补丁同样 226 项通过，但仍记录收尾基础设施错误；第 5 个 `1-structured` 已启动。旧批次继续使用冻结实现，未插入新的源码快照入口。[下一题设计与准备状态](../../research/project-experience-partition.md) 单独记录。

截至 2026-09-07 后续检查，本批全部 9 个配置已落盘：7 个实际执行的补丁均通过 226 项检查，末尾 `2-none`、`2-compact` 在零轮即遇到 Provider 限流，其工作区仍为未修复基线。`2-structured` 执行 365 次工具后同样遇到限流，但留下的补丁通过检查；原 Episode 随后被收集器记为 infrastructure_error。不能将两次零轮基线评分算作模型修复失败，也不能将有补丁通过等同于 Runtime 正常收尾。新题 B2 的限流和首轮结果见上述独立报告。
