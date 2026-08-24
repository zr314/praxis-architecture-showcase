# 平台与长任务测评记录（分层判定）

最后更新：2026-08-22。

公开 benchmark 更像“让 Agent 完成外部工作”；本页则直接考 Praxis 自己的调度、持久化、恢复、上下文和 Provider 适配。验收以 SQLite Authority、journal、Artifact 和 stream 中的机器状态为主，模型最终报告仅作辅助。

## Workflow 与多 Agent

### 默认 Agent Run Tree：自主选择与受控 conformance

这组实验首次直接测 ADR-008 之后的默认 `auto`：模型不编写 DAG，而使用 `agent.spawn/wait/result/cancel/steer`。它分成自主组和受控组，避免把“模型不愿委派”误判成“Runtime 不会运行 Child”。Provider/model 均为 MiniMax CN / MiniMax M3，SQLite、只读 policy；完整结果根目录为 `D:\agent-evals\results\multiagent\`。

<details>
<summary>自主组实际题目</summary>

```text
Audit the current source tree in D:\praxis and produce one evidence-based final report. This is a read-only task: do not modify files.

Investigate three independent evidence tracks:
1. Model-facing planning surface: compare solo, auto, and explicit workflow, and explain whether auto requires DAG authoring.
2. Runtime reliability path: trace spawn, background execution, wait/result, steer, cancel, settlement, persistence, and restart recovery; distinguish durable state from in-memory delivery.
3. Prompt and capability boundary: explain when spawning is recommended, Child authority, recursive-Child status, and transitional representation.

Cross-check current architecture/ADR/status documentation against code. The final answer must start RUN_TREE_AUDIT_V1, use exact path:line evidence, separate implemented/transitional/not-yet-implemented, and must not claim tests were run.
```

</details>

受控组使用相同三轨任务，但要求前两个 Tool call 分别 `agent.spawn` 两个只读 Child，Root 同时调查第三轨，然后 `agent.wait(all)`、消费 result 并核对 `architecture.md`、ADR-008、`project-status.md` 和 `workflow-platform.md`。修复后的最终题面还明确禁止模型自行填写数值 token/turn/tool/墙钟预算。逐字文件：

- `D:\agent-evals\sources\praxis-multiagent-long\run-tree-architecture-audit.md`
- `D:\agent-evals\sources\praxis-multiagent-long\run-tree-architecture-audit-coordinated.md`

#### 四次 rollout

| 运行 | Child/协作 | Runtime | 任务/Prompt | 结论 |
| --- | --- | --- | --- | --- |
| `2026-08-22__02-59-44__run-tree-architecture-audit` | 0 Child | PASS；Root succeeded | FAIL/PARTIAL；遗漏可靠性轨道和文档交叉核对，marker 前有前言 | 自主选择了 direct，不能证明 Run Tree 执行 |
| `2026-08-22__03-05-07__run-tree-architecture-audit-coordinated` | 2 spawn，两个 Child failed；Root 调用 result/wait/result | PARTIAL；失败隔离和收敛正确 | FAIL | 两个 Child 均为 `CHILD_CREDENTIAL_BUDGET_EXCEEDED` |
| `2026-08-22__03-09-49__run-tree-architecture-audit-coordinated` | 0 Child | PASS；Root succeeded | FAIL；忽略受控委派合同 | 记录 MiniMax 工具服从方差，不是 Runtime 回归 |
| `2026-08-22__03-12-15__run-tree-architecture-audit-coordinated` | 2 spawn → result → wait(all) → result；Root/2 Child 全 succeeded | **PASS** | PARTIAL；最终综合仍有事实归因和格式错误 | 当前代表运行 |

当前代表运行 Workflow 为 `workflow-06ad4573-1d81-434c-a26d-fea9e82d6ddc`。第一个 Child 从 `scheduled → running → succeeded`，第二个受 MiniMax capacity=2 约束，在 Root 和第一个 Child 活跃时保持 scheduled，随后 `leased → running → succeeded`。Root 等待期间没有显式 Join Node；`agent.wait` 读取持久 projection，最终所有节点终态且 Workflow completed。总用量为 258 turns、366 tools、897,846 input、46,184 output、826,811 cache-read；按 `cacheRead / (input + cacheRead)` 计算约 47.9%。

#### 暴露并修复的 Praxis 缺陷

第一次受控组中，MiniMax 为两个 `agent.spawn` 都填写 `maxTokens=12000`。该字段实际限制 Child 生命周期累计 Provider input+output，而模型把它当成常见的单轮输出额度；Child 首轮就超过限制并被 credential broker 正确 fail-closed。门禁本身没有算错，缺陷是默认通用 Run Tree 把模型不可能可靠估计的数值资源旋钮暴露给了模型。

永久修复位于 `apps/runtime/src/workflow/agentRunTreeTools.ts`：默认 `agent.spawn` 不再接受 per-Child token/turn/tool/墙钟数字，Child 继承父 Run/组织策略；显式 `workflow` 节点仍保留业务预算。专项测试还验证直接调用即使携带旧 `maxTokens=1` 也不会把它写入 Child budget。修复后两个真实 Child 均完成，证明不是把错误码隐藏或简单放宽成另一个固定上限。

#### 分层结论

- **Planner 自主性：未证明提升。** 未强制的任务中 MiniMax 选择 0 Child；受控题也有一次完全忽略 spawn 要求。工具可用不等于模型稳定选择最优组织方式。
- **Run Tree Runtime：通过。** 已真实覆盖异步 spawn、稳定 Child handle、Provider-aware 后台调度、result 非阻塞读取、wait(all)、持久结果消费、optional Child 失败隔离和结构化收敛。
- **任务正确性：部分通过。** 最终报告没有以 marker 作为首字符，未完整完成四份文档核对，还把“auto 初始是 Root”混写成“Run Tree 不是默认”，并错误声称本轮前两个动作是 read；stream 证明实际是两次 spawn。
- **当时尚未覆盖：** steer、cancel 的真实 Provider 长任务路径后来由下一节补齐；进程中途重启与 Child 递归 spawn 仍不能从本次成功外推。

### 动态改计划：cancel 旧分支并持久 steer 新分支

这道题专门验证新的设计原则：Runtime 不持久化模型完整自然语言 Plan，但模型在读到新证据后可以改变接下来要做什么。它先创建两个真实 Child；在 ADR-008 这个新 Observation 出现后，Root 放弃过时路线，把新增要求送给另一个 Child，再等待有价值的结果。Provider/model 为 MiniMax CN / MiniMax M3，planner policy 为默认 `auto`，只读 workspace。

<details>
<summary>展开实际题目原文</summary>

```text
# Praxis Agent Run Tree dynamic replanning conformance

Perform a read-only source audit in `D:\praxis`. This experiment validates dynamic plan revision in default `auto`; do not use explicit Workflow/DAG tools, shell, write, or edit.

Conformance order:
1. Your first Tool call must be `agent.spawn`. Create an `explorer/read` Child named by objective as the obsolete Supervisor branch. Ask it to perform a deliberately broad historical audit of old Supervisor paths and include `OBSOLETE-SUPERVISOR-BRANCH` in its result. Give it read/grep/glob/find/ls only. Do not supply numeric budgets.
2. Your second Tool call must be `agent.spawn`. Create an `explorer/read` Child to audit current Agent Run Tree recovery and coordination. Its initial objective must cover spawn/wait/result, durable Authority state, and live-host control, but must not mention recursion, budget inheritance, or the sentinel below. Give it read/grep/glob/find/ls only. Do not supply numeric budgets.
3. Root now reads `docs/adr/ADR-008-agent-run-tree.md`. Treat its contents as a new observation that changes the plan.
4. Cancel the obsolete Supervisor Child with `agent.cancel`, reason `ADR-008 supersedes the obsolete branch`. The cancelled branch must not be restarted or replaced.
5. Steer the current Run Tree Child with `agent.steer`. The instruction must require it to add the current non-recursive Child boundary, default `agent.spawn` budget inheritance, and the exact sentinel `STEER-RECURSION-BOUNDARY` to its final result. This information must come from steer, not its initial objective.
6. Wait only for the current Run Tree Child with `agent.wait(mode=all)`, then call `agent.result` for both Child handles.

Final-answer contract:
- The first characters must be exactly `RUN_TREE_REPLAN_V1` with no preamble.
- Report both stable Child IDs and terminal states.
- Prove whether steer was delivered live or persisted for startup by quoting the `agent.steer` Tool result; do not infer.
- Confirm the successful Child result contains `STEER-RECURSION-BOUNDARY` and cite its durable result reference.
- Confirm the obsolete branch is cancelled and report its exact error/state without treating cancellation as Root failure.
- Cite source paths and line numbers for the corrected plan claims.
- Do not claim tests were run; this is source inspection only.
```

</details>

逐字题面保存于 `D:\agent-evals\sources\praxis-multiagent-long\run-tree-replan-steer-cancel.md`。

#### 修复前后两次真实运行

| 运行 | 墙钟与用量 | 机器事实 | 分层结果 |
| --- | --- | --- | --- |
| `2026-08-22__13-04-07__run-tree-replan-steer-cancel` | 4 分 20 秒；105 turns、122 tools、290,627 input、13,993 output、46,075 cache-read | 两次 spawn、cancel、steer、wait、result 均成功；旧 Child 的 Artifact 是 `cancelled`，但 projection 错记为 `failed` | Runtime PARTIAL；暴露取消终态缺陷。任务/Prompt PARTIAL/FAIL |
| `2026-08-22__13-12-48__run-tree-replan-steer-cancel` | 3 分 21 秒；68 turns、118 tools、244,807 input、13,538 output、31,320 cache-read | Root `succeeded`；旧 Child `cancelled`；保留 Child `succeeded`；Workflow `completed` | **框架 PASS**；任务内容基本完成，但 Prompt 起始 marker FAIL，因此整题仍记 PARTIAL |

修复后代表 Workflow 是 `workflow-056e21a4-e8d9-4516-8005-8225fef03952`。稳定句柄分别是旧分支 `delegate-92ed301d-b3a8-467b-a016-df8e13f4fbb0` 和保留分支 `delegate-5ec749e4-af03-4a69-8a42-c675377cca9e`。实际工具顺序严格为：

```text
agent.spawn → agent.spawn → agent.cancel → agent.steer → agent.wait → agent.result
```

取消工具报告 `activeCancellationRequests: 1`，证明旧 Child 当时已经有活跃宿主，而不是只从排队列表删除。它最终为 `state: cancelled`，保留原因码 `CHILD_PARENT_CANCELLED`；这不是 Root 失败。保留 Child 当时仍在排队，`agent.steer` 的原始返回是：

```json
{"childId":"delegate-5ec749e4-af03-4a69-8a42-c675377cca9e","delivered":false,"messageId":"agent-steer-69036e77-a873-4385-8d8b-91a17fa444f6"}
```

`delivered:false` 不是“发送失败”。它表示当时没有可即时接收的活跃 Child 进程，因此指令先写入 durable mailbox；Child 获得 Provider 槽、真正启动之前会读取这条消息。成功结果 Artifact 为 `artifact-7bdac0a00fd920b74a1866dc207406050aa9e9830ce0e603a9c9e6ca7d750d04`，其中确实包含只在 steer 指令中出现的 `STEER-RECURSION-BOUNDARY`，所以能证明启动前持久投递链路成立，而不是只证明 Tool 返回了 `ok`。

#### 这道题证明了什么

- **动态路线修订成立。** Root 能根据新 Observation 放弃已运行的旧路线，不需要重写或持久化整张认知 DAG。
- **结构化并发成立。** 旧 Child 必须先进入终态，保留 Child 的结果必须由 Root 明确等待和消费；Runtime 不会留下孤儿分支。
- **durable steer 成立。** 排队 Child 的新增约束跨越调度等待进入启动上下文，并出现在最终 Artifact。
- **取消隔离成立。** 可选探索分支的主动取消不否定 Root；修复后取消也不会污染失败统计。
- **模型严格服从仍未通过。** 两次最终回答都在指定 marker 前写了说明文字；修复后报告还对预算继承的 ADR 行号给出了较弱归因。这是模型输出/综合问题，不应把正确机器状态改坏来迁就模型文案。

#### 新手名词解释

- **Observation（观察）**：Agent 在执行中刚读到的新事实。这里是 ADR-008，它让旧 Supervisor 调查失去价值。
- **steer（转向指令）**：父 Agent 不重启 Child，而是给同一 Child 追加一条新要求。若 Child 未启动，指令先持久保存；若正在运行，则尝试在安全边界实时送达。
- **durable（持久）**：信息已经写入 Authority/SQLite，进程短暂退出也不会只存在内存里。
- **projection（投影）**：从事件日志计算出的当前状态快照，例如 Child 是 scheduled、running、cancelled 还是 succeeded。
- **Artifact（结果制品）**：Child 的完整结果文件。Root/mailbox 通常只携带短引用，避免把大正文重复塞进上下文。
- **sentinel（哨兵字符串）**：预先约定的唯一文本，用来证明某条要求真的抵达了目标结果；本题是 `STEER-RECURSION-BOUNDARY`。

### Quorum join 与恢复

#### 实际题目

<details>
<summary>展开题目原文</summary>

```text
请对 D:\praxis 当前代码做一次只读的“运行时韧性审计”，最终判断它是否具备进入长生命周期 agent harness beta 的条件。

这不是单智能体顺序阅读任务。请由 auto planner 自己组织真正的 Child Agent DAG：至少三个彼此独立、同时启动的调查流，分别覆盖：
1. planner / workflow 调度、join、预算与终态；
2. SQLite session/workflow authority、lease、幂等副作用与恢复；
3. MCP/plugin、权限衰减、child runtime 与安全边界。

三个调查流必须使用只读 workspace，不运行测试、不修改任何文件。为了验证容错，请使用 2-of-3 quorum：任意两个调查流提供有效证据后即可完成，最慢的分支不得阻塞最终结果。不要在 root 中假装三个角色；必须调用可用的协作/工作流工具创建真实 Child。

每个调查流需要引用至少 4 个具体源码文件并给出“能力、风险、证据”三栏结论。Root 最后只能基于 Child 返回的 artifact/evidence 作综合，明确列出实际完成、被 quorum 关闭或失败的分支。

最终回答包含：总体结论、证据矩阵、未验证边界、建议的下一项工程工作。不要写入 workspace。

这是长任务，不是 3 分钟探针。构图时每个调查 Child 必须申请至少 86400000ms、500 turns、10000 次工具调用，并且不要设置 maxTokens，使用 v3 Profile 的无 Child token 硬上限语义；Workflow 仍记录每轮 input+output 的累计 usage。只读源码时优先读取相关区段，避免反复整文件灌入上下文。为了让 quorum 的提前收敛可观测，第三个 MCP/security 分支还要额外覆盖至少 8 个文件，前两个分支达到成功标准后不应等待它。
```

</details>

题目源：`D:\agent-evals\sources\praxis-multiagent-long\quorum-audit.md`。

#### 2026-08-21 当前代表运行

原始证据：`D:\agent-evals\results\multiagent\2026-08-21__15-33-40__quorum-audit\recovered-summary.json`。

| 项目 | 结果 |
| --- | --- |
| Provider/model | MiniMax CN / MiniMax M3 |
| Workflow | `workflow-073660df-4ce9-46f8-a781-42b896673f41` |
| Quorum | 2-of-3 |
| 成功 Child | planner、SQLite 两个调查 |
| 尾部 Child | MCP/security 被 `WORKFLOW_JOIN_SATISFIED` 取消 |
| Root 恢复 | attempt 1 因 `LEASE_EXPIRED_RETRYABLE` 失败，attempt 2 成功 |
| 总用量 | 425 turns、498 tools、1,276,929 input、58,743 output |
| 墙钟 | 2026-08-21 07:33:41Z 至 08:20:18Z，约 46 分 37 秒 |

**最终结果**：外层证据 collector 在 Root synthesis 时关闭 stdout，原 CLI 管道出现 BrokenPipe；新 Runtime 使用同一 `PRAXIS_HOME` 接管同一 Workflow，最终状态 `completed`。两个成功 Child 的 Attempt 没有重放，第三个节点在达到 quorum 后取消，decision 成功。这同时验证 2-of-3 早收敛和持久恢复。

#### 2026-08-08 历史代表运行

`D:\agent-evals\results\multiagent\2026-08-08__13-45-18__quorum-audit` 也完成 2-of-3：3 个 Child 中 planner、SQLite 成功，MCP/security 取消；Root 为 6 turns、11 tools、181,391 input、16,943 output、26,752 cache-read。结论为“有条件进入 beta，安全分支未验证”。

### Cross-review

<details>
<summary>实际任务合同（可读版）</summary>

```text
Perform a read-only, auditable architecture review of the Planner and Workflow implementation in D:\praxis. Answer: should Praxis keep its current unified durable workflow shell with a direct ReAct loop inside each AgentTask, or revert the whole product to pure ReAct?

Use the auto planner to create real durable Child Agents. Submit exactly one workflow.expand call containing this complete five-node DAG:
1. audit-execution: no dependencies; audit execution correctness, recovery, persistence, retry/idempotency and state machines; inspect at least 8 files.
2. audit-autonomy-context: no dependencies; audit autonomy, auto/solo/workflow selection, Prompt/context cost, Child result plumbing and complexity; inspect at least 8 files.
3. review-a: depends on both audits; read both complete persisted reports, enumerate reviewed conclusions, re-check disputed claims and give an independent verdict.
4. review-b: same dependencies and duties, but independent from review-a.
5. synthesis: depends on both reviewers; retain/reject opinions with reasons, give a recommendation and confidence, and list unverified capabilities.

Use quorum=5. All nodes are read-only, no network/MCP/Skills, only read, glob, grep, find, ls and artifact_read. Each Child gets maxWallClockMs=86400000, maxTurns=500, maxToolCalls=10000 and no maxTokens. Audits must cite 8 files; reviewers and synthesis must prove predecessor Artifact access. Root may do only small read-only path discovery before expansion, may not create probe graphs, and must base its final answer on persisted Child evidence. Report actual topology, dependency evidence, findings, recommendation, usage and unverified capabilities.
```

</details>

逐字题面：`D:\agent-evals\sources\praxis-multiagent-long\cross-review.md`。结果：`D:\agent-evals\results\multiagent\2026-08-21__16-21-52__cross-review`。

| 项目 | 结果 |
| --- | --- |
| Workflow | `workflow-b16b6c6a-6d02-4e31-9d8a-1836e6abc6b6` |
| DAG | 2 个并列 audit → 2 个并列 reviewer → 1 个 synthesis → join |
| 节点状态 | 5 个 Child、join、Root 全部 succeeded |
| 投影 | 13/13 唯一状态投影，约 620 KiB |
| 用量 | 128 turns、200 tools、1,652,828 input、79,984 output、173,674 cache-read |
| 终态 | `prompt_completed`、exit 0 |

**最终结果**：持久 DAG 的依赖顺序、两路独立复核和最终综合都完成；综合建议保留“durable Workflow 外壳 + 每个 AgentTask 内 ReAct”，而不是全局退回纯 ReAct。

**分层判定**：模型前三次给了无效 `workflow.expand` 参数，第 4 次才被 Authority 接受。机器状态只有一次图变更，所以 Workflow conformance 通过；题目要求的“模型只调用一次”没有严格通过。这个差异记录在[问题页](issues-and-fixes.md#模型行为)。

### 后台执行、mailbox 与 join

<details>
<summary>实际任务合同（可读版）</summary>

```text
Perform a read-only conformance review of the updated Praxis Workflow inter-process coordination implementation in D:\praxis. This run tests durable background Child execution, typed mailbox delivery, and Root-controlled join. Do not modify files or run tests/executables.

Make exactly one workflow.expand with rootAction="continue" and exactly three nodes in a serial chain:
1. authority-mailbox: inspect SQLite authority and verify transaction boundary, result/error insertion, idempotency, ordering and acknowledgement. Sentinel IPC-AUTHORITY-OK.
2. background-worker: depends only on the first; inspect durable worker/orchestrator/expand path and verify ready, claim, lease, completion, retry/recovery and Root visibility. Sentinel IPC-WORKER-OK.
3. root-coordination: depends only on the second; inspect coordination tools, RuntimeKernel and Workflow Prompt; verify inbox filters/ack, all/any/quorum join and final-response gate. Sentinel IPC-ROOT-OK.

All Children use profile=worker, workspace=read, network=false, no Skills/MCP, bounded read-only tools, maxWallClockMs=86400000, maxTurns=300, maxToolCalls=3000, no maxTokens.

After expansion, record all internal node IDs. Root must independently read remoteWorkflowAuthority.ts before join. Then call workflow.inbox exactly once without acknowledgement, record throughSequence/messages/states, and workflow.join exactly once with the exact internal IDs and mode=all. After join, artifact_read all results, check sentinels, and report what was and was not directly demonstrated.
```

</details>

逐字题面：`D:\agent-evals\sources\praxis-multiagent-long\ipc-background-join.md`。结果：`D:\agent-evals\results\multiagent\2026-08-21__15-09-56__ipc-background-join`。

| 项目 | 结果 |
| --- | --- |
| Workflow | `workflow-a21eef4e-743c-4f01-b029-c096cbc278bc` |
| 节点 | 3 个串行 Child 全 succeeded，另有 1 个内部 activity succeeded |
| Root 前置工作 | join 前独立核对 remote/local Authority parity |
| inbox | pre-join 调用完成，当时 0 条结果也被如实记录 |
| join | 用 3 个精确 internal node ID，`mode=all`，全部成功 |
| Artifact | 3 个结果回读，三个 sentinel 均存在 |
| 用量 | 222 turns、285 tools、942,259 input、43,249 output、83,344 cache-read |

**最终结果**：后台 Worker 在 Root 仍 active 时推进 DAG；消息和节点状态通过 Authority 持久化；Root 的 join 是唯一阻塞同步点。由于题目故意用串行链避开 Provider 并发，这一运行证明后台协调，不证明 Child 并行吞吐。

### Provider-aware 容量准入

<details>
<summary>实际任务合同（可读版）</summary>

```text
对 D:\praxis 做一次只读的 Provider-aware Workflow 调度审计。不要修改文件，不要运行测试或可执行文件。本任务验证：DAG 中三个互相独立的 Child 可以同时 ready，但 Runtime 按持久化 Provider capacity admission 控制实际 Lease 数，且 Root 在后台执行期间继续工作。

必须且只能调用一次 workflow.expand，rootAction="continue"，创建三个无依赖节点且不加 joinNode：
1. capacity-spec：检查 core workflow 类型、providerExecutionPolicy 和 minimaxConfig，解释 group 校验、MiniMax limit、环境覆盖和持久 Spec；结果以 PROVIDER-SPEC-OK 开头。
2. authority-admission：检查 sqliteWorkflowAuthority，解释 active Lease 计数、group 隔离、check/claim 同事务和更严格 limit；结果以 PROVIDER-AUTHORITY-OK 开头。
3. runtime-wiring：检查 RuntimeKernel、autoWorkflowPlanner 和 durable worker，解释 Root/前台/后台/恢复是否都走 Authority claim 及能力边界；结果以 PROVIDER-RUNTIME-OK 开头。

三个 Child 都是只读 worker，无网络/Skills/MCP，限定 read/grep/glob/find/ls/artifact_read，maxWallClockMs=86400000、maxTurns=180、maxToolCalls=1500、无 maxTokens。

扩图后记录 ID。Root 在 join 前独立检查 workflow-platform.md 和 Provider 文档，区分累计任务预算、瞬时 Provider capacity 和 Router 重试。然后 inbox 恰好一次，再 join 恰好一次，最后回读三个 Artifact 和 sentinel；报告 ready/leased/running 顺序、是否 429 以及问题归因。
```

</details>

逐字题面：`D:\agent-evals\sources\praxis-multiagent-long\provider-aware-parallel.md`。当前有效结果：`D:\agent-evals\results\multiagent\2026-08-21__14-58-08__provider-aware-parallel`。

| 项目 | 结果 |
| --- | --- |
| Bundle | `praxis-cli-20260821-provider-aware-v3.mjs` |
| Workflow | `workflow-b558ad2e-1bc2-4730-a22e-467553f6c352` |
| 节点 | 3 个无依赖 Child 和 Root 全 succeeded |
| Capacity 行为 | limit=2，Root 占 1 个 active Lease，Child 实际逐个 claim |
| Provider | 没有观察到 rate limit/429 |
| 投影 | 12 条、12 条唯一；633,555 bytes |
| 用量 | 88 turns、148 tools、239,833 input、30,833 output、139,402 cache-read |

**最终结果**：持久 Spec、Authority 同事务准入、后台 Worker 和 Root 路径形成闭环。模型最终文字曾误称源码接线“尚未确认”，但 SQLite/stream 已直接观察到容量行为；本档案采用机器事实，不采用该句模型自评。

同题 v2（`2026-08-21__14-38-41`）功能也完成，却产生 1,823 条投影、只有 12 条唯一，stream 12.86 MiB；修复投影去重后才把 v3 作为当前代表结果。

### 硬重启恢复

<details>
<summary>实际测试合同</summary>

```text
创建一个持久 DAG，其中 RR-P1-FAST 和 RR-P1-DEEP 为第一阶段，RR-SYNTHESIS 依赖两者，最后是 Quorum 3 decision。控制器在 RR-P1-DEEP 已成功、RR-P1-FAST 仍运行时强制终止整个 Praxis 进程树，再以同一 PRAXIS_HOME 和 SQLite Authority 启动新的 Runtime。

验收：Workflow ID 不变；已成功节点的 Attempt 不变；中断节点旧 Attempt 变为 LEASE_EXPIRED_RETRYABLE 并创建新 Attempt；不得出现重复标题/重复 DAG；synthesis、join、Root 最终成功；不存在 nonterminal node/task。
```

</details>

原始长题说明：`D:\agent-evals\sources\praxis-multiagent-long\restart-recovery.md`；确定性 runner 的实际简化图和状态都保存在结果中。证据：`D:\agent-evals\results\multiagent\2026-08-09__14-01-38__restart-recovery\summary.json`。

**最终结果**：`passed=true`、`validationErrors=[]`。Workflow `workflow-ec67e553-3b34-4e78-9cf8-2564cc6a38a1` 在重启前后相同；`RR-P1-DEEP` 成功 Attempt 未改变；`RR-P1-FAST` attempt 1 以 `LEASE_EXPIRED_RETRYABLE` 结束，attempt 2 成功；synthesis、Quorum 3 和 Root attempt 2 成功；无重复标题、无非终态节点/任务。恢复后累计 26 turns、62 tools、63,669 input、9,429 output、3 个 AgentTask。

### 聚焦 synthesis 恢复

实际题目要求只创建一个 `synthesis-recovery` Child，使用 `artifact_read` 读取上一次 cross-review 已持久化的两个 reviewer wrapper 及嵌套完整报告；不得重跑 audit/reviewer；必须逐项保留或拒绝每位 reviewer 至少两条意见，给出架构选择、置信度和未验证能力。题面：`D:\agent-evals\sources\praxis-multiagent-long\synthesis-recovery.md`。

当前结果：`D:\agent-evals\results\multiagent\2026-08-21__16-50-04__synthesis-recovery`。单 Child 和 Root 均完成，四个结构化 criterion 全部接受；6 turns、6 tools、32,931 input、8,440 output、29,512 cache-read。最终建议保留统一 durable Workflow，置信度 0.85，并明确这是旧运行的聚焦恢复，不是新的五节点 benchmark。

## Context compaction

### DeepSeek 单次语义压缩

<details>
<summary>实际任务合同（可读版）</summary>

```text
你正在验证长会话压缩。必须严格按顺序完成以下三次读取：
1. 完整读取 D:\praxis\apps\runtime\docs\02-session-memory-prompt.md
2. 完整读取 D:\praxis\docs\prompt-audit\09-native-compaction-and-context-editing.md
3. 完整读取 D:\praxis\apps\runtime\src\memory\compactionPolicy.ts
不得根据记忆猜测，也不得在三次读取前作答。最终回答必须以 COMPACT_OK 开头，并准确写出 DEFAULT_CONTEXT_POLICY 的 threshold、maxUncompactedTokens、keepRecentTokens。
```

</details>

证据：`D:\agent-evals\results\compact-deepseek-2026-08-09-semantic-v3`。

在强制 24K context 下，运行 exit 0，共 5 turns、4 tools；一次 semantic compaction 使用 9,387 input、731 summary output，覆盖 5 条消息，checkpoint 为 752 tokens。最终输出以 `COMPACT_OK` 开头，恢复 `threshold=0.85`、`maxUncompactedTokens=65536`、`keepRecentTokens=8`。总 usage 为 40,906 input、1,382 output、9,728 cache-read。

### MiniMax 连续 19 次压缩

<details>
<summary>实际任务合同（可读版）</summary>

```text
This is a real multi-compaction fidelity check. Preserve this immutable contract across every turn and compaction:
- Sentinel: ORCHID-7319.
- Do not modify files, run tests/executables, use shell/network, delegate or create a workflow.
- Completely read six specified Praxis docs/source files in exact order using paged read.
- Do not answer before all reads finish.
- Final answer must start MULTICOMPACT_OK, repeat ORCHID-7319, state the prohibition was obeyed, and report threshold, maxUncompactedTokens and keepRecentTokens from file 6.
```

</details>

逐字题面：`D:\agent-evals\sources\praxis-multiagent-long\multi-compaction-minimax.md`。证据：`D:\agent-evals\results\multi-compaction\2026-08-09__14-05-59`。

| 指标 | 结果 |
| --- | ---: |
| Context 上限 | 24,000 tokens |
| Turns / tools | 26 / 33 planned（24 started） |
| Usage | 218,823 input / 30,132 output / 34,874 cache-read |
| Checkpoints | 19 |
| Journal coverage end | 从 7 严格增长到 77 |
| 关键合同 | 每个 checkpoint 都含 sentinel、禁止项、最终回答合同 |
| 禁止 Tool | 9 次 `shell` 尝试，0 次执行成功 |

**分层结果**：`frameworkPassed=true`。19 次压缩后仍恢复 `ORCHID-7319` 和 `0.85 / 65536 / 8`，Policy 也拦住全部 shell，因此 compaction fidelity 与权限边界通过。`passed=false` 是严格题面服从失败：模型尝试了禁止工具，且最终在 `MULTICOMPACT_OK` 前写了说明性前言。它不是“整项完全通过”，所以总表明确标成框架层通过。

## Prompt prefix cache A/B

<details>
<summary>两组共用的实际题目</summary>

```text
验证多轮 Provider prompt-prefix cache。必须严格顺序完成下列四步，每一轮只调用一次 read，拿到结果后再进行下一次 read，不得并行：
1. 读取 D:\praxis\package.json
2. 读取 D:\praxis\tsconfig.json
3. 读取 D:\praxis\apps\runtime\src\memory\compactionPolicy.ts
4. 读取 D:\praxis\apps\runtime\src\prompt\promptRegistry.ts
最终回答以 CACHE_OK 开头，列出 package.json 的 name、tsconfig 的 extends、DEFAULT_CONTEXT_POLICY.threshold、DEFAULT_PROMPT_VARIANT。
```

</details>

证据：`D:\agent-evals\results\cache-ab\2026-08-09__03-22-52`。两组都是 DeepSeek、5 turns、4 次串行 read、exit 0、`CACHE_OK`。

| Variant | Input | Cache-read | 全程名义命中率 | 第 2–5 轮命中率 |
| --- | ---: | ---: | ---: | ---: |
| `baseline-v1` | 20,651 | 16,256 | 78.7% | 78.0% |
| `iron-law-lean-v1` | 19,210 | 13,440 | 70.0% | 77.2% |

baseline 首轮是已有 85% 热缓存，lean 首轮是 0% 冷启动，所以 78.7% 对 70.0% 不能直接比较。公平看第 2–5 轮，两者接近；lean 累计 input 少 1,441，即 6.98%。结论是“精简后保持后续缓存复用并减少输入”，不是“缓存突然提升到某个绝对百分比”。

## MiniMax Provider smoke

| 实际题目 | 模型 | 终态 | Usage | 证据 |
| --- | --- | --- | --- | --- |
| `只回复 MINIMAX_OK` | MiniMax M2.7 | exit 0，输出 `MINIMAX_OK` | 1,504 input / 39 output | `D:\agent-evals\results\minimax-smoke\2026-08-09__12-48-02` |
| `只回复 MINIMAX_M3_OK` | MiniMax M3 | exit 0，输出 `MINIMAX_M3_OK` | 1,594 input / 7 output / 128 cache-read | `D:\agent-evals\results\minimax-smoke\2026-08-09__12-49-54` |

两次 trace 都记录 `iron-law-lean-v1`。同一中国区 token 请求国际 endpoint 返回 `PROVIDER_AUTH_REQUIRED`，所以 Runtime 保持区域端点显式配置，不自动混用。

## 这些平台测试共同证明了什么

```text
用户任务
  -> Root ReAct
      -> workflow.expand 持久化 DAG
          -> Authority 事务性准入/Lease
              -> 后台 Child AgentTask
                  -> Artifact + mailbox
          -> all / quorum join
      -> Root 综合
  -> journal + checkpoint 支持恢复
```

它证明的是上述链路在列出的具体 Provider、题目和运行中真实走通。它没有证明模型每次都会主动委派、每次第一次就生成合法 DAG，也没有证明远程大规模集群的吞吐和 SLA。
