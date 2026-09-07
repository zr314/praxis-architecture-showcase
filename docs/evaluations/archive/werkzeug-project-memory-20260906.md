# Werkzeug 跨版本项目经验实验

> 公开快照说明：下文标注的本地产物保存在独立评测环境，未随此仓库分发。Local evaluation artifacts referenced below are not included in this public source snapshot.

日期：2026-09-06。English summary: a single real-repository maintenance case using MiniMax M3, offline Docker workspaces, frozen historical experience, and independent byte-level grading. Extraction failures are retained separately from code-repair outcomes. This report records a case study, not a public benchmark score or evidence of general learning.

## 状态与范围

本批已人工中止并暂停剩余运行，尚无有效的组间比较。九个预注册配置为 none / compact / structured 各三次；compact 的唯一提炼调用失败，因此对应三次目标记为 `extraction_error`，不通过重试替换。第一条 none 运行约 91.5 分钟、540 次主循环模型请求后仍未结束，记为 `operator_aborted`；另两条 none 和三条 structured 未启动。主张范围仅为同一个 multipart 子系统中，经历一次诊断与版本验证后，下一次修复是否减少探索。

| 阶段或组 | 已有结果 |
| --- | --- |
| A 历史调查 | 完成，原版源码未修改 |
| compact | 一次提炼失败，三个目标配置阻塞 |
| structured | 记忆生成成功，三个目标尚未执行 |
| none | 首条人工中止，另两条未执行 |

这不是 none 的 0/3 正确率，也不是 structured 的成功结果；中止样本与未执行样本不能伪装成完整对照。

协议和选型见 [Werkzeug 外部仓库案例](../../research/external-repository-selection.md)。预注册配置（本地产物：`artifacts/werkzeug-memory-minimax-20260906/preregistered.json`） 保存模型、源码版本、实现哈希、镜像 ID、题面和运行次序。MiniMax M3 沿用已有 Token Plan 凭据；不使用其他提供商。

## 历史来源与冻结

A 在官方 3.1.4 上调查上传末尾 CR 字节丢失，并通过只读的官方 3.1.5 验证升级。实际 33 轮、32 次工具调用，约 192 秒；模型仅新增 `tests/sansio/test_repro_trailing_cr.py`，没有修改源代码。所有 B 都使用相同官方 3.1.5，既不继承这个测试文件，也不继承其他组的补丁。

模型输入 50548、输出 7710、缓存读取 216833 Token。它是共同的历史工作成本，不计入各组的目标修复成本，但必须单列。跨任务提炼只读取公开 user / assistant / tool 轨迹，不读取私有 reasoning、B 题面或隐藏验收。

- compact：一次提炼失败，耗时约 5 秒；该次错误记录没有保存具体异常原因和 usage，不能进一步确定是传输、格式还是长度问题，也不能把缺失 usage 算作零费用。
- structured：生成 15 条笔记，提炼输入 27735、输出 2400、缓存读取 128 Token。2400 Token 的注入上限实际选中前 10 条、保守估计 2386 Token，遗漏后 5 条。完整元数据保留适用和失效条件。
- 记忆质量存在问题：`n2` 声称旧版两个尾部 CR 时正确，和同一历史中新增回归测试的两个失败结果矛盾；后面的 `n10` 反而记录了两个失败，但它未被选中。这里保持原始生成结果，不在运行中人工修正。

## 独立验收

每个代理只访问自己的完整源码副本。Shell 在无网络容器运行，不挂载宿主凭据、评分代码、未来 release 或其他组产物；A 另有只读升级参考，B 没有。目标结束后移除容器，再把修改后的 `src` 复制进新容器，用宿主保存的检查和原版上游测试评分。模型改写测试文件不影响评分。

正式检查共 226 项可执行检查，另有 1 个明确 skip，覆盖 Request 上传、底层 decoder 的分块、合法 CR/LF、多个 part、空字段、历史 A 回归，以及原版 `test_multipart.py` 与 `test_formparser.py`。在 3.1.5 上 79 项失败，在 3.1.7 上全部通过；只替换 3.1.5 中的上游 multipart 修复也全部通过。错误的统一 lstrip 补丁有 74 项失败。交叉验证记录（本地产物：`artifacts/werkzeug-oracle-audit-20260906/results.json`）

扩大预检中发现 3.1.7 本身也无法通过 12 个额外变体，已在首个模型调用前从此特定修复的主验收范围中排除，原失败保留在 扩大预检（本地产物：`artifacts/werkzeug-preflight-20260906/preflight.json`）。不把官方修复也解决不了的附加问题默认为本次任务要求。

## 成本与解释规则

中止运行的完整最终 usage 未来得及由 Runtime 输出，费用未知。540 是主循环请求 manifest 数，另有 88 次压缩；不能把它当成所有 Provider 请求的完整计费账单。原始 Session 数据库、公开轨迹、压缩检查点和最终代码均保留在 中止记录（本地产物：`artifacts/werkzeug-memory-minimax-20260906/0-none.json`） 指向的试验目录中。

全部配置和目标结果保存在实验目录的 `results.json`；运行 `node evals/werkzeug/analyze.mjs artifacts/werkzeug-memory-minimax-20260906` 生成 `analysis.json`。输入加输出是 Provider 原始 Token 口径，不是金额，缓存读取单列。每次目标的首次使用口径为该次执行加一次对应提炼成本；三个随机重复不是三个真实业务任务，不能用它们摊薄提炼费用。

同时看独立正确性、请求数、工具调用和实际探索轨迹。失败修复不能凭较少 Token 胜出。三个重复不足以声称显著性；同一小补丁案例不足以声称跨项目迁移或长期持续学习。

## 实现验证

已完成 TypeScript 类型检查；原 recap / mechanism 相关 12 项测试通过；新增的中断保留、断点续跑、基线变化、路径链接隔离与安全异常记录测试 3 项通过；文档合同检查 3 项通过。没有新增总体轮次、工具数、Token 或任务时长上限；单个容器命令使用 180 秒进程看门狗。

## 中止诊断与后续修正

本次错误继承了小题 runner 的 32768 Token Session 上下文覆盖。仓库维护反复读取源码后发生 88 次压缩：34 次 `COMPACTION_SUMMARY_INVALID`、27 次 `PROVIDER_STREAM_INVALID`，共 61 次退回确定性摘要，另 27 次使用模型摘要。检查点中仍保留任务目标，但源码定位、修改状态和验证事实不能可靠延续；基线对 `repo_shell` 的文件操作缺少结构化识别，`modifiedFiles` 为空不代表未修改。

后续语义摘要将“应使用 read() 而不是 readinto()”的错误推断升级成 CRITICAL 待办，而原始用户复现正确地覆盖了 readinto()。末段公开轨迹又重新发现这一点，继而混淆原始症状和自己补丁引入的 BadRequestKeyError。最初只是多出 CRLF，最终补丁还改变了 DATA_START 状态推进；中止后验收未取得完整通过报告。现有证据支持“压缩后的事实漂移参与了重复探索”，不能隔离估计压缩对失败的独立因果贡献。

中止后已修正仓库实验入口：不再覆盖为 32K，而使用 Runtime 按所选模型解析的上下文容量；每个公开事件立即落盘，避免只在进程正常结束时保存；提炼及运行异常保留安全的 name / code；人工暂停的批次禁止被普通 run 命令意外续跑。这些是下一批的实现修正，尚无修正后的模型结果。原批实现已冻结归档，禁止把新配置续跑结果混入本表。摘要语义可靠性问题尚未完成修复。
