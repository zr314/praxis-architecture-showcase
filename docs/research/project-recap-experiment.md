# 同项目经验继承实验

更新：2026-09-06。English summary: an opt-in project-memory pilot with frozen history, isolated Runtime sessions, deterministic grading, and shared-snapshot ablations. Smoke tests validate plumbing, not learning quality.

## 研究问题与当前范围

下一项最小研究设计见 [Werkzeug 外部仓库案例](external-repository-selection.md)：使用官方历史版本上的两次 multipart 维护问题，检验同子系统、跨上游版本的经验继承；已复现真实缺陷，尚未运行模型对照。此前的 [Praxis 选题草案](single-case-project-experience.md) 已停止采用。

在后续任务和执行预算相同的情况下，从前序项目交互提炼的经验，能否提高后续任务正确率，或在正确率不下降时减少探索与总 Token？项目约定改变时，旧经验是否反而造成错误？

代码已提供独立 `recap` 模块及 `eval:recap` 入口。它是主动运行的实验，不是默认产品后台学习；不写入现有 `memory-v1.sqlite`，也不把自动提炼结果标为 `user_explicit`。当前任务集是原创的小型文件处理任务，适合验证实验设计、观察机制和估算预算，不能替代真实仓库开发或长任务 benchmark。

## 实验组

| 组 | 跨 Session 继承内容 | 用途 |
| --- | --- | --- |
| `none` | 无，提炼 Token 为 0 | 冷启动基线 |
| `compact` | 现有语义 compaction 生成器的 portable summary | 测试同任务压缩摘要直接迁移的效果 |
| `recap` | 一个普通叙事摘要 | 普通总结基线 |
| `structured` | fact / decision / failure / open_question / constraint 原子笔记 | 每条包含适用条件、失效条件和历史 message 引用 |
| `structured-without-failure` 等 | 从同一次生成的 structured 快照中删去指定类别 | 判断保留内容的边际作用 |

`compact` 复用的是 `ProviderCompactionSummaryGenerator`，不是完整生产 CompactionService 的切点、确定性补全、裁剪和 fallback 流程。所有组在目标任务内部仍沿用相同的 Runtime compaction 行为。本实验先比较跨任务继承，尚未测量同一长任务中途压缩后的恢复质量。

所有组有相同的注入 Token 上限；只选完整笔记，元数据和外壳也计入预算。选取先于消融，删去类别后不补入其他笔记。生成器的输出上限和实际费用不同，不能把相同注入上限称为相同总费用。过长的单条摘要可能完全未注入，须检查实际 manifest 的 selectedIds / omittedIds / tokens。

## 冻结与隔离

1. 每个项目、每次重复先运行一个探索 Session，读取项目约定并产生公开交互。
2. 公开 user / assistant / tool 消息投影为 `source.json`；不复制 reasoning 和额外评分元数据，固定 message ID 和内容摘要。
3. 所有提炼器接收同一历史前缀，生成全部快照后才执行后续任务。提炼器不接收后续题面、输入或评分答案，也没有操作工具。
4. 每个目标、每个组创建独立 Runtime 进程、Session、PRAXIS_HOME 和 UUID 工作目录；输入文件相同，报告保存 workspaceDigest。v2 在题面附加相同的完整输入文件名清单和访问规则，无记忆组也能发现当前证据。v1 缺少枚举工具又未列出规则文件名，首轮 live 暴露了这一偏差；其结果不能用于经验收益对比。
5. 模型只能读取本轮列出的输入及自己的答案，只能写 `answer.json`；输入不可改写。评分答案保留在父进程。仍有内部 `plan.*` 工具，其开销一并计入；没有 Shell、MCP、联网或 Child 工具。
6. Host 只在指定工作目录装配快照；Child authority 不能设置该入口。笔记作为低信任资料，不是 system 指令或执行证明。适用和失效条件目前由模型判断，尚无语义冲突检测。
7. 后续任务互不传递结果，评分也不反馈到下一次提炼。这是冻结经验迁移，尚不是连续在线学习。

digest 检测内容变化、关联证据，不是数字签名；合法历史引用也不意味着笔记语义正确。自动提炼中的错误与过期经验正是实验要测量的对象。

## 题目选择

检查了 `D:\agent-evals\results\harbor-minimax-medium` 下 197 份 result.json：`kv-store-grpc` 8 次记录有 5 次 reward=0、2 次 reward=1、2 次异常；`mteb-leaderboard` 6 次记录有 5 次 reward=0、1 次 reward=1、无异常。reward 与异常可能重叠；跨构建、模型和配置的这些记录只用于选题，不能作为当前版本失败率。

首批抽取接口契约、榜单规则两类机制，没有照搬原题答案：

| 原创项目 | 探索阶段 | reuse 目标 | updated 目标 |
| --- | --- | --- | --- |
| `kv-contract` | schema、大小写、去重约定和以往错误 | 应用已有约定转换新输入 | 字段名改变后应用当前 schema |
| `ranking-contract` | 排名、退出条目、tie-break 和事故记录 | 对新条目计算排名 | 指标由得分改为误差后纠正方向 |

目标保留当前规则文件，none 组也有完整求解信息。记忆主要可能减少读取；简单题准确率可能出现天花板。探索阶段读取事故记录，不等于模型亲自经历失败。只有 2 个项目、4 个固定目标；重复运行只测模型波动，不能冒充更多独立题目。

后续加入真实仓库维护、不同难度、负迁移和无关经验条件。先冻结开发集的提炼规则，再用未参与调参的新任务评测。重新运行当前无记忆基线，不直接拿历史分数作对照。

## 运行

### MiniMax 扩展题型

`--case` 还可显式选择以下扩展项目；不指定 case 时仍运行原来的两个入门项目，既有命令规模不变。每个新项目有 reuse / updated 两个目标，预期答案由独立参考算法测试核验。

| case | 新实验内容 | 参考的历史题型与区别 |
| --- | --- | --- |
| `journal-recovery` | 交错事务、未提交写、校验失败、删除、checkpoint 与持久化 cutoff | 参考 db-wal-recovery 的恢复问题；不执行原题的 SQLite WAL 解密与二进制修复 |
| `shape-batching` | prompt/gen 分别对齐、分组、容量、排序和全局编号；变更对齐与容量 | 参考 llm-inference-batching-scheduler；是确定性小批次变换，不是原题成本优化成绩 |
| `log-date-windows` | 日期闭区间、月界、未来记录、精确 severity、文件日期切换为 UTC 时间戳日期 | 参考 log-summary-date-ranges；使用新数据、新时区陷阱及 JSON 判分，不是原版 CSV benchmark |
| `async-cleanup` | 并发槽持有至 cleanup 结束、fail-fast 取消、drain 策略更新 | 参考 cancel-async-tasks；新事件模拟题，不执行原题 Python 实现 |
| `meeting-constraints` | 半开区间、后置缓冲、午休、偏好排序、重叠备选；更新时长与排序 | 参考 constraints-scheduling；新日历与 JSON 评分，不是原题 ICS 测评 |
| `heap-placement` | 对齐、连续空闲块、分配失败、释放合并；切换 first-fit/best-fit | 从 custom-memory-heap-crash 失败选题；堆状态模拟，不复现 C++ 崩溃 |
| `html-fragment-policy` | 片段过滤、检测与保留原始格式；更新 data 图片例外 | 从 filter-js-from-html 失败选题；输入已分词，不是完整 sanitizer |
| `closure-binding` | 词法闭包、引用捕获、可变状态、真值；更新 let 初始化方式 | 从 schemelike-metacircular-eval 失败选题；AST 求值，不是自举解释器 |
| `gcode-state` | XYZ/E 独立模式、G92、回抽与挤出、层筛选更新 | 参考 gcode-to-text 题型；新状态机，不做原题图像文字识别 |
| `byte-machine` | 字节序、符号扩展、32 位回绕、零寄存器和局部存储 | 参考 make-mips-interpreter 题型；有限指令模拟，不运行 DOOM，不声称复现旧失败原因 |

题目实现为 `evaluation/recap/transferCases.ts`、`systemsCases.ts`、`holdoutCases.ts` 和 `machineCases.ts`。这些仍是受控任务，不应将结果填写到原版 Terminal-Bench 通过表。MiniMax 运行示例（先把订阅 Key 放到本次进程的 MINIMAX_CN_API_KEY 环境变量）：

```powershell
npm run eval:recap -- --mode live --provider minimax-cn --model MiniMax-M3 --case shape-batching --repeats 1 --strategies none,extractive --output artifacts/minimax-shape-new
```

前三类扩展的 v2 pilot 运行四个基础组；v3/v4 新题对照显式选择 `none,structured,extractive`，每题重复两次。Token Plan 订阅 Key 与按量 Key 是不同资源，接入说明见 [MiniMax 官方文档](https://platform.minimaxi.com/docs/token-plan/quickstart)。

### 原文证据摘录对照（当前提炼器 extractive-v3）

上一轮发现叙事大笔记超预算后整组注入为空，也发现助手在探索阶段自行算错日期，摘要继续保留。新增 `extractive` 用模型选择成功 read 原文里的短候选，Host 按 ID 回填原文，按模型选择顺序装入实际 tokenizer 预算。原策略保持可用，旧结果不重写。extractive 不截断大段文字、不自动重试补写；超长单元跳过，候选为空或选择非法记失败。

v3 的 candidateId + kind 提交遇到类别/数量不合规，异步题也暴露 end 字段歧义。v4 明确取消时 end 为取消时间，并将 extractive-v2 输出缩小为 1..8 个候选 ID：模型只选和排序，Host 保存原文，kind 固定 fact。该提炼器只接收候选原文，不接收助手回答；显式 write/edit 路径的读回也被过滤。旧批次保留，不用复验替换失败。

这同时改变证据来源、生成方式和粒度，是组合策略对照，不能将收益单独归因于某一项。它保留读到的规则与记录，舍弃仅存在于助手回答中的推导；也可能漏掉真正有价值的助手经验。引用不保证真实，源文件中的错误和过期规则仍可能被保留。路径过滤只覆盖公开历史中显式 write/edit 的路径，不是通用污点追踪。没有检索、自动版本失效、事实验证或产品数据库写入。

```powershell
npm run eval:recap -- --mode live --provider minimax-cn --model MiniMax-M3 --case async-cleanup --strategies none,structured,extractive --repeats 2 --max-turns 16 --max-tokens 128000 --timeout-ms 180000 --output artifacts/recap-v4-async-new
```

v3 trial 新增 exposure：实际模型请求数、携带记忆请求数、首请求记忆 Token、manifest 与实际消息 digest 是否一致。必须将未注入的实验组单独说明；暴露计数不是正确率。主指标仍为完成且 JSON 全匹配，次指标为工具调用、执行与一次性提炼 usage。重复采样反映随机波动，不扩大独立任务数。

已完成的 [v3/v4 新题复验](../evaluations/archive/project-recap-extractive-20260906.md)保留两批共 48 个目标配置。v4 extractive 6/8、none 5/8，structured 4/8（另四个目标被提炼失败阻断）。摘录组八个目标都实际注入，异步题受益、更新排程题出现反例，工具调用没有减少；这仍是开发样本，不能声称稳定准确率或总效率提升。

随后[冻结策略的新错题型扩展](../evaluations/archive/project-recap-frozen-expansion-20260906.md)增加堆分配、HTML 片段和闭包求值，固定 extractive-v2，仅比较 none/extractive。24 个目标全部结算，结果 8/12 对 6/12；配对 4 胜、2 负、6 平，改善集中在闭包题。两组各一次达到轮次上限，提炼无失败，未显示整体 Token 节省。

[取消执行预算后的 v5 扩展](../evaluations/archive/project-recap-unlimited-20260906.md)重跑旧三类题并加入 G-code/字节序，共 40 个配置。none 9/20、extractive-v2 10/20，配对 4 胜、3 负、13 平；共同完成的 18 对中记忆组 Token 和工具调用更多。一次提炼因返回 16 个候选超过 8 条上限而阻塞两个目标。

该冻结批次结束后，extractive-v3 移除固定 8 条选择门槛，允许选择实际候选集的任意非空唯一子集（候选集现有上界 256），并把 extractive 快照容量与候选集对齐。实际 Token 装配继续选择完整笔记，省略项逐条记录。未知/重复 ID、额外字段仍失败；structured 的 32 条合同不变。用原始 16-ID 失败提交零模型调用回放，16 条笔记验证通过，注入 11 条/1475 Token、显式省略 5 条。此修复没有回填旧成绩，v3 端到端准确率还未独立 live 对照。

### 通用入口

在仓库根目录安装依赖后执行。实验从源码启动，不依赖已安装 CLI 或旧 dist；不自动加载外部测评目录的 `.env`。

```powershell
# 无付费调用：真实 Runtime / Tool / Session 链路，Mock 提供固定响应。
npm run eval:recap -- --mode smoke --output artifacts/recap-smoke --omit failure

# 先按 Provider 配置文档设置环境变量，替换 provider-id/model-id。
# 输出目录必须不存在，防止覆盖实验。
npm run eval:recap -- --mode live --provider provider-id --model model-id --case kv-contract --repeats 1 --output artifacts/recap-live-pilot --omit failure

# 两个项目、各三次重复，默认四组加一个 failure 消融组。
npm run eval:recap -- --mode live --provider provider-id --model model-id --repeats 3 --output artifacts/recap-live-repeated --omit failure
```

v5 CLI 默认 `--budget-mode unlimited`：不设置轮次、工具次数、累计 Token、执行/提炼超时、父进程 watchdog 或 RPC 请求定时器。保留 1500 Token 记忆注入上限、上下文窗口和单次模型输出上限；这些控制上下文与响应大小，不终止累计执行。`manifest.executionLimits=null` 表示无执行预算，`options` 中旧数值只是 bounded 模式备用值。程序化调用为兼容旧实验，须显式设置 `unlimited:true`。

实现使用可信 Host 的 `unbudgetedSoloRuns` 选项，仅对没有显式预算/截止时间的本地 solo prompt 生效，不传给 Child。无预算 solo 直接执行 AgentLoop，保留 Session 日志、提示词、压缩、工具权限和终态事件；不进入要求有限预算的统一 Workflow 包装层。普通产品入口仍保持默认预算，显式预算仍生效。manifest 记录 `executionRoute`，所以 v4/v5 的绝对分数变化不能只归因于取消轮次限制；同一 v5 内 none/extractive 使用相同路线。

复现旧预算时显式使用 `--budget-mode bounded --max-turns 16 --max-tokens 128000 --timeout-ms 180000`；bounded 未指定数值时沿用 12 turns、24 tool calls、64000 累计 Token、120000ms。unlimited 与限制参数同时出现会报错，避免参数被静默忽略。提炼独立计账。一项目一次重复、四组包含 1 个探索 Session、3 次提炼、8 个目标 Session；加消融后为 10 个目标 Session。Session 数不是模型请求数。

不自动重试整场实验，不回退另一 Provider。提炼失败保留已知 usage、校验原因和公开提交候选；目标失败继续保存结果；探索失败停止并保留证据。结果逐次原子替换，尚不支持批次自动断点续跑。live 答案错误可正常退出，基础设施失败返回非零；smoke 答案错误也返回非零。消费结果始终检查 status 和 passed。

## 固定历史与操作经验机制实验

`eval:memory-mechanism` 用两个原创新代码任务检验旧实验中的混杂因素：heap-program 修复释放后的空闲块合并，gcode-program 修复 XYZ/E 模式混用。它们是预置缺陷修复，不能描述成模型自己首次生成了错误。Host 先执行公开回归，再让模型检查、修复、重测，最后独立复验并附带公开回执。

所有历史与快照在任何目标运行前冻结。主要组为 none、rules、procedure_a、irrelevant；同源独立提炼的 procedure_b 是额外探针。每组同一快照重复三次，共 24 个主要目标和 6 个探针目标，只有两个独立项目。A/B 都是触发条件→行动→检查的操作经验；每条引用历史验证，不把历史测试通过当作泛化保证。

各组都能读相同规则和公开旧回归，用 write 写 `solution.js`，用 evaluate 执行纯同步 `solve(input, policy)`。当前输入与策略改变，最终由 Host 对公开回归与三组目标检查整体评分；目标隐藏答案不发送给模型。由此可以排查此前手工状态追踪/算数错误，但不能把新旧两批差值单独归因于记忆。

记忆以 compact 格式注入，完整证据仍保存在快照；四个记忆组同为 1200 估计 Token 上限，rules 与操作经验实际长度未严格相等。无关档案文字按 A 的渲染字节/本地 tokenizer 对齐，不保证厂商实际 Token 完全相等。目标工作目录用不透明标识，三次重复做部分顺序轮换；没有模型 seed 控制。

```powershell
npm run eval:memory-mechanism -- --output artifacts/memory-mechanism-new --provider minimax-cn --model MiniMax-M3 --repeats 3 --concurrency 2
```

可用 `--phase prepare` 只完成学习、提炼、冻结；`--phase run --output <已冻结目录>` 运行目标并跳过已结算行，不覆盖中断目录。preregistered.json 保存协议与源码哈希，source/ 保存相关实现副本，prepared.json/frozen.json 固定历史和快照。修改实现必须另开批次；不以反复重试覆盖失败。

无 Run 轮次、工具次数、累计 Token 或截止时间限制。单个程序测试保留 10 秒计算看门狗：这是用户代码求值边界，区别于取消的任务预算。程序在清除 Provider 凭据的子进程运行，Node 权限仅允许读选定脚本和 worker，没有写入或子进程授权；VM 仅为额外隔离，不声称通用安全沙箱。学习与 A/B 提炼开销分别记录，不能只报目标成本。

## 指标与判读

[固定历史机制实验](../evaluations/archive/project-memory-mechanism-20260906.md)已完成：30 配置，21 实际执行全部通过，9 配置被两次提炼失败阻断；无记忆 6/6。只有 heap 的 A/none/rules/irrelevant 可形成完整三次配对，A/B 同项目比较无法完成。成本因项目而异，未证明稳定收益。批次结束后 procedure-v2 增加完整 JSON 围栏兼容、显式逐条验证引用提示和失败原文记录，仅做离线验证，旧分数不变。

- **正确率**：固定 JSON grader 做结构比较，多余字段也不算正确。必须同时 `status=completed` 与答案匹配，不采用模型自报成功。
- **效率**：执行 input/output Token、缓存 Token、costUsd（Provider 返回时）、工具尝试次数、重复参数 read 次数和墙钟时间。重复 read 未必无用；墙钟包含进程启动，也受缓存和服务端负载影响。
- **完整成本**：`learningEpisodes` 记录共同探索；每组 summary 将每次探索对应的提炼只算一次，再加目标执行。消融与 structured 共享真实调用，但各组独立预算评估均包含提炼；不能把各组 summary 相加当实际账单。未知费用为 null，不当成 0。
- **配对结果**：`paired` 按项目、目标、重复、输入和历史 digest 与 none 对齐，报告正确性、工具次数和执行输入 Token 差值。提炼成本另列，不能只看执行 Token 就声称总成本降低。
- **旧经验副作用**：reuse / updated 分开分析。若复用省 Token、规则更新却增错，应报告取舍。

先检查每题结果和实际笔记，再汇总。pilot 后正式比较需要更多独立项目/目标、任务层面的配对区间或 bootstrap，并预先固定主要指标。脚本不计算统计显著性，不把少数重复当作普遍结论。当前还没有 full-history 基线、检索或多轮经验更新。

## 产物与源码

- `manifest.json`：参数、suite digest、关键实现文件 digest；不是完整工作区镜像，复现还应保存 checkout 与环境。
- `learning-*/episode.json`、`source.json`、各组快照：公开交互、固定前缀、笔记引用与 usage。
- `trial-*/launch.json`、`events.json`、`episode.json`、`result.json`：单组配置、执行和评分。
- `context-manifests.jsonl`：实际注入内容 digest/count 与装配 manifest 对照，不含私有推理。
- `results.json`：完成与失败 trial、分组汇总、配对差值和共同探索开销。

源码：[数据合同](../../apps/runtime/src/recap/recap.ts)、[提炼器](../../apps/runtime/src/recap/providerRecapGenerator.ts)、[预算装配](../../apps/runtime/src/recap/recapContext.ts)、[执行器](../../apps/runtime/src/evaluation/recap/runner.ts)、[题目](../../apps/runtime/src/evaluation/recap/cases.ts)、[测试](../../test/project-recap.test.ts)。配置见[Provider 指南](../provider-setup.md)。
