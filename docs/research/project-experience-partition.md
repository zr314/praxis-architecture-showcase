# 项目经验迁移：分块不变性后续案例

> 公开快照说明：下文标注的本地产物保存在独立评测环境，未随此仓库分发。Local evaluation artifacts referenced below are not included in this public source snapshot.

最新续跑状态（2026-09-07）：7/9 个配置已结束，6 个最终源码通过检查，1 个恢复执行的 structured 最终回归；`2-none` 仍运行，`2-compact` 排队。见文末的续跑分析及合并视图（本地产物：`artifacts/werkzeug-partition-minimax-20260907-resume-2/analysis.json`）。下文首次限流记录属于先前阶段，不能当作当前状态。

English summary: the MiniMax cohort has ended, with one executed repeat per arm and six zero-turn provider rate-limit failures. All three executed patches pass 300 checks. Structured memory reaches a passing patch at tool 52 versus 56 without memory, with fewer pre-patch main-loop tokens; compact needs 227 tools. Structured is interrupted after repairing, so its total is censored. These are exploratory observations, not replicated or monetary savings.

## 为什么选这道题

[上一轮轨迹复验](../evaluations/archive/werkzeug-project-memory-v2-20260906.md) 显示，structured 在第 14 次工具调用就产生了合格补丁，却在随后继续执行 159 次工具。接下来需要同时测量“找到正确源码”和“完成全部交付”，而不是为了拉开最终通过率不断增加题目难度。

新目标 B2 使用本地已有的官方 3.1.7。此前宽范围预检已经发现：同样的合法 multipart 字节，按一个字节或某些其他位置分块后，空字段或文件内容会变化。它是本地复现的问题，不声称有已核实的上游 issue。上次针对头部结束位置的修复不足以解决它；新任务仍要求保留合法 CR/LF 字节、空 part 和流式输出。这让已有经验可能帮助确定约束与回归检查，同时需要重新诊断。

可执行文件：

- [公开复现](../../evals/werkzeug/partition_public.py)：只使用内存输入，展示整块与逐字节输入的差异。
- [私有检查](../../evals/werkzeug/partition_checks.py)：标准 CRLF 输入的 7 种固定分块宽度、所有单切点、二进制及空内容，并验证大文件在 EOF 前持续输出。
- [预检入口](../../evals/werkzeug/partition-preflight.mjs)：使用已有 Docker 镜像，`--pull never`、`--network none`，不访问网页或远程仓库。
- [准备入口](../../evals/werkzeug/prepare-partition-study.mjs)：冻结历史 A、目标源码和题面，不调用模型。

## 离线验收

最终预检（本地产物：`artifacts/werkzeug-partition-preflight-20260906-v2/results.json`） 使用 74 项新检查和 226 项旧检查，另有沿用的 1 个 skip；旧检查没有因为新目标而移除。

| 实现 | 通过 | 失败 | 解释 |
| --- | --- | --- | --- |
| 官方 3.1.7 | 279 | 21 | 目标缺陷确实存在 |
| 作者参考修复 | 300 | 0 | 当前固定验收可满足，不代表全面正确或上游认可 |
| 仅再加上次修复的删除位置保护 | 279 | 21 | 不能靠机械重复旧补丁通过 |
| 对输出裁掉 CR/LF | 123 | 177 | 会破坏必须保留的有效数据 |

最初的预检草案（本地产物：`artifacts/werkzeug-partition-preflight-20260906/results.json`）不合格并完整保留。它把任意二进制尾部与 LF/CR 单独分隔符做了笛卡尔积，产生无法唯一解释的字节序列，例如载荷末尾 CR 与分隔 LF 会组成 CRLF。这不是适合用隐藏测试强行指定答案的兼容性要求。模型运行前已将新的任意字节分块契约限定为标准 CRLF；旧的非标准换行兼容性仍由未修改的上游测试覆盖。参考实现最初也失败，修正实现后才获得上述通过结果，没有依据模型得分删题。

## 固定的历史与对照

准备目录（本地产物：`artifacts/werkzeug-partition-study-20260907/design.json`） 保留最初的 `fixture_prepared_not_model_run` 状态；随后启动的独立批次见执行预注册（本地产物：`artifacts/werkzeug-partition-minimax-20260907/preregistered.json`）。不要把旧的准备文件当作实时运行状态。

历史 A 固定使用上一批第一个无记忆修复任务 `0-none` 的完整 130 条公开消息。它包含真实诊断、修复和回归验证，不加入宿主评分、B2 题面、隐藏测试或参考补丁。它使用 3.1.5；B2 始终从规范 3.1.7 起步，不能继承 A 的工作区。选择规则在 B2 的任何模型调用之前确定，不根据 B2 结果换历史。

保持 none / compact / structured 三组和循环顺序，每组三次。两种记忆只从同一历史各提炼一次，失败不重试择优。统一 4096 注入上限并核对实际选中内容。所有组拥有相同的完整源码、上游测试、复现和工具；关键约束也明确写进共同题面，无记忆组可自行发现原因。该案例验证同子系统的近迁移，不冒充跨项目长期学习。

## 衡量什么

主指标是第一个通过固定 300 项检查的工具结束后源码快照。首先评分基线，再按时间顺序评分每个变更快照；同一源码恢复后仍保留其时间位置。评分全部在模型结束后进行，不向模型提供额外反馈。

同时报告修复前后的工具调用、主循环输入/输出/缓存、辅助调用总量、一次提炼成本、最终正确率、终止状态和证据导出状态。修复后添加回归测试属于交付的一部分，应与无新增证据的重复验证区分。未出现合格快照就记录未达到，不用最终回复措辞或平均数补齐。

[快照工具](../../apps/runtime/src/evaluation/recap/checkpointTool.ts) 会保留初始源码及每个发生源码变化的工具结果，失败命令已经产生的写入也会保留；源码恢复不会被遗漏。快照放在模型工作区之外，不向模型返回快照或评分信息。工具结束时间和快照额外开销分别记录。[独立运行入口](../../apps/runtime/src/evaluation/recap/checkpointRuntime.ts) 尚未接入旧批次，因此旧批次协议没有改变。

## 当前边界

2026-09-07 流程已结束，9 个配置均有结果记录，但只有首轮三组实际执行，后六次在第 0 轮收到 `PROVIDER_RATE_LIMITED`。这不是完成了三轮对照，也不是后六道题答错。汇总文件（本地产物：`artifacts/werkzeug-partition-minimax-20260907/analysis.json`） 是生成时的快照，可用 `node evals/werkzeug/partition-analyze.mjs artifacts/werkzeug-partition-minimax-20260907` 刷新。

两次真实 MiniMax 提炼均成功，未重抽或修改结果：compact 1 条笔记，保守估算注入 4069 Token；structured 13 条，3379 Token，均无遗漏。提炼的输入 + 输出分别为 81,225 和 68,655 Token；这部分成本单独报告，不能摊薄到三个随机重复。运行器与依赖源码摘要、历史、题面和评分均已冻结，后续目标启动前重新核对实现与基线。实际首请求 manifest 确认 1,000,000 上下文容量，未设置总轮次或总 Token 上限。

[新收集器](../../apps/runtime/src/evaluation/recap/partitionRunner.ts)直接保存公开事件，不再额外分页请求整段 transcript；模型终止状态和证据收集错误独立记录，完成之后的连接收尾错误不会覆盖已观察到的完成事件。隐藏评分只在模型结束、容器关闭后读取私有源码快照。快照缺失、工具回执数量不一致或最终源码不匹配时，不报告首次通过指标。

无模型集成测试（本地产物：`artifacts/werkzeug-checkpoint-integration-20260907/integration.json`）在真实离线容器中产生基线、修复、撤回、恢复四个快照，独立评分分别为 279/21、300/0、279/21、300/0；其中撤回命令退出失败，源码仍被保留。快照测试、完成状态保留测试及 TypeScript 类型检查通过。

旧批次继续按原冻结协议运行，因此两批可能共享宿主资源和 MiniMax 服务。耗时作为描述性数据，主要比较工具调用和分阶段 Token；不把两批结果混合平均，也不声称独立任务上的统计显著性。

## 首轮结果与限流

| 组别 | 首次通过 300 项检查的工具序号 | 修复前主循环输入 + 输出 | 加一次提炼 | 修复后工具调用 | 模型结束状态 |
| --- | --- | --- | --- | --- | --- |
| none | 56 | 195,529 | 195,529 | 24 | completed |
| compact | 227 | 477,583 | 558,808 | 160 | completed |
| structured | 52 | 115,494 | 184,149 | 52 | PROVIDER_RATE_LIMITED |

所有首次通过位置均来自任务结束后对保存的源码快照独立评分，最终源码也分别通过 300 项检查。none 曾在第 67 次撤回源码、第 68 次恢复，首次通过仍是第 56 次。compact 在第 146 次补丁还失败 9 项，第 227 次才全部通过。structured 曾出现失败 289、41、177 项的中间补丁，第 52 次才全部通过；因此不能把更早编辑源码等同于更早修好。

structured 修复前的主循环输入 + 输出比 none 少约 41%，首次通过的工具序号少 4 次；计入一次提炼后，该 Token 口径只少约 6%。它仍在修复后继续了 52 次工具调用，于北京时间 2026-09-07 01:46:08 收到限流错误而中断。none / compact 整个 Episode 输入 + 输出分别为 272,516 / 1,095,176；structured 中断前已记录 352,560，不能当作自然完成所需总量。分阶段主循环不含辅助调用，缓存单列，也不是费用。

紧随其后的六个配置全部零轮失败，usage 没有返回输入/输出计数，保留为未知而非 0。现有事件只能确认 Provider 限流，不能区分短时速率限制与 Token Plan 周期额度限制，也没有依据声称恢复时间。没有发起新的模型请求来试探或重跑。

结论限定为：structured 在这一轮有较早找到合格补丁、减少修复前主循环 Token 的迹象；compact 显著增加探索；尚无三轮重复支持，也没有整体省钱或准确率提升证据。旧批次同样已结束：7 个实际执行的补丁通过原有 226 项检查，另外 2 次零轮限流；这些结果不与 B2 混合计算。

检查结果时还发现一个收集器缺陷：零工具调用没有 timeline / usage 文件，评分读取抛出 ENOENT，掩盖了原本的 Provider 限流。现已为未来批次修复缺失活动日志的处理，并单独记录失败代码；缺失日志允许为空，损坏日志仍报错。针对零轮限流的测试通过。历史结果不覆盖，报告从原始事件恢复限流原因；本批已冻结的源码副本保留，后续批次需重新注册修订实现。

## 额度恢复后的续跑

用户确认额度恢复并授权继续后，已创建续跑记录（本地产物：`artifacts/werkzeug-partition-minimax-20260907-resume-1/amendment.json`）。首轮已经正常完成的 none / compact 不重跑；首轮 structured 沿用原 Session ID 和原工作区继续，其余六个零轮失败配置从相同基线重新启动，使用原先冻结的记忆，不再调用提炼器。

原 Session 存储和完整工作区在恢复前已备份。首个恢复请求确认保留了 4091 Token 的压缩摘要及全部 13 条结构化笔记，实际 Session ID 未变。首次通过仍以原来的第 52 次为准，后续消耗追加到修复后阶段；恢复提示只说明上次受 Provider 限流中断，不透露检查已通过的事实或修改任务要求。断开的等待时间不计入模型执行时长。

[续跑入口](../../apps/runtime/src/evaluation/recap/partitionContinuation.ts)保存每次尝试和合并视图，并允许后续批次读取上一续跑批次的结果。再次限流会暂停队列，不连续派发剩余配置。续跑指标与连续完成的指标分别标注，不能假装没有中断。当前开始恢复的 structured 尚未产生续跑最终结果，剩余六次已排队。

恢复首个 Session 后发现收集器使用了默认 TypeScript lib 未声明的 Array.findLast（当前 Node 可执行）；已改为等价的 filter/at，并增加了读取前一续跑批次的支持，类型检查通过。该改动不涉及模型 Runtime、记忆或题面。为保留冻结约束，首个续跑批次在当前样本落盘后会由实现摘要检查停止；排队进程随后创建新的续跑批次，跳过该已完成样本，仅补齐六个零轮配置。交接说明保存在队列交接记录（本地产物：`artifacts/werkzeug-partition-minimax-20260907-resume-1/queue-handoff.json`）。

涉及首次通过位置保留、费用未知值、零轮限流和源码撤回恢复的 5 项测试通过，TypeScript 类型检查通过。尚未对解题步骤做优化；完整结果到齐后，才单独测试验证去重和结束条件，避免中途改变求解策略。

## 续跑后的阶段分析：正确补丁也可能在收尾时丢失

English continuation analysis: seven configurations have settled, with six passing final patches and one genuine regression after a resumed structured-memory run. The first passing snapshot is not the final delivery. Two trials remain pending, so group totals are incomplete. No solver policy is changed during this frozen cohort.

| 配置 | 首次通过的工具序号 | 总工具调用 | 修复后调用 | 最终独立评分 |
| --- | --- | --- | --- | --- |
| 0-none | 56 | 80 | 24 | 300 项通过 |
| 1-none | 117 | 148 | 31 | 300 项通过 |
| 0-compact | 227 | 387 | 160 | 300 项通过 |
| 1-compact | 40 | 100 | 60 | 300 项通过 |
| 0-structured，含恢复 | 52 | 390 | 338 | 出现失败并触发整体 180 秒看门狗 |
| 1-structured | 98 | 279 | 181 | 300 项通过 |
| 2-structured | 85 | 214 | 129 | 300 项通过 |

上述数据来自第二续跑批次合并结果（本地产物：`artifacts/werkzeug-partition-minimax-20260907-resume-2/results.json`）。`pending` 中的两项仍附带历史零轮失败行，新的合并视图会将其显示为运行中或排队，不误计为新的失败结果。

### 1. 早期修复收益没有稳定复现

可配对的前两轮中，structured 的首次通过工具序号是 52 / 98，none 是 56 / 117；但 structured 修复前主循环输入 + 输出是 115,494 / 281,355，none 为 195,529 / 247,929，分别约少 41% 和多 13%。加一次提炼后，structured 为 184,149 / 350,010，分别约少 6% 和多 41%。不能只用工具次数宣称成本下降，也不能只展示第一轮的有利百分比。

compact 的首个通过位置 227 / 40 对比 none 的 56 / 117，同样出现方向相反的结果。第三轮对照未齐，不比较三组不等样本的均值，更不从同一题上的这些重复推广到跨项目记忆效果。

### 2. 收尾开销是更一致的现象

两个已完成的 none 在首次通过之后又执行 24 / 31 次工具；compact 为 160 / 60；两个未中断的 structured 为 181 / 129，分别占总调用约 65% / 60%。这些调用也包括必要的回归测试编写、负对照和交付检查，不能全部计为浪费。

对相同源码/测试修改阶段内的完全相同命令做粗筛，七份阶段轨迹仅发现 1–5 条重复候选。Shell 临时文件还可能变化，所以候选也不等于无效执行。这说明问题不只是重复同一个命令；还包括更换命令形式继续论证、扩大检查范围、反复切换不同修复版本。单纯缓存重复命令不能解决主要开销。

### 3. 恢复后出现了有证据的交付回归

0-structured 恢复时的初始快照通过全部 300 项检查，恢复阶段第 4、62、64、119、216、265、266 次工具后的快照也通过。第 271 次却从 `/tmp/multipart_fixed.py` 复制了另一版本，最终停留在该版本；其中新增的 DATA_START 延迟逻辑在小分块空载荷下不能正常产生下一事件。

最终评分日志已出现多项失败，但整体超时，汇总数字 0/0 是没有拿到 pytest 结尾，不代表没有测试执行。额外的只读首失败诊断（本地产物：`artifacts/werkzeug-resumed-regression-audit-20260907/pytest.txt`）在 0.80 秒内复现：每块 2 字节、标准 CRLF、空文件时 `Decoder did not yield`，结果 10 通过 / 1 失败。因此可确认存在补丁回归，不能将此样本简单归为评分基础设施问题。该诊断没有替换正式结果，也没有给模型反馈。

恢复后模型反复引用 recap 中的旧删除位置保护，将其称为 canonical fix，并对比多个临时备份；最终回复仍声称全部检查通过。这暴露了版本适用性、备份含义与验证证据管理问题。但恢复提示、已有压缩状态和模型随机性也参与其中，不能仅凭这个样本断言记忆是唯一原因。

### 下一步的受控优化

等剩余样本完成后，再单独测试以下变化：记录公开验证命令对应的源码与测试版本、明确交付检查范围、修改后重新验证而不继承旧的通过结论，以及用带证据的快照标识替代含义模糊的临时备份。旧记忆的具体补丁建议必须核对当前版本；失效建议保留为历史，不继续作为当前修复要求。

这些策略只能使用模型可见的公开复现与测试证据。宿主隐藏评分仅用于测量，不能自动挑选隐藏评分最高的补丁或告诉模型何时停止。流程优化应同时用于无记忆与结构化记忆对照，才能分清流程改进和经验继承各自的作用。旧批次保持原始求解策略及原始结果。


## 2026-09-07 修订：恢复 Plan 接入与公开验证版本记录

English revision: the unbudgeted solo shortcut bypassed planner-installed Working Plan tools. The revised runner restores advisory planning without adding a turn ceiling, enables Bash pipefail, and retains version-scoped public command observations outside the workspace. A new one-repeat-per-arm pilot reuses the exact frozen memories and task; it is separate from the interrupted cohort. Hidden grading never controls execution or selects a patch.

代码核对修正了先前“项目缺少收尾机制”的表述。项目已有 Working Plan 的持久清单、可选隔离审查，以及 required ReviewPlan 的验收门禁。实际问题是 [Runtime 无总预算分支](../../apps/runtime/src/framework/runtimeKernel.ts)直接进入 AgentLoop，绕过了注册 Plan 工具的步骤。现在该分支同样安装原有 Working Plan 工具，继续使用 Journal 与动态计划上下文；普通 Plan 仍为自报进度，不把 done 当作验证证明。无总预算直达路径没有 required 模式所需的执行 broker，因此对该组合明确报错；本实验只使用 optional，未启用强制验收，也未重新添加总预算。

[公开验证记录](../../apps/runtime/src/evaluation/recap/publicVerification.ts)保存完整命令、模型提供的检查标签、真实退出码，以及命令前后源码、测试和列明配置文件的摘要。文件变化后增加版本代数；恢复到过去相同字节也不复活旧检查。记录保存在模型工作区外的本次 Session home，重新打开时恢复；每次模型请求提供最近五条检查及其是否仍对应当前版本，因此不依赖压缩摘要记住通过结论。命令与标签为低信任内容，退出 0 只表示命令成功，不证明覆盖率或任务正确；临时文件、环境及命令内改动后又撤回的中间状态不在证明范围内。

[仓库工具](../../apps/runtime/src/evaluation/recap/repositoryTool.ts)启用 Bash `pipefail`，修复 `pytest ... | tail` 可能掩盖失败的问题。工具额外支持可选 `check` 标签，引导把验证与编辑分开执行。公开记录仅反映模型自己运行的命令；宿主 300 项隐藏评分仍在任务结束之后进行。

旧批次当前为 7 个结算、1 个执行到 79 次仓库调用后中止、1 个未开始。新批次通过[修订准备入口](../../apps/runtime/src/evaluation/recap/partitionRevision.ts)从原始基线重跑 none / compact / structured 各一次，保持记忆、题面和评分相同，不重新提炼。此次同时修复 Plan 接入与验证流程，因此只能探索整体修订效果，不能据此分离各项修复的独立因果贡献。`toolCalls` 保持仓库调用口径，新增 `totalToolCalls` 包含 Plan 操作；完整 Provider usage 还包括压缩和可选审查。

无模型测试覆盖 Plan 工具可用与持久上下文、预算显式生效、严格模式不能退化为咨询模式、检查在修改/恢复/重启后失效及仓库调用与总调用分别计数。真实离线容器验证（本地产物：`artifacts/werkzeug-public-verification-integration-20260907-r2/integration.json`）确认失败 pytest 管道退出 1、成功退出 0、恢复文件使旧检查失效。此前一次容器测试因 Docker 引擎未启动未能执行；本地日志显示残留 dockerInference 通信文件阻止启动，保留改名旧 run 目录后引擎恢复，未重置镜像、容器或卷。


修订运行记录：正式三组批次（本地产物：`artifacts/werkzeug-partition-minimax-20260907-revision-2/amendment.json`）。第一次修订启动没有继承本地 Token Plan 环境文件，三个配置均在本地凭据检查阶段退出，没有进入 Provider；该批次目录保留，不算解题结果。运行器已增加派发前凭据检查，并在基础设施失败时暂停队列；评分也兼容完全没有公开事件文件的启动失败。

正式批次首个 none 在两个 Provider 尝试后返回 `PROVIDER_UNAVAILABLE`，零仓库调用，输入/输出 usage 未返回，不能声称该远端尝试费用为零；compact 随后已经实际运行，manifest 确认六个工具（repo_shell 与五个 Plan 工具）可见。按有限补试规则（本地产物：`artifacts/werkzeug-partition-minimax-20260907-revision-2/retry-policy.json`），只有原队列三个配置全部结算后，才对零工具调用的临时服务失败各补一次；操作中止或队列不完整时不补试。补试沿用同一冻结实现，不向模型反馈隐藏评分，单独存储旧尝试和有效视图。当前尚无修订后的完整三组成绩，不宣称调用量下降。
