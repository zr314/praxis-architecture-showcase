# Praxis Prompt 首批执行台账

状态：**Phase 0–2 的实现切片与定向验证已完成；逐 unit 机器账本仍未完备。`iron-law-lean-v1` 已于 2026-08-09 晋升为默认，`baseline-v1` 保留为显式回滚；命名式 production alias 尚未创建。**

本页记录 2026-08-08 经用户确认后实际落地的第一批改动，并在第 8–9 节追加后续上下文/cache 结果。第 1–7 节是历史阶段账本，不应把其中“候选尚未晋升”理解为当前状态；现行装配规范见[Prompt、Context 与 Compaction](../prompt-assembly.md)，最终测评见[最终测评总结](../evaluation-final-2026-08-09.md)。

## 1. 本批边界

- 注册 `baseline-v1` 与 `iron-law-lean-v1` 两个版本；首批实现时默认仍为前者，2026-08-09 已切换为后者。
- 为每个已接入的候选模型请求编译一个 `praxis.trusted-instructions`，并在 manifest 中记录 version、owner、block count、digest、estimated tokens 和 component IDs。
- 主 Agent 的动态 workspace / workflow facts、Skill catalog、project guidance、Session ContextView、checkpoint Skill replay、显式 Skill、Prompt command provenance 和 Prompt resource 改用中性 `<praxis-context kind="…">` envelope。
- Planner 与 semantic verifier 的 call-specific 输出契约并入同一个 Trusted Instructions block。
- Runtime 内部的 `trust`、provenance、permission、risk、持久化与 admission 语义保持不变；`trust` 不作为事实置信度渲染给默认候选模型。
- 本批没有运行行为评测，没有读取旧评测分数，没有修改 Pi 或 Claude copy。

未设置 `RuntimeKernelOptions.promptVariant` 或 `PRAXIS_PROMPT_VARIANT` 时为 `iron-law-lean-v1`。可通过相同入口显式指定 `baseline-v1` 做回滚或 A/B；未知值会被拒绝，而不是静默回退。

## 2. 标识与 Prompt registry

| 层级 | 本批 canonical identifier | 说明 |
| --- | --- | --- |
| Runtime selector / registry variant | `baseline-v1`、`iron-law-lean-v1` | 当前代码真实接受的值 |
| Trusted unit ID | `praxis.trusted-instructions` | 每个已接入候选请求中的唯一铁律 ID |
| 未来 production/canary alias | 尚未创建 | Roadmap 中 `praxis.prompt.*` 仅为设计占位，不是当前可用 selector |

### 2.1 已实现的不变量

| 项目 | 实现 | 当前结果 |
| --- | --- | --- |
| 版本注册 | `apps/runtime/src/prompt/promptRegistry.ts` | `baseline-v1`、`iron-law-lean-v1` |
| 默认 variant 常量 | `DEFAULT_PROMPT_VARIANT` | `iron-law-lean-v1` |
| 唯一 ID | `praxis.trusted-instructions` | 主请求、Planner、verifier 候选路径共用 |
| 候选编译器 | `composeLeanTrustedInstructions()` | 铁律核心与 call-specific contract 合成一个字符串 |
| 最终清单 | `PromptManifest.program` | 固定 `blockCount: 1`，记录 rendered digest/token |
| 中性上下文 | `renderNeutralContext()` 及 replay renderer | 默认候选不呈现 high/low trust/confidence 分层措辞；内部元数据继续存在 |

Provider 仍只接收一个 `instructions` 字符串。manifest 的 `blockCount: 1` 是编译期不变量，不是依赖 Prompt 文案自报的属性。

## 3. 已实现切片的 Unit 处置摘要

下表是人工摘要，不冒充 Roadmap Phase 2 要求的逐 unit 机器账本。实现切片和定向门禁已经通过，但仍缺少每个 unit 的独立 source digest、完整条件矩阵和 wire block index，因此不能把“当前切片通过”扩大成“机器化资产治理全部完成”。

| 原单元 | baseline-v1 | iron-law-lean-v1 处置 | 替代位置 | 契约证据 |
| --- | --- | --- | --- | --- |
| `P-SYS-01…05` safety / identity / workspace / workflow / execution | 原样保留 | rewrite + merge | 唯一 `praxis.trusted-instructions`；动态 facts 后置 | `system-prompt.test.ts` |
| `P-CTX-01` Skill catalog reminder | 原样保留 | move + rewrite | `kind="skill_catalog"` | `system-prompt.test.ts` |
| `P-CTX-02` project guidance reminder | 原样保留 | move + rewrite | `kind="project_guidance"` | escaping 与 included 测试 |
| `P-CTX-03` Session ContextView | 原样保留 | rewrite | `kind="session_view"` | `prompt-assembly-v3.test.ts` |
| `P-CTX-04…05` checkpoint / Skill replay | 原样保留 | rewrite | checkpoint 正文 + `kind="skill_invocation_replay"` | `prompt-assembly-v3.test.ts` |
| `P-CTX-06` Skill Tool / invocation | 原样保留 | rewrite 文案；参数、输出和 execution schema 不变 | 中性 Tool description + `kind="skill_invocation"` | `skill-invocation.test.ts` |
| `P-CTX-07…08` Prompt command / resource | 原样保留 | rewrite | `kind="prompt_command_provenance"` / `kind="prompt_resource"` | Runtime 调用点按 variant 装配 |
| `P-PLAN-01…02` | 原样保留 | rewrite + merge | Planner contract 并入唯一铁律块；proposal context 改中性句式 | `provider-planner-adapters.test.ts` |
| `P-VERIFY-01…02` | 原样保留 | rewrite + merge | verifier contract 并入唯一铁律块 | `provider-planner-adapters.test.ts` |
| project manifest `included` | 保留原 Prompt 字节 | fix manifest 判定 | 由 `project.content.length > 0` 独立决定 | omission contract test |

这里的“原样保留”指模型可见 baseline Prompt 字节；新增的 registry manifest 元数据不进入模型正文。Skill Tool 的候选 description 发生了文案变化，但其 JSON parameters、output schema 与 execution contract 未变。`project manifest included` 是 baseline/candidate 同时生效的可观测性修复，不是 Prompt-only 差异；未来成对实验必须让两组共同包含该修复。

## 4. 冻结 fixture 与静态指标

可复现命令：

```powershell
npm run audit:prompts
```

固定 fixture：`prompt-program-root-win32-v1`，cwd=`D:/workspace/praxis`，root/auto，包含 `read`、`agent.delegate`、`workflow.expand`、一个 Skill disclosure 和一份项目说明。计数器沿用当前 Composer 的 UTF-8 bytes/2 静态 estimator，不冒充 Provider tokenizer。

本次实现源码 bundle 使用排序后的 `path NUL bytes NUL` 做 SHA-256，结果为 `sha256:0a2e784f914938a402c7c5e94ab6a0de5103e8321ee02f8b1bbb586e290020d6`；源 Git commit 为 `08e71bca07ead67a19e69f8258e84318f1bde653`。bundle 文件清单由 `npm run audit:prompts` 一并输出。

| 指标 | baseline-v1 | iron-law-lean-v1 | 变化 |
| --- | ---: | ---: | ---: |
| Trusted Instructions characters | 2741 | 1081 | -60.6% |
| Trusted Instructions estimated tokens | 1371 | 541 | **-60.5%** |
| 整个 system/context estimated tokens | 1529 | 826 | **-46.0%** |
| context messages | 1 | 3 | 动态 facts/context 后置后的预期变化 |
| Trusted block header count | 不适用旧标题 | 1 | 满足候选不变量 |
| 候选禁用分层词命中 | 不适用 | 0 | 仅针对本 fixture 的最终渲染内容 |

冻结 digest：

- baseline Trusted Instructions：`sha256:cb60dfbc326a8ee568fd7a388d93c07e53cb84379a76424550d573b2bde3761b`
- candidate Trusted Instructions：`sha256:f94d96b38d8eb5361bde3adfcc958c3ef03f90b2fad7c9285520eaffdfcfa2ba`

baseline digest 已写入契约测试，防止无意漂移。candidate digest 由版本化审计脚本输出；候选在全路径与晋升门禁通过前仍允许按审计意见修订。

## 5. 验证结果

已执行的重点检查：

```powershell
npm run typecheck
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.check.json --test test/system-prompt.test.ts test/prompt-assembly-v3.test.ts
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.check.json --test test/provider-planner-adapters.test.ts test/skill-invocation.test.ts
npm run audit:prompts
```

重点契约覆盖：默认版本、唯一 ID、单 block、baseline digest、候选禁止词、workspace facts 后置、project/Skill escaping、checkpoint replay、Planner/verifier 单块装配，以及 Skill 参数/输出/execution schema 不变。下面的运行记录必须明确给出结果；未列出的检查均视为未运行，不能从命令清单推断通过。机器可读摘要见 [`verification-20260808.json`](./verification-20260808.json)。

| 检查 | 结果 | 可核对摘要 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | TypeScript 无错误 |
| 10 个变更相关 test files | exit 0 | 94 tests，94 pass，0 fail，0 skip；2355.7788 ms |
| `npm run audit:prompts` | exit 0 | fixture 与 source bundle digest 如上；候选禁用词 0 |
| `npm run lint` | exit 0 | 471 files，无 lint error |
| 19 个变更相关文件 format check | exit 0 | 无 format error |
| `npm run format:check` | exit 0 | 471 files；经用户授权后修复 4 个既有脏文件的混合换行/尾随空白，并格式化本验证 JSON |
| 首次 `npm test` | exit 124 | 外层 124037 ms 超时，未取得最终汇总 |
| 第二次 `npm test`（历史尝试） | exit 1 | 1024 tests：1018 pass、1 fail、5 skip；production evaluation 的旧断言固定期望 compactions=1，实际原因为 `threshold, threshold, manual` |
| production evaluation 定向复核 | exit 0 | 3 tests，3 pass，0 fail，0 skip；12834.6118 ms |
| 最终 `npm test` | exit 0 | 1025 tests：1020 pass、0 fail、5 skip；214060.4841 ms |

第二次全量测试的单一失败已完成归因：production composition fixture 会触发两次合法的自动 threshold compaction，随后测试再显式触发一次 manual compaction；旧断言却把总数固定为 1。断言已改为核对摘要计数与 trace 记录一致、恰有一次 `manual`，且 reason 只能是 `manual` 或 `threshold`。定向复核及最终全量测试均通过。该修复不改变 Prompt 文案，baseline Trusted Instructions digest 仍未改变。

经用户明确授权，一并规范化了四个问题明确的既有脏文件：`apps/runtime/src/longLivedExecutionPolicy.ts`、`apps/runtime/src/workflow/subworkflowTool.ts`、`apps/runtime/src/workflow/workflowOrchestrator.ts`、`test/workflow-orchestrator.test.ts`；改动只处理混合换行/尾随空白。验证 JSON 也按仓库格式化规则重新排版。

本次没有保存原始终端日志；JSON 只保存命令、退出码和有界汇总。这是 Phase 0 证据链仍未完成的一部分，不能用该摘要冒充完整可重放日志或 wire artifact。

## 6. 首批结束时未完成，以及当前状态

以下事项没有伪装成本批已完成：

- 已运行 DeepSeek Prompt-only paired A/B：lean 后四轮 input 减少约 6.1%，cache 命中与 baseline 接近；它支持“体积更小”的结论，不证明通用任务成功率提升。
- 主 Agent、Planner、verifier、Skill、checkpoint replay 和 Child composition 的默认均已统一到 `DEFAULT_PROMPT_VARIANT`；内部 `trust` 字段和 baseline 分支合法保留。
- 已实现 compatible Provider 的 Run-stable prefix 生命周期；尚未实现 Anthropic 显式 cache blocks、真实 tokenizer、完整 wire request dump/digest 和按需 Tool schema loading。
- `iron-law-lean-v1` 已成为默认；命名式 canary/production alias 仍未创建。
- 仍不能以源码全文字符串搜索代替最终 payload 审计，因为 baseline 分支和 Runtime-only 注释会合法保留旧词。

## 7. 历史晋升门禁与当前变更门禁

首批结束时的结论是“候选架构可继续，但当时不切换默认”。随后已完成全路径默认统一、contract/payload 检查和 paired cache/体积验证，并于 2026-08-09 晋升。以下历史问题已经用于人工审计：

1. Trusted Instructions 英文核心及 root/child operational contract 是否语义充分且无冗余；
2. 动态 workspace/workflow facts 后置为 context 是否符合预期；
3. Skill Tool description 的候选文案差异是否可接受；
4. compactor、memory、Child 与 Workflow Tool 的 context/prompt 边界；
5. paired eval 的固定模型、任务、工具、ContextView 生命周期和首轮冷热解释。

当前继续变更 Prompt 时必须遵守[现行装配规范](../prompt-assembly.md)的 review checklist：单一 Trusted Instructions、确定性 context 顺序、Tool schema 独立、Child 合同机械校验、manifest/trace 可解释、paired eval 与显式回滚。命名式 production alias 仍是独立的后续版本治理能力。

## 8. 后续上下文工程批次（2026-08-08）

本批不改变 production Prompt alias，完成的是 PromptAssembler、Provider adapter 与 durable checkpoint 之间的上下文协议：

- `SummaryCheckpoint` 同时保存 portable semantic checkpoint 与可选 `ProviderNativeContext`；V3 JSONL/SQLite projection、JSONL repository 和 Child IPC request 均能验证和恢复该字段。Child credential broker 另有独立 compact RPC，复用短期 handle、target/deadline/replay/token-budget 校验，不把 API key 下发给 Child。
- OpenAI Responses adapter 接入独立 `/v1/responses/compact`，把返回的 canonical opaque items 原样作为后续请求前缀；Runtime 绑定 provider、model、instructions digest、message coverage 与 source digest。精确绑定不成立、端点失败或状态不合法时保留 semantic checkpoint，不使主任务失败。
- `PromptAssemblyManifest.context.state` 只记录 `none / semantic_checkpoint / provider_native` 及无正文的 digest/target 元数据，不记录 opaque payload。
- reasoning/thinking 与 Tool result 都只在 Provider 发送视图中清理；SessionJournal 的 canonical transcript 不改写。OpenAI Responses/Anthropic adapter 不再把展示用 reasoning 伪造成普通 assistant 文本；DeepSeek 保留其 Tool-thinking 协议需要的最近 `reasoning_content`。
- 取消原生 compact 状态的 8 MiB 和 SessionJournal 单事件 1 MiB 字节硬上限；继续保留 JSON 可序列化、最大嵌套深度、字段、ID、列表数量与 reducer 状态机校验。
- Tool Search 暂不启用：当前测得常见 supervisor root 为 15 个工具、约 5.3K schema token；只有工具数超过约 20、schema 超过约 8K token/有效窗口的 8–10%，或 MCP 动态目录显著增长时再进入 capability catalog + schema fetch 设计。

定向验证为 `npm run typecheck` 通过；最新一组 compaction/context editing/provider/prompt assembly/session journal/Child broker 检查共 74 项，73 pass、0 fail、1 个需显式 API key 的网络 smoke skip。未重跑全量测试，也未把本批描述成任务成功率提升证据。详细架构和能力矩阵见 [`09-native-compaction-and-context-editing.md`](./09-native-compaction-and-context-editing.md)。

## 9. Prefix cache 修复与 DeepSeek A/B（2026-08-09）

- 归因：每轮变化的 Session ContextView 位于历史前缀，导致 Provider 只能命中它之前的固定 system/tool 部分；Prompt 文案缩短不能解决该结构问题。
- 修复：一次 Run 内冻结 ContextView，成功 compact 后才换代；新 Tool/Workflow 状态继续由 durable history 追加。
- 统计：OpenAI-compatible adapter 补齐 DeepSeek 顶层 `prompt_cache_hit_tokens` 和 Anthropic-compatible `cache_read_input_tokens`；trace manifest 记录实际 Prompt variant；production summary 计算 hit/miss/rate。
- 晋升：默认已切换到 `iron-law-lean-v1`，所有内部默认参数统一引用 `DEFAULT_PROMPT_VARIANT`；未实现命名式 production alias 和 Anthropic 显式 cache blocks。
- DeepSeek V4 Flash：排除首轮后 baseline 78.0%，lean 77.2%；lean 输入减少约 6.1%，证明“文案体积”和“前缀命中”是两条优化轴。
- 证据：`D:\agent-evals\results\cache-ab\2026-08-09__03-22-52\summary.json`。

## 10. 可信度措辞复核（2026-08-18）

- 结论：不增加模型可见的可信度等级；保留唯一指令权威边界，事实判断改用 provenance、receipt、时效、verifier 和 cross-review。
- 默认 `iron-law-lean-v1` 的 context/Skill/Planner 路径继续使用中性表达；协议中的 `trust: 'user' | 'low'` 仍是 Runtime-only 元数据。
- `agent.handoff` 的工具说明已从 `authoritative low-trust evidence` 改为 `reviewable evidence`，避免把“不能授予权限”和“事实是否可靠”混成一个标签。
- Tool 输出中的 `authoritativeResult` 仍是兼容字段名，已登记为命名债务；它不改变 Child 结果的 verification 状态。
- 完整决策与后续审计门禁见[指令权威、来源与事实验证](./10-authority-provenance-and-verification.md)。
