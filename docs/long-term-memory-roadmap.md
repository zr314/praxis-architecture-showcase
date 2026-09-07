# 长期记忆路线图

更新：2026-09-06。English summary: local explicit memory and isolated recap experiments are implemented; production automatic extraction and advanced retrieval remain future work.

本页只保留阶段状态和后续工作，不再把已接线功能写成“尚未实现”。当前命令、字段、限制和源码依据统一见[本地长期记忆](long-term-memory.md)。本轮未改变已安装程序，验证使用源码和隔离测试目录。

面试研究方向已落实为[同项目经验继承实验](research/project-recap-experiment.md)：冻结公开历史、四组对照、共享快照消融和 Runtime 目标执行。它不写产品记忆库，不意味着下面的后台提炼与生命周期已经实现；当前优先获得可解释的实验结果。

## 1. 已落地：M0 与 M1 的核心闭环

| 工作包 | 当前状态与证据 |
| --- | --- |
| M0 身份与合同 | Project/User scope、off/read-only/explicit；Git common directory 身份、非 Git 登记根、移动 rebind；[身份实现](../apps/runtime/src/long-term-memory/projectIdentity.ts)、[领域合同](../packages/core-sdk/src/long-term-memory.ts) |
| M1 本地存储 | 独立 memory-v1.sqlite；CAS、幂等回执、整批 import 事务、分页 export；不迁移现有 Session JSONL/SQLite；[MemoryService](../apps/runtime/src/long-term-memory/memoryService.ts) |
| M1 产品入口 | memory.* 工具、memory.manage RPC、Client/CLI；模型写入需具体授权，管理命令直接表达用户意图；[工具](../apps/runtime/src/long-term-memory/tools.ts)、[Runtime](../apps/runtime/src/framework/runtimeKernel.ts) |
| M1 模型接线 | Run 候选快照、词法检索、预算内低权限上下文、manifest/Trace；[装配](../apps/runtime/src/prompt/promptAssembler.ts) |
| M1 纠正/删除 | 同 key revision 更新、过期过滤、删除后阻止已暴露 Session/fork 继续发送；不伪造全副本擦除；[生命周期测试](../test/long-term-memory.test.ts) |
| M1 真实进程 | 新 Runtime + 新 Session 召回、项目隔离、JSONL/SQLite、模型授权写入、CLI 管理；[接入测试](../test/long-term-memory-runtime.test.ts) |

测试验证的是合同与接线。确定性 Mock Provider 不证明真实模型一定记得正确，也不构成记忆提高 benchmark 成绩的证据。具体测试执行记录见[本轮验证记录](evaluations/archive/local-memory-validation-20260906.md)。

与初始提案相比，明确选择了几项保守实现：

- 模型写入逐次授权；不让模型自己声明“用户明确要求”就跳过权限。CLI put/forget 不重复确认。
- 新项目默认 off，首次启用选择 explicit；不在升级后自动加载所有项目记忆。
- 删除无法保证安全重建旧摘要，因此阻止受影响旧 Session 发送、要求新会话，不修改原始 Journal。
- Child 暂不自动继承 Memory Packet，也不开放记忆库/工具；避免先共享后补授权和撤销。
- applicability 暂为条件提示，同 key 有 CAS，但没有跨 key 语义冲突检测。不能把这两项写成机械验证已经实现。
- 不引入云服务、向量数据库、embedding、后台常驻提炼或多租户控制面。

## 2. 下一步优先补齐 M1 的实用性

先使用显式版本收集真实问题，再按下面顺序推进；不是立刻扩展模型调用数量。

| 优先级 | 工作 | 验收方式 |
| --- | --- | --- |
| P0 | 真实跨 Session 语义场景：偏好应用、用户改口、项目决策、错误旧经验、恶意记忆 | 固定模型/构建/预算，与 memory off 配对比较；记录失败原因，不只检查“入库了” |
| P0 | 更细的撤销关联，减少仅成为候选就使会话失效 | 仍须在下一次 Provider 发送前阻止失效内容；不得以少弹提示换取旧摘要泄漏 |
| P1 | 更新体验：按 key 查找现有 revision、用户指定的跨 key 冲突关系、过期项管理 | 不静默 last-write-wins；冲突项停止自动注入，用户可明确纠正 |
| P1 | 可机械检查的 applicability：路径/文件摘要/环境条件 | 当前文件变化时经验降为待核验；不能仅用 branch 名或整个仓库 commit 判断 |
| P1 | 有边界的 Child 只读 Packet | 父级显式选择、绑定 projectId/记录版本，子级无写权；父级撤销后的在途/重放边界必须明确 |
| P2 | 收缩 token/候选开销，调整中英混合检索 | 按实际命中与任务收益调参，不追求记忆数量或缓存率单项最大化 |

不要把源码目录、package.json 脚本和完整日志重复保存成长期事实。更值得保留的是用户偏好、明确纠正、项目取舍的理由，以及当前源码无法直接恢复的背景。

## 3. M2：可选自动提炼，不是默认后台学习

前置条件：M1 的权限、隔离、删除和真实语义场景得到可解释的结果；用户明确 opt-in。先做“主动触发一次整理”，再考虑机会式后台执行。

### 3.1 准入与可信度

- 输入只选已持久的用户信息和相关 Runtime 观察，保留 source Session/Run/message/tool 引用；不把完整聊天、密钥或隐藏推理喂给提炼器。
- Working Plan done、advisory Review accepted、严格 ReviewPlan 的标签都不是长期事实证明。严格执行证据也只支持具体时间/版本下的具体命题。
- 提炼模型只能产出候选，由 MemoryService 校验 scope、来源、长度、秘密、去重、revision 和删除抑制状态。
- 不用模型随意填的 confidence=0.99 代替证据。区分 user_explicit、runtime_observed、inferred，后两种目前尚未接线。
- 低风险项目候选可按用户启用的规则处理，不要求每条重复审批；跨项目推广、冲突覆盖、敏感内容仍需明确授权。

### 3.2 生命周期与费用

- 只在 Run 终态持久化后排队，主任务的成功不能被可选整理失败改成失败。
- Session Journal 与 Memory DB 不假装跨库原子事务：保存提炼游标/幂等键，启动时对账“终态已提交但未排队”的窗口。
- 队列必须有取消、超时、重试上限、退出 drain 与恢复状态；不使用无人接管的 fire-and-forget。
- 单独限制提炼输入/输出和每日费用，记录已知 usage，未知标 unknown；后台费用不补写成已经结束的 Run 的原始账单。
- 删除抑制不能只依赖现在的 key tombstone：补来源抑制、版本与必要 HMAC。阻止自动重新学回，但不承诺识别全部同义改写。
- 失败任务中的用户纠正仍可能有价值；失败执行绝不能提炼成已验证成功经验。

验收覆盖：重复/冲突、错误成功报告、外部注入、删除后重学、过期、跨项目污染、中断恢复、额外模型费用。辅助调用重试可能重复计费，不承诺 exactly-once Provider 调用。

## 4. M3：确有召回缺口后才增强检索

先改 key/标签、中文切分、同义词和排序。只有成对实验确认词法检索无法满足需求，才重新评估更复杂的本地检索方案；本轮不建设向量数据库。

任何索引都必须可从权威记录重建，跟随 revision、scope 和删除。不得把“向量检索相关”当成“事实当前正确”。

将稳定经验晋升为 Skill 或项目文档是用户授权的独立变更，不允许提炼器自动修改固定政策、已有 Skill 或 AGENTS.md/PRAXIS.md。

远程同步、多人共享、云数据库、组织 ACL、在线灰度控制面不在个人版必做清单中。

## 5. 评测安排

D:\agent-evals 中的 Harness-Bench、Harbor/Terminal-Bench、AgentDojo 继续作为通用任务与安全回归；不能只凭这些 benchmark 已安装就说覆盖长期记忆。本轮没有运行它们。

新增纵向场景的基本结构：

1. Session A 明确提供偏好或项目背景，实际存入记忆。
2. 关闭进程，Session B 使用新任务；仅共享专用 memory store，不共享 A 的消息/checkpoint。
3. Session C 纠正或忘记，再验证 Session D 及跨项目读取。
4. 分别核对实际 Provider 请求、最终行为、Token/耗时和未授权写入，不以 recall 事件代替任务收益。

每个独立案例/重复实验使用隔离 home；同案例 A/B 保留同一记忆库。冷启动通用 benchmark 默认 memory off；热记忆实验单独标记，不能把 grader 答案或其他测试的解法作为记忆来源。质量测试按 memory off/explicit/auto（M2 后）分组，固定模型、版本、预算并记录重复次数与波动。

## 6. 调研依据与保留的设计取舍

| 官方方案 | 借鉴 | 不照搬 |
| --- | --- | --- |
| [Claude Code memory](https://code.claude.com/docs/en/memory) | 项目记忆与人工指导分离；短索引/按需加载 | 直接共享可任意修改的 Markdown 作为并发权威 |
| [LangGraph memory](https://docs.langchain.com/oss/python/concepts/memory) | thread checkpoint 与跨会话 Store 分离；namespace；热路径/后台写入分开 | 为记忆替换当前 ReAct/Working Plan 主循环 |
| [Letta Agent SDK memory](https://docs.letta.com/agent-sdk/memory) | 分层、按需读取与可选后台整理 | 云记忆仓库或所有记忆常驻可信政策块 |
| [Mem0 Add Memory](https://docs.mem0.ai/core-concepts/memory-operations/add) | 独立提炼、检索和作用域 | 把 add 调用视为冲突、删除、权限和证据问题都已解决 |

外部资料核对日期为 2026-09-06；以上是设计参考，不是厂商性能排名。现有 Praxis 的代码与限制以当前使用合同为准。
