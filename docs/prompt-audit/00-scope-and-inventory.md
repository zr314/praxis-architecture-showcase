# 审计范围与全量来源清单

## 1. 识别规则

源码中的字符串只有在满足以下至少一项时才计为 Prompt 单元：

1. 被送入 Provider 的 `instructions`、`system`、`messages` 或 `input`；
2. 被装入模型可见的 `tools[].description` 或 JSON Schema `description`；
3. 被包装为合成的 user/context/reminder 消息并持久化或重放；
4. 被独立的模型调用用于规划、压缩、校验、提取、总结或维护；
5. 成为子 Agent 的系统职责、任务说明、约束、禁止项、成功标准或输出协议。

错误消息、UI 文案、测试夹具和只给人看的 CLI 帮助不计入；若某段错误信息会作为工具结果回到模型，它属于“动态工具结果”，登记通道但不逐条翻译所有可能错误。

## 2. 覆盖矩阵

| 类别 | Praxis | Pi | Claude copy |
| --- | --- | --- | --- |
| 主系统 / instructions | `systemPromptComposer.ts` | `system-prompt.ts` | `constants/prompts.ts` |
| 项目指令 | 默认中性 user context envelope；内部保留来源元数据 | 拼入 system 的 XML | CLAUDE.md 等通常作为首轮 system-reminder/user context |
| Skill | 默认中性 catalog/invocation envelope；正文按需加载 | Skill catalog 拼入 system；模型再读取文件 | Skill tool、skill discovery attachment、动态全文 |
| Session continuity | ContextView、checkpoint、skill replay | compaction/branch summary user message | compact summary、session memory、自动 reminders |
| 工具 Prompt | RuntimeTool definitions/schema | tool definitions/snippets/guidelines | 每个工具 `prompt.ts` + schema |
| 辅助模型调用 | Planner、semantic verifier | compaction、branch summary | compact、memory extraction、Magic Docs、Session Memory、WebFetch 二级模型等 |
| 子 Agent | profile + canonical context packet | 由 harness/extension动态提供 | default agent、agent-specific prompt、env notes |
| Provider 装配 | Anthropic / Responses / Chat-compatible adapters | pi-ai provider adapter | Anthropic Messages request builder |
| 追踪 | Prompt manifest + digest | session tree，缺少统一 prompt manifest | cache scope/section registry + debug/request logging |

## 3. Praxis 权威来源

### 3.1 主会话与上下文

| 文件 | 模型可见内容 |
| --- | --- |
| `apps/runtime/src/prompt/systemPromptComposer.ts` | 默认唯一 Trusted Instructions、runtime facts、Skill catalog 和 project guidance；baseline 保留旧 sections/reminder。 |
| `apps/runtime/src/prompt/promptAssembler.ts` | 默认中性 Session ContextView；系统、上下文、历史、checkpoint 和工具预算装配。 |
| `apps/runtime/src/prompt/contextBuilder.ts` | Prompt ContextView 的运行时数据来源。 |
| `apps/runtime/src/prompt/projectInstructionLoader.ts` | 项目指令发现、选择、裁剪与决策记录。 |
| `apps/runtime/src/memory/contextWindow.ts` | checkpoint、Skill invocation replay、历史后缀选择。 |
| `apps/runtime/src/memory/contextEditing.ts` | Provider-only Tool result 截断与陈旧只读结果清理；不改 durable transcript。 |
| `apps/runtime/src/memory/reasoningContextEditing.ts` | Provider-only reasoning/thinking block 清理；保留最近 reasoning turn。 |
| `apps/runtime/src/providers/openAIResponsesProvider.ts` | OpenAI `/v1/responses/compact` 调用与 opaque compaction item 原样重放。 |
| `apps/runtime/src/framework/runtimeKernel.ts` | 用户 Skill 参数、Prompt resource、Prompt command provenance 等合成消息。 |
| `apps/runtime/src/loop/index.ts` | 每轮 Provider request 顺序、tool loop、progress guidance 注入。 |
| `apps/runtime/src/loop/units.ts` | 重复失败时的低信任 Runtime guidance。 |

### 3.2 独立模型调用与子 Agent

| 文件 | 模型可见内容 |
| --- | --- |
| `apps/runtime/src/planner/providerPlanGenerator.ts` | 规划 system instruction、planning user prompt、提交计划工具。 |
| `apps/runtime/src/planner/providerSemanticVerifier.ts` | fresh-context verifier system/user prompt、提交校验工具。 |
| `apps/runtime/src/workflow/agentAssembly.ts` | worker/explorer/default profile、默认成功标准、模型可见 assembly schema 描述。 |
| `apps/runtime/src/workflow/localWorkflowAgentWorker.ts` | 子任务追加指令、约束、禁止项、结果 envelope schema。 |
| `apps/runtime/src/subagent/contextPacket.ts` | ContextPacket 固定前言、canonical JSON、输出协议。 |
| `apps/runtime/src/extensions/skillInvocationService.ts` | Skill 工具说明和 Skill invocation reminder。 |
| `apps/runtime/src/planner/controlledWorkspaceMerge.ts` | 合并失败后供执行者参考的恢复说明；作为工作流结果/上下文出现。 |
| `apps/runtime/src/planner/directoryWorkspaceIsolation.ts` | 隔离目录恢复说明；作为工作流结果/上下文出现。 |

### 3.3 工具定义

内置工具：`artifact_read`、`edit`、`find`、`glob`、`grep`、`ls`、`read`、`shell`、`write`、`skill`。

工作流工具：`agent.delegate`、`agent.handoff`、`workflow.expand`、`workflow.subworkflow`、`workflow.loop`、`workflow.compensate`、`workflow.wait`、`workflow.human_task`、`workflow.timer`。

第三方 Plugin/MCP 工具定义是运行时输入：Runtime 只装配其名称、描述和 schema，固定原文不在 Praxis 仓库内。

## 4. Pi 权威来源

| 文件/目录 | 模型可见内容 |
| --- | --- |
| `packages/coding-agent/src/core/system-prompt.ts` | 默认系统 Prompt、工具 snippets/guidelines、项目上下文、Skill、cwd；custom/append 优先级。 |
| `packages/agent/src/harness/system-prompt.ts` | Skill catalog 的三条固定指令与 XML 布局。 |
| `packages/coding-agent/src/core/tools/*.ts` | bash/edit/find/grep/ls/read/write 的 description、promptSnippet、promptGuidelines 和 schema description。 |
| `packages/coding-agent/src/core/messages.ts` | compaction summary、branch summary、bash execution 的 user 消息转换。 |
| `packages/coding-agent/src/core/compaction/compaction.ts` | 初次/增量/超大单轮前缀压缩 Prompt。 |
| `packages/coding-agent/src/core/compaction/branch-summarization.ts` | 废弃分支摘要 Prompt 与恢复前言。 |
| `packages/coding-agent/src/core/compaction/utils.ts` | 摘要调用 system Prompt。 |
| `packages/agent/src/harness/agent-harness.ts` | 未提供自定义系统 Prompt 时的 `You are a helpful assistant.`。 |
| Extension API | `input`、`before_agent_start`、`context` 等 hook 可替换输入、system 或消息；内容由扩展提供。 |

Pi 仓库同时有 `packages/agent/src/harness` 与 `packages/coding-agent/src/core` 的平行实现；相同文字只翻译一次，文档注明两处来源，不把复制代码误计为两个语义 Prompt。

## 5. Claude Code copy 权威来源

Claude copy 已带一套逆向审计资料：

- `D:\claude-copy\docs\system-prompts\inventory.md`：分类清单；
- `D:\claude-copy\docs\system-prompts\injection-map.md`：主会话、提醒、辅助请求与子 Agent 的调用链；
- `D:\claude-copy\docs\system-prompts\source-extracts.md`：由 `scripts/extract-system-prompts.mjs` 从 244 个候选文件生成，含 563 个匹配组，是大规模英文原文取证层；它是启发式匹配产物而非完备性证明，例如未收录 `init-verifiers.ts`；
- `D:\claude-copy\src\constants\prompts.ts`：默认主系统 Prompt 的唯一主体入口。

本审计把宽泛匹配结果收敛为以下语义单元：

### 5.1 主系统段落

`hooks`、`system reminders`、`language`、`output style`、`intro`、`system`、`doing tasks`、`executing actions with care`、`using tools`、`agent tool`、`skill discovery`、`session-specific guidance`、`output efficiency`、`tone and style`、`MCP server instructions`、`environment`、`memory`、`scratchpad`、`function result clearing`、`summarize tool results`、`token budget`、`brief`、`autonomous work`。

### 5.2 子 Agent、Prompt commands 与辅助请求

`DEFAULT_AGENT_PROMPT`、子 Agent env notes、agent definition prompt；内置 `general-purpose`、`Explore`、`Plan`、`statusline-setup`、`claude-code-guide`、`verification` Agent；内置 Prompt commands `commit`、`commit-push-pr`、`init`、`init-verifiers`、`insights`、`review`、`statusline`、`security-review` 与 `pr-comments`；完整/部分/前缀压缩；自动/团队记忆提取与相关 memory selection；Magic Docs 更新；Session Memory 模板与更新；auto-mode rules critique、agentic session search、model validation 等 side query；WebFetch 二级模型内容处理；Chrome automation；companion/buddy。

### 5.3 工具 Prompt 文件

以下文件都进入 `tools[].description`、延迟工具 schema 或工具使用指导：

`AgentTool`、`AskUserQuestionTool`、`BashTool`、`BriefTool`、`ConfigTool`、`EnterPlanModeTool`、`EnterWorktreeTool`、`ExitPlanModeTool`、`ExitWorktreeTool`、`FileEditTool`、`FileReadTool`、`FileWriteTool`、`GlobTool`、`GrepTool`、`ListMcpResourcesTool`、`LSPTool`、`MCPTool`、`McpAuthTool`、`NotebookEditTool`、`PowerShellTool`、`ReadMcpResourceTool`、`RemoteTriggerTool`、`ScheduleCronTool`、`SendMessageTool`、`SkillTool`、`SleepTool`、`SyntheticOutputTool`、`TaskCreateTool`、`TaskGetTool`、`TaskListTool`、`TaskOutputTool`、`TaskStopTool`、`TaskUpdateTool`、`TeamCreateTool`、`TeamDeleteTool`、`TodoWriteTool`、`ToolSearchTool`、`WebFetchTool`、`WebSearchTool`，以及 `utils/claudeInChrome/prompt.ts`。

`MCPTool/prompt.ts` 的 `PROMPT` 和 `DESCRIPTION` 均为空字符串，不产生语义内容，但仍登记为显式空单元。

`REPLTool` 目录存在，但本基线中没有识别到独立、固定且直接进入模型的 `prompt()`/`description()` 文本；它复用 Read/Write/Glob/Grep 等常量，因此不虚构一个 REPL Prompt 单元。测试专用工具不计入生产全集。

## 6. 动态插槽登记

| 插槽 | 来源 | 固定包装 | Provider 角色 / Runtime 元数据 | 注入时机 |
| --- | --- | --- | --- | --- |
| 用户任务 | 用户 | 无或产品命令包装 | user | 每个新任务/steer |
| 项目指令 | 工作区文件 | 各产品自己的 XML/reminder | Praxis 默认为 user context、内部 `trust=low`；Pi system；Claude user reminder | session 初始化或请求重建 |
| Skill 元数据/正文 | 安装的 Skill | catalog / invocation wrapper | 产品各异 | 初始化、匹配或按需调用 |
| MCP instructions | MCP server | 标题分块/动态 attachment | Claude system/delta；其他取决于实现 | 连接、重连或请求重建 |
| 工具结果 | Runtime/tool | provider 原生 tool result | tool result；来源/receipt 由 Runtime 记录 | 每次工具完成后下一轮 |
| checkpoint | 压缩器/持久层 | summary wrapper | context user | 历史超预算或恢复会话 |
| 环境事实 | Runtime | `runtime_facts`；baseline 为 workspace section | 默认 user context；baseline system/instructions | 主请求装配时 |
| 子任务包 | Planner/父 Agent | canonical JSON/envelope | child user/context | 子 Agent 启动时 |

本表的 Runtime `trust` 是路由、持久化和兼容元数据，不是内容真伪等级，也不等于 Provider role。默认生产 Prompt 不把它渲染成“低可信”标签；具体事实是否可靠由 provenance、时效、receipt、verifier 和冲突状态判断。详见[指令权威、来源与事实验证](./10-authority-provenance-and-verification.md)。

## 7. 完整性限制

- Claude copy 是构建产物/逆向副本，feature flag、内部模块和运行时 attachment 会让“某次真实请求”只包含全集的一个条件分支。
- Pi 扩展和三套系统的 MCP/Skill/项目文件均可注入仓库外内容；本审计能证明插槽和边界，不能预先翻译未知未来内容。
- JSON Schema 的字段名、枚举和约束本身是机器协议，不做中文替换；只翻译其中影响模型决策的英文 `description`。
- 中文翻译用于审计，不参与精确缓存哈希，也不保证与英文 token 数相近。

## 8. 关键源文件 SHA-256

这些 digest 锚定的是审计时 working-tree 文件，不等同于 Git commit：

| 源文件 | SHA-256 |
| --- | --- |
| Praxis `prompt/systemPromptComposer.ts` | `71f3139addaced102db08121ec92d9a2eb838380ff536a8028619673499377c8` |
| Praxis `prompt/promptAssembler.ts` | `6c2b3882be987fa4b0e64bca75917ce06e0cf5d3cb9f087e264a5ff0c3d55c0d` |
| Praxis `memory/contextWindow.ts` | `d8c4d976c47fc560444117305608567c2450736ae378743b190a4451fb55ba5e` |
| Praxis `planner/providerPlanGenerator.ts` | `8a4dd7c255e2923868787bb845229d633b049f3caa02a1d3f28ac4dd787e06d7` |
| Praxis `planner/planGenerator.ts` | `58179b14cc6ee5ab00d8a58aa99bd10284dd0a515c70358fb47e7eef5c4f0ee4` |
| Praxis `planner/providerSemanticVerifier.ts` | `8165bcc32897ca6a0a8f68aec180ca7b8526637fd99220cf10f99c10b9678441` |
| Praxis `workflow/agentAssembly.ts` | `9a4dfdaa3587799170584d659acb92432ca2e6e7ae1b2fb503d0d4976c46fb95` |
| Praxis `workflow/localWorkflowAgentWorker.ts` | `795466c2078cc5a1f10dafd126ace39815c3920b4053f1071b83ee2c3d747e2d` |
| Praxis `subagent/contextPacket.ts` | `cb87332343d6b48ca11984bdd6dcbfefa8fdb3b953380e6eba74984330226582` |
| Pi `core/system-prompt.ts` | `677c3cf2ca259d15c27466961702a489244e9505829a6c994d0de314b2a469ef` |
| Pi `core/agent-session.ts` | `4fb0c7cafa450588a8786617f2212c08356160af325c137b8cc7f065a4a9bc9e` |
| Pi `core/compaction/compaction.ts` | `0ce643e2e3c97e4dc160e888e93cb8b5b53914e609a6d333765493d630b6b731` |
| Pi `core/compaction/branch-summarization.ts` | `9b0af541098b1f8346c1cb8bcbe51b6194288a10cf55dc0365a71fd8d41e9b9b` |
| Pi `core/compaction/utils.ts` | `6e9d2c0b6076d5cac5fd444e5381a1fc01da5acf30eb776319a6b562fc42a02c` |
| Claude `constants/prompts.ts` | `7dac778e089a7f002403df2a2efb6f0b9e4a450af21766680ab8948596c10f25` |
| Claude `services/compact/prompt.ts` | `7e676e4003a0c1dd4c5b3ca9e7fa413dc957bf03e937da17d2ed900876708c55` |
| Claude `SessionMemory/prompts.ts` | `37c52fa005cfda8ebe3978d7e93a6101c1d956010f2a4733b9a38481d0b85975` |
| Claude `extractMemories/prompts.ts` | `0ac1179d56716466629822a15c2c2c736847e092708e9d14d7f9a6202db86c9e` |
| Claude `commands/init-verifiers.ts` | `5f6b98fa36a08698ff3bc04bf750249b67a5460e47736580af11741ade67784b` |
| Claude `commands/security-review.ts` | `3306669f0ba32658c2fbe565d260ae804f2d1114dac8bd68581812b9000cf64b` |
| Claude `commands/pr_comments/index.ts` | `6ac1e4f2dc79a464496bb4e32844aba69b49323e16163128ef12d50d626ca109` |
| Claude `cli/handlers/autoMode.ts` | `9e018a6599d62a72c2828e4580336a0c4b42b31bb85502e1096ce81fb8730a26` |
| Claude `AgentTool/builtInAgents.ts` | `24df97f95532f86108d60176d1c708edf4040bda028ee8f22a52f1bac6acfb22` |
| Claude `AgentTool/built-in/verificationAgent.ts` | `467f06234a59cdc07f52e4a418d8b66ec98507e793ef0bed3c1c45afa0b2559e` |
| Claude `source-extracts.md` | `422cecf9af05667b54e39736abc42157e3b7e834b72c97974bffc87fe9d89d1d` |
