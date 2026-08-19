# 工业界 Prompt 与 Context Engineering 方法

调研基线为 2026-08-08，只采用供应商官方文档或项目官方文档；Praxis 实现状态于 2026-08-18 重新对账。这里不把“提示词技巧”孤立看待，而把生产系统拆成 Prompt 资产、装配、工具、上下文、安全、评测与发布七个层面。

## 1. Eval-driven，而不是凭感觉改文案

Anthropic 把“先定义可测成功标准，再设计评测”视为 Prompt engineering 的核心循环；成功标准需具体、可测、可达、相关，并建议真实任务分布、边界案例、自动评分优先、代码评分优先于人评和 LLM judge。[Anthropic：Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)

OpenAI 当前模型指导也建议从已工作的 Prompt/工具集出发，每次只移除一组指令、示例或工具，然后重跑同一批 eval；同一指令只写一次，只暴露相关工具，工具描述保持简洁精准。[OpenAI：Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

落地方法：

- 每个 Prompt unit 有稳定 ID、owner、目标行为、反行为和版本；
- 测试分为 deterministic contract（schema、工具名、权限、路径）、task outcome（是否完成）、behavioral rubric（是否先检查、是否越权）、cost/latency/context；
- 建立固定回归集 + 线上失败回灌集 + adversarial injection 集；
- 一次发布只改一个有解释力的变量，报告质量、token、成本、延迟和失败类型，而不只报平均分。

## 2. Lean prompt：去重、分层、按需暴露

OpenAI 的最新指导明确指出，删除重复指令/示例并简化工具描述可能同时改善任务表现与 token 效率；官方内部 coding-agent 样本给出的提升区间只应视为方向性结果，必须用自己的代表性任务验证。[OpenAI：Favor leaner prompts](https://developers.openai.com/api/docs/guides/latest-model)

实践原则：

1. 一条政策只在最高适合层声明一次；工具局部约束放 schema，不在 system 重复。
2. system 只保留跨任务不变且需要高优先级的政策；会话事实、项目内容和外部数据放动态 context/evidence 通道。
3. 工具描述回答“何时用、何时不用、输入契约、关键副作用”，不写与工具无关的通用行为。
4. 工具多时使用 tool search/deferred loading，避免每轮重复巨大 schema。
5. few-shot 例子只保留能纠正实测缺口或编码产品要求的样本。

## 3. Prompt registry、不可变版本与发布别名

AWS Bedrock Prompt Management 支持保存可复用 Prompt、变量、模型和推理参数，用同一模板服务不同 workflow。[AWS：Prompt management](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-management.html)

MLflow Prompt Registry 提供不可变 Prompt versions、diff、alias、lineage、tracing 与评测；不可变版本可长期缓存，而 `@production` 等 alias 可移动，适合灰度和回滚。[MLflow：Prompt Registry](https://mlflow.org/docs/latest/genai/prompt-registry/index.html)

推荐的 Praxis 资产模型：

```text
PromptUnit {
  id, semanticVersion, owner, purpose,
  channel, source, cacheClass,
  runtimeOnlyMetadata { provenance, permissionClass },
  template, variablesSchema,
  sourceDigest, compatibleModels,
  evalSuite, rolloutState, supersedes
}
```

`session/run manifest` 应记录解析后的准确 version/digest，而不是只记录 section 名；生产 alias 的移动应有 eval gate、canary、自动回退和审计事件。

## 4. 缓存工程：稳定前缀，变化内容后置

Anthropic 明确说明 Prompt cache 覆盖完整前缀，顺序是 `tools → system → messages`；静态工具定义、系统指令、上下文和示例应放在开头，cache breakpoint 放在跨请求保持完全一致的最后一个 block。时间戳、每轮用户消息等变化内容不应位于共享 cache breakpoint 之前。[Anthropic：Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

这意味着缓存不是给 section 加一个 `cacheScope` 字段就完成了，还需要：

- 确定 Provider wire 中的真实顺序；
- 稳定工具集合或使用 deferred loading；
- 把 cwd/date/git/MCP delta/项目内容移到静态断点之后；
- 记录 cache read/write tokens、hit prefix digest、首次分歧 block；
- 按变化频率设置少量分层断点，不让一个高频变化字段击穿全部缓存。

Praxis 已把动态 workspace/workflow facts 从唯一铁律移到 `runtime_facts`，并在 Run 内冻结 ContextView；DeepSeek paired run 排除首轮后的 cache 命中率已可解释。尚未完成的是 Anthropic 显式 cache blocks、真实 tokenizer、first-divergence 诊断和大规模 MCP/tool schema 的按需加载。

## 5. 工具契约：schema 优先、严格结构、最小权限

工具是 Prompt 的一部分，但它同时是可执行安全边界。成熟做法是：

- 使用 JSON Schema/structured outputs 约束输入与辅助调用输出；能结构化就不要让模型生成文本再用 regex 解析；
- 描述重点放在“什么时候使用/不要使用”，并给出会改变选择的少量示例；
- 工具名、schema、权限和副作用由 Runtime 验证，不能靠 Prompt 自觉；
- 每轮只暴露有效且相关的工具/能力；读、写、进程、网络和外部状态分别授权；
- 模型可见 tool result 标记中性的 `source/kind/digest`、截断/完整 artifact、执行 receipt 和证据引用；`trust/provenance/permission/risk` 只进入 Runtime 内部审计元数据，不渲染给模型。

Praxis 已有能力衰减、workspace grant、strict schema、结果 receipt 与 capability snapshot。下一步应在工具规模达到门槛后补按需工具加载，并完善 schema version/digest 与 tool-choice eval。

## 6. Prompt injection：把外部内容当数据，不当指令

Anthropic 对 indirect prompt injection 的官方建议包括：第三方内容只放 `tool_result`，明确说明来源；system 中声明工具/文档/搜索内容不能覆盖政策与原任务；尽可能 JSON 编码；不要把自己的高优先级指令塞入 tool result；实施 least privilege、输出 screening 和红队测试。[Anthropic：Mitigate jailbreaks and prompt injections](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)

这不要求在每个项目文件、Skill、摘要和工具结果前重复一遍“low-trust”。更适合 Praxis 的表达是：Trusted Instructions 中只声明一次不可覆盖边界；动态块只携带必要的 `source/kind/digest`，让模型知道它是什么，不让“高/低置信度”标签干扰任务判断。权限与扩权防护仍由 Runtime 实施；事实可靠性由具体 receipt、时效、verifier 和交叉验证表达。详见[指令权威、来源与事实验证](./10-authority-provenance-and-verification.md)。

Praxis 默认路径已采用带来源边界的中性 JSON wrapper，这是三套系统中最接近上述模型的实现。后续应把两点保持为回归门禁：

1. Provider 原生 tool results 保持 tool_result 通道；模型可见只附中性的必要来源信息，Runtime 内部另存 provenance/permission/risk。不要为了统一而转成普通 user text。
2. 项目/Skill/Prompt resource 的 canonical wrapper 与 escaping 测试持续覆盖闭合标签、Unicode、超长内容、嵌套 JSON 和伪造 system-reminder。

## 7. Compaction 与 memory 是两种资产

OpenAI 的 Responses compaction 同时提供服务端 `context_management` 自动阈值与独立 `/responses/compact`。独立端点接收完整 context，返回下一轮应原样使用的 canonical compacted window，其中的 encrypted compaction item 对客户端不透明；客户端不应自行裁剪该输出。[OpenAI：Compaction](https://developers.openai.com/api/docs/guides/compaction)

Anthropic 的原生 compaction 支持按输入 token 触发、暂停后插入额外内容，以及完全替换默认摘要 Prompt 的 custom instructions；默认目标是生成未来 context window 继续任务所需的 `<summary>`。[Anthropic：Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)

Anthropic 还把 tool-result clearing 与 thinking clearing 作为独立 context-editing 策略，并要求组合时先处理 thinking。这个区分很重要：Tool output 可以用 digest/artifact/replay 语义替代，thinking block 则可能带 Provider 签名或与最近 Tool turn 连续，不能当普通文本截断。[Anthropic：Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)

工程上应分开：

- **Compaction/checkpoint**：只服务当前任务连续性，带 coverage range、生成 Prompt version、源消息 digest、fresh/updated 模式和过期判断。
- **Long-term memory**：跨 Session 的经过选择的事实/偏好/模式，需 provenance、scope、敏感数据规则、冲突与遗忘机制。
- **Recent verbatim suffix**：保留最新原文，降低摘要丢失当前工作状态的风险。
- **Tool artifacts**：大结果独立持久化，以有界摘录 + digest/ref 回放，而不是把所有内容塞入摘要。

摘要质量应测试：约束召回、待办召回、文件/符号/错误精度、已完成/未完成不混淆、用户最新意图优先、注入内容不升级为政策。

Praxis 当前采用双层资产：始终保存 portable semantic checkpoint；OpenAI Responses 可额外保存精确绑定 provider/model/instructions 的 opaque native context。native 不匹配或失败时回退 semantic，不覆盖完整 SessionJournal。旧 reasoning 与 Tool result 只在发送视图中编辑。实现状态与 Tool Search 门槛见[第 9 篇审计文档](./09-native-compaction-and-context-editing.md)。

## 8. 自动优化可以用，但不能替代评测与审查

Google 的 Prompt Optimizer 区分零样本优化和数据驱动优化：前者直接改一个 Prompt/template；后者在标注样本与指定指标上迭代目标模型输出。官方同时注明 SDK 仍可能变化。[Google Cloud：Prompt Optimizer](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-optimizer)

适合用自动优化的部分：分类、抽取、结构化摘要、工具选择说明、固定 rubric。谨慎使用的部分：权限政策、安全边界、破坏性操作、跨 Provider 角色映射。这些必须由人审、规则测试和 adversarial eval 共同把关。

## 9. 可观测性与线上反馈闭环

每次模型请求至少记录：

- prompt manifest version/digest、最终 block 顺序和变量 digest；
- provider/model/reasoning/response format；
- 暴露工具的 name/schema version/digest；
- input/output/cache read/cache write tokens、延迟、成本；
- context omission、checkpoint coverage、artifact refs；
- tool calls/results、权限拒绝、重复失败、最终 stop reason；
- 自动/代码/LLM judge 分数和人工 override；
- 不含秘密的安全审计事件。

线上失败按根因回灌：Prompt 冲突、缺少上下文、工具描述误选、schema 失败、权限过宽/过窄、摘要丢失、模型能力、产品 bug。不要把所有失败都归因于“Prompt 不够强”并继续加文字。

## 10. 开源 Agent 的可复用证据

开源项目能证明的不是“写一篇更长的 system prompt 就能通过 benchmark”，而是 Prompt、动作接口、上下文选择、编辑协议、反馈与预算必须共同设计：

- **Pi**：本地 `D:\pi` 的 Prompt 主干很短，工具提示按实际可用工具条件生成，项目内容使用 XML 边界。其 Git 历史还显示三个值得迁移的 Prompt 变更：`7577d3b8` 把项目内容从 Markdown 标题改为明确 XML 边界；`1ab28998` 删除了没有必要的工具偏好句；`f4e9ca74` 删除每轮变化的当前日期。它们分别对应边界清晰、去除无效指令和稳定缓存前缀；这些提交本身没有附单因素 benchmark，不能声称具体分数来自某一句 Prompt。
- **SWE-agent**：论文把主要提升归因于 Agent-Computer Interface，包括专门的文件导航、编辑、执行和观察反馈；代码中 system/instance/observation/error templates 都是可配置组件。可迁移点是“缩短 Prompt + 改善动作/反馈接口”，不能把成绩归为 Prompt-only。[SWE-agent 论文](https://papers.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)、[官方仓库](https://github.com/SWE-agent/SWE-agent)
- **mini-SWE-agent**：保留明确的 system template、instance template、step/cost limits 和简单循环，用极小 scaffold 作为研究基线。它支持“先建立 lean baseline，再逐项增加机制”的方法，而不是支持无评测删减。[官方文档](https://mini-swe-agent.com/latest/)、[默认 Agent 源码](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py)
- **Aider**：按模型选择 whole/diff/udiff 等编辑协议，并单独统计任务完成率和格式遵从率；architect/editor 也使用职责更窄的编辑 Prompt。这里真正被优化的是“Prompt + 输出协议 + 应用器”的组合。[编辑格式](https://aider.chat/docs/more/edit-formats.html)、[代码编辑 benchmark](https://aider.chat/docs/leaderboards/edit.html)
- **OpenHands**：CodeAct 把 Agent 动作统一为可执行代码/命令，并配套 sandbox、事件流与评测。其官方描述同样把性能来自 action space 与平台设计，而不是孤立文案。[Agent 文档](https://docs.openhands.dev/openhands/usage/agents)、[官方论文](https://arxiv.org/abs/2407.16741)

因此，开源材料可用于选择工程方法，不能代替 Praxis 自己的单因素验证。Prompt 冗余应先由源码对账确认；行为收益必须用固定二进制、固定任务、固定工具和同模型的成对消融实验验证。

## 11. 面向 Praxis 的方法清单

| 方法 | Praxis 当前 | 建议 |
| --- | --- | --- |
| Runtime 来源/权限边界 | 强；默认模型侧已收敛为一个 Trusted Instructions | 保持 authority/provenance/verification 分离，禁止可信度阶梯回流 |
| 稳定 Prompt ID/version | 两个不可变 variant 与统一默认已接入；无 production/canary alias | 补发布 alias、变更门禁与自动回滚 |
| 真实 Provider cache | Run-stable ContextView、usage 解析与 paired A/B 已完成 | 补显式 cache blocks、首次分歧诊断和更多 Provider 样本 |
| 工具按需加载 | 无/有限 | tool catalog + schema fetch |
| structured auxiliary calls | Planner/verifier/compactor 已有结构化合同 | 继续做字段所有权与输出真实性校验 |
| eval gate | contract、paired cache 与小样本长任务已有 | 建多模型、多故障、统计化固定数据集与发布门禁 |
| compaction lineage | semantic/native 双层、coverage 与 manifest 已接入 | 加多类型 fidelity 统计、跨天恢复与故障注入 |
| long-term memory | 基础能力 | 与 checkpoint 分离并加 provenance/forget |
| injection defenses | 强基础 | 原生 tool_result、统一编码、红队 corpus |
| request observability | manifest 较强 | 加真实 payload blocks/cache/tool schema lineage |
