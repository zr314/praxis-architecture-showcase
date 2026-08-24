# 项目状态

最后核对：2026-08-24。测评结论、实际题目、问题修复和证据等级见[持续维护的测评档案](evaluations/README.md)。

## 已接入产品路径

- 独立 Runtime 进程、NDJSON JSON-RPC、Ink TUI 与非交互 print 模式。
- `@praxis/client` 提供高层 `defineAgent`：`run/stream/resume/abort`、Run 级 application instructions、typed state/output，以及输入、事件、权限、结果和错误 middleware；单一通知泵按 Run 多路复用事件，同一连接可承载并发 Agent Run。
- `@praxis/runtime/run` 提供可信宿主 middleware：`beforeModel/afterModel` 与 `beforeTool/afterTool`；Tool 改写发生在 schema、target 和权限计算之前。每 Hook 有 deadline，连续失败触发冷却/half-open 熔断，`runtime.doctor` 暴露无原始内容的有界健康快照；非法、超时和熔断分别以稳定错误码 fail-closed。
- Child Runtime 默认不继承父进程 middleware；仅带稳定 `childId`、显式 `registered` 策略且由 Child 入口 registry 解析的实例，才会通过认证 bootstrap 按 ID 重建。闭包与宿主权限不跨进程序列化。
- 新 Session 默认 `auto`；`solo/workflow` 是同一实现的 policy override。
- 每个 Prompt 事务创建 durable Workflow、Root Node、Attempt、Task 和 Lease。
- 默认 `auto` 的模型协作面已改为 `agent.spawn`、`agent.wait`、`agent.result`、`agent.cancel` 和 `agent.steer`；模型不再需要编写完整 DAG。显式 `workflow` policy 才额外提供 `agent.delegate/handoff` 与 `workflow.expand/loop/wait/subworkflow`。
- `agent.spawn` 返回稳定 `childId` 后 Root 继续同一个 ReAct；Child 生命周期、后台 Task、等待、终态 result/error 和 Artifact 引用仍由 Authority 持久化。Child 被标记为可选证据分支：必须结构化收敛，但其失败或取消不自动否定 Root 的最终结果。
- `workflow.expand` 使用事务化图准入与独立 durable scheduler；依赖由 Journal 状态释放，claim 二次核验，重建 scheduler 不重复成功节点。
- Graph 支持确定性条件边、未选分支 `skipped`、持久化 `all/any/quorum` join，以及通过连续 GraphPatch 展开的有界无环循环；每轮都有独立 Node、Attempt 和证据引用。
- Handoff 持久化为 synthesis Node；Subworkflow 使用独立 Workflow ID，并记录父 Workflow/Node 身份，Child 禁止继续创建 descendant。
- `workflow.wait` 创建真实 HumanTask 或 Timer Node；在线 wake pump、启动补扫、到期处理和 `/human-*` 命令推进同一 projection。
- 所有可变 Tool 进入统一 effect broker；Child MCP/process/API 通过父 `ToolRuntime` brokered view，不能绕过 schema、权限、Activity、receipt 或补偿。
- 幂等 effect 在调用前原子 reservation；并发重复不会同时执行，committed 结果重放完整 ToolResult，输入冲突拒绝。
- 模型可申请 `default/worker/explorer` 三种同构 Child Harness，并逐 Child 装配 Prompt、Tool、Skill、MCP、workspace、模型/档位、推理强度、返回 Schema 和成功标准；Runtime 负责裁剪。默认 `agent.spawn` 的数值预算继承父 Run/组织策略，显式 Workflow 节点仍可申请任务预算。
- Task 持久化原始装配/能力申请；不可变 execution snapshot 保存 effective assembly、Capability Bundle digest 和 denied 项。旧 coordinator/researcher/coder/reviewer/verifier Profile 仅作内部或历史兼容，版本与内容 digest 不可变。
- 真实独立 Child Runtime/Session/上下文/Tool Loop、fd 认证、credential broker、Capability Bundle、权限转发和原始结果 Artifact。
- Child 可使用获准 Builtin、Skill、MCP、Shell 和 workspace write；迁移第一阶段仍禁止 descendant，受认证的递归 spawn broker 尚未接入。
- 可写 Child 在 Git 仓库使用 worktree、候选 commit、父侧校验和 fast-forward；非 Git 目录使用私有快照仓库和摘要校验回写；阻塞时保留 recovery path。
- Workflow SQLite authority：event/projection、task/lease、outbox/timer/signal/human task/profile、execution snapshot ref、budget charge、effect reservation 和公平调度状态。
- 启动与后台过期 Lease recovery：安全 effect 创建新 Attempt，未知副作用进入 unknown/manual；durable Worker pump 自动接管 Root/Child ready Task。
- 认证的远程 Authority/Artifact HTTP 边界；远程 Runtime 竞争同一 Lease，不共享 SQLite 文件。
- Workflow Protocol：get/list/events/signal、pause/resume/cancel/terminate、HumanTask list/resolve 与 `workflow_update`；TUI 渲染真实 projection。
- 暂停阻止新 Lease；取消/终止同步中止父 Run、后台 Worker、Child Host 和权限请求；Signal、HumanTask 和 Timer 使用幂等事件唤醒 waiting Workflow。
- unknown 节点必须先显式 resolve；failed 节点在 RetryPolicy 内可由 `retry-node` 创建新 Attempt。
- Session V3 JSONL/SQLite 可选双后端，JSONL Catalog 增量更新和启动快速路径。
- 父 Agent 使用 journal context view；旧 CompactPlan 不再创建、注入或作为 plan 查询来源。
- 默认 Prompt 程序为 `iron-law-lean-v1` 1.2.0：每个请求只有一个 Trusted Instructions block，动态 runtime/Skill/project 内容作为中性 context；`runtime_facts` 包含结构化 shell dialect；多要求任务有通用最终验收合同；用户已授权目标时，模型负责选择可验证、优先可逆的实现方法并在单一路径失败后尝试安全替代。`baseline-v1` 保留为显式回滚，默认 system Prompt 装配预算统一为 4,096。
- 生产 Prompt 不向模型展示笼统的 high/low trust 等级；Runtime 内部来源元数据仍保留，权限、来源与事实验证分别由 authority/provenance/verification 表达和执行。
- Run 内冻结模型可见 ContextView，成功 compact 后才换代；reasoning 与 Tool result 只编辑 Provider 发送视图，SessionJournal 原文不变。
- Portable semantic checkpoint 始终是恢复底座；OpenAI Responses 可叠加精确绑定的 native compact，Child 通过 credential broker 使用同一路径。
- Semantic checkpoint 使用字段级所有权：用户任务/签名 Packet 决定 objective 与 constraints，Packet/成功 Tool 证据决定 refs、read/modified files，模型只补充 decisions/unresolved/active plan，不能用合法 JSON 把推测升级成权限或副作用事实。
- v4 长生命周期产品路径不再隐式设置 turns、Tool calls、tokens、wall clock、累计 Child、depth、loop 或图演化次数上限；只有用户、CLI、组织策略或节点 Proposal 的显式 budget/deadline 才会收紧。
- Local Runtime 同时启动 Child 的容量为 256，这是 worker-pool 并发度，不是累计任务配额。
- Kimi/通用 Provider 429 和暂时性 5xx 错误分类保留为 budget-bound retryable。
- TUI Composer/Transcript 分离、窗口化历史、独立 Spinner 和鼠标回滚。

## 稳定 Tool closure

- 可用：write/edit 支持 `expectedDigest`，在真实写入前检测 TOCTOU；冲突不会覆盖用户的新修改。
- create-only、whole-file edit、分页 read 与结构化 Shell stdin 的准确合同见 [Tool Policy](tool-policy.md)。

## 已删除的产品路径

- `ProductSupervisorPlannerV1` 总控类。
- 固定两路只读 Supervisor fallback。
- Direct/Supervisor Planner 实例二选一。
- Supervisor 失败后父 Runtime 从头重做的产品逻辑。
- 新 Run 写入或注入 CompactPlan。

旧输入 `direct/supervisor` 仅为迁移别名。旧 `supervisor_update` 类型和底层 DAG/Verifier 组件暂时保留，用于历史数据兼容、评测或作为 Workflow 底层库；Router 不会选择旧产品流。

## 当前明确未完成

- PostgreSQL Workflow authority；当前远程 Worker 使用认证 Authority 服务作为单一写入点。
- 跨租户的 Provider 公平配额和持久分布式熔断；当前已交付跨 Workflow 公平 claim 与单 Worker 熔断。
- 跨天高可用通知渠道与 TUI 一键审批；持久等待节点、CLI 审批、到期唤醒和 Root/Child 恢复 pump 已接入。
- 任意递归 Subworkflow 和进程重启后自动续跑中的动态 GraphPatch；当前 Subworkflow 是独立但非递归的，循环是有界无环展开。
- Agent Run Tree 的任意层级递归委派；当前 Root 已使用异步 Child 句柄，Child 自身仍固定 `solo`。后续只持久化 Parent/Child 生命周期和 wait/result，不把 Child 的自然语言 Plan 提升成外层 Workflow DAG。
- 自动补偿策略与各外部系统的 compensation descriptor；统一 broker 和双 receipt Saga 账本已接入，设计明确不承诺 exactly-once。
- Artifact 的跨 Workflow ACL/retention 与独立对象存储；当前远程 Worker 通过认证 Artifact RPC 读写 Authority 端内容寻址存储。
- 崩溃恢复的规模化终态一致性验证；当前 MiniMax 单次硬杀进程树已做到同 Workflow、成功 Attempt 不变、中断 Attempt 重试、join/root 收敛且无非终态 Task，但尚无重复故障分布。
- 多次 compaction 的大样本保真率；当前 MiniMax 单次压力运行完成 19 个递增 checkpoint，目标/禁止项/最终合同和关键参数全部保留，但尚未覆盖错误码、Child Artifact refs 等完整 fidelity 集合。
- Anthropic server-side compaction、thinking clearing、显式 cache blocks，以及达到工具规模门槛后的按需 Tool Search。
- 真实浏览器与公共 Web Search；当前本地 HTTP/静态 DOM 任务已通过，但不能据此宣称支持 JavaScript 浏览器、登录态或外部网站检索。

这些是 [Planner Platform RFC](planner-platform-rfc.md) 后续阶段，不能从表结构或类型定义推断为已交付。

## 已有测评证据

| 范围 | 当前结果 | 允许得出的结论 |
| --- | --- | --- |
| Harness-Bench | 历史 Kimi 3 题 Praxis 平均 combined `0.9219`、Pi `0.8319`；MiniMax 当前 106 题有效代表快照均分 0.8269、中位数 0.8883、28 个满分；它混合多个修复阶段，不是同版官方全量批次 | direct 路径可完成代码、本地 API/DOM、结构化数据和长 ReAct；模型精确验收仍有明显方差。raw 与合同调整分必须分开，不是排行榜结论 |
| Harbor 历史 3 题 | 3/3 正常结束，reward `1/3` | 早期容器主链路样本；保留作历史基线 |
| Harbor MiniMax M3 扩展 | 中等批次 20 个有效 rollout 中 15 个通过；后续额度耗尽批次 6 个有效 rollout 中 4 个通过，另 1 个 Provider 中断无效；档案共 20 道不同通过题 | 长 ReAct、受损数据库恢复、语言迁移和自主推进路径可用；单模型小样本、含修复回归，不是排行榜结论 |
| AgentDojo 7 次 | 7/7 framework completion；clean 3/3；本样本 attack goal 0/2 | MCP 与基础权限边界可用，不是安全统计保证 |
| Quorum / cross-review smoke | 3 Child 与 5 Child 场景均 `prompt_completed` | 真实 Child DAG、并行 join、quorum 和 cross-review 可运行 |
| Agent Run Tree A/B | 自主组 0 Child；受控修复组 2 Child、spawn/result/wait/result，Root 与两个 Child 全成功 | 默认 Run Tree 工具链与失败隔离可用；MiniMax 是否委派和最终综合仍有明显方差 |
| Agent Run Tree 动态改计划 | 两次真实 MiniMax rollout 均完成 spawn×2 → cancel → steer → wait → result；修复后 Root succeeded、旧 Child cancelled、保留 Child succeeded | 已证明模型可在 Observation 后放弃旧路线并向排队 Child 持久追加要求；最终 marker/事实综合仍受模型方差影响 |
| 长 cross-review recovery | 只复用旧 Artifact 运行 1 个 synthesis Child，四项 criterion 全通过 | 结构化 Child 终态与失败后局部恢复已验证 |
| Restart recovery | MiniMax 单次确定性硬重启完整通过 | 持久接管、成功节点不重跑、中断节点新 Attempt、join/root 终态一致在该样本成立 |
| Compaction/cache | DeepSeek 单次 compact 成功；MiniMax 19 次 checkpoint fidelity 通过；lean 后四轮 input 减少约 6.1% | 压缩路径和关键合同保真可用；仍缺多类型、大样本分布 |
| MiniMax CN | M2.7/M3 smoke、M3 Child DAG restart、M3 multi-compaction 均跑通框架路径 | Provider、Child broker、恢复、semantic compact 与 usage 解析可用；严格模型服从仍需单列 |

## 质量门

提交前必须通过：

```powershell
npm run check
npm run build
npm test
npm run install:local
```

完整测试包含真实 Runtime/PTY 进程。测试 runner 必须能在超时或失败后关闭子进程；若全量脚本静默超时，应分组运行并检查残留 Runtime，而不是把超时当作通过。

## 主要入口

- `apps/runtime/src/workflow/`：统一 Workflow 纵向切片。
- `packages/core-sdk/src/workflow.ts`：Workflow 领域合同与 reducer。
- `packages/core-sdk/src/workflow-port.ts`：Authority/Task/Lease Port。
- `apps/runtime/src/framework/runtimeKernel.ts`：产品接线。
- `packages/protocol/`：Workflow 方法、事件与 Schema。

面向用户的解释见 [Agent Run Tree 与可选 Workflow](workflow-platform.md)。
