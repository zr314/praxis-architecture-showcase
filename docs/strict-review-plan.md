# 严格 ReviewPlan：仅显式 required

核对日期：2026-09-05。English summary: explicit host-required acceptance, not the default working-plan contract.

本文只描述 `auto/solo + planPolicy=required`。默认 optional 使用[Working Plan](working-plan.md)，即使创建清单也不会升级为这里的强制状态机。显式 legacy workflow 与 required 在入口被拒绝。

## 1. 为什么保留严格模式

需要 Host 强制检查证据与批准终态时，可选择 required。模型提出目标、步骤和验收条件，Runtime 管理版本、Attempt、证据、授权与决定。它不是模型认知路线的完整存储，也不是通用正确性证明。

ReviewPlan 是有序 Item 列表，没有 DAG dependencies/edges/join。执行仍复用 Task/Lease/effect 底座。模型不能直接写 accepted/completed，不能降低 Host policy。

```powershell
praxis --planner solo --plan-policy required --print "完成工作并按要求验收"
```

## 2. 五个工具的严格合同

| 工具 | 必要输入/行为 | 约束 |
| --- | --- | --- |
| plan.create | objective、acceptanceCriteria、items | criterion 有 id/description/kind/required；Item 关联 criterionIds |
| plan.update | expectedPlanRevision + 完整新定义 | 替换合同；保留必要要求，不能用改文字绕过授权 |
| plan.progress | expectedPlanRevision、itemId、action | start/focus/block/request_skip；不是任意设置 done |
| plan.review | expectedPlanRevision、scope、summary | item 或 final；Runtime 收集证据，不让模型猜内部 evidenceRefs |
| plan.abandon | expectedPlanRevision、explanation | 需要精确 Host grant；模型不能自行降级 required |

所有 Schema 拒绝未知字段。运行身份和 invocationId 由 Runtime 注入。精确参数以 `apps/runtime/src/review-plan/tools/` 为准。

普通工作绑定 focused/open Item Attempt。控制工具保留批次 barrier；模型应读到控制结果后再发依赖它的工作工具。accepted Item 不能直接重开旧 Attempt；后续修复需要合法更新并建立可执行 Item。

## 3. 生命周期

```text
create → active
start Item → running Attempt → item review
                            → accepted
                            → needs_fix → 新 Attempt
                            → blocked
全部满足必要条件 → final review → completed / needs_fix / blocked
```

即使只有一项，也先 item Review，再 final Review。最终语义审查不能由“命令返回 0”替代。结束回答和 terminal Tool 都经过同一 completion gate，不能用文本宣称通过。

Plan mutation 通过 invocation identity、payload digest 与 Journal CAS 提交。相同操作重放返回原回执；相同身份不同输入拒绝。Plan Attempt 是一轮业务修复，Workflow Attempt 是一次基础设施执行，两者不同。

## 4. 证据冻结和两类检查

Review 在调用模型前保存 prepared 输入 Artifact 与 Journal 事件，固定 Plan revision、Item Attempt、条件、原始任务、摘要和证据引用。prepared fence 期间拒绝相关工作变更。模型 summary 只是候选陈述，不是执行证明。

机械检查的模型可见类型包括 file_rule、content_digest、tool_receipt、effect_receipt、artifact_or_child_result；Host 可注册 registered_check。注册检查器代码由 Host 提供，模型不能注册任意执行器。旧 Journal 可解码的 checker 不代表当前全部开放。

文件存在或精确 digest 只能证明对应精确事实。Tool/effect/Child 回执只能证明来源和执行状态，仍可能需要语义判断是否覆盖用户要求。final 始终进行隔离 Semantic Review；原始任务优先于模型自拟 criterion。

## 5. Semantic Reviewer 的边界

Reviewer 使用固定 `REVIEWER_INSTRUCTIONS_V1`，不共享 Root 对话；只接收此次冻结的 neutral JSON 和允许的证据。

- 原生 structured output：空 tools + strict JSON Schema。
- 其他 Provider：强制受限 submit 工具。
- 当接线允许且证据截断时，可使用 read_review_evidence 读取本次冻结片段；没有 live 文件、网络或隐藏测试权限。

严格结果逐项绑定 criterion 与可用 evidence ref，校验 proof/decision。格式有效不保证语义正确；模型仍可能错误接受或拒绝。完整 Prompt 与 Schema 见[模型请求目录](model-request-catalog.md)。

Review 输入有描述符、预览和补读预算，遗漏与截断必须明确；完整执行记录不因此删除。这些是单次审查资源边界，不是整个任务的累计 Tool 上限。

## 6. 恢复与耗尽

冻结请求、ReviewCallStore、ReviewBudget 和调用身份共同支持恢复。已知成功重用原结果；已开始但远端结果未知的尝试不会冒充成功。格式/传输最多三次 Provider 尝试，其他修复/replan/no-progress 预算由受信 Runtime policy 管理，不由模型 Tool 随意扩大。

预算耗尽或需要 Host 决策时安全进入 blocked，清理 prepared 状态，不伪造验收结果。`prompt_blocked` 贯通 Runtime、协议、CLI 和 Agent SDK。它与 optional 咨询 unavailable 后继续执行不同。

Session Journal 与 Workflow Authority 是两个领域存储，不承诺跨库 ACID。稳定 requestId、执行绑定与 reconciliation 用于补齐提交窗口；不能以“有表和恢复函数”推断所有分布式故障已验证。

## 7. 源码入口与适用建议

- `review-plan/planControlService.ts`：变更、授权、Attempt 与状态。
- `review-plan/reviewCoordinator.ts`：冻结、检查、决定和完成门。
- `review-plan/semanticReviewer.ts`：Provider 传输和严格响应合同。
- `review-plan/reviewCallStore.ts`：调用尝试与诊断。
- `packages/core-sdk/src/review-plan*.ts`：领域类型和事件归约。

以上 Runtime 路径相对 `apps/runtime/src/`。通用长任务先使用 optional；只有业务确实需要 Host 强制验收才选择 required。历史 P&R / P&E 测评分开记录在[测评档案](evaluations/README.md)，不能拿旧严格结果证明当前轻量默认的效果。
