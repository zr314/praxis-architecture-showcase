# 轻量动态 Plan：工作记忆、执行事实与验收分离

更新：2026-09-05。当前默认行为，不是未来建议。English summary: working Plans are editable memory; execution remains autonomous, and reviews are opt-in snapshot-scoped reports.

## 新手先看

默认 `auto/solo + planPolicy=optional` 仍运行一个自主 AgentLoop。模型认为有帮助时才创建任务清单；清单可以在执行中修改、重排、重开、完成或放弃。它不是执行许可证，也不是另一份高于用户要求的合同。

例如模型先打算“搜索 API → 下载数据 → 生成报告”，发现 API 不可用后，可以直接改为“读取本地数据 → 说明覆盖范围 → 生成报告”。不需要先将当前步骤 blocked，再创建一个修复 Attempt；但不能擅自降低用户明确要求，也不能把没有取得的数据编出来。

三个概念分开：

| 概念 | 所有者 | 能做什么、不能做什么 |
| --- | --- | --- |
| Working Plan | 模型 | 记录意图和自报进度；可以修改，不授予权限，不证明正确 |
| 执行事实 | Runtime | 保存真实 Tool、Child、effect 和结果；改计划不能抹去历史或取消进程 |
| Review | 独立审查调用 / Host 政策 | 普通咨询仅给快照报告；显式 required 才有强制验收门槛 |

`done` 是自报进度，意思是“执行 Agent 认为做完了”，不是“已经由外部验证器证实”。官方 benchmark verifier 的成绩仍独立记录。

## 五个工具，新的默认合同

| 工具 | 输入重点 | 行为 |
| --- | --- | --- |
| `plan.create` | objective、items；每项 id/title，可选 status | 创建持久清单，不要求验收条件或步骤映射 |
| `plan.update` | 可选 objective、items、state、expectedPlanRevision | 替换清单、增删重排或重开；可以在执行过程中修改 |
| `plan.progress` | itemId、status；可选 expectedPlanRevision | 直接更新 pending/in_progress/done/blocked/skipped |
| `plan.abandon` | 可选 expectedPlanRevision | 自主放弃普通计划，不需要 Host grant |
| `plan.review` | 可选 question、criteria；无 Plan 时必须提供 question | 对已记录证据请求隔离审查，返回咨询报告，不阻止执行 |

Plan 的 state 是 active/done/abandoned。Item 的 blocked 只是“这一步暂时走不通”，不自动产生 `prompt_blocked`。已 done 的 Item 可直接改回 pending/in_progress。模型也可将 Plan 整体标为 done，而不必给每项做独立审查。

`expectedPlanRevision` 是可选的防并发覆盖检查：带它时，陈旧版本被拒绝；不带时，对最新清单做串行编辑。Runtime 仍使用 Journal CAS 保证原子提交，相同 invocationId 重放不会再次修改。

计划编辑可以与普通工具出现在同一模型响应中，按现有工具冲突调度执行，不再自动拒绝兄弟工具。若某个工具依赖另一工具尚未返回的结果，模型仍应等待结果再构造参数。严格 required 模式仍保留控制 barrier。

## 执行层到底改了什么

默认 Root 不再要求 focused/open Attempt；旧 optional Session 中残留的 ReviewPlan fence、blocked、accepted Item 不会继续约束新 optional Run。它们不被删除，仍可追溯。

普通工作继续经过原来的 ToolRuntime 权限校验和 WorkflowEffectBroker；写文件、外部操作、Child 调度与恢复并没有变成直接调用。Plan 不决定是否派 Child；改清单也不会自动取消、重启或重复派发 Child，更不会回滚已写文件或撤销外部副作用。需要取消时仍明确调用 `agent.cancel`，修改 Child 目标用 `agent.steer`；文件撤销是另一项需要正常授权和验证的操作。

模型结束回答时，optional Plan 的 pending、blocked、未审查等状态不会强制续轮。未完成的真实 Child 等原有生命周期约束仍按 Runtime 的执行合同处理。用户或 Host 设定的权限、预算与强制验收不能由模型修改 Plan 解除。

## 持久化和恢复

没有新增“只存在内存里”的捷径，也没有独立 Plan 数据库。SQLite / JSONL 两种 Session Journal 后端都支持三个新事件：

- `working_plan.saved`：原子保存一份清单快照、操作身份与输入 digest。旧快照保留在 Journal。
- `working_plan.review_requested`：冻结审查输入 Artifact 和请求身份，在 Provider 调用前落盘。
- `working_plan.reviewed`：保存独立报告引用，绑定输入快照而不是给清单发成功证明。

SessionProjection 增加 `workingPlan` 与 `workingReviews`；`session.plan` 返回当前清单，另带严格历史状态和咨询记录。TUI `/plan` 能识别 items/status，不再只认旧 steps/state。

`session.plan` 是只读查询，Run 结束并从内存卸载后仍可查看，不会为查看而重新打开 Session。fork 复制所选消息位置之前的工作清单，并分配新的 Plan identity/revision；不复制审查接受状态、在途执行或权限。显式 legacy workflow 与 required ReviewPlan 不混用，入口会提示选择 auto/solo，避免进入缺少 Plan 工具却要求验收的状态。

最新 Working Plan 会作为低信任动态上下文注入模型请求，独立于压缩摘要；不把它塞入固定 System Prompt。未创建则没有假 Plan。当前模式只注入一种 Plan 快照，避免旧严格指令与新清单冲突。

恢复成功/失败的 Reviewer 调用仍依赖 ReviewCallStore；未知远端结果不冒称成功，也不重新提交同一个已开始的 attempt。格式/传输重试最多三次，不限制任务的改计划次数。缺少该存储的定制 Host 无法调用持久 Reviewer，返回明确错误，但普通计划与执行可继续。

## 审查能证明什么

咨询使用当前 Session 已持久化的非 Plan 工具消息，带 Run/sequence 来源，并按 Run、Tool call ID 和工具名配对调用参数及返回结果，冻结成输入 Artifact。这样能检查刚写入的源码或实际验证命令；失败调用不能证明写入发生，旧成功调用也不能证明后来没有改动。请求缺失/歧义时明确标记，不从 assistant 的普通叙述补造证据。它不读取实时工作区、不访问任意路径、不注入隐藏测试。最近候选与总预览受输入预算限制；遗漏和截断明确标记，不能把未展示的内容假装成证据。

咨询使用独立 Prompt/Schema：summary 与逐项 supported（有支持）、concern（有问题）、unknown（不确定）即可，不再要求 proof 和验收 verdict。局部缺项、重复或非法证据引用降为不确定，其余意见保留；无法解析的顶层响应才按有限次数重试。兼容存储仍有 accepted/needs_fix 标签，但由 Runtime 从意见派生且始终 advisory，不能启用严格完成门。旧版在途咨询的冻结合同保持不变，恢复时仍使用旧 Reviewer；新请求使用 advisory-v1。

审查失败后可在本地 ReviewCallStore 查看经尽力脱敏的 submittedResponse（最多 64 KiB，截断明确标记）、校验路径和用量；不记录 Provider 隐藏 reasoning，不把诊断原文注入 Root，不自动上传。该记录不是完备的秘密扫描，也不是完整网络抓包，与 ReviewCallStore 共用本地保留周期。

报告绑定 planRevision、snapshotSequence、evidenceSequence。即便 accepted，也只是对这些旧观察和当前问题的判断；后续修改不会获得旧报告的自动背书。服务失败返回 unavailable，不把任务改成 blocked。新 advisory-v1 不让模型输出 blocked/verdict；旧合同恢复留下的咨询 blocked 也只是快照意见，不是执行门禁。

这仍是模型审查，可能误判。它不能替代可靠测试、事实来源或业务审批。当前没有自动判断每次工作区修改会使哪条审查失效，因此报告始终明确限定在快照，而不提供“当前已验证”的全局标签。

## 严格模式与兼容性

Host/API 显式传入 `planPolicy=required` 时，仍选择[严格 ReviewPlan](strict-review-plan.md)：旧工具 Schema、Attempt、冻结证据、授权、有限重试与最终验收继续有效。模型看不到修改 policy 的参数，不能用普通计划工具降级。

这是一次默认工具合同变更：旧客户端如果硬编码了 acceptanceCriteria / criterionIds，应明确选择 required，或改为新的轻量输入。旧 Journal 仍可读，新事件需要新版本 Runtime；不承诺老二进制可以读取升级后的 Session。两个策略不是同一场 benchmark 的可直接混用版本，应冻结构建再比较。

CLI/SDK 与 Runtime 应一起升级：`session.plan` 新增了策略及咨询报告字段，旧客户端的严格结果 Schema 可能拒绝这些字段。当前 monorepo 构建会同步更新协议包和客户端。

## 验证与边界

本地回归覆盖双后端编辑/重启/幂等、陈旧版本冲突、无 Plan 咨询、失败耗尽后继续编辑、Host required 防降级、普通批次不再拒绝兄弟工具、旧严格守卫保留，以及完成后的 Session 查询、fork 清单和协议兼容性校验。

真实验证的构建、测试计数、题目和问题处理统一保存在[测评档案](evaluations/README.md)。已有 KV 样本表明：咨询协议可以正常返回，但模型仍会语义误判，因此 done、advisory accepted 和 prompt_completed 均不能当作官方 verifier 通过。当前没有证明轻量 Plan 普遍提分。

源码入口均相对仓库根：`packages/core-sdk/src/working-plan.ts`、`apps/runtime/src/working-plan/workingPlanService.ts`、`apps/runtime/src/working-plan/tools.ts`；接线在 `apps/runtime/src/framework/runtimeKernel.ts`，存储归约在 `packages/core-sdk/src/session-journal.ts`。


## 无总预算的 Host 单任务入口

Host 的 `unbudgetedSoloRuns` 分支同样提供上述 Working Plan 工具与 Journal 动态快照；没有总轮次预算不代表关闭计划记忆。该直达 AgentLoop 的入口不安装严格执行 broker，因此 `planPolicy: required` 与无总预算组合会明确失败，不能把咨询工具当作强制验收。普通 optional Plan 保持自报进度语义，不自动延长或终止任务。
