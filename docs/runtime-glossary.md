# Runtime 名词表 / Runtime Glossary

以下解释对应当前实现。先看中文含义，再用英文名字找源码。

## 模型、计划与验收

| 名词 | 通俗解释 | 不等于 |
| --- | --- | --- |
| AgentLoop / ReAct | 模型看观察，决定调用工具或回答，再看返回值继续 | 预先固定全部步骤 |
| Harness | 包围模型的工具、权限、上下文、存储和恢复基础设施 | 模型自身知识或智力 |
| Host | 创建并配置 Runtime 的可信宿主程序，可指定政策或注册检查器 | 模型自己编写的指令 |
| Provider | 把统一模型请求转成某个供应商 API 的适配器 | Planner 或任务调度器 |
| Schema | 规定 JSON 哪些字段、类型和值合法的结构合同 | 对答案含义的正确性证明 |
| optional / required | Host 的计划政策：可选工作清单 / 必须严格验收 | 模型在 Prompt 里自行切换的开关 |
| Session | 可持续多次对话的会话 | 一次 API 请求 |
| Run | 一次用户请求从启动到终态的执行 | 一次 Provider turn |
| Turn | 模型的一次响应及相关工具处理 | 完整任务 |
| Working Plan | 模型可改的持久清单，默认 optional | 执行许可证、外部验收 |
| Item / status | 清单的一项和自报进度；done 表示模型认为做完 | 已被测试证明 |
| Advisory Review | 针对冻结观察的独立模型咨询 | 必须服从的审批或可靠验证器 |
| Strict ReviewPlan | Host 显式 required 的合同、Attempt 和验收状态机 | 默认 auto |
| Criterion | 检查条件；模型自拟条件仍可能遗漏或误译原题 | 自动等同用户全部要求 |
| Plan-and-Execute | 先列计划，再按步骤执行的一类策略 | 唯一确定的标准算法 |
| Plan-and-Review | 加入独立审查的策略族；本仓库必须区分轻量与严格版本 | 必然比 ReAct 得分高 |
| DAG | 无环有向图，可表达并行和依赖；显式 legacy workflow 使用 | 默认 Working Plan 的数据结构 |

## 协作与权限

| 名词 | 通俗解释 |
| --- | --- |
| Root / Child / Subagent | Root 是本次主 Agent；Child 是独立进程与上下文的子 Agent，目前不能再创建 Child |
| Run Tree | 父子执行关系；当前产品是 Root 加一级 Child，不是任意递归树 |
| Profile / Harness assembly | 为同一种 Child 执行器选择角色说明、工具、模型和边界 |
| Capability Bundle | Runtime 批准并固定的能力快照；申请不等于授权 |
| Broker | 父进程代理凭据或工具调用，避免把原始秘密和不受控对象交给 Child |
| all / any / quorum | 等待全部、任一或达到指定数量的子结果；不是“多数答案一定正确” |
| Steer | 在安全边界投递新指令；不是即时改写正在执行的系统调用 |
| Structured concurrency | Root 结束前必须处理实际 Child 生命周期与结果，避免遗留后台任务 |
| Worktree / directory snapshot | Child 的独立写工作区；父侧校验后才合并，Root 普通写入不自动使用它 |

## 持久化、恢复与证据

| 名词 | 通俗解释 |
| --- | --- |
| Journal | 按顺序记录已提交事件的账本 |
| Authority | 某类状态的权威存储，决定恢复时以什么为准 |
| Projection | 由事件计算出的当前状态，加速查询；不是另一份任意可写真相 |
| Task / Lease | 待执行工单 / 某 Worker 暂时拥有它的凭据与期限 |
| Attempt | 一次执行尝试；Workflow Attempt 和严格 Plan Item Attempt 属于不同层 |
| CAS / revision | 提交时检查版本，防止旧状态覆盖别人刚做的修改 |
| Idempotency / digest | 相同请求重复到达不重复执行；摘要用于核对内容是否相同 |
| Effect / receipt | 外部副作用 / Runtime 记录的实际调用结果；成功回执不等于任务语义正确 |
| Unknown effect | 不知道外部动作是否完成，不能直接当失败重试 |
| Artifact / evidence ref | 保存长结果的内容对象 / 对它的引用；有引用不等于内容有证明力 |
| Frozen snapshot / fence | 固定某次审查输入 / 严格模式审查期间禁止相关变更的栅栏 |
| Mailbox / outbox | Agent 间持久消息 / 基础设施可靠发布队列，职责不同 |
| TOCTOU | 检查后到使用前状态发生变化；expectedDigest 可阻止覆盖已变化文件 |

## 上下文与测评

| 名词 | 通俗解释 |
| --- | --- |
| PromptEnvelope | 校验后的本次输入与来源、摘要和持久策略 |
| ContextView | 从 Journal 取出的有界上下文视图；Run 内稳定，compact 后换代 |
| Compaction / checkpoint | 压缩模型后续输入 / 保存继续工作所需的摘要状态，不删除原始 Journal |
| MemoryService / long-term memory | 独立保存跨 Session 的项目/User 记忆；默认关闭，显式写入、有界召回，区别于会话压缩 |
| Pinned task contract | 本次用户任务逐字保留在可压缩历史之外，不让摘要取代题面 |
| Native compaction | 特定 Provider 返回的不透明上下文状态，必须匹配模型和指令才能重用 |
| Prompt cache | Provider 对重复前缀的缓存；不等于回复缓存，也不保证固定命中率 |
| Benchmark / verifier | 固定任务集 / 外部评分程序，与 Agent 自测和 Reviewer 分开 |
| Reward 0 | 按该题评分规则未通过，可能只是一个子检查失败，不代表没有完成任何内容 |
| Rollout | 用某个冻结构建、模型和策略执行一道题的一次记录 |
| Controlled trial | 明确提示使用 Plan 等功能的实验，不能证明模型会自发使用 |

当前架构见[架构](architecture.md)，计划合同见[Working Plan](working-plan.md)，测评分母与 Token 口径见[测评术语](evaluations/glossary-and-maintenance.md)。
