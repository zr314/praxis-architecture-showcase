# Praxis / Pi / Claude Code Prompt 审计与优化

本文档集回答四个问题：三个系统到底向模型注入了什么；每段内容何时、以什么角色注入；各段如何装配成最终请求；Praxis 为什么分阶段优化。它是审计与演进记录；当前 Praxis 的规范入口是[Prompt、Context 与 Compaction](../prompt-assembly.md)，可信度标签的现行决策见[指令权威、来源与事实验证](./10-authority-provenance-and-verification.md)，最终运行结论见[最终小样本测评与优化总结](../evaluation-final-2026-08-09.md)。

审计基线日期为 **2026-08-08**：

- Praxis：`D:\praxis`，Git `08e71bca07ead67a19e69f8258e84318f1bde653`，分支 `main`。
- Pi：`D:\pi`，Git `cee5ff7520d8828bed9955ef00419e995d1f91e0`，分支 `main`。
- Claude Code copy：`D:\claude-copy`，包版本 `2.1.88`；`src/constants/prompts.ts` SHA-256 为 `7dac778e089a7f002403df2a2efb6f0b9e4a450af21766680ab8948596c10f25`。

三个目录都可能在继续变化，文档中的行号只用于定位，以上版本标识才是复现基线。初始审计只在 `D:\praxis\docs\prompt-audit` 新增文档；用户确认 Roadmap 后，Praxis 实现并验证了 `iron-law-lean-v1`，并于 2026-08-09 将其晋升为默认。2026-08-18 又按当前 working tree 复核了可信度措辞与 Root 委派提示；`baseline-v1` 仍可显式选择，命名式 production alias 尚未创建。Pi、Claude copy 未被修改，Praxis 原有未提交改动也未被覆盖。执行详情见[首批执行台账](./08-execution-ledger.md)。

Praxis 与 Pi 在审计时都不是 clean worktree；本文翻译和装配分析以 **2026-08-08 当时磁盘上的 working-tree 源码**为准，Git commit 只作为最近提交锚点，不能单独复原未提交文本。需要完全复现时应同时保存本文档、Prompt source digests 和最终请求 dump。

## 阅读顺序

1. [审计范围与全量来源清单](./00-scope-and-inventory.md)
2. [Praxis 当前生产 Prompt：Root、Planner、Compactor、Child 与 Tool 装配](./01-praxis-prompts.md)
3. [Pi Prompt：原文、翻译、注入时机](./02-pi-prompts.md)
4. [Claude Code copy Prompt：原文、翻译、注入时机](./03-claude-copy-prompts.md)
5. [三套装配原理与差异](./04-assembly-comparison.md)
6. [工业界方法与可迁移实践](./05-industry-practices.md)
7. [指令权威、来源与事实验证：为什么不向模型展示可信度等级](./10-authority-provenance-and-verification.md)
8. [Praxis Prompt 优化 Roadmap](./06-praxis-roadmap.md)
9. [源码追踪与覆盖对账](./07-traceability-and-coverage.md)
10. [首批执行台账、最终验证与后续扩展门禁](./08-execution-ledger.md)
11. [原生 Compaction、Reasoning 清理与 Tool Search 决策](./09-native-compaction-and-context-editing.md)
12. [现行 Prompt 装配规范](../prompt-assembly.md)
13. [最终小样本测评与优化总结](../evaluation-final-2026-08-09.md)

## “所有 Prompt”的边界

这里的“全量”指在基线源码中能识别出的、会进入模型请求的全部**源码静态语义单元**，包括条件分支内的模板；它不表示所有这些单元会同时出现在一次请求中。覆盖对账与例外见[源码追踪与覆盖对账](./07-traceability-and-coverage.md)。

- API 的 `system` / `instructions`；
- Runtime 合成的 `user`、`context`、`system-reminder`；
- 工具顶层 `description`、对模型有行为影响的 schema 字段说明；
- 压缩、规划、语义校验、记忆提取、文档维护等独立 LLM 请求；
- 子 Agent 的角色、任务包、约束、成功标准和结果格式提示。

下列内容不是源码中的固定原文，因此不能假装存在一种固定中文翻译；文档登记它们的插槽、来源、通道、Runtime-only 权限元数据、预算与装配位置：

- 用户消息与运行中 steer；
- `AGENTS.md`、`CLAUDE.md`、Pi context files 等项目内容；
- Skill 文件、Skill 参数、MCP server instructions；
- 工具返回值、网页/文件正文、检查点摘要、记忆正文；
- 路径、日期、平台、模型、能力快照、预算等运行时变量；
- 扩展通过 hook/transform API 提供的自定义 Prompt。

“原文”采用两层表达：正文列出对行为有意义的固定英文模板；超长或含大量动态变量的模板同时给出权威源文件定位。短模板直接翻译；百行级 Prompt 用保留规则、禁止项、流程与输出契约的中文语义摘要，并明确回指逐字英文，不能冒充逐句对照稿。中文仅用于理解和审查，**不会被 Runtime 注入**，也不主张替换英文生产 Prompt。

## 统一术语

| 术语 | 含义 |
| --- | --- |
| 源码静态文本 | 存在于源码中的固定字面量或模板；模板渲染结果仍可因变量、feature flag 或工具集合而变化。 |
| 会话稳定值 | 在一次已解析 Session 内保持不变、但换 Session 或重载配置后可能变化的值。 |
| 缓存前缀 | 某个已解析请求变体中被 Provider 标记为可复用的前缀；它可能包含源码静态文本和会话稳定值，不保证对所有 Session 都字节相同。 |
| 动态尾部 | 会因会话、工作区、用户、工具或时间变化的请求内容。 |
| Trusted Instructions | Runtime 产生、进入 `system`/`instructions` 的唯一“铁律”政策块。 |
| context / evidence | 用户任务、项目约定、Skill、工具结果、记忆和摘要等模型输入；按来源和通道处理，不使用“高/低置信度”指挥模型。 |
| authority | 一段内容能否改变指令、权限或执行边界；它不是对内容真假的评分。 |
| provenance | 内容的来源、时间、digest、lineage 和可追踪引用。 |
| verification | 某个具体事实由 receipt、测试、verifier 或交叉审查支持到什么程度；只在影响决策时呈现。 |
| auxiliary call | 不继承主对话职责、为压缩/规划/校验/记忆等目的单独发起的模型调用。 |
| 装配 | 从 Prompt 片段、上下文、历史、工具 schema 到 Provider wire request 的确定性过程。 |
| 注入时机 | 某单元被创建并进入哪一次模型请求的条件与生命周期阶段。 |

## 快速结论

- **Praxis 的初始强项**是 Runtime 权限、能力衰减、来源容器、Manifest 与证据约束；初始短板是缺少统一 Prompt registry/version、Provider 缓存断点，以及“low-trust / cannot change policy”同义策略重复。当前默认路径已建立两版本 registry、唯一指令权威边界、中性 context envelope、全局默认源、Run-stable ContextView、Prompt/assembly manifest 和 Provider-only editing；内部 `trust` 字段不是事实置信度。真实 tokenizer、完整脱敏 wire dump、Anthropic 显式 cache blocks 与按需 Tool Search 仍未完成。
- **Pi 的强项**是小而清楚：一个可替换主系统 Prompt，加工具片段、项目上下文、Skill 和 cwd；扩展点强。短板是项目指令与 Skill 直接进入 system 字符串，信任隔离和可观测性较弱。
- **Claude Code copy 的强项**是产品化成熟：缓存前缀/动态尾部边界、按功能开关装配、完善工具说明、压缩/记忆/子 Agent 独立提示。短板是 Prompt 体量与条件分支非常大，重复规则和难以全局验证的运行时变体较多。
- Praxis 不应照搬最长的 Prompt；应借鉴 Claude 的**生命周期与缓存工程**、Pi 的**最小核心与扩展性**，保留自身的**Runtime 权限边界与来源可追踪性**，而不是增加模型可见的可信度等级。

2026-08-09 paired A/B 表明 lean 的主要收益是后四轮输入减少约 6.1%；修复前缀 cache 的关键是 Run 内冻结 ContextView，而不是继续压缩铁律文案。`iron-law-lean-v1` 已成为默认，`baseline-v1` 只用于显式回滚/A-B。

## 术语修订说明

Praxis 协议仍存在 `trust: 'user' | 'low'`，`baseline-v1` 兼容分支也保留 `Low-trust ...` 原文，所以基线审计章节必须继续逐字记录这些字样。默认 `iron-law-lean-v1` 已改用中性 envelope；不能把 baseline 的历史原文误读为生产推荐。现行决策把三件事分开：

- **指令权威**由唯一 Trusted Instructions、用户授权和 Runtime admission 决定；
- **来源追踪**由内部 role/trust、source、digest、lineage 和引用决定；
- **事实验证**由具体 receipt、测试、verifier、时效与冲突状态决定。

模型只接收一份不可被覆盖的 **Trusted Instructions**。其他内容标为任务、上下文或证据，不做全局“高/低信任”或“高/低置信度”分级。`agent.handoff` 的当前工具说明也已从旧的 `authoritative low-trust evidence` 改成 `reviewable evidence`；返回对象中的 `authoritativeResult` 仍是待兼容迁移的旧字段名，不能据此把 Child 输出视为已经验证的事实。
