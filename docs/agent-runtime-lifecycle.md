# 一次 Agent Run 的完整生命周期

核对日期：2026-09-06。English summary: follow one request through execution, persistence, review, memory, and recovery.

## 1. 先分清四个对象

Session 是可以多次续聊的会话；Run 是其中一次用户请求的执行；Working Plan 是模型按需维护的清单；Task/Lease 是 Runtime 的执行工单和暂时所有权。一个 Run 没有 Working Plan，也仍有执行工单。

```text
用户输入
→ CLI / SDK 发 session.prompt
→ Runtime 固定本次任务合同、记录 Run
→ 创建执行容器和 Root Task，领取 Lease
→ AgentLoop：装配上下文 → 调模型 → 执行工具 → 读取结果 → 继续
→ 收拢实际 Child，检查 Host 的完成要求
→ 持久化唯一终态 → 向客户端发送事件
```

## 2. 输入和启动

CLI 编译普通文本、Skill 或 Prompt Template，再通过协议交给 Runtime。Runtime 校验参数、选定模型和 Planner policy，并将 PromptEnvelope 的有效文本固定为本 Run 的逐字任务合同。它不是模型摘要，也不能由后续 Plan 重写。

`RunCoordinator` 管理 Session/Run 生命周期；`AutoWorkflowPlannerV1` 和 `WorkflowOrchestratorV1` 创建执行容器。Task、Attempt 与 Lease 让后续执行有可恢复身份。这里没有额外的“先问模型选模式”请求。

启用本地长期记忆时，Root 在新 Run 按项目身份检索候选并固定召回快照。每轮只占用正常任务/历史选择之后的剩余预算；发送模型请求前检查 Session 是否因记忆撤销而失效。新项目默认 off，Child 不获得父记忆库访问权。详见[长期记忆](long-term-memory.md)。

## 3. 一轮 AgentLoop 做什么

1. 检查取消、显式预算和待处理指令。
2. 读取消息，装配固定指令、任务合同、最新 Plan、稳定 ContextView 和消息后缀。
3. 如达到压缩条件，保存新的 checkpoint，再构造 Provider 请求。
4. ProviderRouter 选择已授权模型、调用适配器，汇总流式文本、Tool call 和 usage。
5. 有 Tool call 时交给 ToolRuntime；按 Schema、权限、资源冲突和副作用类型调度。
6. 将实际返回值持久化，作为下一轮观察；没有新工具时尝试结束。

“模型说我已完成”不是 Runtime 终态。流式 delta 也不是已提交的完整消息。真正完成必须经过收尾路径，由 Runtime 提交并发布 `prompt_completed`。错误、Host 阻塞、取消分别为 `prompt_failed/prompt_blocked/prompt_aborted`，客户端不得把它们混为成功。

## 4. Plan 在哪里介入

默认 optional 的五个 Plan Tool 就像模型的持久笔记操作：创建、改清单、记进度、请教独立 Reviewer、放弃。没有强制按 Item 顺序执行，也不必先 start Attempt 才能写文件。Plan Item 的 blocked 不是 Run 的 blocked；Plan done 不是测试通过。

`plan.review` 冻结本次问题、原始任务和已记录 Tool 参数/结果，独立调用 advisory Reviewer。它不共享 Root 对话，不读 live 文件，不看到隐藏 verifier。报告回到 Root，由 Root 判断是否修改路线。咨询不可用也不自动阻断任务。

只有 Host 显式 required 才使用[严格 ReviewPlan](strict-review-plan.md)：工作要绑定 Attempt，审查时冻结证据，并通过 final gate。两套合同不能凭相同工具名混用。

## 5. 工具和 Child 如何推进

普通 read/grep 等返回可供推理的观察。write/process/network 的外部动作还经过 effect broker：先记录请求或 reservation，再调用，最后记录 receipt。本地 memory 工具另用 MemoryService 的权限、事务和 CAS 回执，不绑定 Plan Item 或 Workflow effect。exit code 0 只说明该命令报告成功，不保证实现满足题意。

`agent.spawn` 提交 Child 申请；Runtime 裁剪能力、创建持久 Task，返回 childId。Root 可继续工作，再 result、wait、steer 或 cancel。等待 all/any/quorum 是实际执行关系，不要求模型画 Join Node。

Child 有独立上下文和进程，目前固定 solo、不能再派 Child。Root 结束前仍要处理存活 Child 和未消费结果。改 Plan 不会自动停止旧 Child，也不会自动合并文件。详见[Child 与 Workflow](workflow-platform.md)。

## 6. 调度不是模型推理路线

Workflow Worker 根据 ready 状态、依赖、Provider capacity、冲突键和预算领取 Task。Lease 包含所有者、有效期、心跳与进展。它决定谁现在能执行，不决定模型下一步应该研究什么。

Provider lane 约束瞬时并发，不等于整个长任务允许的总轮数。默认产品路径不设置累计 turns/tools/tokens/墙钟上限，但显式预算、取消、上下文窗口、工具输出边界、审查重试和资源并发限制仍有效。没有上限也不意味着任务可无限进展或 API 免费。

## 7. 重启与故障处理

| 情况 | 保存的依据 | 正确处理 |
| --- | --- | --- |
| UI 断开 | Session/Run/Workflow 状态 | 重新查询或恢复，不能仅看旧屏幕 |
| Lease 过期 | Task、Attempt、effect 与 RetryPolicy | 安全任务重试；未知副作用进入人工处理路径 |
| 工具结果已提交但响应丢失 | invocation/request identity 与 receipt | 重放已有结果，不重复产生副作用 |
| Plan 编辑响应丢失 | Journal 操作身份和 digest | 幂等返回；不同输入不能伪装成重试 |
| Review 已开始但远端结果未知 | 冻结输入与 ReviewCallStore | 不伪造成功，不把同一个 started attempt 无限制重发 |
| Provider 格式或网络错误 | 错误分类、usage、预算 | 有界或预算内恢复；耗尽后如实结束 |
| 上下文过长 | portable checkpoint + retained tail | 换代上下文；原始任务和执行事实仍独立保留 |

重试可能创建新的基础设施 Attempt，不等于整个业务任务从头再做。未知外部动作不承诺 exactly-once。

## 8. 为什么 compaction 不是“忘掉历史”

Journal 保存原始消息，compaction 只减少后续发送给模型的内容。逐字任务合同和当前 Plan 在可压缩历史之外；模型摘要不能改写权限、真实文件变更或 receipt。成功 compact 后 ContextView 换代，最近消息保留为继续执行边界。

但模型仍可能误读原始要求，摘要中的决策也可能错。要诊断失败，应依次检查原始题目、工具输入输出、checkpoint、Reviewer 输入和官方 verifier，而不是仅凭 Token 多就归因于压缩。详细规则见[Prompt 装配](prompt-assembly.md)。

## 9. 阅读源码的顺序

- 接入：`framework/runtimeKernel.ts` 的 `session.prompt`。
- 生命周期：`session/runCoordinator.ts`、`session/sessionService.ts`。
- 执行容器：`workflow/autoWorkflowPlanner.ts`、`workflow/workflowOrchestrator.ts`。
- 模型循环：`loop/index.ts`；工具：`tools/toolRuntime.ts`。
- 轻量计划：`working-plan/workingPlanService.ts`；严格验收：`review-plan/`。
- 跨 Session 记忆：`long-term-memory/memoryService.ts`、`long-term-memory/tools.ts`、`prompt/memoryContext.ts`。
- Child：`subagent/childRuntimeHost.ts`；执行账本：`workflow/sqliteWorkflowAuthority.ts`。

以上路径相对 `apps/runtime/src/`。具体实测能力和未覆盖窗口见[测评档案](evaluations/README.md)，不能仅凭“有恢复代码”宣称所有故障都能自动恢复。
