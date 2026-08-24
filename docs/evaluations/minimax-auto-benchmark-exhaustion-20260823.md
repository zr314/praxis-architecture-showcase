# MiniMax M3 + Auto：续跑至额度耗尽的最终记录

最后更新：2026-08-23。

这份报告记录本轮“继续运行剩余 benchmark，直到 MiniMax 额度耗尽”的实际结果。它同时保存题目、机器评分、失败归因、主干修复和停止条件，方便第一次接触 Agent 测评的读者复核。

> 阶段说明：本文的 `PROVIDER_RATE_LIMITED` 是当时的真实终态。MiniMax 额度后来再次重置，后续 Terminal-Bench 运行、451 轮 MIPS 压力样本和新的 `PROVIDER_MODEL_UNAVAILABLE` 终态另见[额度再次重置后的续测](minimax-auto-terminalbench-resume-20260823.md)。两阶段原始错误码不会互相覆盖。

## 1. 先看结论

- 本轮最后用**单进程、单个最小请求**复核额度：5.131 秒内连续得到 `PROVIDER_RATE_LIMITED`，0 turn、0 tool、0 token。可以确认是账户/计划额度终止，而不是并发拥塞；此后没有继续调用 Provider。
- Harness-Bench 当前 106 题的“最新有效代表结果”均可由 adapter 正常解析：均分 **0.8269**，中位数 **0.8883**，28 题满分，51 题不低于 0.90，66 题不低于 0.80，6 题低于 0.50，最低 0.16。
- 这 106 个结果是跨多个修复阶段保留的**当前有效快照**，不是同一 commit、同一 Prompt 下重新全量跑出的官方排行榜批次，不能把 0.8269 宣称为官方 benchmark 总分。
- 本轮新增 6 个可评分的 Terminal-Bench rollout：4 个 reward 1、2 个 reward 0；另有 1 个 `polyglot-c-py` 因额度中断，标记 `INVALID`，不计正确率。
- 其中 `sqlite-db-truncate` 连续运行 9 分 52 秒，使用 140,264 uncached input、718,976 cache-read、35,632 output token，官方 verifier reward 1。它是本轮最有代表性的长任务。
- `fix-git` 用 Prompt 1.1 时 reward 0；通用自主推进合同升级为 Prompt 1.2 后，同题 reward 1。这是一次真实的 Prompt A/B 信号，但仍只是单题、各一次 rollout。
- 主干永久修复了三类可复用问题：Provider 流中断恢复、UTF-8 BOM 可观察性、已授权结果下的无谓澄清。没有为了某一道 benchmark 写 task-specific 特判。
- 本轮低分主要来自模型的业务规则、精确 schema、负面约束和边界测试能力；没有证据表明这些失败由 compaction 丢失上下文造成。

## 2. 测试环境与判分口径

| 项目 | 本轮设置 |
| --- | --- |
| Agent | Praxis 主干构建产物 `D:\agent-evals\artifacts\praxis-cli.mjs` |
| Planner | `auto`；外层 Workflow 可选，Agent 内部动态 ReAct/Plan，自主决定是否创建 Child |
| Provider / model | MiniMax 中国区 Coding Plan，`MiniMax-M3` |
| Prompt | `iron-law-lean-v1`，过程中由 1.1.0 升级到 1.2.0 |
| Harness-Bench | 本地 fixture、oracle 与 adapter；不访问公共互联网 |
| Terminal-Bench | Harbor 隔离 Linux 容器与题目自带 verifier |
| Praxis 显式上限 | `max_turns=10000`、`max_tool_calls=100000`；没有 6 分钟/48 turns/160 tools 的旧主干上限 |

几个容易混淆的状态：

- `prompt_completed`：只说明 Agent 循环正常收尾，不代表答案正确。
- Harness-Bench 的 0–1 分：oracle 对产物和过程给出的连续分数；本批没有统一的二元及格线。
- Terminal-Bench reward 1：题目自带 verifier 全部通过；reward 0 是有效失败。
- `INVALID`：Provider、容器或采集器在判题前中断，不能用 0 分评价 Agent 能力。
- canonical result：同题多次运行后，保留的最新有效代表文件；失败实验另外归档，不覆盖有效样本。

## 3. Harness-Bench 106 题当前有效快照

精确题面位于：

```text
D:\agent-evals\sources\harness-bench\tasks\<编号-题名>\prompt.txt
```

多轮题使用同目录下的 `prompt_round1.txt`、`prompt_round2.txt`。每个当前代表结果位于：

```text
D:\agent-evals\results\harnessbench\praxis-auto-minimax\unknown-api\<编号-题名>.json
```

下面列出完整索引。题名就是任务内容的简写，例如 `local-rest-api-summary` 表示从分页 REST API 取数、处理 429/503、关联实体并生成 JSON/质量报告；逐字要求以源目录中的 Prompt 为准。

| ID | 题目 | 分数 | ID | 题目 | 分数 |
| --- | --- | ---: | --- | --- | ---: |
| 001 | file | 1.0000 | 002 | exec | 1.0000 |
| 003 | browser | 1.0000 | 004 | meeting-summary | 1.0000 |
| 005 | email-triage | 1.0000 | 006 | access-bilibili | 1.0000 |
| 007 | session-memory | 1.0000 | 008 | image-recognize | 1.0000 |
| 009 | git-pr-merge | 0.7500 | 010 | office-docs | 1.0000 |
| 011 | code-debug | 0.9500 | 012 | doc-synthesis | 0.7500 |
| 013 | image-edit | 1.0000 | 014 | task-decomposition | 0.9500 |
| 015 | security-injection-defense | 0.6600 | 016 | code-repair-pytest | 0.7000 |
| 017 | db-doc-consistency | 0.9700 | 018 | provider-failover-audit | 0.9346 |
| 019 | incident-runbook-synthesis | 0.7992 | 020 | archive-checksum | 1.0000 |
| 021 | batch-rename-transform | 0.8235 | 022 | local-rest-api-summary | 0.8696 |
| 023 | web-form-extraction | 0.9474 | 024 | calendar-scheduling-conflict | 0.8889 |
| 025 | meeting-action-tracker | 0.9444 | 026 | ppt-brief-generation | 0.9000 |
| 027 | contract-summary-risk | 0.6429 | 028 | email-thread-merge | 0.6364 |
| 029 | expense-packet-review | 1.0000 | 030 | word-revision-plan | 1.0000 |
| 031 | cross-doc-citation-check | 0.5556 | 032 | customer-followup-draft | 1.0000 |
| 033 | offline-knowledge-qa | 1.0000 | 034 | evidence-matrix-claims | 0.9600 |
| 035 | conflicting-source-resolution | 0.7529 | 036 | citation-consistency-audit | 0.7800 |
| 037 | policy-clause-retrieval | 0.7400 | 038 | research-brief-synthesis | 0.8480 |
| 039 | repo-architecture-map | 0.9620 | 040 | test-coverage-fill | 0.9886 |
| 041 | frontend-state-bug | 0.5925 | 042 | api-schema-migration | 0.7400 |
| 043 | db-migration-safety | 0.8400 | 044 | ci-config-repair | 1.0000 |
| 045 | dependency-upgrade-compat | 0.6280 | 046 | performance-regression | 1.0000 |
| 047 | code-review-risk-report | 0.6465 | 048 | release-note-changelog | 0.8877 |
| 049 | excel-like-cleaning | 1.0000 | 050 | multitable-join-analysis | 0.9679 |
| 051 | sql-query-report | 0.9506 | 052 | metric-definition-audit | 0.8118 |
| 053 | anomalous-transaction-detect | 0.9572 | 054 | budget-variance-analysis | 0.9628 |
| 055 | funnel-dropoff-analysis | 0.5792 | 056 | inventory-forecast | 0.6900 |
| 057 | interruption-resume | 1.0000 | 058 | multiday-project-state | 1.0000 |
| 059 | event-update-replan | 1.0000 | 060 | task-cancellation-cleanup | 1.0000 |
| 061 | periodic-status-rollup | 0.8636 | 062 | k8s-config-audit | 0.8936 |
| 063 | alert-dedup-noise | 1.0000 | 064 | service-dependency-triage | 0.7689 |
| 065 | capacity-planning | 0.6490 | 066 | rollback-readiness | 0.8242 |
| 067 | canary-release-check | 0.9263 | 068 | product-launch-ops | 1.0000 |
| 069 | legal-compliance-review | 0.9500 | 070 | hr-resume-screening | 0.7000 |
| 071 | ecommerce-support-routing | 0.8300 | 072 | logistics-delay-response | 0.8800 |
| 073 | research-repro-package | 0.4600 | 074 | education-grading-feedback | 0.5200 |
| 075 | platform-appeal-review | 0.8600 | 076 | medical-admin-claim-check | 0.8300 |
| 077 | archive-manifest-defense | 0.2759 | 078 | local-api-cursor-retry-ledger | 0.7778 |
| 079 | smallfile-batch-reject-ledger | 0.4102 | 080 | schema-roundtrip-conversion | 0.9130 |
| 081 | local-html-dom-form-extract | 1.0000 | 082 | compose-config-repair | 0.7000 |
| 083 | monorepo-interface-repair | 1.0000 | 084 | js-state-type-bug | 0.9675 |
| 085 | flaky-test-root-cause | 1.0000 | 086 | sql-migration-preflight-rollback | 0.1600 |
| 087 | cli-parser-bug-tests | 0.9250 | 088 | api-contract-mock-client-compat | 0.5000 |
| 089 | ab-test-caveat-analysis | 0.9524 | 090 | timeseries-anomaly-attribution | 0.3729 |
| 091 | financial-close-reconciliation | 0.6721 | 092 | schema-drift-audit | 0.3269 |
| 093 | jsonl-sessionization-analysis | 0.5918 | 094 | metric-definition-migration-diff | 0.7925 |
| 095 | policy-version-conflict-resolution | 0.6900 | 096 | offline-knowledge-qa-insufficient-evidence | 0.6500 |
| 097 | research-claims-batch-evidence-audit | 0.7200 | 098 | three-source-decision-record-synthesis | 0.7371 |
| 099 | privacy-dsar-intake-review | 1.0000 | 100 | financial-kyc-admin-check | 0.6000 |
| 101 | marketing-sensitive-commitment-review | 0.9083 | 102 | internal-doc-retrieval-injection-defense | 0.6000 |
| 103 | policy-update-replan-diff | 0.9340 | 104 | async-ops-window-rollup | 0.8875 |
| 105 | partial-batch-resume-ledger | 0.7300 | 106 | release-approval-gate-plan | 0.9477 |

注意：某些 canonical 分数与更早报告中的单次 raw 分不同，是因为本轮保留了修复后的最新有效运行；额度中断和 Provider 畸形流样本被另存为带原因后缀的 JSON，没有覆盖 canonical 文件。

## 4. 本轮最关键的 Harness 题与实际内容

### 4.1 `008-image-recognize`：图片输入与畸形流恢复

实际要求是读取两张绝对路径图片，用简短英文描述图片主体、主色和前景/背景线索，并分别写入两个恰好一行的文本文件。

第一次运行 366 秒后，MiniMax 在第 15 turn 留下未闭合 reasoning block，最终返回 `PROVIDER_STREAM_INVALID`；没有可提交的最终 token。修复后复跑 21.171 秒完成，oracle 1.0000。精确的畸形流分支另由单元测试覆盖，因此不能把第二次刚好没有复现坏流说成“Provider 永远正常”。

### 4.2 `022-local-rest-api-summary`：分页、重试、关联与精确编码

实际要求是只访问 `MOCK_API_BASE` 下的 projects/users/incidents 三个分页端点，处理首次 429/503，去重、关联 owner 和 incident，生成排序后的 JSON 和数据质量报告。第一次与第二次分别只有 0.2174、0.3478，主要原因是 PowerShell 5.1 写出了不可见 UTF-8 BOM。

`read` 过去会把 BOM 解码掉，模型看到的内容干净，无法知道原始文件首字节仍有 BOM。主干增加 `hasBom` 后，模型能够观察真实编码；复跑达到 0.8696，JSON parse、URL、计数、排序、重试等检查全部通过，只因质量报告没有逐字写出 `429`/`503` 扣分。

### 4.3 `103-policy-update-replan-diff`：多轮政策变化后重规划

第一轮要求根据现有政策、区域约束、团队容量和沟通矩阵生成计划；第二轮注入政策变更，要求比较旧计划并重排。一次运行在已有部分可见文本后遇到 `PROVIDER_TRANSPORT_ERROR`，旧 Runtime 直接失败，得分 0.1。

主干改为把**尚未提交、尚未执行 Tool**的 Provider turn 当作事务：网络传输失败时可以丢弃这段不完整可见文本并完整重试一次，trace 记录 `discardedVisibleText=true`。复跑得分 0.934。这个修复只重试未提交 turn，不会在 Tool 已执行后盲目重放副作用。

### 4.4 `104` 与 `105`：异步更新、恢复与 Prompt 相关性

- `104-async-ops-window-rollup` 要至少轮询 30 秒，按时间窗筛选异步 JSON 更新、去重、识别根组件/下游症状，并生成 Markdown、JSON 状态与 CSV ledger。BOM 可观察性修复后，代表分从 0.35 提升到 0.8875。
- `105-partial-batch-resume-ledger` 是两轮任务：第一轮按规则处理批次并留下失败项，第二轮读取 retry 指令与既有 ledger，要求幂等恢复而不重复成功项。Prompt 1.2 后代表分从 0.56 提升到 0.73，但这只是相关信号，不能仅凭一次复跑断言全部提升来自 Prompt。

## 5. Terminal-Bench 本轮实际题目与结果

| 题目 | 实际交付要求 | 结果 | 墙钟与用量（input/cache/output） |
| --- | --- | --- | --- |
| `cancel-async-tasks` | 在 `/app/run.py` 实现有最大并发限制的 `async run_tasks`，键盘中断时仍执行任务 cleanup | **FAIL，reward 0**；6 项 verifier 过 5 项，3 个任务/max=2/SIGINT 时前两个 cleanup 计数为 0 | 4m26s；7,906 / 32,973 / 3,065 |
| `openssl-selfsigned-cert` | 生成 RSA-2048 私钥、365 天自签证书、组合 PEM、验证报告和 Python 检查器，私钥权限 600 | **PASS，reward 1** | 2m33s；11,810 / 81,228 / 5,208 |
| `sqlite-db-truncate` | 从被二进制截断的 SQLite 文件中尽可能恢复行，输出规定 schema 的 `/app/recover.json` | **PASS，reward 1** | 9m52s；140,264 / 718,976 / 35,632 |
| `fix-git`，Prompt 1.1 | 找回 checkout master 后看不见的个人站点改动，并合并进 master | **FAIL，reward 0**；找到 commit，`--ff-only` 失败后把 merge/cherry-pick 的实现选择退回用户 | 1m29s；9,458 / 31,907 / 1,408 |
| `fix-git`，Prompt 1.2 | 同上，作为通用自主推进合同的 A/B 复验 | **PASS，reward 1** | 1m58s；10,269 / 107,264 / 2,092 |
| `cobol-modernization` | 理解 COBOL 对 INPUT.DAT 和三个 DAT 文件的逻辑，用 Python 精确复现字节结果 | **PASS，reward 1** | 4m14s；29,384 / 354,304 / 13,135 |
| `polyglot-c-py` | 一个 `main.py.c` 同时可由 Python 3.12 运行和 GCC 13 编译，两者输出 Fibonacci | **INVALID**；执行到 Provider 额度终止，Harbor 报 `ApiRateLimitError`，reward 0 不计正确率 | 4m56s；中断前 11,807 / 347,264 / 21,839 |

逐字英文题面都保存在：

```text
D:\agent-evals\sources\terminal-bench-2\terminal-bench-2\<题名>\instruction.md
```

本轮 6 个可公平评分 rollout 是 4/6 通过；按不同题目去重，并把 Prompt 1.2 的有效 `fix-git` 作为该题最终结果，是 4/5 通过。历史档案原有 17 道不同通过题，本轮新增 `openssl-selfsigned-cert`、`sqlite-db-truncate`、`cobol-modernization` 三道，因此当前共记录 **20 道不同的 Terminal-Bench 已通过题目**。这仍不是官方 leaderboard 提交。

## 6. 发现的问题、责任层与处理方法

### 6.1 已永久修复：Provider 流错误恢复不完整

旧逻辑只在没有可见输出时重试，并且把未闭合 reasoning 也当成不可重试。真实 Provider 会出现两类情况：只留下未完成 reasoning；或先吐出一小段可见文本，再发生传输错误。两者都还没有形成可提交 assistant turn，也没有执行 Tool。

现在 Runtime 对未提交 turn 做一次有界重试：

- `PROVIDER_STREAM_INVALID` / 空流：没有耐久可见输出时重试；未闭合 reasoning 不再阻止恢复。
- `PROVIDER_TRANSPORT_ERROR`：即使出现部分可见文本，只要整轮尚未提交且 Tool 未执行，也可丢弃半截响应并重试一次。
- trace 明确记录是否丢弃过可见文本，便于区分“恢复成功”和“Provider 一直正常”。

边界：只重试一次，且不会越过已执行副作用的提交点；它不是无限重试，也不能解决账户额度耗尽。半截文本若已经作为实时 delta 发给 UI，canonical journal 不会提交它，但当前协议还没有 delta 撤回事件，客户端可能短暂看见它；这是仍需补齐的展示层语义。

### 6.2 已永久修复：文本读取看不见 BOM

Prompt 告诉模型 PowerShell 5.1 可能写 BOM，只能减少犯错概率；若 `read` 把 BOM 静默剥掉，模型无法验证原始字节。现在 `read` 结果增加 `hasBom: boolean`，摘要在存在 BOM 时显示 `UTF-8 BOM detected.`，正文仍返回正常解码文本。这样既不污染内容，又让编码成为可观察事实。

### 6.3 已永久修复：已授权目标仍把实现选择退回用户

`fix-git` 的用户已明确要求“找回并合入 master”，但模型在一种 Git 方法失败后询问应 merge 还是 cherry-pick。这不是权限不足，而是 Prompt 对自主推进边界描述得不够清楚。

Prompt 1.2 现在要求：用户已授权具体结果、只未规定实现方法时，选择合理、可验证、优先可逆的方法继续；只有信息缺失会实质改变结果、权限或风险时才询问；一种方法失败后先检查状态并尝试安全替代。真实 A/B 从 reward 0 变为 1。

### 6.4 有效模型失败：异步 cleanup 边界没有被自测覆盖

`cancel-async-tasks` 的 Runtime 和容器正常，官方 verifier 实际执行到了实现代码。模型的自测没有覆盖“3 个任务、并发 2、启动后立刻 SIGINT”这一精确时序，导致正在运行的两个任务 cleanup 都没执行。这属于模型生成代码和测试覆盖不足，不应归因给 compaction 或 Provider。

### 6.5 尚未修复：Workflow 终态与 Root 终态的语义不一致

`cancel-async-tasks` 的 SIGINT 诊断命令、以及 Prompt 1.1 `fix-git` 的 `git merge --ff-only` 退出 128，都可能被 Workflow effect 状态记为 `WORKFLOW_EFFECT_OUTCOME_UNKNOWN`，进而让 Workflow 标为 failed；但 Root 仍可以观察错误、继续执行并最终 `prompt_completed`。

这里真正需要设计的是：诊断命令的非零退出是否应被视为“已知失败结果”，还是“副作用结果未知”。现在把两者混在一起，会造成 UI/投影上的假失败。由于改变状态机含义会影响恢复与幂等，本轮只记录证据，没有草率修改。

### 6.6 不是 compaction 的问题

本轮关键低分任务的 trace 没有出现 compaction/truncation 先于错误；模型仍能读取题面与文件。典型问题是遗漏业务规则、字段名不精确、否定约束处理错误、只跑自写 happy-path 测试。除非 trace 显示 checkpoint 后合同消失，否则不能把所有长任务失败都归因成“上下文被压缩坏了”。

## 7. Prompt 1.2 与静态审计

`npm run audit:prompts` 的当前结果：

| 项目 | baseline-v1 1.2.0 | iron-law-lean-v1 1.2.0 |
| --- | ---: | ---: |
| Trusted Instructions chars | 3,702 | 2,179 |
| Trusted Instructions estimated tokens | 1,851 | 1,090 |
| 整个 system/context estimated tokens | 2,217 | 1,579 |
| context messages | 2 | 3 |
| Trusted Instructions digest | `sha256:a3f6583218006ceac8fac7e4db45cc34499e2c9cbfe6a89511f5de719f653247` | `sha256:434763811067f5293913ea2b8065ff7337666cf05d3e90a02313e87dae287486` |

源码 bundle digest 为 `sha256:709816ca376ba521805b32787217a3aa3336050f60b2154e62069213b1a2fc12`。lean 相比 baseline 的可信指令字符/token 少 41.1%，整个 system/context 估算 token 少 28.8%。这些数字只证明 Prompt 体积和确定性装配，不直接证明任务正确率。

## 8. 本地验证与额度终态

主干修改后的本地证据：

- `planner-loop.test.ts`：45/45 通过，覆盖未闭合 reasoning 和部分可见文本后的传输恢复。
- 加上 trace contract：61/61 通过。
- `read-tool.test.ts` / `tools.test.ts` 相关检查：19 pass、1 skip；覆盖 `hasBom`。
- `system-prompt.test.ts`：20/20 通过；Prompt 1.2 digest 已冻结。
- TypeScript typecheck、workspace build、`npm run audit:prompts` 均通过。

额度探针使用 canonical `001-file` 的最小任务。失败样本已归档为：

```text
D:\agent-evals\results\harnessbench\praxis-auto-minimax\unknown-api\001-file.quota-probe-20260823.json
```

探针 5.131 秒结束，第一次 Provider turn 只有约 183 个估算输入 token，0 输出、0 Tool；Runtime 的一次有界重试也返回 `PROVIDER_RATE_LIMITED`，最终 `run.failed`。`095` 与 `098` 的额度中断结果同样另存为 `quota-interrupted` / `quota-terminal` 后缀，并恢复此前有效 canonical 文件。

这满足本轮停止条件：不是“看到一个 429 就停”，而是在在途任务结束后用单路最小请求确认总额度不可用。

## 9. 能从这轮测评推出什么

可以推出：Praxis 的 `auto` 能稳定承载文件、REST、异步轮询、Git、证书、语言迁移和受损数据库恢复等任务；长任务不会被旧的人为 turn/tool/wall-clock 限制截断；Provider 异常、BOM 和 Prompt 自主推进缺口都有可复验的主干级处理。

不能推出：Praxis 已达到工业级 SLA；0.8269 是官方排行榜分；Prompt 1.2 对所有模型都必然更好；或所有任务都应该创建 Child。本轮多数 Harness 题由 Root 直接完成，说明 Workflow/Subagent 是按收益选用的能力，不是 benchmark 通过的必要仪式。
