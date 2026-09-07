# Prompt、Context 与 Compaction

核对日期：2026-09-05。本文是当前装配规则的唯一说明入口。English summary: stable instructions, explicit dynamic state, protected task text, and provider-only context editing.

精确固定字符串、所有模型请求和 Provider wire 字段见[模型请求目录](model-request-catalog.md)。该目录包含当前源码仍可调用的 baseline 和未接线 adapter，并明确标注；不把它们当成默认路径。

## 1. 默认、版本和职责

默认源：`apps/runtime/src/prompt/promptRegistry.ts` 的 `DEFAULT_PROMPT_VARIANT=iron-law-lean-v1`。当前 lean 与显式 baseline 均为 1.3.0。Host 的 promptVariant 优先于环境变量 `PRAXIS_PROMPT_VARIANT`，未知值拒绝。

`SystemPromptComposer` 组装固定指令、Runtime facts、Skill 目录和项目指导。`PromptAssembler` 负责 pinned/dynamic context、ContextView、reasoning/Tool-result 编辑、窗口选择和 manifest。`AgentLoop` 组合请求；Provider adapter 转成供应商格式。可信 Host middleware 在发送前还可校验并改写请求，排查时必须区分装配结果与最终请求。

默认 system 装配预算为 `DEFAULT_SYSTEM_PROMPT_TOKEN_BUDGET=4096`。它不是模型上下文窗口或任务轮数限制。必需指令放不下时返回 PROMPT_BUDGET_TOO_SMALL，而不是静默丢掉政策。

## 2. 一次主 Agent 请求的实际顺序

| 顺序 | 内容 | 生命周期 |
| --- | --- | --- |
| 1 | 一个 Trusted Instructions block | 固定政策和角色操作合同 |
| 2 | runtime_facts | cwd、平台、shellDialect、角色、实际协作工具 |
| 3 | skill_catalog，可选 | 名称和摘要；不预装所有 Skill 正文 |
| 4 | project_guidance，可选 | 发现并校验后的项目约定，受独立预算裁剪 |
| 5 | 需要重放的本 Run 逐字任务；Child 可另有签名 ContextPacket | pinned；任务仍完整保留在消息后缀时不在此重复 |
| 6 | 当前 Working Plan 或严格 ReviewPlan 快照 | 每轮重建的 dynamic context，不与另一种策略混注入 |
| 7 | session_view | Run 内稳定，成功 compact 后换代 |
| 7a | long_term_memory，可选 | 新 Run 检索的候选快照；按剩余预算选择，删除后禁止受影响旧会话重放 |
| 8 | semantic checkpoint 或适用的 native context | native 精确绑定失败则回退 semantic |
| 9 | 最近完整消息后缀 | 包括真实 ToolResult、steer 和执行结果 |
| 独立字段 | granted Tool definitions | Provider tools，不是 system 文案 |

这里是逻辑装配顺序，native context 的具体 wire 位置由 adapter 实现。任务合同若仍完整存在于选中的 canonical 消息中，就保留其原时间位置，不额外发送 pinned 副本；只有窗口遗漏它时才前置重放。不是每轮重复两份题目。

**动态 Plan 位于稳定 ContextView 之前。** 编辑 Plan 会改变后续前缀，可能影响缓存，这是当前实现的真实代价。不能再宣称“除 compact 外所有 context 永远不变”，也不能仅凭命中率低就认定政策文字太长。

## 3. 指令权限、来源与事实可信度分开

本地长期记忆默认关闭。启用后的 memory context 位于 ContextView 后，最多 8 条/约 1500 Token，只使用原上下文选择后的剩余预算，允许随预算缩小而省略；不会变成固定政策或 Plan 完成证明。实际 schema、Token 与撤销语义见[本地长期记忆](long-term-memory.md)。

默认 lean 的资料外壳为 `<praxis-context kind="…">JSON</praxis-context>`，JSON 中的左尖括号转义，避免内容伪造关闭标签。固定指令明确资料不能覆盖政策或扩大权限；不对每段资料反复打印一套笼统的可信度分数。

这不代表源码或所有模型请求中完全没有 trust/low/untrusted：Runtime 仍有来源元数据，Working Plan 有“自报进度不是证据”的提示，隔离 Reviewer 仍明确提醒证据中的指令不具权威，baseline 也保留自己的外壳。

三个问题分别判断：

- authority：能否授权或改变指令？由 Host、用户授权和 Runtime Policy 决定。
- provenance：来自哪里，什么时间、版本和执行？看 ID、digest、sequence、Artifact/receipt。
- verification：能证明哪个要求？Tool 返回成功、模型判断、外部 verifier 是不同等级证据。

不能授权的编译错误仍可能是可靠观察；Runtime 记录的模型报告仍可能在语义上错误。Prompt 表达不替代机械权限校验。

## 4. Root、Child、Plan 和扩展

auto Root 可直接工作、建清单或按需 spawn；solo 不提供 Child；显式 legacy workflow 额外提供图工具。委派提示要求考虑独立上下文、并行、隔离或验证的收益，不因“很长”就硬派 Child。

optional 注入 Working Plan：可修改、自报进度、咨询结果只对应快照；required 注入严格合同、Attempt 和验收状态。两套工具的名字相同，但 Schema、指令与完成要求不同。

Child 使用同一 composer/loop，附带委派目标、签名 Packet 与缩减 Capability；当前固定 solo。其结构化终结工具由 Runtime 提供，父 Host 再次校验完整结果，不能用一段 prose 绕过。

Skill catalog 只披露摘要。选择后 SkillInvocationService 校验固定 digest、加载正文并记录调用；重放使用对应 context。MCP stdio 激活并获准的 Tool 进入同一 tools 字段，结果作为观察而非 system 政策。二者不能自行增加权限。

## 5. Provider-only context editing

```text
canonical Journal messages
→ reasoning 编辑
→ Tool-result 编辑
→ 窗口选择和完整调用配对
→ Provider adapter
```

这些操作不改原始 Journal 或 Artifact。Reasoning 超过默认预算后从旧回合清理，保留最近回合及适配器需要的协议连续性，不把隐藏推理伪造为普通 assistant 文本。

大 Tool 结果可保留头尾、digest、字节数和恢复引用；陈旧 read/none 结果可清理。write/process/network、协作和 Skill 等关键结果不按普通陈旧读取处理。占位仍保留调用身份和状态；窗口边缘孤立 ToolResult 不直接发送。默认值由 `memory/reasoningContextEditing.ts` 和 `memory/contextEditing.ts` 定义，不在文档另造一套阈值。

## 6. Compaction 与恢复

模型窗口压力或 checkpoint 后未压缩正文达到默认 64K 估算 Token 软阈值时，CompactionService 选择安全前缀、生成 portable semantic checkpoint、保留最近边界并检查实际收益。默认摘要容量 4096 Token，keepRecentTokens 为 8192；手动 compact 和自动触发的范围策略不同。64K 是成本触发器，不是任务总 Token 上限。

有适用 Provider compact 能力时，可在 semantic 成果之上保存 opaque native state。当前 OpenAI Responses 路径实现 standalone compact；MiniMax、DeepSeek 等当前常用路径使用 portable semantic checkpoint。没有成功 native 调用，就不能把一次压缩记为“供应商原生压缩通过”。

Native 重放需匹配 provider、model、format、覆盖范围和 instructions digest；不匹配或调用失败时回退 semantic。Child 通过 credential broker 使用对应 Provider 能力，不获得 API key。

checkpoint 字段有明确来源：

| 字段 | 来源边界 |
| --- | --- |
| objective、constraints | 用户任务、签名 Packet、先前已准入状态 |
| relevantRefs、readFiles、modifiedFiles | Packet、已有状态与成功 Runtime Tool 证据 |
| decisions、unresolved、activePlan | 可接受模型语义补充，但不能变成授权或已执行事实 |

成功 write/edit 的结构化路径可作为修改证据；shell 命令里的路径猜测只标未核实候选，exit 0 不能证明所有提到的文件都被修改。新的有效 continuation 可以替换旧意图；空洞摘要使用保守回退。fitting 优先保留约束、未完成事项和修改状态，不把截断半句伪装为完整结论。

逐字任务、动态 Plan 和实际执行账本独立于摘要。摘要可以错，但不能覆盖原始合同或“编造” receipt。失败 summary 记录安全错误码和已知 usage；未知用量不估算为真实账单。

## 7. 隔离 Review 是另一种模型请求

| 路径 | 输入 | 输出与失败语义 |
| --- | --- | --- |
| optional advisory-v1 | 原始任务、问题、可错的 criteria、冻结 Tool 参数与返回值 | summary + supported/concern/unknown；局部非法意见降级，服务耗尽为 unavailable，不阻断 Run |
| required strict | 原始任务、Plan scope/Attempt、冻结证据、检查结果 | proof/decision 严格校验；影响验收完成门，耗尽可 blocked |

咨询按 runId/toolCallId/name 配对已持久 Tool 调用与结果，不把普通叙述当证据。缺失、歧义和截断明确标记；当前不补读实时文件或隐藏测试。严格 Reviewer 在获准时可以补读此次冻结证据片段，不是任意工具访问。

原生 structured output 使用空 tools，其他 Provider 使用受限提交工具。旧版在途请求按冻结合同恢复，不强行换成新 schema。ReviewCallStore 的诊断尽力脱敏且有界，不注入 Root；它不是完整网络抓包，也不是完备秘密扫描器。

## 8. 缓存排查规则

先冻结模型、构建、工具集、策略和题目，再观察实际请求前缀与 Provider usage。分别记录普通输入、cache read、输出、Reviewer 和 compaction 用量，区分供应商是否已把 cache 计入 input，避免重复计算。

应核对固定 instructions digest、工具顺序、runtime facts、Plan revision、ContextView 换代及 middleware 改写。Plan 每轮变化可能比历史 ContextView 更早打断前缀；独立 Reviewer 冷请求也会拉低整体比例。短 Prompt 与高缓存率不是同一指标。

历史 DeepSeek A/B 只说明当时的样本；不能当作当前 MiniMax 或当前 Working Plan 的预期命中率。详见[平台实验](evaluations/passed-platform-evaluations.md)。

## 9. 当前没有 Tool Search

当前直接暴露获准 Tool Schema，尚无“搜索目录后再动态加载完整 schema”的产品能力。是否需要增加，应依据实际 toolCount/toolSchemaTokens、窗口比例和调用质量评估；没有代码实施的门槛不写成自动切换规则。

## 10. 修改和验收

修改 Prompt 时同步：源码常量或输出合同、模型请求目录、相关 schema/payload 测试和必要的冻结真实样本。Root 程序版本与 advisory-v1 等辅助合同分别管理，不能只改一个版本号就宣称全部请求改变。

至少检查：唯一政策块、任务去重和压缩保护、动态 Plan 顺序、Child 权限、Tool pair 完整、原始任务优先、Prompt 不含 benchmark 答案、usage 可追溯。静态合同通过只说明装配一致，不能证明模型审查可靠。

源码入口：`prompt/promptRegistry.ts`、`prompt/systemPromptComposer.ts`、`prompt/promptAssembler.ts`、`memory/`、`working-plan/`、`review-plan/`，相对 `apps/runtime/src/`。
