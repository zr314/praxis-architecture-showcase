# 测评发现的问题与处理方法

最后更新：2026-09-06。

本页不只列“报错了什么”，还区分问题发生在哪一层。对 Agent 平台来说，同一个失败表象可能来自模型、Prompt、Praxis、测评脚本、Provider 或 Docker；归错层会得到错误修复。

最新 [Plan-and-Review 收敛修复](archive/plan-review-convergence-20260905.md)：KV 官方产物 7/7，但 blocked 后 Root 反复解释 762 轮直到额度耗尽。已修复结构化 blocked 终态、Reviewer 按条件数分配输出预算、截断诊断、失败 attempt 持久化及重试格式反馈，并纠正“Agent 参与就不可信”的过度审查提示。旧失败原文未保存，不能断言全部 INVALID 都因截断或缺 proof。本地回归不等于新的真实提分，后续复测仍待运行。

## 怎样判断责任层

本轮源码审计新增两项已复现修复：Child 通过旧 `dist` 丢失公共导出，以及工作区 A→B→A 写入被内容幂等键误去重。代码、失败断言和复验见[2026-09-06 修复记录](archive/harness-audit-fixes-20260906.md)。它们位于当前工作树，不将其冒称为已发布版本，也不改写历史题目分数。

| 层 | 常见例子 | 是否应改 Praxis 主干 |
| --- | --- | --- |
| Praxis Runtime/Workflow | 状态重复、恢复重放、权限绕过、错误终态 | 是，修合同和实现 |
| Prompt/任务合同 | 字段所有权含糊、重复规则干扰 cache | 是，修现行 Prompt/ContextPacket |
| 模型行为 | 参数 JSON 不合法、明知有工具却不用、过度调查 | 可以增加约束和恢复，但不能谎称完全消除 |
| Provider/API | 断流、429、usage 方言不同、区域端点不兼容 | Adapter/Router 应正确归类、重试和记账 |
| 测评 Harness | 分数缩放错误、结果重复计数、collector 断管 | 修测评脚本；不能算作 Praxis 能力提升 |
| 外部环境 | Docker 500、Debian 镜像 502、磁盘不足 | 记录为 invalid；不能计入任务失败或成功 |

## 已在 Praxis 主干永久修复的问题

先给维护者一张源码锚点表。它不是“文件存在就等于修复通过”，而是告诉后续读者从哪里核对实现；真实复验仍以[运行总账](run-ledger.md)和详细结果目录为准。

| 问题域 | 当前主要实现锚点 |
| --- | --- |
| AgentLoop、Tool closure、进展判断 | `apps/runtime/src/loop/index.ts`、`apps/runtime/src/loop/units.ts` |
| Child 合同与 Runtime-owned 结果 | `apps/runtime/src/subagent/contextPacket.ts`、`childResultSubmissionTool.ts`、`childRuntimeHost.ts` |
| Workflow 结果、重试、Artifact 引用 | `apps/runtime/src/workflow/workflowOrchestrator.ts`、`workflowExpandTool.ts`、`sqliteWorkflowAuthority.ts` |
| MCP 环境与进程激活 | `apps/runtime/src/extensions/mcpActivationService.ts`、`mcpStdioClient.ts`、`processActivationService.ts` |
| Canonical history 与 compaction | `apps/runtime/src/memory/compactionService.ts`、`providerCompactionSummaryGenerator.ts`、`session-db/sessionRepositoryV3.ts` |
| Prompt 稳定前缀/ContextView/默认预算 | `apps/runtime/src/prompt/contextView.ts`、`promptAssembler.ts`、`promptRegistry.ts`、`systemPromptComposer.ts` |
| Provider 错误、usage 与重试 | `apps/runtime/src/provider-router/providerRouter.ts`、`providers/openAiCompatibleProvider.ts`、`anthropicProvider.ts`、`deepSeekProvider.ts` |
| Provider capacity | `packages/core-sdk/src/workflow.ts`、`apps/runtime/src/providers/providerExecutionPolicy.ts`、`workflow/sqliteWorkflowAuthority.ts` |
| 默认 Agent Run Tree 与预算继承 | `apps/runtime/src/workflow/agentRunTreeTools.ts`、`workflowOrchestrator.ts`、`localWorkflowAgentWorker.ts` |
| 运行中 Child 取消终态 | `apps/runtime/src/workflow/agentDelegateTool.ts`、`durableWorkflowWorkerService.ts`、`workflowOrchestrator.ts` |

修复 16–18 可直接定位历史提交：`207eba2` 负责全 workspace 构建和投影去重，`816c8a3` 负责原子 retry。修复 19 位于 2026-08-22 当前 Agent Run Tree 工作树，以源码锚点和复验目录定位；在真实 commit 产生前不杜撰 hash。

### 1. 普通 Tool 错误被升级成整轮框架失败

**现象**：`read` 的 `totalLines` 计算异常、某次普通 Tool 返回错误，或者最终回答刚好越过预算边界时，整轮被判成不可恢复失败。

**根因**：Tool 层、AgentLoop 层和终态层没有完整区分“这一步失败但模型还能修正”与“Runtime 已无法继续”。

**处理**：统一 Tool closure 和错误语义；可恢复的 Tool 错误返回给模型，只有达到明确不可恢复条件才终止；最终回答阶段不再被旧的预算边界误杀。

**为什么是永久修复**：改的是 Runtime 的通用状态机，而不是给某道 benchmark 增加特判。

### 2. Provider 卡住或畸形流没有稳定分类

**现象**：Kimi 曾返回 malformed stream；网络或 SDK 的嵌套 `Undici` cause 只显示成笼统异常；长时间没有新事件时 runner 看起来像“卡住”。

**根因**：Provider Adapter 没有完整保留嵌套 cause，超时边界和可重试分类也不统一。

**处理**：保留错误因果链，统一认证、限流、网络、畸形流和超时类别；Provider Router 只对合适类别做有界重试。长等待改用可恢复的持久 Timer/Lease 语义，而不是依赖单进程无限等待。

**仍有边界**：Provider 自身长时间无响应仍会消耗墙钟；Router 能正确处理，不等于外部服务永不失败。

### 3. MCP 的已批准环境变量没有进入真实进程

**现象**：配置和授权界面显示 MCP server 有环境变量，但子进程拿不到，导致工具注册后实际调用失败。

**根因**：批准记录与 process spawn 的环境装配是两条链路。

**处理**：将批准后的最小环境快照纳入 MCP 启动合同，并在 spawn 时显式注入；未批准变量仍不透传。

### 4. Child 用自由文本报告结构化结果，父节点无法可靠消费

**现象**：Child 声称完成，但遗漏字段、伪造 `modifiedFiles`，或父节点只能从自然语言猜测结果。

**根因**：本应由 Runtime 拥有的字段交给模型自由填写，且没有强制的结构化提交入口。

**处理**：引入 Runtime-owned result submit Tool 和强制 `toolChoice`；模型只填允许的结果字段，状态、文件变化、约束和 receipt 由 Runtime 合并；父节点使用 schema、criterion 和 Artifact 引用。

**复验**：`custom-memory` checkpoint 暴露的字段伪造问题不再由模型自述决定，Workflow 结果从持久事实合成。

### 5. 重试或替换节点无法复用已成功工作

**现象**：一个下游节点失败后，替换节点又重复执行已通过的 Child，耗时、token 和副作用风险都增加。

**根因**：替换只知道旧节点失败，不知道哪些依赖 Artifact 已经有效。

**处理**：允许新节点通过 `dependencies` 和 `inputRefs` 复用旧成功结果；成功 Attempt 不重放。

### 6. 大证据列表把 Workflow 消息和上下文撑爆

**现象**：Child 返回大量文件、证据或 Artifact 时，单条消息变得巨大，压缩和恢复成本上升。

**根因**：大对象直接内嵌在 mailbox 或模型上下文。

**处理**：大结果写 Artifact；消息保留稳定 `resultRef`。证据集合用递归 manifest 分页引用，不再复制整个列表。

### 7. Compaction 在 Provider 编辑视图上计算，可能污染权威历史

**现象**：为了适配某个 Provider 而临时重排/清理过的消息，被错误当成压缩输入，恢复后可能丢字段或改变语义。

**根因**：canonical history 与 provider request view 没有清晰分层。

**处理**：checkpoint 永远从 canonical journal/history 计算；Provider 适配只生成一次性请求视图，不回写权威历史。

### 8. Compaction 可能忘掉 Child 的身份、权限和交付合同

**现象**：摘要还记得“要审计代码”，却忘了“只读、不得联网、必须输出某 sentinel”。

**根因**：所有信息都放在可压缩聊天历史中，模型摘要本身也可能遗漏硬约束。

**处理**：把签名/结构化 `ContextPacket` 放在 compactable history 之外；每轮重新装配身份、授权、目标、criteria 和结果 schema。语义 checkpoint 只负责压缩工作记忆。

### 9. 只依赖模型原生 compact，Provider 可移植性差

**现象**：不同模型 API 是否支持原生 compaction、thinking block 形态和状态恢复方式不一致。

**处理**：Praxis 提供 portable semantic checkpoint 基线；支持原生能力时可作为优化接入，但 journal 和恢复合同不依赖某一家私有状态。

### 10. Prompt 前缀不稳定，缓存命中低

**现象**：早期只有约 2%–5% 命中；每轮动态内容、重复规则和无关可信度标签插入 system 前缀，导致 Provider 认为每次都是新请求。

**根因**：稳定规则与动态运行态混装；Prompt 版本在一轮运行中可能漂移；多个来源重复表达同一权限规则。

**处理**：采用 `iron-law-lean-v1`；固定稳定前缀顺序，动态内容后置；同一 Run 冻结 `ContextView` 和 variant；压缩重复规则，移除会干扰模型且不能形成真实安全边界的“可信度分级”文本。

**复验**：DeepSeek A/B 两边都完成 5 turns/4 reads。排除冷热启动误差后，lean 的后续轮次 cache 比例与 baseline 接近，累计输入从 20,651 降到 19,210（少 6.98%）。因此优化价值主要是更短输入和更稳定前缀，不是把一次 70% 与 78.7% 粗暴解释为退步。

### 11. Tool 参数错误产生长篇诊断并污染后续上下文

**现象**：模型传错 `workflow.expand` JSON 后，大段 schema/堆栈反复进入对话，进一步降低下一次调用成功率。

**处理**：Tool 错误返回有界、结构化、可操作的诊断；保留关键字段和错误码，裁掉重复堆栈。

### 12. Provider usage 方言导致 token 与 cache 记账错误

**现象**：不同 API 把 usage 放在 start、delta 或不同兼容字段；早期零占位可能覆盖最终真实值，造成缓存命中和预算统计失真。

**处理**：按 Provider 方言解析，在合法候选中取一致的最终/最大累计值；运行汇总只使用 Runtime terminal aggregate，避免父子事件再累加。

### 13. 长任务的人为上限过紧

**现象**：6 分钟墙钟、48 turns、160 Tool calls 会在复杂编译、DAG 和恢复任务尚有进展时强行终止。

**处理**：从 Praxis 主路径取消这些隐式硬上限；显式预算仍可由用户/任务设置。Worker、Provider 和 Workflow 使用持久 Lease、重试与容量控制来限制资源，而不是假设所有任务都应在几分钟内完成。

**安全说明**：取消默认上限不等于无限制。权限、Provider capacity、显式预算、取消和运维监控仍必须存在。

### 14. LoopProgressGuard 把“长时间做有效工作”当作死循环

**现象**：旧固定计数器在编译或批量调查中触发终止，即使每轮读取的文件和错误都在变化。

**处理**：从硬终止改为 advisory 信号；最终是否停止结合状态变化、重复 fingerprint、预算和模型判断。

### 15. Provider 并发没有进入持久调度

**现象**：DAG 中多个 Child 同时 ready 时，单靠 Provider Router 的请求重试会先撞 429；进程重启后也不知道之前的并发占用。

**处理**：将 `capacityGroup + limit` 写入 Workflow Spec；SQLite Authority 在 claim 同一事务内统计 active Lease 并做准入，不同 group 隔离，多个约束取更严格 limit。

**复验**：2026-08-21 provider-aware 场景中 3 个独立 Child 均完成，容量为 2 且 Root 占 1 个名额时 Child 实际依次领取，没有 Provider rate limit。

### 16. 测评 bundle 混入旧 workspace 产物

**现象**：源码已经修复，但打出的 CLI bundle 仍包含某个 workspace 的旧 `dist`，导致测评像是在验证新代码，实际跑的是旧实现。

**根因**：打包前只构建局部 workspace。

**处理**：默认先构建全部 workspace，再生成不可变、带时间/用途标识的测评 bundle。修复落在 commit `207eba2`。

### 17. Workflow 投影事件重复洪泛

**现象**：第一次 provider-aware 运行功能完成，却生成 1,823 条投影事件，只有 12 条唯一状态，stream 达 12.86 MiB。模型收到大量重复状态，token 和墙钟急剧上升。

**根因**：相同 Workflow sequence 被多个唤醒路径反复投影，且 Prompt 尚未开始时事件也直接注入。

**处理**：按 `workflowId + runId + sequence` 去重；`prompt_started` 前的更新先排队，开始后再按顺序投影。修复落在 commit `207eba2`。

**复验**：同题 v3 只有 12/12 唯一投影，stream 633,555 bytes，3 个 Child 和 Root 全部成功。

### 18. 可重试 Child 失败与 quorum 判断发生竞态

**现象**：Child 的 Lease 过期后，系统先把 attempt 标记失败；quorum 可能在替代 attempt 创建前观察到“失败数过多”，提前结束整个 Workflow。

**根因**：结束旧 attempt 与创建新 attempt 不是同一个 Authority 事务。

**处理**：在 Authority 内原子完成“关闭失败 attempt + 创建/调度 retry attempt + 更新 Task 投影”，quorum 只能看到事务前或事务后的完整状态。修复落在 commit `816c8a3`。

### 19. 默认 `agent.spawn` 让模型猜累计资源预算

**现象**：2026-08-22 的受控 Run Tree 审计中，MiniMax 为两个只读 Child 都主动填写 `maxTokens=12000`；两个 Child 在首轮分别以 `CHILD_CREDENTIAL_BUDGET_EXCEEDED` 失败。Root 仍能读取错误、等待全部终态并独立完成，所以失败隔离没有问题，但默认 Child 实际不可用。

**根因**：模型通常把 `maxTokens` 理解成单轮最大输出，Praxis 的 credential broker 则按整个 Child 生命周期累计 Provider input+output 扣减。复杂 system/context 首轮就可能超过 12k。Credential broker 的 fail-closed 计算正确；错误在于默认自主 Run Tree 暴露了模型无法可靠估计的数值成本控制面。

**处理**：从默认 `agent.spawn` schema 和 proposal 中移除 per-Child token、turn、Tool-call、wall-clock 数字。Child 继承父 Run、组织策略和 Runtime capacity；需要确定业务预算的显式 `workflow` 节点继续支持这些字段。测试覆盖 ToolRuntime schema 不再暴露字段，且直接执行携带旧 `maxTokens=1` 也不会污染持久 Child budget。

**复验**：同题 `2026-08-22__03-12-15__run-tree-architecture-audit-coordinated` 中两个真实 Child 均成功，Root 使用 `agent.wait(all)` 和 `agent.result` 消费结果；Root、两个 Child 与 Workflow 全部终态成功。

### 20. 正在运行的 Child 被取消后却显示为 failed

**现象**：动态改计划实验中，`agent.cancel` 确实中止了 Provider 请求；Child 结果 Artifact 内部也是 `status: cancelled`、`category: cancellation`、`code: CHILD_PARENT_CANCELLED`。但是 Workflow projection 和 `agent.result` 却把同一个节点显示成 `failed`。这会污染失败率、告警和上层决策：主动放弃旧路线不等于执行出错。

**根因**：Child Runtime 的三态结果（`succeeded / failed / cancelled`）进入通用 Workflow 完成接口时被压成一个布尔值 `ok`。Authority 只看 `ok=false`，无法区分失败和取消，所以把运行中取消统一提交成 `failed`。尚未领取的 Child 由 `cancelNodes` 直接提交为 `cancelled`，因此旧单元测试没有覆盖这个差异。

**处理**：Worker 结果增加显式 `cancelled` 终态意图，并从 Local Worker、Durable Worker、直接 delegate、handoff、subworkflow 和 durable scheduler 一路传到统一 `WorkflowOrchestrator.complete`。完成事务现在把 Node/Attempt 提交为 `cancelled`，保留原错误码，不为取消安排 retry；如果被取消的是 Root，Workflow 也进入 `cancelled`。Task 队列仍以失败式 acknowledgement 释放 Lease，这是内部队列结算，不改变业务节点终态。

**为什么是永久修复**：修改的是所有 Workflow Agent 完成共享的状态合同，不依赖 `CHILD_PARENT_CANCELLED` 字符串，也不是在展示层把 `failed` 改名。

**复验**：专项类型检查、Biome 和 12 个 Run Tree/调度测试通过。真实 MiniMax 修复前运行 `2026-08-22__13-04-07__run-tree-replan-steer-cancel` 的旧分支为 `failed`；重建 CLI 后，同题 `2026-08-22__13-12-48__run-tree-replan-steer-cancel` 明确得到 Root `succeeded`、旧 Child `cancelled`（仍保留 `CHILD_PARENT_CANCELLED`）、保留 Child `succeeded`、Workflow `completed`。

## 测评工具自身修正

这些修改保证测量有效，但**不计入 Praxis 产品能力**：

- Harness-Bench：修复分数缩放、ground-truth 路径、Kimi rubric temperature 回退、adapter timeout 与成功判定。
- AgentDojo：每次 rollout 使用正确 state snapshot，避免前一题的邮件/文件修改污染后一题。
- Windows：统一 UTF-8，避免日志和中文 Prompt 因默认 code page 损坏。
- Harbor：修复 cache key；usage 只采用 Praxis terminal aggregate，避免把 Child 事件再加一次。
- 结果 collector：`safe_print` 处理 stdout `BrokenPipe`，外层超时后可从 SQLite/trace 生成 recovered summary。
- 恢复监控：只在状态改变时记录，避免轮询本身制造重复数据；超时后清理孤儿 runner。
- Harness-Bench HB-087：给 oracle venv 补齐 pytest；文本 fixture 完整性哈希先把 CRLF 标准化为 LF，避免 Windows checkout 被误判成模型篡改。修正只改变 evaluator，Agent sandbox 未再修改；原始误评分和 regrade 同时保留。

## 没有伪装成 Praxis 缺陷的问题

### 模型行为

- MiniMax 多次生成不符合 schema 的 `workflow.expand` 参数；cross-review 当前代表运行第 4 次才成功。Authority 只接受了 1 次图变更，所以 DAG 状态正确，但“恰好调用一次”的 Prompt 服从没有通过。
- MiniMax 在部分任务中不愿委派，或相反创建重复 DAG。Praxis 可以提供工具、schema 和恢复，不能保证模型总做出最佳组织决策。
- 新 Run Tree 审计的自主组选择 0 Child；受控组也有一次忽略“前两个动作必须 spawn”的要求。成功复验最终又能严格先 spawn 两次，说明这里存在模型 rollout 方差，不能用单次运行宣称 Prompt 已稳定控制委派。
- 修复后受控组的最终答案仍在 marker 前加前言、遗漏指定文档核对，并把 Child 自己的 read 顺序误归因成 Root 的工具顺序。Authority/stream 事实正确，错误发生在 Root 综合与格式服从层。
- 动态改计划的修复前、修复后两次运行都完成了规定的工具顺序，但最终回答仍在 `RUN_TREE_REPLAN_V1` 前增加说明文字，并把预算继承的 ADR 行号描述得过于牵强。Runtime 机器状态和 Child Artifact 正确；这是 MiniMax 的严格格式与综合质量问题。
- Harness-Bench HB-098 首次运行中 MiniMax 读取了全部来源并成功写出三份合法产物，但自拟 decision key、在 `winning_source` 后追加括号锚点，并遗漏 feature scope 的两个组成部分，oracle 为 0.5251；后续有效复验提升到 0.7371，仍只命中部分规范决策。这里没有 Tool/权限/compaction/终态异常，归为模型结构化综合不足；oracle 对 ISO 日期和带锚点来源等语义等价形式也较敏感。
- 多次 compaction 题中模型 9 次尝试被题目禁止的 `shell`，全部被 Policy 拒绝；最终在 `MULTICOMPACT_OK` 前写了前言。这说明权限边界通过、严格服从失败。
- `kv-store-grpc`、`raman-fitting`、`filter-js` 等任务是最终技术答案不正确，官方 verifier 为 0；没有证据显示是 Context 丢失。
- `db-wal-recovery`、`large-scale-vim-macro`、`gcode` 出现低效搜索或停滞，主要是模型策略问题；框架的长任务上限已经不是阻断点。
- `make-mips-interpreter` 最终有效复跑已生成存在且与参考相似的首帧，但 stdout 缺少 verifier 实现要求的精确初始化文本，3 项只过 2 项。逐字题面只说启动 DOOM、保存帧并检查首帧，没有公开这段 exact stdout，因此 raw reward 仍记 0，同时把隐藏评分条件与模型公开合同分开；Runtime 正常完成 487 turns / 486 tools 与 9 次 compaction，不再标成外部 INVALID 或 Praxis 中断。

### Provider 与外部环境

- Kimi malformed stream 是 Provider 响应无效；Praxis 的责任是正确归类和终止/重试，不是修复服务端。
- MiniMax 额度耗尽和 429 会使新任务无法完成；Provider-aware admission 能降低并发撞限，不能增加账户额度。
- Debian 镜像 502、Docker Desktop API 500、镜像拉取 JSON 截断属于 invalid rollout，不计入任务通过率。
- Terminal-Bench 容器中的网络、包源和编译速度会显著影响 wall-clock；因此时间指标只在相同环境下比较。

### 21. Harness-Bench 多轮 session 没有续接 Praxis 内部 session

**现象**：`007-session-memory` 第一轮保存的信息在第二轮像是消失，初始得分只有 0.25；多个 resume/replan 题也有不自然的跨轮退化。

**根因**：Harness-Bench 提供的是外部 session 标识，而 Praxis CLI 恢复需要内部 `s-...` session id。旧 adapter 每一轮都重新传 `--provider/--model/--planner`，实际创建了新 session。共享 workspace 偶尔能掩盖问题，但不是真正的会话续接。

**处理**：`D:\agent-evals\adapters\praxis-runner.mjs` 在首轮 stdout 中提取 Praxis session id，按 Harness 外部 session id 写入隔离 `PRAXIS_HOME/harness-session-map.json`；后续轮次改传 `--session <s-...>`。同时把 stdout/stderr 捕获缓冲提高到 64 MiB，避免长 stream 被默认 buffer 截断。

**复验**：`007-session-memory` 从 0.25 到 1.0；`105-partial-batch-resume-ledger` 从 0.74 到 0.9175；`103-policy-update-replan-diff` 从 0.92 到 0.964；`057-interruption-resume` 从 0.9231 到 1.0。该问题属于评测集成，不是 Praxis 主干 session journal 的存储缺陷。

### 22. 高并发限流与总额度耗尽容易混淆

**现象**：8 路并发时两条长任务返回 `PROVIDER_RATE_LIMITED`。如果立即停止，会把瞬时 RPM/token-rate 限制误判成总额度耗尽。

**处理**：先让所有在途任务自然结束，再用单路最小任务探测。第一次单路 13.766 秒满分，证明只是并发限流；随后降为 3 路继续完成 20 个有效任务。最终再测时，单路任务 5.124 秒失败；直接 CLI 在 0 turns、0 tools、0 tokens 时明确返回 `terminalCode=PROVIDER_RATE_LIMITED`，才停止本轮。

**结论**：Provider-aware admission 可以控制 Praxis 自己发出的并发，但 benchmark 外层同时启动多个独立 Praxis 进程时仍需全局限流器。账户额度或计划窗口耗尽则无法由 Runtime 消除，只能正确分类、停止重试并等待 Provider 恢复。

### 23. Adapter 失败结果没有保留 Praxis terminal 文本

**现象**：额度临界的 `079/080` 在 Harness 结果中只有 `returncode=1`，`adapter_result.stdout` 被 usage collector 的 `missing responses/` 占据；精确的 Praxis terminal code 没进入结果 JSON。

**影响**：oracle 仍可评价已写出的产物（`080` 甚至为 1.0），但无法只看结果 JSON 区分 Provider 限流、Runtime 错误与超时。

**当前处理**：用隔离 `PRAXIS_HOME` 的直接 CLI 探针取得 `PROVIDER_RATE_LIMITED`，并把两条标为 `INVALID`，没有把产物分数冒充完整 rollout。后续应让 Harness adapter 同时保存原始 Praxis stdout/stderr 与 usage collector 输出，而不是共用一个 stdout 字段。

## 2026-08-23 新发现与修正

### 24. 默认 system Prompt 预算容不下真实 Windows 路径

**现象**：为 `041-frontend-state-bug` 做 `baseline-v1` A/B 时，任务没有产生任何 Provider turn、Tool 或 token，Runtime 直接返回 `PROMPT_BUDGET_TOO_SMALL`。表面上很像额度还没恢复，但直接 trace 显示失败发生在 Prompt composer。

**根因**：RuntimeKernel 写死的默认 system Prompt 预算只有 1,536 个估算 token。baseline 会把 cwd、platform、shell 和工作区事实写进可信指令；Harness 的 Windows sandbox 绝对路径很长，完整必需 Prompt 超出预算。这个预算限制的是 Prompt 装配，不是模型 context window。

**处理**：把默认值提升为 4,096，并集中到 `promptRegistry.ts` 的 `DEFAULT_SYSTEM_PROMPT_TOKEN_BUDGET`。RuntimeKernel 与测试只引用这一常量，以后不再到多个调用点同步改数字。预算仍 fail closed：必需 policy 真装不下时不会静默裁掉安全合同。

**复验**：使用现实长度 Windows 路径构造 baseline/lean；两者均低于统一预算，Prompt 仍恰好一个可信 block。真实 baseline rollout 随后成功进入 MiniMax、完成 11 turns 并交给 oracle。专项 Prompt 测试 12/12、全 workspace build 通过。

### 25. lean Prompt 没告诉模型实际 Windows shell 方言

**现象**：`079` 中模型使用 `&&`、`$(pwd)`、`head`；`078` 中使用 Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8`，给 JSON/CSV 写入 BOM。Tool 正确返回错误或成功，Runtime 没有执行错命令，但模型浪费轮次，最终精确产物失败。

**根因**：lean `runtime_facts` 过去只写 `shell: powershell`。对经常在 Linux 训练环境中工作的模型，这不足以明确 PowerShell 5.1 的分隔符、不可用 POSIX 语法和 BOM 行为。baseline 有部分文字说明，两个 variant 的环境事实也不一致。

**处理**：在中性的 `runtime_facts.workspace.shellDialect` 中提供版本语义、命令分隔符、不可用语法、多行 stdin 和 UTF-8 no-BOM 写入建议；POSIX 也有对应事实。它是当前执行环境的数据，不是额外安全层，也不改变 Tool 权限。

**边界**：Prompt 事实不能机械禁止模型使用 `Set-Content`。本轮 `078` 说明精确编码若是高价值合同，最终应由 write/edit、typed output 或 artifact verifier 强制检查；不要无限叠加 shell 教程。

### 26. 模型用自写测试替代用户验收条件

**现象**：`041` 的模型自测明确断言优惠券不改变 subtotal，与用户要求相反；`078` 多次重跑覆盖重试证据；`079` 只验证文件存在/哈希；`080` 第一轮产物正确但漏 conflict report。

**根因**：通用执行合同只说“验证结果”，没有提醒模型在多要求任务收尾时重新对照原始 acceptance criteria。模型容易把自己刚写的测试当成权威规范，出现“测试通过但答错题”。

**处理**：baseline 和 lean Prompt program 均升级到 1.1.0，追加一条通用收尾合同：重读用户验收条件，并按任务需要检查 parseability、encoding、schema、exact required headers 和 material semantics；自写测试不能重新定义结果。没有写任何 benchmark 专用字段。

**复验与限制**：`080` 复验补齐了原先遗漏的 conflict report；`041` 复验推进到另一个隐藏边界。单次 raw score 没有单调上升，因为模型 rollout 有方差、oracle 还要求题面未声明的 CSV trailing newline。结论只能是合同修正了已识别的 Prompt 缺口，不能宣称它保证所有任务正确。

### 27. 外层 benchmark timeout 会留下仍在工作的 Praxis 进程

**现象**：`078` 首次运行超过 Harness 外层 1,200 秒后，Python collector 抛出 `subprocess.TimeoutExpired`。当时 Praxis 仍有进展，已有 48 turns/50 tools 和部分产物；benchmark 没走到清理逻辑，留下两个属于该 sandbox 的进程。

**处理**：先按完整命令行和 sandbox 路径核对精确 PID，只终止这两个 orphan；复跑把**外层观察超时**调到 3,600,000，Praxis 在 531.484 秒完成。没有给 Praxis 主路径重新加入任务寿命上限。

**永久建议**：runner 应使用 job/process-group 归属和 `finally` 清理；超时结果同时保留 Praxis session/run id、SQLite/trace 和部分产物。`AgentTimeoutMs` 是测试基础设施观察窗口，不应与 Runtime 的显式用户预算混为一谈。

### 28. Oracle 的精确匹配可能误罚语义正确结果

2026-08-23 代表批次确认了四类 evaluator 风险：

- `023`：source 与 workspace fixture 字节完全一致，oracle 使用陈旧 SHA-256；
- `088`：三个 protected fixture 的 source/workspace MD5 一致，oracle 的三个硬编码 MD5 均陈旧；hidden test 还把带 endpoint/cursor 的完整 URL 当成 `base_url`，超出公开合同；
- `096`：`no_fabrication` 扫描整行禁用字符串，把“从未批准某值”的正确否定证据也当成采用该值；
- `080`：canonical CSV 内容完全一致，只缺题面未要求的文件末尾换行。

**处理原则**：原始分永远保留；另记 contract-adjusted 结论并附字节/hash/题面证据。不能为迎合错误 oracle 给 Praxis 加 task-specific workaround，也不能把调整分冒充官方分。完整证据见归档的[2026-08-23 代表性续测](archive/minimax-auto-harnessbench-20260823.md)。

### 29. Provider 未提交的半截流无法安全恢复

**现象**：`008-image-recognize` 在第 15 turn 留下未闭合 reasoning 后返回 `PROVIDER_STREAM_INVALID`；`103-policy-update-replan-diff` 则先产生部分可见文本，再返回 `PROVIDER_TRANSPORT_ERROR`。旧逻辑把前者的 reasoning 和后者的半截文本都视作“已有输出”，因而不重试，整个 run 失败。

**根因**：Runtime 没有严格区分“Provider 已吐出一些字节”和“assistant turn 已提交”。只要响应尚未完成、Tool 尚未执行，这一 turn 仍是可整体丢弃的未提交事务。

**处理**：无耐久可见输出的空流/畸形流可重试一次；未闭合 reasoning 不再阻止恢复。传输错误或畸形流即使已有部分可见文本，只要 turn 未提交且没有执行 Tool，也允许丢弃半截输出并完整重试一次；trace 记录 `discardedVisibleText`。已执行 Tool 的 turn 不使用该路径，避免重复副作用。

**复验**：真实 `008` 修复后得 1.0000，`103` 修复后得 0.934；后续 `llm-inference-batching-scheduler` 又捕获到“先输出可见半句、随后畸形结束”的 MiniMax 流，促成同一事务规则覆盖 malformed stream。新增“可见畸形流第二次恢复成功”和“连续两次畸形后按单次上限失败”的精确回归，planner + compaction 专项 58/58，TypeScript typecheck、workspace build 和 Harbor bundle 重建通过。

**剩余显示边界**：部分文本已经作为实时 `text_delta` 发给客户端后，canonical journal 不会提交它，但当前事件协议没有单独的“撤回这些 delta”事件。CLI/UI 可能短暂显示半截文本与重试结果；trace 可审计，耐久历史正确。后续客户端协议可增加 turn attempt/retraction 语义。

### 30. `read` 解码后隐藏了 UTF-8 BOM

**现象**：`022` 两次分别只有 0.2174/0.3478，`104` 旧代表分约 0.35。模型读取自己生成的 JSON 时看到正常 `{`，但 oracle 的严格 parser/字节检查仍发现文件开头有 BOM。

**根因**：文本读取层会消费 BOM 后再返回字符串，模型无法从正常正文反推出原始首字节。Prompt 的 PowerShell BOM 提示只能预防，不能完成产物验证。

**处理**：`read` 输出增加 `hasBom: boolean`，存在时摘要追加 `UTF-8 BOM detected.`；正文仍返回干净解码文本。Tool 文档、schema 和测试同步更新。这是通用文件可观察性，不是 benchmark 特判。

**复验**：相关 read/tools 测试 19 pass、1 skip。`022` 复跑到 0.8696，JSON parse、URL、计数、数据、排序和重试检查全部通过；`104` 提升到 0.8875。

### 31. 已授权结果下的无谓澄清阻塞

**现象**：Terminal-Bench `fix-git` 中，模型已经找到遗失 commit；`git merge --ff-only` 发现非 fast-forward 后，却询问用户选择 merge 还是 cherry-pick，任务没有完成，reward 0。

**根因**：旧 Prompt 强调风险和澄清，却没有把“结果授权”与“实现细节选择”分开。模型把正常、可验证的实现选择误判为必须由用户决定。

**处理**：baseline/lean 同步升级到 1.2.0：已授权具体结果时，自主选择合理、可验证、优先可逆的方法；只有结果、权限或风险会实质改变才询问；一种方法失败后先检查状态并尝试安全替代。

**复验**：同模型、同任务、同 `auto` 的下一次 rollout reward 1；Prompt 测试 20/20，静态审计通过。单题 A/B 是强相关证据，不等于跨任务因果定论。

### 32. Workflow effect 的“结果未知”制造假失败

**现象**：`cancel-async-tasks` 的 SIGINT 诊断命令和旧 Prompt `fix-git` 的 `git merge --ff-only` 非零退出，都可让 Workflow 进入 `WORKFLOW_EFFECT_OUTCOME_UNKNOWN` / failed；与此同时 Root 已收到确定的命令结果，仍能继续并最终 `prompt_completed`。

**根因**：诊断命令“明确返回非零”和有副作用命令“连接中断、不知道是否生效”不是同一种状态。旧 broker 只按 Tool 的保守 `write/process/network` 分类判断，导致任何 `process/network` 的 `ok:false` 返回都进入 `unknown`，没有利用“Tool 已经返回一个完整结果”这个提交事实。

**处理**：现在把两条路径分开：

- Tool 正常返回完整的 `ToolResult`，即使 `ok:false`，也表示结果已知。Runtime 把失败 envelope 存成 Artifact，Activity 记为 `failed` 并释放幂等 reservation；Agent 可以读取错误并恢复，Root 成功时 Workflow 可以完成。
- Tool 调用直接抛异常、没有返回结果，或结果返回后 durable receipt 无法写入，才进入 `unknown`。前者使用 `WORKFLOW_EFFECT_OUTCOME_UNKNOWN`，后者使用 `WORKFLOW_EFFECT_RECEIPT_PERSIST_FAILED`，仍禁止盲目重放不确定副作用。

这里的“failed Activity”不是把错误藏起来：非零退出码、stderr、结构化错误和 failure Artifact 都保留；只是不再把一个可恢复的工具观察错误升级成整个 Workflow 的未知提交状态。

**复验**：`workflow-effect-broker.test.ts` 7/7，覆盖返回失败、工作区失败、抛异常、幂等 replay 和 Saga receipt。修复后的 `gcode-to-text` 真实运行中有 4 个已知失败 Activity，Root 最终 `succeeded`、Workflow `completed`，46 turns / 45 tools 正常结束；旧实现会把同类 Shell 非零结果投影成 `WORKFLOW_EFFECT_OUTCOME_UNKNOWN`。

### 33. 仅靠 Prompt 提醒，模型仍会启动无边界 Shell 命令

**现象**：`gcode-to-text` 已运行到第 192 个工具调用时，模型启动 600×100 网格、每个点再遍历全部投影线段的 Python 暴力计算，没有设置 deadline。命令持续约 12 分钟，最终由 Harbor 的 30 分钟 Agent timeout 回收；本次 rollout 是 `AgentTimeoutError`，不能公平计分。第一轮只修改 Tool description 后，后续 MIPS 仍生成无界 JavaScript 调试循环，batching 又连续启动没有 `timeoutMs` 的组合搜索，证明“模型看见提醒”不等于“控制面一定有 liveness”。

**根因**：过去把两种上限混为一谈：旧的 6 分钟 Agent Run 墙钟确实不适合长任务，但这不代表一次子进程活动也应无限等待。Tool description 已明确区分探索性命令和正式长命令，模型仍可能忽略；仅靠自然语言不能形成资源回收保证。

**处理**：ShellTool description 与 `timeoutMs` schema 继续要求按复杂度选择 deadline，同时执行层为每条命令提供默认 10 分钟安全租约。调用者可以给探索命令更短的值，也可以给已知有界的构建/恢复显式更长的值。Tool policy、Runtime 文档和当前 Prompt 中文审计同步更新；没有按 benchmark 名称特判。

**为什么是永久修复**：10 分钟限制的是单条 Shell 活动，不是 Agent Run 的累计墙钟、Turn、Tool call、token 或 Child 数。Agent 收到结构化 timeout 后仍能换算法并继续；真正需要更久的有限命令可显式延长。这样同时保留长任务能力和最终可回收性。Run 取消和 timeout 都回收进程树。

**复验**：`test/tools.test.ts` 冻结新的 Tool description，并用 20 ms 自定义默认租约验证“输入不带 `timeoutMs` 也会回收”。最终专项为 23 pass、1 个 Windows 预期 skip，TypeScript typecheck 和实际 Harbor bundle 重建/冒烟通过。正式 batching v4 中一个接近 10 分钟的有限枚举在租约内自然完成并最终 reward 1，说明默认值没有误杀这次合法搜索；更长命令仍须显式延长。

### 34. 测评适配器把人为累计上限重新注入 Praxis

**现象**：Praxis v4 长生命周期策略已经不再默认限制累计 turns、Tool calls、token 和墙钟，但 Harbor/AgentDojo 适配器仍显式传入很大的 `max_turns=10000`、`max_tool_calls=100000` 和内部 timeout。数值很大也仍是隐藏终止条件，而且与主干语义不一致。

**处理**：从 Praxis 测评入口删除这些内部参数、环境变量和 CLI flags。新 Harbor 命令只选择 planner、storage、policy 与 bundle，不再注入累计 turn/tool/deadline。Praxis v4 的 `defaultBudget` 为空；只有用户或上层任务明确设置预算时才有限额。

**保留哪些边界，为什么**：Harbor 的外层 timeout 仍保留，因为它是 benchmark 的统一计时和容器回收条件，不是 Praxis 的认知生命周期上限。Provider context window、单次 inline Artifact 大小、数据库锁/Lease、Provider 请求与 compactor 的单次 deadline、有限重试和本地并发也保留；它们用于协议正确性、防重复副作用、防死锁或资源隔离。删除这些边界会把“支持长任务”变成不可恢复的挂死或数据损坏。

**兼容性**：旧 durable journal 中 v1–v3 的历史有限 profile 仍可读取和 replay，不能删除，否则恢复旧 Session 时会改变原始合同。新运行使用 v4，不继承旧默认值。

**复验**：PowerShell、Python 和 Node adapter 语法检查通过；实际新 `mteb-leaderboard` 与 `gcode-to-text` job command 均不含 `--max-turns`、`--max-tool-calls` 或 Praxis `--timeout-ms`。CLI 文档已同步为“v4 无隐式累计预算”。

### 35. 1K compaction checkpoint 容量不足以承载复杂长任务

**现象**：`llm-inference-batching-scheduler` 在 553 个 Provider turn 的压力运行中多次压缩。旧 checkpoint 约 954–1199 tokens，长题面本身占去大半空间，后续摘要逐渐丢失“全局硬约束、当前最佳候选、已验证失败路线”，模型从接近可行解退化为反复搜索，最终还写入不满足 64 对齐的结果。

**根因**：64K replay 阈值只是“什么时候压缩”的成本触发器，真正问题是摘要输出上限仅 1024 tokens。把触发阈值继续放大只会让每次请求更贵，不能保证 checkpoint 有空间保存状态。

**处理**：默认 `maxSummaryTokens` 提升到 4096。它是最大容量，不是要求每次写满；compactor 仍按“硬合同、已完成事实、最佳指标、当前路线、失败教训、未解决问题”生成紧凑 checkpoint，reasoning/thinking 临时块不进入长期状态。

**复验**：policy 回归冻结 64K 触发和 4K 容量，planner + compaction 专项 58/58。真实 `mteb-leaderboard` 在约 64K 后第一次压缩只实际生成 421 tokens、省略 62 条消息，并继续保留“截至 2025 年 8 月”的时间合同。这证明 4K 是防止复杂任务被强截断的上界，不会强迫简单任务膨胀到 4K。后续 batching v3 又证明 4K 只能改善工作记忆容量，不能保证模型摘要逐字无误；原始任务合同还必须采用问题 38 的确定性固定层。

### 36. v4 长 deadline 在 Child credential timer 中溢出

**现象**：`make-mips-interpreter` 的 MiniMax 模型自主 spawn 了一个只读 explorer Child，委派内容是 ELF、syscall 和 BSS 调查。Child 成功启动并提交首轮 Prompt，却在 0 turn / 0 tool 时立即失败为 `CHILD_CREDENTIAL_EXPIRED`；Root 随后只能自行降级调查。

**根因**：Workflow 与 Child profile 已正确把 v4 unlimited deadline 编码为 `9999-12-31T23:59:59.999Z`，但 credential broker 的 `linkedInvocationSignal()` 仍把“当前时间到 9999 年”的毫秒数直接传给 Node `setTimeout`。Node 原生 timer 的可移植上限约 2,147,483,647 ms（约 24.8 天）；更大数值会发出 `TimeoutOverflowWarning` 并缩成约 1 ms，所以长期凭据被瞬间取消。

**处理**：credential broker 改用 Runtime 已有的 `scheduleLongDurationTimer()`，把超长期限分成多个安全片段重挂；取消时调用统一 timer handle。没有删除 deadline，也没有改成一个新的短 TTL，因此显式 deadline 仍然 fail-closed，v4 unlimited 也不再被底层 timer 偷偷截短。

**复验**：新增 `9999-12-31` credential deadline 回归：Provider 延迟 25 ms 后返回 completed，旧实现会约 1 ms 过期，新实现正常完成；同时保留 50 ms 真 deadline 的失败测试。credential delegation 专项 7/7，TypeScript typecheck、workspace build 和 Harbor bundle 重建通过。

### 37. Child Run 的 durable deadline 被截成 24.8 天

**现象**：修复 credential timer 后继续审计同一条长生命周期链路，发现父 Runtime 提交 Child `session.prompt` 时仍把 `timeoutMs` 截到 `2,147,483,647`。短测看不出异常，但任何声明为 unlimited 的 v4 Child 最终都会得到约 24.8 天的实际 Run deadline。

**根因**：这里混淆了两种完全不同的数字。`setTimeout` 的单次 delay 确实不能超过约 24.8 天；但 `session.prompt.timeoutMs` 不是一个正在运行的 Node timer，而是会进入 Child Run budget 的耐久合同。提前截断合同等于偷偷重新加入任务寿命上限。

**处理**：删除 `remainingDeadlineMs()` 中的原生 timer 截断，传递从现在到签名 `deadlineAt` 的完整安全整数。真正 arm deadline 的 `FormalChildControl` 已使用 `scheduleLongDurationTimer()` 分段重挂，所以不需要、也不应该在协议层缩短预算。用户或部署显式设置的有限 deadline 继续原样生效。

**复验**：新增 Child Runtime Host 回归，使用 `3,000,000,000 ms`（超过 24.8 天）的 deadline，受控 Child 实际观察到的 `session.prompt.timeoutMs` 保持大于 `2,147,483,647`，然后由父级主动取消并正常回收；Child Runtime Host 专项 19/19、TypeScript typecheck 和 workspace build 均通过，Harbor bundle 重建后 `--version` 冒烟通过。

### 38. Semantic checkpoint 截断并改写了原始任务合同

**现象**：`llm-inference-batching-scheduler` v3 的 SQLite SessionJournal 中，checkpoint objective 明确出现 `…[task contract truncated]…`，并把 Bucket 2 的 `pad≤0.15` 等独立阈值混成 Bucket 1 的 `pad≤0.055`。模型随后按错误合同优化。增加摘要 token 只能降低概率，不能把模型生成的摘要变成原始用户输入的权威副本。

**根因**：Root 的 user task 虽然完整写入 canonical history，但一旦该消息被 compaction 覆盖，Provider replay 只剩 semantic checkpoint；只有 Child 的签名 ContextPacket 位于 compactable history 之外。架构错误地让 Root 原始任务依赖有损自然语言摘要。

**处理**：每次 Root/Child Run 启动时，`RuntimeKernel` 从已校验 PromptEnvelope 生成逐字 pinned user task contract，并保存在当前 `RuntimeRun`；`PromptAssembler` 每轮先装配它，再装配 Child 可选签名 ContextPacket、ContextView、checkpoint 和最近 history。相同 canonical live message 会被去重，Provider 不会看到双份题面。checkpoint 仍压缩进度、决策、失败路线和 open loops，但不能替换原始合同。

进程级回归还发现内置 Mock Provider 过去只读取 `request.messages`，没有像真实 OpenAI/Anthropic adapter 一样合并 `contextMessages`。任务合同去重到 pinned context 后，它会看不到 `tool:shell` 测试指令。Mock Provider 已改为从两部分共同解析 ContextPacket，并在普通 messages 为空时选择 `trust=user` 的 pinned 任务作为当前输入；这保证离线测试 Provider 与正式 ProviderRequest 语义一致。

**为什么不把完整模型计划也固定**：用户硬合同需要逐字稳定；模型计划本来就应该随工具证据变化，全部固定会制造陈旧路线、浪费 context 并把 Agent 重新变成僵硬 Plan-and-Execute。Runtime 只固定输入合同和可验证 authority，认知路线仍由模型动态修改。

**复验**：Prompt assembly 回归构造包含 `…[task contract truncated]…` 的 checkpoint，确认逐字 pinned contract 仍存在、checkpoint 也保留且任务只发送一次。Prompt/Shell 专项合并执行 23 pass、1 个 Windows 预期 skip，Runtime process 9/9，typecheck 通过。使用修复后 bundle 的 batching v4 经历 3 次 compaction，压缩后仍使用 B2 正确阈值，最终 Harbor 6/6、reward 1；运行 78 Provider turns / 77 Tool calls、0 exception。

### 39. Plan Tool Schema 与 Core 领域校验不一致

**现象**：真实 MiniMax 控制样本用 `file_rule.path = "D:\\praxis"` 调用 `plan.create`。Provider 看到的 Tool Schema 接受该字符串，但 Core 只允许工作区相对路径，最后只返回泛化的 `PLAN_CREATE_INVALID`。模型为理解错误反复读取 Planner 源码。

**根因**：`tools/shared.ts` 的路径字段只有普通 string/length 约束，ID pattern、路径规则、长度和 Review policy 上限也没有与 `packages/core-sdk/src/review-plan.ts` 对齐。

**处理**：模型可见 Schema 现在明确要求相对路径，禁止盘符、前导斜杠、NUL 和 `..` 路径段；ID 使用相同安全 pattern；objective、artifact ref 与 policy 数值范围对齐。常见错误会在 Tool 输入验证层给出字段路径，不再先进入持久化控制面。

**复验**：ToolRuntime 接受 `README.md`，拒绝 `D:\\praxis\\README.md`；专项测试通过。真实 v3 第一次即创建 Plan。

### 40. Semantic Reviewer 假设所有 Provider 都支持原生 JSON Schema

**现象**：MiniMax M3 的普通 Agent Tool 调用正常，但隔离 Reviewer 连续耗尽，ReviewCall 只留下 `provider_started`。

**根因**：Reviewer 无条件传 `responseFormat=json_schema` 且不给 Tool。MiniMax 的 Anthropic Messages adapter 声明 `output.jsonSchema=false`，会忽略该字段；模型只能用自由文本尝试满足严格 JSON，可靠性不足。

**处理**：Reviewer 按 Provider capability 选择双通道：支持原生 Schema 时继续用严格 `responseFormat`；不支持时注册并强制调用 `submit_review_plan_decision`，再使用同一个领域 validator 校验 Tool 参数。实现不包含 MiniMax 特判。

**复验**：新增 native/fallback 单元覆盖；真实 MiniMax 可生成合法的强制 Tool decision。

### 41. 合法 Reviewer decision 因 usage 的 `undefined` 字段无法落盘

**现象**：完成问题 40 后 Reviewer 仍显示耗尽。独立调用证明 decision 合法，但 SQLite 的三次 attempt 都停在 `provider_started`，没有 raw response、decision 或 usage。

**根因**：Anthropic 风格 adapter 返回的 `ProviderUsage` 带有值为 `undefined` 的可选键。`ReviewCallStore` 使用严格 canonical JSON 持久化 usage；canonical JSON 正确拒绝 `undefined`，但 Coordinator 把这个本地持久化错误与远端未知结果一起吞掉，所以模型只看到 exhausted。

**处理**：在 Semantic Reviewer 返回边界过滤未定义的可选 usage 键，只保留真实数值；耗尽信息同时附带最后一个安全错误码，便于区分 Provider、解析和持久化错误。

**复验**：测试 fixture 显式返回 `cacheWriteTokens: undefined`，ReviewCall 仍能提交。真实 v3 的 Item/Final Review 均在 attempt 1 进入 `decision_committed`，usage 分别正确落盘，两笔预算均为 `settled/actual`。

### 42. 终态 Attempt 被误判为 in-flight，动态 replan 无法恢复

**现象**：Item Review blocked 后，模型尝试提高 Review policy 并修改 Plan，却得到 `PLAN_UPDATE_INFLIGHT_CONFLICT`。这会把本应可动态修订的 Plan 变成死路。

**根因**：`plan.update` 只要看到 `currentAttempt` 就拒绝，没有检查 Attempt state；accepted、needs_fix、blocked、cancelled 等终态也被当成运行中。

**处理**：只有 `open` 和 `review_requested` 才构成 in-flight 冲突。终态 Attempt 可以触发 material replan，新的 revision 重置未接受 Item；真正执行中或已有 prepared fence 时仍 fail closed。所有 Plan Tool 描述另补充“控制调用与工作 Tool 不同回合”，减少 `PLAN_CONTROL_BATCH_BARRIER` 的无效重试，Runtime barrier 本身不删除。

**复验**：单测先确认 open Attempt 仍拒绝 update，再把 Attempt 置为 blocked，更新成功到 revision 2。真实 v2 也完成 revision 1→2 并重新启动 Item；最终 v3 无 replan 即完成整个 Plan。

### 43. Reviewer 只看到证据名字，没有看到证据内容

**现象**：`plan.review` 允许 Root 提交任意字符串 `evidenceRefs`，neutral payload 只携带这些名字和 Root 自己写的 summary。即使引用指向一段源码，Reviewer 也没有读取源码内容的能力；“accepted”实际可能只是相信了文件名和自述。

**根因**：ArtifactStore 的读取只用于少数 deterministic check，没有在 Reviewer 边界构造统一的证据视图；引用也没有与当前 Item Attempt 的 Runtime 执行账本交叉验证。

**处理**：每个 current Attempt 单独投影 Runtime 写入的 evidence ref。`plan.review` 省略引用时自动使用这组事实，显式引用时只能选择其子集；final 只能使用 accepted Item 冻结的证据。Runtime 将 summary、文件快照和原始任务合同也转成内容寻址 Artifact，随后构造 bounded Evidence Manifest，逐项包含 source、Item/Attempt、available、canonical digest、bytes、内容预览和 truncated。不可读取的项显式列出且不能被 Reviewer decision 引用。

**复验**：foreign ref 在 `review_prepared` 之前返回 `REVIEW_EVIDENCE_NOT_ATTEMPT_OWNED`；真实 manifest 的每项均为 `owner=runtime` 且带可读内容；passed finding 不引用证据会被 strict validator 拒绝。

### 44. Root 自拟 Plan 可以漏掉原始用户要求

**现象**：旧 final Reviewer 只检查 Root 自己写的 objective 和 acceptance criteria。若用户要求 A/B/C，而 Root 创建 Plan 时只写 A/B，Reviewer 即使完美执行也看不到 C。

**根因**：原始用户任务虽然对 Root 有 pinned replay，但没有成为 ReviewPlan 的不可变验收输入；“计划是否完整”与“是否按计划完成”被错误合并成后者。

**处理**：`plan.create` 从当前 active Run 的持久化 user prompt 固定 `taskContract(runId,messageId,text,digest)`；replan 只能修改模型 Plan，不能修改 task contract。final Review 自动增加 Runtime 生成的 task-coverage criterion，并同时提供原始任务、当前 Plan、候选摘要和证据 Manifest。Reviewer 必须逐项报告 omitted/weakened/contradicted/unproven requirement，coverage finding 也必须引用可读取证据。

**兼容性**：旧 Journal 的 `review_plan.created` 仍能 replay；旧活动 Plan 没有 task contract 时 final coverage fail closed，而不是虚构一个原任务。Plan create 的既有 mutation digest 保持不变，避免升级后同一 invocation replay 冲突。

### 45. 未接线 checker 被当成模型可用能力

**现象**：Tool Schema 同时列出 `registered_check`、`json_schema`、`diff_boundary` 和 registered content rule，但当前 ReviewCoordinator 没有 checker catalog、schema resolver 或冻结 diff manifest，模型可以创建一个必然 `unverifiable` 的 Plan。

**处理**：Core union 和旧 Journal 解码保留这些类型，保证持久化兼容；模型可见的 `plan.create/update` Schema 只列当前 composition 已接线的 checker。新增的 `file_rule` 实现会在 fence 前规范化工作区路径、拒绝 escape、流式计算文件 sha256 并冻结预览 Artifact；Tool/effect/Child checks 按真实 Runtime wrapper 和已落盘 receipt 判断。

**后续扩展规则**：只有 checker 的 resolver、冻结输入、资源上限、安全测试和恢复语义全部接线后，才能重新加入模型 Schema；增加 TypeScript union 本身不等于能力上线。

### 46. `needs_fix` 后旧 Attempt 没有退出，无法直接修复

**现象**：Review decision 把 Attempt 标成 `needs_fix`，却继续保留为 `currentAttempt`。下一次 `plan.progress start` 在 reducer 看到已有 Attempt 后失败，模型只能通过 material replan 绕行并消耗 replan budget。

**处理**：Item review decision 现在先冻结 accepted evidence/attempt identity（仅 accepted 时），再结束并移除 current Attempt，同时清理 focusedRootAttemptId。`needs_fix` 回到 Item 的修复状态后可直接创建 attempt 2；旧 Attempt 的证据不会进入新 Attempt。Plan replan 仍只用于路线或验收合同确实变化的情况。

**复验**：ReviewPlan reducer、PlanControl、Coordinator、Tool Schema、文件冻结、task coverage 和 Reviewer 引证约束合并专项 29/29，TypeScript typecheck 通过。

### 47. Plan 快照随每次 Tool 证据增长，长任务在实现完成后崩溃

**现象**：2026-09-03 的 `adaptive-rejection-sampler` Plan-and-Review 实验已经安装 R、写出约 900 行实现并持续修复，却在第 32 次工作 Tool 后以 `PLAN_SNAPSHOT_TOO_LARGE` 终止。失败发生在真正验收之前，官方 0 分属于 Praxis Runtime 异常，不是模型解题失败。

**根因**：8 KiB 是发给模型的单轮 Plan 控制快照边界，本身有必要；实现却把 Item 的累计 `evidenceRefs` 和 `currentAttempt.evidenceRefs` 同时逐项复制进快照。每个 Tool 都让动态 Context 变长并改变字节，既必然撞限，也会破坏 Provider prefix cache。规范要求的 descriptive/minimal 两级投影没有实现完整。

**处理**：快照改为确定性两级投影。普通层保留截断后的 objective、criterion 描述和 Item 标题；最小层只保留 Plan identity/revision/state、policy 与计数、全部 required criterion ID/kind/status、Item 状态、Attempt identity、prepared fence digest 和 accepted evidence digest。运行中证据引用只保存在权威 Journal，不再进入每轮 Prompt；因此同一 Attempt 内连续 Tool 调用不会改变 Plan snapshot。

**复验**：回归构造 600 条、每条 300 字节的 Attempt evidence，快照与 0 条证据时逐字节相同且小于 8 KiB；另构造长中文 objective、30 个长 criterion 和长 Item 标题，确认自动降级后仍保留第 30 个 required criterion 与 Plan identity。与 Coordinator 回归合并 7/7，TypeScript typecheck 与评测 bundle 构建通过。

### 48. 模型选择证据既不可用，也允许选择性隐藏失败

**现象**：真实 MiniMax 运行连续把普通 Tool 输出中的 Artifact ID 填进 `plan.review.evidenceRefs`，Runtime 正确返回 `REVIEW_EVIDENCE_NOT_ATTEMPT_OWNED`。原因不是引用伪造，而是 Root 根本看不到内部 Review evidence ledger 的精确 ID。随后同一长 Attempt 又会积累超过旧 Reviewer 128 项上限，预期在 Review 边界硬失败。

**根因**：模型可见接口暴露了一个只有 Runtime 才掌握的信息，同时让被验收者决定隐藏哪些执行事实；`evidenceRole` 也只是模型自填字符串，Runtime 从未签发或按它匹配，容易制造虚假的精确性。持久证据总量和单次 Reviewer 输入量又被错误地当成同一个上限。

**处理**：模型 Schema 删除 `evidenceRefs` 与未被可信签发的 `evidenceRole`。Review 自动使用全部当前 Attempt 事实；对旧 Journal 的字段仍兼容。直接 evidence descriptor 上限提高为 256，并与持久账本解耦：超出时 Runtime 按固定 `first-and-latest-v1` 策略保留开头环境事实和最新验证事实，同时生成包含完整有序 refs、总数、总 digest 和 omitted count 的 immutable evidence-index Artifact。模型不能影响选择，Journal 可长期保留最多 65,536 条 Attempt refs。

**复验**：Tool Schema 不再出现两个模型不可正确控制的字段；Core 仍接受旧事件；600 条证据的边界选择稳定保留前 16 条和最后 239 条，并为索引预留一项。Plan Tool、domain、event reducer、snapshot 和 Coordinator 合并专项 21/21，TypeScript typecheck 通过。

### 49. “Tool 返回成功”被误当成“任务结果正确”

**现象**：ARS 真实轨迹运行过带管道的 R 命令。R 已输出 `Execution halted`，但 POSIX 管道最后的 `head` 正常退出，Shell Tool 因而记录成功。旧 ReviewCoordinator 又允许仅含 `tool_receipt` 的 mechanical Item 在结构匹配后直接 accepted，形成双重假阳性风险。

**根因**：回执只能证明 Runtime 观察到某次调用的状态，不能证明命令输出满足用户要求；普通 `/bin/sh -lc` 默认只返回管道最后一个进程的退出码。结构真实性和任务语义被错误地合并了。

**处理**：只有能直接证明精确事实的 `file_rule` 与 `content_digest` 可以在 Item checkpoint deterministic self-accept。`tool_receipt`、`effect_receipt`、`artifact_or_child_result`、`reviewRequired=true` 和所有 semantic criterion 必须进入隔离 Reviewer。在存在 `/bin/bash` 的 POSIX 环境，Shell Tool 改用 `bash -o pipefail -lc`；任一管道阶段失败都会返回非零。没有 Bash 时保留 `/bin/sh` 兼容路径，Windows 使用原 PowerShell 适配器。

**复验**：新增分类回归，确认 shell success receipt 需要 Semantic Reviewer，而文件存在可自行接受；新增 POSIX-only pipeline 回归，确认上游 `exit 7` 不会被下游成功掩盖。Plan Tool、Coordinator、snapshot 与 Tool 专项合计 29 pass、1 个 Windows 预期 skip，TypeScript typecheck 通过。

### 50. Reviewer 通过有限自测，但隐藏安全测试仍失败

**现象**：有效的 `filter-js-from-html` Plan-and-Review trial 完整经历一次 `needs_fix`、第二次 Attempt、三个 Item accepted 和 final accepted，Runtime 以 `prompt_completed` 结束；模型自建的 33 个功能测试与 10 个边界测试也全部通过。然而 Harbor 官方 verifier 的两个顶层测试仍为 0/2：隐藏 XSS 语料仍能触发，12 份干净 HTML 中有 5 份被改写。官方 reward 为 0。

**责任层判断**：这不是 Journal、Plan reducer、Reviewer 调用或 compaction 崩溃，而是语义验收的覆盖盲区。criterion 使用了近似“阻断所有脚本”“保持安全 HTML 不变”的全称要求；现有 Evidence Manifest 只证明一组有限样例通过。同模型的隔离 Reviewer 虽然没有 Root 对话历史，却仍可能把“样例很多”错误推广成“要求已经普遍成立”。因此，“Reviewer 独立”减少自我确认偏差，但不等于具备形式证明或隐藏测试知识。

**为什么不能针对 benchmark 打补丁**：隐藏 verifier 的意义就是检查实现能否推广到未见输入。把隐藏向量复制进 Prompt、给某道题写专用规则，或者让 Reviewer 看官方答案，都会污染 A/B，无法证明通用 Agent harness 更强。本轮因此只记录缺口，没有为了把 0 改成 1 而修改 Praxis 主干。

**通用改进方向**：

1. Reviewer Prompt 明确区分“存在性/样例性证据”和“全称要求”：有限测试只能证明已覆盖样例，不足以单独证明 `all`、`any input`、安全隔离或解析器等价性。
2. 为安全、兼容性和精确保持类 criterion 增加可声明的高强度验收 profile，要求证据覆盖类别、测试语料身份与数量、属性/实体/空白等字节级 fixture 或 hash，而不只是“测试通过”的摘要。
3. 允许任务注册领域 checker、模糊测试或独立 verifier；Reviewer 负责解释覆盖范围，确定性工具负责执行可重复检查。没有领域 checker 时应降低置信度或明确报告尚未证明的范围。
4. 后续实验可比较同模型 Reviewer、不同模型 Reviewer 与确定性 checker 的 false-success 率，不能只比较最终 reward。

**当前状态**：尚未作为主干修复项关闭。有效 trial 位于 `D:\agent-evals\results\harbor-minimax-medium\minimax-m3-plan-ab-evidence-fix-v5-plan-review-html-r1`；43 turns / 41 Tool calls，Agent 8.44 分钟，input/cache-read/output 为 320,686 / 856,340 / 25,046。按用户要求，该 trial 完成后暂停，不继续启动新题。

### 51. Docker Desktop 的失效 IPC 文件使引擎无法启动

**现象**：Docker Desktop 报错 `initializing Inference manager`，尝试监听 `unix://C:\Users\97993\AppData\Local\Docker\run\dockerInference` 时无法移除旧端点，并以“文件名、目录名或卷标语法不正确”退出。此前一个 HTML trial 的 Agent 已完成，但 Docker 在 Selenium verifier 期间崩溃，Harbor 没有得到 reward 文件，因此该 trial 无效。

**根因与责任层**：Docker Desktop 的本地 `run` 目录保留了不可正常访问的 inference IPC 状态，属于宿主机环境故障，不是 Praxis Planner、模型解题或官方 verifier 的任务失败。

**处理**：停止 Docker Desktop/backend 后，先精确确认目标路径，再把 `C:\Users\97993\AppData\Local\Docker\run` 可恢复地移动为 `C:\Users\97993\AppData\Local\Docker\run.stale-20260903-180258`，重新建立空 `run` 目录并启动 Docker Desktop。Docker Server 28.4.0 恢复响应；保留旧目录作为故障证据，没有直接删除。随后从全新容器、全新 Praxis Session 重跑同一 HTML 实验，Agent 和 verifier 均完整结束。

**测评记账规则**：Docker 崩溃、缺少 reward 文件或 verifier 未完成的 trial 标记为 `invalid`，不能把 Harbor 默认写出的 0 当成模型分数。只有恢复后完整执行的 v5 trial 进入 A/B 总账。

**2026-09-04 再次复发**：21:13 启动日志再次显示相同错误，Docker backend 随后退出，Linux Engine pipe 尚未创建。`fsutil reparsepoint query` 对 `dockerInference` 返回 Windows Error 1920（系统无法访问该文件）。此时新批次 benchmark 尚未启动，没有 MiniMax 调用，不能记作 Praxis 或模型失败。确认 Docker Desktop/backend 均已退出、`run` 是普通目录且只包含 `dockerInference` 与 `userAnalyticsOtlpHttp.sock` 两个临时端点后，将它精确移动到 `C:\Users\97993\AppData\Local\Docker\run.stale-20260904-2130`，建立空 `run` 并重新启动。`docker version` 已成功取得 Docker Desktop 4.47.0 / Server 28.4.0 响应。旧目录保留，可供排查；没有删除镜像、容器数据、卷或 WSL 虚拟磁盘，也没有修改 Docker AI 设置。这是已验证的**恢复措施，不是根因永久修复**；复发说明仍需追踪 Docker Desktop 端点清理问题。[Docker 官方仓库中的同类问题 #625](https://github.com/docker/desktop-feedback/issues/625) 目前没有公开的修复结论，不能保证升级或关闭 Model Runner 就能解决。

### 52. accepted Item 的 Review 元数据再次撑破最小 Plan 快照

**现象**：ARS 长任务已经不再把运行中 evidence ledger 放进每轮 Prompt，但在第 277 次 Tool call、
第五个 Item accepted 后仍以 `PLAN_SNAPSHOT_TOO_LARGE` 终止。官方产物测试是 9/9，Agent 却非零退出，
说明失败点纯粹位于 Praxis 收尾阶段。

**根因**：descriptive snapshot 超限后会降级到 minimal snapshot；minimal 虽然删除了原始 evidence ref，
仍为每个 accepted Item 复制完整 `lastReview`（request ID、Artifact ref、digest、verdict）、大量空值字段，
并保留 Item 已经 accepted 后不再活动的 block 摘要。真实 11 criterion / 7 Item Plan 在 Review 元数据
逐项累积后仍可超过 8 KiB。原问题 47 的回归只覆盖“大量运行中证据”和“长定义”，没有覆盖
“多个 Item 依次 accepted”的生命周期，所以未发现第二条增长轴。

**处理**：minimal projection 的 Review ref 缩为 `verdict + decisionDigest`；没有 current Attempt、
prepared review 的字段完全省略；block 只在 Item 当前确实为 blocked 时投影。权威 Journal 仍保留完整
Review request、Artifact 和历史 block，缩小的是每轮模型上下文，不丢恢复证据。

**复验**：新增现实规模回归：11 个 required criterion、7 个 Item、5 个 accepted Item、单 Item
225 条 accepted evidence 和两个历史 block；快照小于边界、仍保留全部 criterion/Item identity，
且不泄漏完整 decision Artifact、历史 block 或 evidence ref。与 PlanControl 专项合计 11/11、
TypeScript typecheck 通过。修复 bundle 的 ARS r2 在 178 Tool calls 后 Plan completed；随后 Scheme r2
在 303 Tool calls、9 个 Attempt 和 10 次 Review decision 后同样 completed，没有再次触发快照错误。

### 53. `block` 的可选 Attempt ID 可制造 blocked Item + open Attempt

**现象**：MiniMax 把 `plan.progress(action="block")` 当成“完成/等待验收”，且省略可选的
`itemAttemptId`。Runtime 把 Item 标为 blocked，却没有关闭当前 open Attempt；后续 `plan.update`
持续返回 `PLAN_UPDATE_INFLIGHT_CONFLICT`。模型最终通过读取快照中的 ID、逐项 focus/review 才绕出，
浪费大量回合。

**根因**：规范要求 block 关闭当前 open Attempt，但实现只有请求显式携带 `itemAttemptId` 时才写
`item_attempt_closed`；Tool Schema 同时把该字段声明为可选，形成接口内部矛盾。

**处理**：`block` 未提供 ID 时，PlanControl 自动使用该 Item 的 current Attempt ID 并原子写入
Attempt close + Item blocked；没有活动 Attempt 时仍允许只记录 Item block。显式错误 ID 继续由 Reducer
拒绝，不能关闭其他 Attempt。

**复验**：新增回归先 start Item，再省略 Attempt ID 执行 block，确认活动 Attempt 从 projection 清除，
随后 material `plan.update` 能进入 revision 2；专项与 typecheck 全部通过。

### 54. 模型自设过小 replan 预算后，陷入无法自救的 Plan 控制循环

**现象**：`db-wal-recovery` 的首条 Plan-and-Review 轨迹先由模型在 `plan.create` 中选择
`maxReplans=2`，两次修改路线后又需要继续调整。此后 `plan.update` 永久返回
`PLAN_REPLAN_BUDGET_EXHAUSTED`；模型尝试 `plan.abandon`，但无头 Harbor 运行没有 Host 签发的
Plan-control grant，因此又永久返回 `PLAN_CONTROL_GRANT_REQUIRED`。模型没有终止，而是在两种错误间
反复切换。该 trial 被人工中断并记为 invalid，不能把未完成时的 reward 0 当成任务分数。

**根因**：旧 Tool Schema 把可靠性预算暴露成 `plan.create/update` 的普通模型参数。模型既不知道任务
实际会经历多少次修复，也不能在预算耗尽后通过同一个受限操作提高预算。与此同时，`plan.abandon`
是需要 Host 授权的安全出口，Prompt/Tool 描述却没有明确告诉模型“缺授权时不要重试”。这不是单纯把
数字 2 改成更大数字就能根治的问题，而是策略所有权放错了层级。

**永久处理**：模型可见的 Plan 定义已删除 `reviewPolicy`；重试、修复和 replan 预算改由 Runtime/受信
Host 管理。Core/API 仍保留可选 policy 以兼容持久数据和部署覆盖，普通模型不能自设过小预算，也不能
解除部署方的安全边界。Runtime 默认单 Item 修复和 material replan 均提高到 8 次；Semantic Reviewer
Provider 尝试与无进展尝试各为 3 次，仍保持有限，以防畸形输出或 Provider 故障造成无限调用。
`plan.abandon` 的 Tool 描述和错误信息同步明确：收到 grant-required 后不得重试，应结束回合，让
Runtime 进入可恢复的 `prompt_blocked`，等待 Host 决策。

**复验**：新增 Tool Schema 回归，确认 `plan.create/update` 都不再向模型暴露 `reviewPolicy`，并确认
`plan.abandon` 描述含“Never retry”。Plan Tool、PlanControl 与 snapshot 专项 16/16 通过，TypeScript
typecheck 通过，测评 bundle 重建成功。修复后的同题 r2 确认 `plan.create` 不含 policy，且没有再次出现
replan-budget/abandon 循环；它运行约 154 turns、153 Tool calls，经历多次 compaction 和至少一次
`needs_fix`，最终在 Provider 返回 `PROVIDER_RATE_LIMITED` 时中断。因此该复验能证明控制循环已消失，
但不能证明题目最终会通过，r2 仍按 Provider invalid 记账。

### 55. Final Review 已指出外部阻塞，却返回 needs_fix；控制错误没有提示合法修复路径

**证据**：2026-09-04 DB-WAL P&R r3 没有先备份输入就打开 SQLite，WAL 随后消失。Root 搜索未果后
按基础记录的规律猜测缺失数据，Item 的格式检查陆续 accepted；两次 Final Review 都通过原始任务
覆盖检查拒绝整题，明确要求外部原始数据或恢复渠道，却仍返回 `needs_fix`。Root 多次在 accepted
Item 上 start/focus，或只改 objective 后调用工作 Tool，被不可变约束和 Attempt guard 拒绝。

**责任层**：数据损失和猜测属于模型操作/解题失败；把“需要外部恢复”的解释配上 needs_fix 属于
Reviewer 的 Prompt 服从与决策分类问题；通用拒绝信息没有提供下一步则是 Harness 接口易用性缺口。
现有状态机并非完全无路可走：Root 后来通过新增修复 Item 恢复了工作调用，但没有新的数据源可以
补救。操作者在重复探索后以 SIGINT 停止诊断，官方产物检查 5/7、reward 0，运行记为人工中止
INVALID，不计有效 P&R 正确率。

**处理**：`PLAN_ITEM_ATTEMPT_REQUIRED` 和 `PLAN_ACCEPTED_ITEM_IMMUTABLE` 的主干错误信息现在明确
说明 start/focus 的合法条件、accepted Item 不可重开、Final Review 后要新增修复 Item，以及缺外部
条件时结束回合而非重复工具。隔离 Reviewer 的两种传输路径共享新增指令：外部阻塞优先返回 blocked，
verdict 必须与说明一致，猜测或更多文档不能替代缺失证据。不放宽原始合同，不更改持久状态机，
不加入数据库或 benchmark 专属解题提示。

**复验及边界**：相关专项 21/21、typecheck 通过；复用三个冻结 Artifact 构造的精简 MiniMax Reviewer
探针返回 blocked，用量为 input/cache/output 3591/3705/468。该探针没有完整重放旧 neutral payload，
也没有同输入旧 Prompt 对照，因此只能证明新指令在一个真实证据案例上生效，不能宣称模型收敛已完全
解决。原始 30 分 41 秒 Agent 轨迹和 6 次 compaction 都保留，供后续分析；不得将其伪装为通过案例。

### 56. 为通过相对路径 Schema 而去掉前导斜杠，检查了错误的文件

**现象**：pMARS P&R 首次把 `/usr/local/bin/pmars` 用作 `file_rule.path` 被 Schema 拒绝，随后改成
`usr/local/bin/pmars`。该相对路径实际指向 `/app/usr/local/bin/pmars`，不是用户要求的安装位置。
构建完成后检查失败，Root 又复制一份二进制到错误检查位置。官方 4/4 通过，是因为真实安装位置也
有二进制，而不是错误的 file_rule 能证明原要求。

**归因**：Runtime 工作区边界执行正确，模型误解路径语义并为自设检查增加无关产物。Schema 已有
“workspace-relative”说明，但没有明确指出“去掉前导斜杠会检查另一个文件”与工作区外目标的替代方式。
这是模型行为加接口提示不足，不是应该通过放开路径逃逸来修复的权限 bug。

**处理与验证**：主干补充通用路径描述：禁止用剥离斜杠转换外部路径；工作区外交付用 semantic
criterion 与受权工具证据，不为错误 file_rule 创建多余副本。路径限制不变，Plan Tool 专项 6/6。
补充后的提示用于后续 C++ 两臂，不回写 pMARS 轨迹，尚不能宣称其真实误用率已经下降。

### 57. 把最终交付条件绑定到调查步骤，导致所有工作挤进第一个 Item

**证据**：DB-WAL r3 的检查步骤要求最终 JSON 已存在；C++ 堆内存 P&R 的 investigate Item 则要求
Release 已成功运行，但后面的 apply_fix 才叫“实施修复”。模型先写出的验收映射把未来步骤的结果
变成当前步骤的前提，造成过早写产物或长时间停留在调查 Item。这不是 Runtime 强制这种顺序，
也不是 compaction 后才出现的合同漂移，而是模型创建 Plan 时就存在的设计问题。

**处理**：主干 `plan.create/update` 共用的 `criterionIds` Schema 描述现在明确：条件应在本 Item
结束时能够达到；调查应有自己的证据条件，不要提前要求最终修复行为；紧密相关的工作可以合并，
映射不合理时可以调整 Plan，但不能削弱原始任务要求。没有增加 DAG，也没有给出任何具体题目解法。

**验证边界**：新增创建/更新两种 Tool 的描述回归，Plan Tool 专项 7/7 通过。本条提示没有热更新
C++ r1，后续 r2 才采用；r2 初始使用一个紧密相关的实施 Item，最终官方 6/6。但版本、采样及
compaction 修正同时变化，不能据此断言单独的阶段提示稳定减少错配，仍需独立对照验证。

### 58. Compaction 硬截断结论，并把 shell 路径猜测和零错误日志写成事实

**真实证据**：C++ P&R `custom-memory-heap-crash__Lm55Eqa` 的首次 `compaction.created`
（2026-09-04 08:28:01 UTC，journal sequence 176）中，多条 decisions 在 240 字符处断句，
例如成功条件被切在 `release exit 0 und`。`modifiedFiles` 同时出现 `main.cpp`、`user.h`、
`locale_init.cc` 等编译输入、include 文本和只读源文件；`unresolved` 又收录了多条
`ERROR SUMMARY: 0 errors`。第二次 checkpoint 使用确定性 fallback，继承这些已有内容。

**根因**：`bounded()` 对每条事实无条件 `slice(0, 240)`，可能切掉否定或适用条件；
`shellMutationPaths()` 只要脚本中有任意写入迹象，就把整段文本内所有源码路径当成修改目标；
失败提取器只看到了大写 ERROR，没有区分零错误汇总。前两项尤其违反摘要字段的证据归属，
不是增加一句“请准确总结”就能修复的问题。

**主干处理**：

- 去掉单条事实的 240 字符截断，保留完整字符串。最终摘要仍按 tokenizer 和原有总 token 预算
  准入；空间不足时按既有优先级移除整条事实，不用半句替代完整结论。
- 成功 `write/edit` 的结构化路径才进入 confirmed modifiedFiles；失败结果即使带 path 也不记为
  已修改。任意 shell 的正则匹配降为 `unresolved` 中明确标注的“未核实变更候选”，不声称完整、
  不当作写入证据；需要从原 Tool 日志和实际文件核实。shell exit 0 不能证明所有提及路径被修改。
- 精确识别 Valgrind 的 `ERROR SUMMARY: 0 errors`，不生成失败提示；正数错误仍保留。

**验证**：Compaction、上下文选择与 JSONL/SQLite checkpoint 持久化专项 23/23 通过，含长结论尾部
否定/Unicode、heredoc/编译输入路径、失败 edit 的 path、零与非零 Valgrind 错误的回归。
修改没有热更新 r1；已有 checkpoint 和旧证据也未重写。后续新会话 r2 采用修复版、官方 6/6，
但只经历一次确定性 fallback，尚不能证明多次语义压缩的保真率或整体完成率提高。模型的绕路在第一次压缩前已经开始，因此不能把所有低效探索
都归因于压缩；但也不能再声称本题压缩内容没有问题。

### 59. Final Review 证据被错误套用 2 KiB 描述符上限，反复要求补证

**真实现象**：C++ P&R r2 已修复程序，Item Review accepted；Final Review 却多次因为
Valgrind 日志预览被截断而 needs_fix。最终仍通过官方 6/6，但出现 6 次 needs_fix 和大量补证。

**代码原因**：`buildEvidenceManifest()` 把用于描述符/二进制预览的 2048-byte 常量也套在每份
实际 Tool 证据内容上，并平均分配 64 KiB 内容额度。即使所有证据合计远小于总预算，稍长的日志
仍会被截掉末尾。初步怀疑平均分配，进一步冻结数据核对确认 **2 KiB 错误耦合才是本例主要原因**。
这不是 compaction；它发生在独立 Reviewer 的证据请求装配阶段。

**主干修复**：语义 Tool 内容不再受描述符 2 KiB 限制；保留 64 KiB 总内容预算，用确定性分配
让短证据未用完的额度供长证据使用。完整内容、顺序、digest 和 ownership 不变，真正超出总预算
仍明确标记 truncated。文件/二进制描述符的独立边界没有取消。不能将“完整读到证据”当成模型必然
正确验收的保证，也没有实现 Reviewer 的任意按需文件检索。

**验证**：Coordinator 专项 9/9，通过真实冻结 Final 输入离线审计：sequence 246 的六份证据
总共 13,563 bytes，旧分配仅完整展示 2/6，新分配完整展示 6/6；其他五次 Final 输入也全部能够
完整展示，且都不超过 64 KiB。审计脚本为 `D:\agent-evals\scripts\audit-review-evidence-budget.mts`，
直接调用主干分配函数，不调用 Provider、不重写 journal。它验证字节展示，不验证新 Reviewer verdict。
本次官方 6/6 仍来自旧证据装配版 r2；不能声称新修复已被该 benchmark 成绩验证。

同轮补充了 `plan.review` 的调用顺序描述和 `PLAN_FINAL_REVIEW_NOT_READY` 的可操作错误信息：
单 Item Plan 也必须先 Item accepted，再 Final；已经 accepted 后要继续工作必须先开新 Item Attempt。
Coordinator 回归覆盖过早 Final 的拒绝与提示。此提示也未热更新 r2。

### 60. 拉曼 P&E 在错误坐标与参数约定下持续拟合

**实际结果**：T71 正常执行 51m02s、67 turns / 66 Tool calls、1 次 compaction，官方仅文件存在项通过，两个峰失败（1/3，reward 0）。这次不是 Docker 故障或无效 trial。

**确定原因**：结束后核对参考脚本，模型漏了 `x = 1e7 / x` 坐标转换，直接用原始第一列筛选峰窗口；使用的 gamma 是半高全宽，而参考公式对应半高半宽，offset 约定也不同。模型随后反复调窗口和背景、增加数值优化迭代次数，把错误窗口里的异常曲线解释为噪声，最终只核对 JSON 结构。初始坐标错误在压缩前已存在，不支持“压缩导致首次走错路线”的归因；不能排除压缩强化错误假设。原题没有完整写出单位和参数公式，也需保留题面歧义。

**处理状态**：已记录证据与分析，未更改主干或任务 Prompt，未把隐藏参考解法注入下一组。适合后续验证的是模型能否检查数据单位、参数约定和异常残差后重新审视基础假设，而不是给通用 Prompt 硬编码本题答案。本轮未调用 Reviewer，P&R 尚未测试，不能宣称 Review 能纠正此类错误。详情见[低分扩展报告](archive/plan-low-score-expansion-20260904.md#t71拉曼-pe-最终结果与归因)。

## 已知但尚未被充分证明的边界

### 2026-09-05 轻量 Working Plan 首测：咨询仍复用严格合同（待修改）

KV 新 optional 运行官方 5/7、reward 0，13 轮正常收尾，无 compaction。原始请求字段 value 被模型写成 val，自测也沿用错误字段；属于实现/合同对照错误，不是摘要丢题。Review 三次 Provider 响应分别在 findings.proof 和 findings.proof.unresolvedAssumptions 校验路径失败，最终 unavailable；没有复现旧 blocked 空转，也没有有效审查报告。

`workingPlanService.ts` 仍设置 requireProofAudit=true 并调用严格 `ProviderSemanticReviewerV1`，使“非强制咨询”继续承担强证明格式。冻结证据只有 Tool observation，write 成功回执没有源码，模型所用自测命令也没有配对传给 Reviewer；原题完整、无外层预算截断仍不等于可检查内容充分。失败响应只保存 digest/路径而无原文，无法进一步区分真实未解决假设和无意义占位文字。

**已验证**：清单落盘、失败咨询不阻塞、Review 实际用量进入 terminal。**尚未修改**：独立轻量咨询合同、权限内请求/结果或源码快照配对、可复现的失败响应诊断。不要通过吞掉矛盾并返回 accepted 来“修复”，也不要硬编码本题字段。完整题面、代码落点和后续顺序见[首测报告](archive/working-plan-validation-20260905.md)。

**后续处理状态（同日）**：上述三个代码方向已经实施，详见[改进与复验](archive/working-plan-advisory-improvement-20260905.md)。全量 1135 通过、5 跳过；新 MiniMax 运行 Review 单次响应有效、11/11 请求结果配对、正常收尾。但官方仍 5/7：Reviewer 看到完整源码与原题，仍把错误字段判为支持。咨询协议可用性已修复，模型原始要求对齐/自拟 criteria 判断偏差尚未解决；不能把这两种状态合并成“全部已解决”。

### 本轮新增待处理项（T72–T74，尚未实施修复）

- **摘要降级与陈旧待办**：G-code 12 次 compaction 中 8 次模型摘要降级、4 次成功；规则摘要从历史“接下来……”叙述不断累积 pending，缺少可靠关闭语义。现有 provenance 不保存降级错误原因，无法准确区分 deadline、Provider 或格式问题。MTEB P&E 的一次语义摘要成功，排除接口普遍不可用的说法。不要把降级全部归因于 MiniMax，也不要把后期所有重复探索归因于压缩。
- **历史证据被当前证据替代**：MTEB 的 Root 和两次语义 Reviewer 均把“当前排名 + 模型早于指定日期发布”当作“指定日期时的排名”，Final accepted，但官方 1/2、reward 0。完整证据传递和独立 Review 不足以保证证据与时间条件等价。
- **独立 Reviewer 用量未汇总**：T74 terminal/Harbor 只反映 Root 用量，两次 Reviewer 的 70,755 输入、256 缓存读取、3,080 输出另存在 `review_call_attempts.usage_json`。可恢复账本不等于终态统计完整；历史费用比较需要注明口径。本轮报告已补已知合计，没有声称主干已修复。

完整题面、路径、错误接受与用量证据见[历史低分扩展报告](archive/plan-low-score-expansion-20260904.md)。

### 2026-09-05 后续实现状态

以上是当时的实验发现。后续已实现 Review 原任务合同贯通、deferred 状态、逐项反馈、冻结证据补读、受信 Host 检查器注册、实际 Review 用量汇总、压缩降级原因及动态意图合并。详见[通用优化与回归记录](archive/plan-review-generalization-20260905.md)。这证明对应机制已修改，不代表旧失败题已重跑通过，也不保证模型不再发生语义误判。

### 其他边界

- **2026-09-06 MTEB 收尾补证**：官方 2/2、reward 1。轻量咨询 needs_fix 后 Root 补跑八个候选对比，正常收尾，无重复 Review；这验证建议不阻塞执行，不证明 Review 决定了答案。Git 加入日期仍不自动等价于历史榜单快照；咨询有分类计数 29/总数 28 不一致，历史日期 finding 的理由缺失被标为 unverifiable。没有吞掉不确定性，但语义准确度与建议的可操作性仍需改进。本次未修改主干或 Prompt，详见[最终结果与边界](archive/working-plan-low-score-20260905.md#8-mteb-最终结果与本批收尾2026-09-06-0027-核对)。

- **2026-09-05 轻量 Plan 低分题复验**：采样器 8/9 的失败发生在官方位置参数调用与实现 API 不兼容，尚未进入采样统计检查；题面未明确完整函数签名，保留评测合同歧义。咨询认可自测不等于接口兼容。Scheme 官方 63/63，但咨询 summary 仍记录更深层自解释的递归/超时限制，五项 findings 全 passed 不应被解释成所有范围均已证明。两题 Runtime 正常收尾，分别 4/6 次 compaction；没有证据把这些语义边界归因于压缩。当前只补证据，未做主干或 Prompt 修改，详见[本轮结果](archive/working-plan-low-score-20260905.md#7-已完成两题的官方结果与归因2310-核对)。

- Provider-aware capacity 目前有真实单机 SQLite 证据，尚缺远程多 Worker、高并发重复压力数据。
- MiniMax capacity=2 时，Root 在 `agent.wait` 内仍持有 AgentTask Lease，因此两个 Child 在本次实验中顺序运行。该行为安全且可恢复，但“纯等待 Root 是否应临时释放 Provider lane”尚未设计和压力验证。
- 硬重启与多次 compaction 各有代表运行，不足以估计故障率。
- cross-review 能按 DAG 完成，但模型能否稳定一次生成正确图仍受模型能力影响。
- prompt injection 只有 2 个攻击样本，不能覆盖间接注入、数据外泄和跨工具组合攻击。
- Terminal-Bench 结果来自小批次、单模型和本地环境，不是官方 leaderboard 提交。
- 真正的外部副作用不确定（调用抛异常且没有结果）仍会让 Activity 进入 `unknown`；这是保守的正确语义。后续还需增加更多真实网络断连、receipt 写失败和重启恢复注入，验证不会误重放或误完成。
