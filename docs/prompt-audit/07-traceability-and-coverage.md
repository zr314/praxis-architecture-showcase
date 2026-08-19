# 源码追踪与覆盖对账（阅读版）

本页是人工阅读索引，把 Prompt 分组映射到源码符号、原文证据和最终请求节点；它不是可直接喂给 CI 的一单元一行 registry。`01` 只给出 Praxis 当前生产 Prompt，`02`–`03` 保存 Pi 与 Claude copy 的审计基线；本页聚合它们以便理解装配关系。Phase 0 应由扫描器为每个单元生成稳定 ID、独立 source symbol/anchor 和 wire block index。Claude copy 的大规模逐字英文证据以其现成的 `D:\claude-copy\docs\system-prompts\source-extracts.md` 为取证层，再由本审计补查该启发式提取未覆盖的源文件。引用外部动态正文时只登记插槽，不伪造固定原文。

## 1. 最终请求节点编号

### Praxis

| Node | Provider-visible value |
| --- | --- |
| `P.S0` | 默认唯一 `praxis.trusted-instructions`；baseline 为 P-SYS-01…05 合并结果 |
| `P.C0` | `runtime_facts` |
| `P.C1` | `skill_catalog`（若有） |
| `P.C2` | `project_guidance`（若有） |
| `P.C3` | Run-stable Session ContextView |
| `P.C4` | semantic checkpoint（若有且未选择 native context） |
| `P.C5+` | persisted Skill invocation replay（若有） |
| `P.H*` | 被 context selector 保留的对话后缀、新 user/tool/steer 消息 |
| `P.T*` | 当前有效 RuntimeTool/MCP definitions 与 schema |
| `P.AUX.*` | Planner、verifier、child worker 各自的独立请求，不与主线共用 node index |

默认主 loop 的真实 context 顺序是 `C0 → C1? → C2? → C3 → C4? → C5+ → H*`。`PromptAssembler.systemContextMessages` 是返回结构中的副本；当前 loop 使用 `promptBuild.contextMessages` 再拼 selector context，详见 `01` 与 `04`。消息对象中的 `trust` 是 Runtime-only 元数据，不是另一层 Provider 指令，也不是事实可信度。

### Pi

| Node | Provider-visible value |
| --- | --- |
| `PI.S0` | 初始化/重载时构建的基础 system，或当前 turn 的 `before_agent_start` override |
| `PI.M*` | context hook 变换后的 session messages，包括 compaction/branch user summary |
| `PI.T*` | 当前有效 tools definitions/schema |
| `PI.AUX.C` | 独立 compaction request |
| `PI.AUX.B` | 独立 branch summarization request |

`PI.S0` 通常跨 turns 复用；有效工具或 extension resources 变化时重建，每轮 extension 可临时替换。这个生命周期与“每轮重新构建”不同。

### Claude Code copy

| Node | Provider-visible value |
| --- | --- |
| `CC.S0` | request wrapper attribution / CLI prefix |
| `CC.S1*` | 当前 resolved 配置下、dynamic boundary 之前的缓存前缀 blocks |
| `CC.S2*` | boundary 之后的 Session/dynamic sections、MCP instructions 等 |
| `CC.S3*` | Git system context、advisor/Chrome 等 wrapper append |
| `CC.U0` | CLAUDE.md、memory、date 等合成 `<system-reminder>` user context |
| `CC.U1+` | 用户消息与 runtime attachments/reminders |
| `CC.T*` | enabled/deferred-loaded tools schema；未加载 deferred tool 只先以名称 reminder 出现 |
| `CC.CHILD.*` | AgentTool 启动的独立 Agent system + task user message |
| `CC.AUX.*` | compact、memory、docs、insights 等独立请求 |

`CC.S1*` 是 Provider cache candidate，不等于全局不可变源码；output style、`USER_TYPE`、enabled tools 和其他条件可产生多个前缀版本。

## 2. Praxis 单元追踪

| 文档 ID | 源码符号/文件 | Node |
| --- | --- | --- |
| `P-SYS-01…05` / lean single unit | `apps/runtime/src/prompt/systemPromptComposer.ts#SystemPromptComposer.compose`、`promptRegistry.ts#composeLeanTrustedInstructions` | `P.S0` |
| lean `runtime_facts` + `P-CTX-01…02` | `SystemPromptComposer.compose` 的 `contextMessages` | `P.C0…2` |
| `P-CTX-03` | `prompt/promptAssembler.ts#PromptAssembler.assemble` | `P.C3` |
| `P-CTX-04…05` | `memory/contextWindow.ts` checkpoint / Skill replay builders | `P.C4…5+` |
| `P-CTX-06…08` | `extensions/skillInvocationService.ts`、`framework/runtimeKernel.ts` envelope builders | `P.H*`，产生后按 persistence policy 重放 |
| `P-CTX-09` | `loop/index.ts`、`loop/units.ts` progress/repeated-failure guidance | `P.H*` |
| `P-PLAN-01…02` | `planner/providerPlanGenerator.ts` | `P.AUX.PLAN.S0/U0` |
| Planner route schema | `planner/planGenerator.ts#PLAN_SCHEMA` | `P.AUX.PLAN.T0.schema` |
| `P-VERIFY-01…02` | `planner/providerSemanticVerifier.ts` | `P.AUX.VERIFY.S0/U0` |
| `P-CHILD-01…03` | `workflow/agentAssembly.ts`、`workflow/localWorkflowAgentWorker.ts`、`subagent/contextPacket.ts` | `P.AUX.CHILD.S0/U0/schema` |
| 10 built-in tools | `apps/runtime/src/tools/*.ts`、`extensions/skillInvocationService.ts` | `P.T*` |
| 9 workflow tools | `apps/runtime/src/workflow/*Tool.ts` | `P.T*` |

人工对账结果：当前 Praxis 文档覆盖唯一 Trusted Instructions、9 类中性 context envelope、Planner/verifier/compactor、Child ContextPacket、10 个内置工具和 9 个协作/Workflow 工具。Plugin/MCP descriptors、project/Skill/resource 正文属于有界动态插槽。Planner 的 route/access/capability 规则和 Child 的结果合同已收敛到 `01`；历史单元处置保留在执行台账。可信度术语的当前处置见[决策记录](./10-authority-provenance-and-verification.md)。

## 3. Pi 单元追踪

| 文档 ID | 源码符号/文件 | Node |
| --- | --- | --- |
| `PI-SYS-01…04` | `packages/coding-agent/src/core/system-prompt.ts#buildSystemPrompt`；Skill catalog 还见 `packages/agent/src/harness/system-prompt.ts` | `PI.S0` |
| 7 tool descriptions/snippets/guidelines | `packages/coding-agent/src/core/tools/*.ts` | `PI.S0` snippets/guidelines + `PI.T*` descriptions/schema |
| `PI-COMP-01…04` | `core/compaction/utils.ts`、`core/compaction/compaction.ts` | `PI.AUX.C`；结果重放至 `PI.M*` |
| `PI-COMP-05` | `core/compaction/branch-summarization.ts#BRANCH_SUMMARY_PROMPT` | `PI.AUX.B`；结果重放至 `PI.M*` |
| summary wrappers | `core/messages.ts` | `PI.M*` |
| extension slots | `core/extensions/types.ts`、`agent-session.ts` | `PI.S0/M*/T*`，内容由 extension 决定 |

人工对账结果：4 个主 system 分组、7 个固定工具、23 条已列 schema descriptions、5 个压缩/分支单元及 3 类重放 wrapper。重复出现在 coding-agent 与通用 harness 的同义文本按语义单元去重。PI-COMP-03 与 PI-COMP-05 的完整英文模板及中文翻译已直接写入 `02`。

## 4. Claude copy 单元追踪

| 文档单元 | 权威源码 | `source-extracts.md` anchor | Node |
| --- | --- | --- | --- |
| `CC-SYS-01…10` | `src/constants/prompts.ts#getSystemPrompt` 及 section helpers | line 4391 | `CC.S1*` / `CC.S2*` |
| simple/override/append priority | `src/constants/prompts.ts`、CLI/query initialization | line 4391 与 `injection-map.md` | `CC.S*` |
| runtime reminders | `src/utils/attachments.ts` 与 attachment producers | 对应 runtime attachment 文件 header | `CC.U0/U1+` |
| `CC-CHILD-01…03` | `src/tools/AgentTool/prompt.ts`、`built-in/*.ts` | Agent line 13530；built-ins line 12625–13238 | `CC.CHILD.*`；`whenToUse` 同时进入父 `CC.T*` |
| `CC-COMP-01…02` | `src/services/compact/prompt.ts` | line 9408 | `CC.AUX.COMPACT` |
| memory extraction | `src/services/extractMemories/prompts.ts` | line 9840 | `CC.AUX.MEMORY` |
| Magic Docs | `src/services/MagicDocs/prompts.ts` | line 10094 | `CC.AUX.DOCS` |
| Session Memory | `src/services/SessionMemory/prompts.ts` | line 10685 | `CC.AUX.SESSION_MEMORY` |
| 40 model-visible tool rows | `src/tools/**/prompt.ts`，另有 `McpAuthTool.ts`、`SyntheticOutputTool.ts`、`TaskOutputTool.tsx` | 各 source file header；Agent 从 line 13530 | `CC.T*` |
| `/commit-push-pr` | `src/commands/commit-push-pr.ts#getPromptContent` | line 838 | synthetic `CC.U1+` |
| `/commit` | `src/commands/commit.ts#getPromptContent` | line 941 | synthetic `CC.U1+` |
| `/init` | `src/commands/init.ts#OLD_INIT_PROMPT`、`#NEW_INIT_PROMPT` | line 1229 | synthetic `CC.U1+` |
| `/init-verifiers` | `src/commands/init-verifiers.ts#getPromptForCommand` | extractor 未收录；直接源码 | synthetic `CC.U1+` |
| `/insights` facets/sections | `src/commands/insights.ts` | line 1297 | `CC.AUX.INSIGHTS.*` |
| `/review` | `src/commands/review.ts#LOCAL_REVIEW_PROMPT` | line 1685 | synthetic `CC.U1+` |
| `/statusline` | `src/commands/statusline.tsx#getPromptForCommand` | line 1732 | synthetic `CC.U1+` → `CC.CHILD.statusline` |
| moved-to-plugin fallback | `src/commands/createMovedToPluginCommand.ts` 与调用文件 | extractor 视调用文件而定 | synthetic `CC.U1+` |
| `/security-review`、`/pr-comments` fallback | `src/commands/security-review.ts`、`src/commands/pr_comments/index.ts` | extractor 未完整收录；直接源码 | synthetic `CC.U1+` |
| auto-mode rules critique | `src/cli/handlers/autoMode.ts#CRITIQUE_SYSTEM_PROMPT` | line 236 | `CC.AUX.AUTO_MODE.S0/U0` |
| memory selector | `src/memdir/findRelevantMemories.ts#SELECT_MEMORIES_SYSTEM_PROMPT` | 对应 source file header | `CC.AUX.MEMORY_SELECT.S0/U0` |
| agentic Session search | `src/utils/agenticSessionSearch.ts#SESSION_SEARCH_SYSTEM_PROMPT` | 对应 source file header | `CC.AUX.SESSION_SEARCH.S0/U0` |
| model validation | `src/utils/model/validateModel.ts` 固定 `Hi` | 对应 source file header | `CC.AUX.MODEL_VALIDATE.U0` |
| Chrome side-query pass-through | `src/utils/claudeInChrome/mcpServer.ts` | 对应 source file header | `CC.AUX.CHROME` 动态 system/messages |

人工对账结果：10 个主 system 分组、默认/env 与 6 个 built-in Agent、compact 模板族、memory/docs/auto-mode critique 及其他 auxiliary calls、40 个工具职责行、9 个 user-facing Prompt commands（其中两项共享 moved-to-plugin factory）和 insights 的 9 个独立 section prompts 均已登记并给出中文语义翻译。`McpAuthTool`、`SyntheticOutputTool`、`TaskOutputTool` 已补齐；`MCPTool` 是显式空单元；`REPLTool` 未发现独立固定模型文本，记录为有源码目录但无可登记 Prompt，而不是遗漏。

## 5. 自动化冻结规则

本阅读索引适合本次理解与设计，但生产基线必须由扫描器持续验证。建议 CI 为每个仓库输出：

```text
category | source candidates | registered | justified exclusions | unexplained delta
```

只有所有类别 `unexplained delta = 0`，并且每个 registered unit 都有 `source symbol → rendered digest → wire node/block index`，才可冻结版本。条件分支还应至少采样 default、不同 tool set、不同 output style/USER_TYPE、Agent/compact/command paths；运行时 dump 用来验证选中分支和顺序，源码扫描用来验证全集，两者互相补充。
