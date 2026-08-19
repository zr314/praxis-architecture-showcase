# 指令权威、来源与事实验证

最后核对：2026-08-18。

状态：**已确认。默认 `iron-law-lean-v1` 不向模型展示全局可信度等级；保留一个指令权威边界，并把来源追踪与事实验证分开。**

本文回答一个容易混淆的问题：Praxis 是否需要把 Prompt 内容分成“高可信 / 低可信”或“高置信 / 低置信”？结论是**不需要这种单轴分级**。它会干扰模型对事实的使用，也不能代替 Runtime 的权限控制。

## 1. 最终决策

Praxis 保留一个模型可见的 `praxis.trusted-instructions`，只说明不可被内容覆盖的执行边界。除它以外，用户任务、项目文件、Skill、MCP、Tool 结果、memory、checkpoint 和 Child 输出都按内容种类与来源进入 context/evidence，不预先贴统一可信等级。

需要分开的三个问题是：

| 维度 | 回答的问题 | 当前/目标载体 |
| --- | --- | --- |
| `authority` | 这段内容能否改变指令、权限、工作区或能力 grant？ | 唯一 Trusted Instructions、用户显式授权、Runtime policy/admission |
| `provenance` | 内容从哪里来、何时产生、是否可追踪和重放？ | role、内部 `trust`、source、digest、timestamp、lineage、Artifact/Tool/Child ref |
| `verification` | 某个具体事实目前有什么证据，是否冲突或过时？ | Tool receipt、测试、schema criterion、verifier、cross-review、freshness |

`authority` 不是事实真伪，`provenance` 不是质量分数，`verification` 也不是授予权限。三个维度不能合并成一个 `trust=high|low`。

## 2. 为什么可信度分级会干扰模型

### 2.1 “不能授权”不等于“事实不可靠”

编译器错误、测试失败、文件内容和 Tool receipt 不能改变 Runtime policy，但可能是当前任务中最可靠、最重要的事实。如果统一标成 `low-trust`，模型可能降低对关键证据的关注。

反过来，Runtime 生成的 ContextView 或 semantic checkpoint 虽然来源可控，也可能过时、不完整或由模型摘要产生。把它称为“高可信”会制造错误确定性。

### 2.2 来源类型内部并不一致

同一个 MCP server 可能同时返回签名 API 数据、缓存数据和自然语言网页；同一个 Child 可能给出经过测试的 patch，也可能只给出推测。给整个来源打一个等级，会掩盖 claim 级差异。

### 2.3 标签不能提供真正的安全边界

Prompt injection、越权写入、凭据访问和外部副作用必须由 capability grant、workspace policy、schema validation、effect broker、receipt 和 verifier 机械限制。反复要求模型“不要相信低可信内容”既不能证明安全，又会增加 Prompt 噪声和缓存体积。

### 2.4 “可信”容易被误解为“已验证”

`trusted` 在安全设计中通常表示“可以发出指令”，但模型和读者很容易把它理解为“内容为真”。Praxis 因此只在 `Trusted Instructions` 这个明确的指令边界上使用该词，不再用它给一般事实排序。

## 3. 当前实现映射

默认 `iron-law-lean-v1` 的模型输入为：

```text
one praxis.trusted-instructions
  -> runtime_facts
  -> skill_catalog?
  -> project_guidance?
  -> pinned Child ContextPacket?
  -> Run-stable session_view
  -> native context or semantic checkpoint?
  -> recent conversation / Tool history
  -> effective Tool and MCP schemas
```

当前行为：

- `composeLeanTrustedInstructions()` 只声明一次 Runtime 边界、证据要求、秘密保护和当前调用合同；
- `renderNeutralContext()` 及 replay renderer 使用 `<praxis-context kind="...">`，不逐块输出 `low-trust / untrusted`；
- `ProviderMessage.trust: 'user' | 'low'` 仍用于 Runtime 路由、持久化、历史选择和兼容，不作为事实置信度显示给模型；
- Planner 默认只要求 proposal 匹配 schema/capability context，不再告诉模型“proposal is untrusted”；
- Skill 默认说明只描述从当前 Run snapshot 加载能力，不再给 Skill 正文贴可信度标签；
- `agent.handoff` 当前说明使用 `reviewable evidence`，不再使用矛盾的 `authoritative low-trust evidence`；
- `baseline-v1` 为回滚与 A/B 保留旧 wrapper，审计文档必须保存其原文，但它不是默认生产规则。

仍有一项命名债务：`agent.handoff` 的 Tool 返回对象使用 `authoritativeResult` 字段。它是兼容 wire 名称，不改变结果的验证状态；未来若改名，应通过版本化 schema 或兼容别名迁移，不能直接破坏 replay 和调用方。

## 4. 模型什么时候应该看到“不确定性”

不使用全局可信度等级，不等于隐藏不确定性。只有当状态会改变下一步决策时，才对**具体 claim**表达：

- `observed`：Tool/文件/API 实际返回了什么；
- `verified`：有匹配的 receipt、测试或 criterion 证明；
- `unverified`：只是计划、推断或尚未复查的 Child 结论；
- `conflicting`：多个来源给出不一致结果；
- `stale`：证据早于相关修改、恢复点或有效期；
- `unknown`：没有足够证据。

这些词是推荐的语义状态，不是当前统一 wire enum，也不应在每条消息上机械展示。优先传递支持状态的引用，例如 command receipt、test artifact、file digest、criterion ID 和时间，而不是传递一个没有解释力的分数。

## 5. Prompt 装配规则

后续修改必须遵守：

1. 每个模型请求最多一个 Runtime-owned Trusted Instructions block；辅助调用把自己的输出合同并入同一 block。
2. 项目、Skill、MCP、Tool、memory、checkpoint 和 Child 内容不得进入 Trusted Instructions，也不得自行授予能力。
3. 默认生产 Prompt 不使用 `high-trust / low-trust / untrusted / confidence tier` 给一般内容分级。
4. 中性 envelope 只提供理解和追踪所需的 `kind/source/ref/digest/range`；没有决策价值的元数据不额外占用模型上下文。
5. 对事实的验证必须是 claim-specific，并引用 receipt、测试、criterion、verifier 或交叉审查；Child 成功只证明 Child 合同完成，不自动证明所有自然语言结论正确。
6. 冲突、过时和未知状态不得在 compaction 时被压成确定事实；Runtime-owned 字段不能由模型摘要覆盖。
7. 权限、路径、预算、schema、副作用和 secret 边界继续由 Runtime 强制，不能退化为 Prompt 自觉。
8. 改动模型可见边界时，至少进行 deterministic payload 检查、Prompt-only paired A/B 和 injection/false-success 回归；不能只凭文案直觉晋升。

## 6. 不做什么

- 不删除唯一 Trusted Instructions；否则外部内容与 Runtime policy 会失去清晰的指令边界。
- 不把所有内容拍平成无来源的纯文本 ReAct history；中性容器、Tool role 和 provenance 仍然必要。
- 不让 LLM 自己决定权限或把自然语言判断写回 authority store。
- 不为每条上下文增加数值置信度；没有校准数据时，这只是伪精确。
- 不立即删除协议中的 `trust` 字段；它仍有兼容和内部处理用途，未来重构应拆成更准确的 `authority/provenance/verification` 类型后再迁移。

## 7. 审计门禁

每次 Prompt 变更至少检查：

- 默认 variant 的最终 Provider payload 是否只有一个 Trusted Instructions；
- `low-trust / high-trust / untrusted / confidence` 是否只存在于 baseline、内部代码注释或人类审计文字，而没有重新进入默认模型正文；
- Tool description、schema description 和 Tool output 字段是否暗示“来源权威 = 事实已验证”；
- context envelope 是否保留必要 provenance，同时没有重复安全声明；
- compaction 是否保持用户约束、未完成事项、修改证据和冲突状态；
- Child/Planner/verifier 结果是否经过 schema/admission/receipt 校验，而不是因为名称带 `trusted` 或 `authoritative` 就被接受。

现行原文见[Praxis 当前生产 Prompt](./01-praxis-prompts.md)，完整装配细节见[Prompt、Context 与 Compaction](../prompt-assembly.md)，历史变更与验证结果见[首批执行台账](./08-execution-ledger.md)。
