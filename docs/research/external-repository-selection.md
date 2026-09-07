# 外部仓库选型：Werkzeug 连续维护案例

> 公开快照说明：下文标注的本地产物保存在独立评测环境，未随此仓库分发。Local evaluation artifacts referenced below are not included in this public source snapshot.

当前执行状态见 [复核后第二批](../evaluations/archive/werkzeug-project-memory-v2-20260906.md)。下文保留选型与第一批配置背景；新批次统一 4096 记忆注入上限，并使用所选模型的上下文容量。

新的阶段分析和后续本地题目见 [分块不变性案例](project-experience-partition.md)：区分首次合格源码与修复后的交付开销，后续题目已启动独立 MiniMax 对照。

日期：2026-09-06。English summary: Werkzeug is selected for a single-case study of experience transfer across upstream releases. Two historical multipart defects were reproduced on pristine release sources. This is feasibility evidence, not a model-memory result; HTTPX and SQLGlot remain unverified alternatives.

## 选型结论

选用 [pallets/werkzeug](https://github.com/pallets/werkzeug)，替代先前的 [Praxis 案例草案](single-case-project-experience.md)。研究问题保持不变：做过一次项目维护后，recap / compact 保留的经验，能否让下一次维护少走弯路并保持正确。

| 仓库 | 网上查到的相关工作 | 适合之处 | 局限与当前证据 |
| --- | --- | --- | --- |
| Werkzeug，首选 | multipart 文件内容的连续回归：[#3077](https://github.com/pallets/werkzeug/issues/3077) → [#3088](https://github.com/pallets/werkzeug/issues/3088) | 同一真实系统中的不同边界条件；可以逐字节验收；本地探针不依赖网络服务 | 已在官方版本复现；两个问题都在同一子系统，后一个补丁较小，可能出现无记忆组也很快完成的情况 |
| HTTPX，备选 | [上传文件回卷 #2065](https://github.com/encode/httpx/pull/2065)、[流式 multipart #2382](https://github.com/encode/httpx/pull/2382) | 上传、流生命周期与重放语义能够产生可复用的项目经验 | 这是相关维护候选，不是已经验证的 A/B 缺陷对；尚未本地复现 |
| SQLGlot，备选 | [DuckDB 命名参数 #3618](https://github.com/tobymao/sqlglot/issues/3618)、[操作符支持 #4199](https://github.com/tobymao/sqlglot/pull/4199)；[维护者架构说明](https://github.com/tobymao/sqlglot/blob/main/posts/onboarding.md) | tokenizer、parser、AST、generator 与方言组织提供明确的项目学习空间 | 容易混入 SQL 知识和特性支持差异；这些候选不是已验证的连续回归链，尚未本地复现 |

选择依据是历史关联、可验收性和运行成本，而不是哪个题目容易让记忆组赢。后续即使没有收益，也完整报告此案例。

## 真实历史与本地证据

上游 [#3065](https://github.com/pallets/werkzeug/issues/3065) 报告分块导致文件尾部多出 CR；随后 3.1.4 出现 [#3077](https://github.com/pallets/werkzeug/issues/3077) 的文件截短回归。[PR #3081](https://github.com/pallets/werkzeug/pull/3081) 修正部分边界处理，进入 3.1.5。之后 [#3088](https://github.com/pallets/werkzeug/issues/3088) 报告在另一种分块位置下正文开头多出 CRLF；3.1.7 的修复记录见[官方变更日志](https://werkzeug.palletsprojects.com/en/stable/changes/)。选后面两次不同故障作为 A / B。

本地用未经修改的官方源码、Python 3.12.13、MarkupSafe 3.0.3，直接调用真实 Request / MultipartDecoder，结果如下：

| 官方版本 | A：65536 字节、末尾合法 CR 的上传 | B：请求头结束后分块的 19 字节正文 | B：相同内容不分块 |
| --- | --- | --- | --- |
| 3.1.4 | 失败：收到 65535 字节 | 通过：19 字节 | 通过 |
| 3.1.5 | 通过：65536 字节 | 失败：21 字节，前面多出 CRLF | 通过 |
| 3.1.7 | 通过：65536 字节 | 通过：19 字节 | 通过 |

A 另有末尾两个 CR 的变体，版本间的通过情况一致。3.1.5 自带的 `tests/sansio/test_multipart.py` 中 21 项测试也通过；这里只执行该文件，不代表完整上游测试套件通过。已有测试通过但 B 探针失败，为后续加入针对性回归检查提供依据。

这些是同一故障机制的确定性复现，并非原报告中的浏览器、Quart 或网络抓包重放。选型探针仅抽取官方 `src` 以低成本检验可行性；正式代理任务应提供完整对应版本的仓库。

- 本地预检 JSON（本地产物：`artifacts/external-repo-selection-20260906/werkzeug-preflight.json`）：包含实际输出、三个 release commit、源码归档 SHA-256；`modelCalls = 0`。
- 预检脚本（本地产物：`artifacts/probe-werkzeug-history.py`）：可审查输入构造和逐字节判断。
- 上游测试运行记录（本地产物：`artifacts/external-repo-selection-20260906/upstream-tests.txt`）。

## 单案例实验安排

**前序经历 A：** 在 3.1.4 上调查并复现“上传文件末尾丢一个字节”，定位实现、运行相关测试、解释边界条件，并在官方 3.1.5 上验证该问题已修复。保留真实的公开工具轨迹。此阶段是诊断与版本验证经历，不宣称一定包含模型独立编写补丁；这也避免模型修 A 时顺便消除 B 后，被实验者强行换回错误代码。

**明确的版本交接：** 项目升级到官方 3.1.5，形成所有后续组相同的代码状态。因此本实验研究“跨上游版本的项目经验继承”，不把模型前序补丁作为目标输入。冻结版本、依赖、前序轨迹与记忆快照后才执行 B。

**后续维护 B：** 在 3.1.5 上调查并修复“同一个文件在某些分块方式下开头多两个字节”。三组各运行三次，共九次目标执行：

| 组 | 跨任务继承内容 |
| --- | --- |
| none | 不继承历史；拥有同样完整的当前源码、工具和问题描述 |
| compact | 从同一 A 轨迹生成的普通压缩摘要 |
| structured | 从同一 A 轨迹生成、带证据引用和适用条件的项目经验 |

提炼器看不到 B 的题面、测试或修复。可复用内容由真实 A 轨迹产生，例如请求解析入口、定位方法、可运行的测试命令、如何构造分块输入和验证字节保真；不手写 B 答案进记忆。组间使用相同注入上限与模型配置，沿用 MiniMax Token Plan；不重新引入人为偏紧的轮次限制。

目标工作区不得包含未来 release、修复 PR、评分代码或其他组产物。源码历史仅提供截至该版本的内容；关闭任务内联网，避免直接检索公开答案。题面提供用户症状与必要复现输入，不复制带修复提示的 issue 评论。公开缺陷可能已经出现在模型训练中，关闭联网不能消除此混杂，需要如实声明。

## 验收与解释范围

仓库 runner 与隐藏验收集已实现，入口为 `npm run eval:repository-memory`。正式验收检查 B 指定分块、相同内容不分块、多个分块位置、合法的前后 CRLF、空字段与多个 part，以及 A 回归和相关上游测试。修复必须保留原始字节，不能通过统一 strip 或只适配某个样本过关；不按参考 diff 匹配判分。

运行使用独立 Docker 容器、完整 release 源码、容器内 Shell、禁用网络，不挂载宿主凭据或其他试验。A 可只读访问官方 3.1.5 以验证升级；B 无此额外挂载。目标结束后销毁执行容器，只取修改后的 `src`，在新容器中运行宿主保存的隐藏检查与未经修改的 3.1.5 上游测试，代理改写自己的测试不会改变评分。

正式冻结前的扩大预检发现：官方 3.1.7 也无法通过逐字节分块的 11 个变体，以及七字节分块的空文件变体。首次预检（本地产物：`artifacts/werkzeug-preflight-20260906/preflight.json`） 与同目录 `broad-probes.py` 保留全部失败。这 12 个变体不纳入此次特定修复的主验收：删除逐字节参数，空文件的七字节变体显式 skip。最终预检（本地产物：`artifacts/werkzeug-preflight-20260906-v2/preflight.json`） 中 3.1.4 为 164 通过 / 62 失败，3.1.5 为 147 通过 / 79 失败，3.1.7 为 226 通过 / 0 失败，各另有 1 skip。这个范围调整发生在任何模型调用之前，不能把额外缺陷算成 B 修复失败。

本次实际配置为 MiniMax M3、三组各三次、串行循环轮换组顺序。记忆注入上限 2400 个保守估算 Token，提炼目标 1200 Token；完整注入保留适用与失效条件。没有 Run 总轮次、工具数、Token 或总时长限制；单个 Shell 命令有 180 秒进程看门狗，单次输出截取 48000 字符，容器为 2 CPU / 2 GiB。上下文窗口仍为 32768 Token，按现有 Runtime 策略压缩。提炼失败不自动重试、不替换样本，对应组记录为阻塞。

报告所有九次的独立验收、模型请求、输入/输出/缓存 Token、提炼成本、搜索读取与测试轨迹。正确率优先，在正确结果间比较成本；模型自述“用了经验”不能充当机制证明。一次目标执行的反事实成本包含一次对应提炼成本，不能把三个随机重复当成三个业务任务来摊薄提炼费用。

这一个案例只检验同一 multipart 子系统内的近距离经验迁移。两个缺陷涉及同一源码文件，不能声称跨模块迁移；一个项目前后两次工作也不足以支持一般长期学习结论。若 none 同样迅速解决，或者记忆导致错误方向，就报告无收益或负迁移，不追加人为障碍制造优势。

首批前序经历和提炼已结束，但第一条目标出现持续重复探索，已人工中止；其余目标暂停。[首批报告](../evaluations/archive/werkzeug-project-memory-20260906.md) 保留失败和原因分析，实验目录（本地产物：`artifacts/werkzeug-memory-minimax-20260906/preregistered.json`） 保留当时的 32K 配置。当前 runner 已取消仓库实验的 32K 覆盖，后续须按新实现另建批次；不能与旧批混算。尚无有效的记忆收益对照。
