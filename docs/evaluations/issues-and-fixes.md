# 测评发现的问题与处理方法

最后更新：2026-08-23。

本页不只列“报错了什么”，还区分问题发生在哪一层。对 Agent 平台来说，同一个失败表象可能来自模型、Prompt、Praxis、测评脚本、Provider 或 Docker；归错层会得到错误修复。

## 怎样判断责任层

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

**处理原则**：原始分永远保留；另记 contract-adjusted 结论并附字节/hash/题面证据。不能为迎合错误 oracle 给 Praxis 加 task-specific workaround，也不能把调整分冒充官方分。完整证据见[2026-08-23 代表性续测](minimax-auto-harnessbench-20260823.md)。

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

## 已知但尚未被充分证明的边界

- Provider-aware capacity 目前有真实单机 SQLite 证据，尚缺远程多 Worker、高并发重复压力数据。
- MiniMax capacity=2 时，Root 在 `agent.wait` 内仍持有 AgentTask Lease，因此两个 Child 在本次实验中顺序运行。该行为安全且可恢复，但“纯等待 Root 是否应临时释放 Provider lane”尚未设计和压力验证。
- 硬重启与多次 compaction 各有代表运行，不足以估计故障率。
- cross-review 能按 DAG 完成，但模型能否稳定一次生成正确图仍受模型能力影响。
- prompt injection 只有 2 个攻击样本，不能覆盖间接注入、数据外泄和跨工具组合攻击。
- Terminal-Bench 结果来自小批次、单模型和本地环境，不是官方 leaderboard 提交。
- 真正的外部副作用不确定（调用抛异常且没有结果）仍会让 Activity 进入 `unknown`；这是保守的正确语义。后续还需增加更多真实网络断连、receipt 写失败和重启恢复注入，验证不会误重放或误完成。
