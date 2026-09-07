# Working Plan 咨询审查完善与复验

> 版本化测评记录：题面、结果和归因对应本文注明的构建与策略，不代表当前默认模式或同版全量成绩。

日期：2026-09-05。已结束：check/build 通过，全量 1135 通过、5 跳过、0 失败；MiniMax KV 复验官方仍 5/7、reward 0。新咨询首次响应即可使用，但发生语义错误接受；不能宣称提分。

## 为什么继续修改

[第一次轻量 Plan 真实测评](working-plan-validation-20260905.md)在 KV 原题上官方 5/7、reward 0。Runtime 正常收尾，但三次 Reviewer 都因 proof 校验失败，没有产生有效意见。那一版已经解除了强制执行门槛，却仍把咨询报告交给严格验收协议；同时只展示 Tool 回执，不展示对应的写入内容和验证命令。

本轮目标是解决这些通用缺口，不向 Prompt 写入任何 benchmark 专用字段或解法。不改显式 required 模式的验收规则，也不改变工具权限或扩大 Reviewer 的文件访问能力。

## 修改内容和代码落点

| 修改 | 通俗解释 | 代码 |
| --- | --- | --- |
| 独立 advisory-v1 合同 | 咨询说清楚有支持/有问题/不确定即可，不需要申请一个验收证书 | working-plan/advisoryReviewer.ts |
| 局部意见保守归一化 | 某项缺失、重复或引用无效，标为不确定；不丢弃其他可用意见，不伪造 supported | validateAdvisoryReviewV1 |
| 配对执行证据 | 把持久化的 Tool 请求和结果放在一起，能检查写了什么、执行了什么检查 | WorkingPlanServiceV1.refresh/review |
| 原始要求优先 | 模型自己重述的问题不能覆盖用户原始任务；对照精确约束，同时保留局部审查范围 | 独立咨询 Prompt + scopeContext |
| 失败响应诊断 | 保存解析后的提交对象、校验路径和用量，尽力脱敏；知道它为何失败，不只看到错误码 | reviewDiagnostics.ts / reviewCallStore.ts |
| 兼容恢复 | 已冻结的旧请求用旧合同恢复，新请求才使用新合同；不改历史报告 | WorkingPlanServiceV1 + RuntimeKernel |

源码共同根目录为 `apps/runtime/src/`。`semanticReviewer.ts` 只共享 Provider stream、结构化输出传输和用量处理；可选的 Host-selected contract 决定提交工具、Prompt、Schema 与解析策略。Host 没传新合同就保持旧严格行为，模型不能通过参数切换 required 为 advisory。

### 咨询新结构

模型回复只需要 summary、findings。每条意见有 criterionId、status（supported/concern/unknown）、reason 和 evidenceRefs。

没有 verdict 和 proof 字段，也不要求写 observation/inference/unresolvedAssumptions 三段证明。某个 supported 缺少可绑定引用时降为不确定；重复项不能选一个最有利的当成通过；非法引用被移除；带旧 proof 的意见不会被当成新的支持证明。其他正常意见保留。

为兼容已有 Journal 和 ReviewCallStore，持久化意见仍映射为 passed/failed/unverifiable，报告中的 accepted/needs_fix 是 Runtime 派生的存储标签，始终附带 advisory。它不接受 Plan Item，也不控制 Run 是否结束。这不是悄悄把未知判成通过。

### 配对的安全边界

只配对相同 Run、Tool call ID、工具名且无歧义的已持久化请求与结果。没有结果的请求不进入证据；缺失请求的结果明确 requestAvailable=false；不会把 assistant 普通文字或思维块当成证据。失败写入仍是失败，旧快照仍是旧快照。Reviewer 没有获得 shell、文件系统或网络访问工具。

证据预览仍有总预算，并明确截断和遗漏；大输出、很早的源代码或没有记录的状态仍可能不可见。这次解决的是“回执与实际调用内容分离”，不是承诺 Reviewer 能看到整个工作区。

### 诊断与隐私

失败的 parsed submittedResponse 随 failure_json 存在本地 ReviewCallStore，不放入 Agent Prompt。按敏感字段名、常见 key/token/Bearer 形式尽力脱敏，排除 reasoning/thinking 字段；超过 64 KiB 明确保存截断预览。脱敏不保证识别任意业务秘密；诊断与本地调用账本共用保留周期，不自动上传。

原始 responseDigest/字节数仍表示原响应，不把脱敏后的内容冒称原文。未解析或被截断的 Provider 流可能没有提交对象。旧记录不存在的 raw response 无法补造，因此本次离线验证使用构造的校验用例，并非重放了上一轮缺失的原始响应。

## 本地验证

已通过的专项 54 项覆盖：原生 JSON/强制 Tool 两种咨询传输、独立 Prompt/Schema、局部无效意见降级、无引用不得通过、诊断脱敏和重启保存、双后端请求/结果配对、无 Plan 咨询、旧冻结请求继续旧合同、已保存结果不重复调用、失败不阻塞、required 守卫、文档与完整 Prompt 原文一致性。

`npm run check` 和 `npm run build` 通过。全量 `npm test` 共 1140 项：1135 通过、5 跳过、0 失败，约 278.6 秒；跳过项不计为已验证。专项不与重叠运行相加伪造测试数量。

## MiniMax 复验条件

- 仅一次 KV 原题，完整题面和实际通用策略提示见[首测报告](working-plan-validation-20260905.md)。不重跑 ReAct/P&E/严格 P&R。
- 相同 MiniMax-M3、iron-law-lean-v1、solo、optional、working-plan 策略；原始任务不添加字段纠错提示。Root Prompt 程序仍 1.3.0，本轮更新的是独立 M11 咨询合同。
- 新容器、新 Session、SQLite、Harbor retries=0、timeout multiplier=10。
- 冻结包 `D:\agent-evals\artifacts\praxis-cli-advisory-v1-20260905.mjs`。
- SHA-256 `eafa20af99574fd213d7ffc75e14a617a2a5753c853eec7d93b1bf089e9aff02`。
- Job `D:\agent-evals\results\harbor-minimax-medium\minimax-m3-advisory-v1-20260905-kv-r1`；Trial `kv-store-grpc__pp7Snjb`。

## MiniMax 最终结果

| 指标 | 首测：轻量 Plan + 旧 proof Reviewer | 本轮：独立 advisory-v1 |
| --- | --- | --- |
| 官方 verifier | 5/7，reward 0 | 5/7，reward 0 |
| Runtime | prompt_completed | prompt_completed，Harbor 无异常 |
| Agent 阶段 | 89.453 秒 | 70.164 秒 |
| Trial 总时间 | 163.049 秒 | 150.156 秒 |
| Root turns / Tool calls | 13 / 17 | 17 / 21 |
| Plan Tool | create 1、progress 7、review 1 | create 1、progress 8、review 1 |
| 独立 Review | 三次 Provider 响应无效，unavailable | 一次 Provider 响应有效，五项 supported |
| Review 冻结输入→报告落盘 | 36.346 秒 | 6.314 秒 |
| Review 错误接受 | 没有有效意见，无法判断 | 有；错误字段被判为符合原题 |
| 压缩 / Child / 路线重排 | 均无 | 均无 |

两次仍是单样本、同一题、不同构建的工程复验，不是统计 A/B。本轮 Reviewer 格式重试减少是可观察事实，但墙钟变化还受采样、网络、缓存和工具选择影响。总体任务没有提分。

### 本轮用量

| 范围 | 未缓存 input | cache-read | output |
| --- | ---: | ---: | ---: |
| Root：17 次完成请求 | 57,710 | 79,885 | 2,583 |
| Reviewer：1 次 | 10,514 | 0 | 848 |
| terminal / Harbor 总量 | 68,224 | 79,885 | 3,431 |

相加与终态一致；Reviewer 唯一 attempt 为 decision_committed，预算 actual 结算。本轮新增配对证据后输入比上次更多，不能只用 Reviewer 输出下降或时间缩短宣称整体 token 成本下降。没有价格证据，不估算费用。

### 已确认修好的机制

1. **独立咨询合同真实可用。** raw_response 是 summary/findings 和 supported 状态，不含 proof 或模型 verdict；一次响应通过，无格式重试。Runtime 只是按映射保存 accepted 咨询标签，没有运行严格 Item/Final 关卡。
2. **证据配对真实生效。** 11 条候选全部 requestAvailable=true，omittedReceipts=0，外层预览无截断。输入 Artifact 30,214 bytes，含完整 proto/server 的写入参数和自测命令，原题完整。不是只看到“写入成功”了。
3. **工具错误可恢复。** 一次 shell 的进程检查因容器缺少 ps 而 exit 1，Runtime 正常返回 TOOL_RETURNED_ERROR；模型随后使用 RPC、端口连接和 /proc 继续检查。该错误不是最终扣分原因。
4. **正常收尾。** 最终 Plan revision=9、active、五项 done；Run completed。没有计划阻塞续轮、Provider 配额中断或 compaction。

### 仍然失败的原因：原题与自拟检查项错位

Root 再次把请求字段 value 写成 val，自测也采用 val。官方两个失败均为 `Protocol message SetValRequest has no "value" field.` 其余文件、依赖、生成代码、服务和后台运行项通过。

这次 Reviewer 的 c2 原文解释包含：

> SetValRequest has key (string) and val (int32) ... original task says "val (int)" ... consistent.

它准确读到了实现，却把响应的 val 要求误套到了请求字段；原题中的请求 value 仍在 originalTaskContract 中。该项引用 receipt-17，实际源码也在这份完整冻结证据里。模型自拟 c2 把请求/响应概括为 key 和 val，又与自己的错误实现一致，具有明显的判断偏差风险。

可以排除本次的证据未传递、48 KiB 截断、proof 校验失败和上下文压缩。剩余是模型语义判断与问题装配造成的偏差，不能仅凭一次样本把两者贡献完全分开。当前 Prompt 已要求原题优先、检查项可错，但这条自然语言提示并没有保证模型做到。

因此这次同时记录：**框架传输/证据/收尾 PASS；Reviewer 有效响应 PASS；审查判断 FAIL；任务 FAIL。** 不因为内部 accepted 标签就改写官方成绩，也不因任务没提分而否认已经验证的机制修复。

## 后续方向与本轮停止边界

本轮修改和一次复验完成后停止，没有继续消耗额度刷同题。下一步若继续改进，优先做小型冻结输入实验：对比“核对执行模型自拟 criteria”与“先从原始要求确定当前审查范围，再对照证据”，观察是否减少错误前提被重复确认。应使用多类约束和反例，避免只靠记住 KV 的字段答案。

不建议为了这一题再恢复强制 proof、增加逐项完成门或硬编码接口检查器。Runtime 可以保证证据来源和持久性，不能用通用语法校验保证任意自然语言判断真实。模型/Prompt 的改进仍应接受外部 verifier 验证。

原始证据在上述 Trial 的 result.json、verifier/test-stdout.txt、agent/praxis-stream.jsonl、session-journal-v3.sqlite 和 review-calls-v1.sqlite。输入 Artifact 为 `artifact-130b2ac6b10e220f205fa4d5934fe491273b6882996e8df199a38c84fe9ac056`；报告为 `artifact-34a86eba54e383c13296c22e3d4181cdeb46ab4e9ed3a8120b4f6373702f1d73`，绑定 planRevision=9、snapshotSequence=48、evidenceSequence=42。Task checksum 与首测相同。Harbor 已清理本次测试容器，其他容器未触碰。
