# MiniMax M3 + Auto 持续测评（2026-08-22）

本页记录 2026-08-22 使用 MiniMax M3、Praxis `auto` 模式持续运行 Harness-Bench，直到 Provider 明确拒绝新请求为止的实际结果。它既保留得分，也解释题目究竟要求 Agent 做什么、失败发生在哪一层。原始题面和机器评分仍以 `D:\agent-evals\sources\harness-bench\tasks\` 与 `D:\agent-evals\results\harnessbench\praxis-auto-minimax\unknown-api\` 为准。

## 先看结论

- 本阶段最后一轮新增 20 个 `adapter_ok=true` 的有效任务，oracle 平均分为 **0.8027**；其中 4 个满分，8 个不低于 0.90。Harness-Bench 对这些题没有统一的二元及格线，因此这里报告连续分数，不把 0.8 擅自换算成“通过率”。
- 20 个有效任务累计 Agent 墙钟为 2,248.525 秒。因为最多 3 路并发，累计墙钟不是用户实际等待时间。
- `040-test-coverage-fill` 有一次完整运行达到 **1,139.631 秒（约 19 分钟）**并正常结束，oracle 0.88。它证明旧的 6 分钟墙钟没有截断当前长任务。
- 在 8 路并发下曾出现 `PROVIDER_RATE_LIMITED`；降到 3 路后又连续完成多批任务，说明第一次是并发/速率限制，不是立即耗尽总额度。
- 最终单路最小任务也在 5.124 秒内、0 turns、0 tool calls 失败；直接 CLI 探针明确返回 `terminalCode=PROVIDER_RATE_LIMITED`。此后停止模型请求，判定本轮 MiniMax 可用额度已经耗尽或进入 Provider 的计划级封锁窗口。
- 本批 `auto` 运行中，已检查的 terminal usage 均为 `subagents: 0`，Workflow 投影为 `single_agent`。所以这些结果证明的是 Root Agent + Runtime 工具循环的承载能力，**不能**作为自动 Child 委派效果的证据。

## 怎样读这些分数

一条运行要分三层看：

1. `adapter_ok=true`：Praxis CLI、Runtime、Provider 和评测适配器走到了可正常评分的终态。
2. `oracle score`：题目产物实际满足多少验收条件。模型写错文件内容时会扣分，即使 Runtime 完全健康。
3. `adapter_ok=false`：运行链路被 Provider、超时或适配器终止。此时即使已生成部分正确产物，也不能当作一次完整有效 rollout。

`oracle` 是 benchmark 自带的机器评分程序；`rollout` 是“给模型一道题并让它从开始执行到结束”的一次完整尝试。

## 有效任务逐题结果

下表的“实际题目内容”是对原始英文 Prompt 的忠实中文展开，不是只看题目名称猜测。每题逐字 Prompt 位于表中给出的源目录下 `prompt.txt`。

| 题目 | 实际题目内容 | 秒 | Oracle | 实际结果与未满足项 |
| --- | --- | ---: | ---: | --- |
| `082-compose-config-repair` | 离线修复事故中损坏的 `compose.yaml`；读取 service policy，保留 api/db/redis healthcheck、worker、依赖和数据卷；禁止拉镜像/启动容器；运行本地 validator，并写根因报告。 | 60.809 | 0.7000 | Compose 结构、高级合同、YAML 解析、`.env.example` 和报告正确；本地 validator 未通过。 |
| `083-monorepo-interface-repair` | 修复 monorepo 跨包接口：catalog 已从 `price_cents` 迁移到 `Money`，orders/reports 仍依赖旧接口；保留 legacy 字典兼容与混合币种报错，禁止改测试。 | 124.821 | 1.0000 | 公开 pytest、隐藏接口行为、测试完整性、实现质量和报告全部通过。 |
| `085-flaky-test-root-cause` | 找出 pytest 偶发失败的生产代码根因；在注入 clock/random 时让任务顺序和 retry jitter 可确定；禁止改测试、sleep、xfail。 | 97.053 | 1.0000 | 连续 8 次 pytest 稳定，隐藏确定性、测试完整性、实现质量和根因报告全部通过。 |
| `084-js-state-type-bug` | 修复 JS session store 的独立实例、不可变更新、用户/角色类型归一、admin 缓存失效、序列化深拷贝和输入校验；禁止改测试。 | 92.422 | 0.9875 | 公开和隐藏状态行为均通过；仅实现质量启发式得到 0.875，折算后总分 0.9875。 |
| `041-frontend-state-bug` | 修复购物车共享状态、非法数量、陈旧 selector、持久化共享数组；补 undo/redo、coupon、v1 数据迁移和深拷贝，隐藏检查会组合多步操作。 | 161.343 | 0.6000 | 可见 Node 测试通过，实现与测试完整性通过；隐藏用例中 `restoreCart` 对合法输入抛出 `Invalid cart payload`。 |
| `044-ci-config-repair` | 按 `CI_NOTES.md` 修复 GitHub Actions：安全事件、固定 action 大版本、Python 3.10/3.11 matrix、pip cache、路径过滤、pytest 与 smoke；禁止部署和 secrets。 | 79.672 | 1.0000 | YAML、CI 结构、路径模拟、本地测试、smoke、设计说明和源码完整性全部通过。 |
| `045-dependency-upgrade-compat` | 仅升级 `python-slugify` pin，保持 `make_slug` 签名并覆盖 Unicode、separator、空值、非字符串和标点折叠；产出决策、矩阵和风险文档。 | 218.321 | 0.5913 | 版本范围写对且改动最小；评测 Python 中缺少 `slugify`，pytest 导入失败，行为检查和矩阵也未完全满足。 |
| `046-performance-regression` | 优化重复目录查询，保持函数与结果、输入顺序、重复 SKU 去重和任意 SKU；禁止外部依赖、数据库、网络及持久缓存。 | 46.155 | 1.0000 | 边界语义、生成数据正确性、实现形态全部正确；耗时 0.03746 秒，低于 0.12 秒阈值。 |
| `047-code-review-risk-report` | 根据 patch 与代码片段输出结构化安全/正确性 review JSON，只报有证据的问题，并按 auth bypass、跨租户、注入、支付重复、泄露等规则定级。 | 84.163 | 0.6381 | 9 类风险基本覆盖且建议可执行；只有 7/9 严重级别精确，只有 6/9 测试建议命中严格要求。 |
| `042-api-schema-migration` | 修复 v1/v1.1/v1.2/v2 订单转换，保留 unknown fields、过滤 PII、默认 shipping、批量聚合错误/警告、写审计文件并支持 JSONL CLI。 | 475.540 | 0.7400 | 5/5 pytest 通过，多版本映射、PII 与 CLI 大体正确；`convert_many` 错误合同和项目内 audit 写入未满足隐藏检查。 |
| `069-legal-compliance-review` | 读取内部政策、营销文案、受监管词表、证据清单和升级压力说明；逐词保留原文证据，生成合规 CSV、改写文案、命中审计和变更理由。 | 82.232 | 0.9500 | 主要结构、13 个词命中、政策依据、改写和 benign identifier 保留正确；仅少量严格项扣分。 |
| `095-policy-version-conflict-resolution` | 只用离线政策版本，按优先级、生效日期和 scoped exception 处理 11 个 case；生成裁决 JSON 与冲突审计 CSV，证据不足时不得编造。 | 126.753 | 0.6900 | 11/11 decision 正确，覆盖和冲突审计正确；来源/证据细节与 insufficient-evidence 约束不够精确。 |
| `096-offline-knowledge-qa-insufficient-evidence` | 只用本地知识库回答 14 问；状态只能是 answered/partial/insufficient_evidence，并逐条列来源和缺失证据，禁止用常识补洞。 | 38.122 | 0.6500 | 14 题全覆盖，13 个状态命中，来源与缺失证据结构良好；2 条仍出现禁止的推断或陈旧答案。 |
| `097-research-claims-batch-evidence-audit` | 审计 14 条科研主张，区分 supported/contradicted/overstated/unsupported/not_reproducible；生成 CSV 和 JSON evidence matrix。 | 91.351 | 0.9364 | 格式、覆盖、证据、复现缺口和夸大范围处理整体优秀；个别状态/矩阵字段未满分。 |
| `099-privacy-dsar-intake-review` | 行政审核 DSAR 删除请求，按政策与 data map 产出决策、申请人回复和脱敏审计；禁止泄露第三方、完整邮箱/电话和内部风险笔记，也不得承诺已删除。 | 62.479 | 0.6000 | 文件、表头、请求覆盖、保留例外和“不承诺已删除”成立；输出仍泄露直接或第三方标识符，触发隐私扣分。 |
| `070-hr-resume-screening` | 只按职位相关证据给候选人 0–5 分、shortlist 和排名；不得包含或推断年龄、性别、族裔、家庭、残障、国籍、宗教。 | 33.549 | 0.7000 | 全候选人覆盖、分数范围、排名与岗位证据正确；shortlist 有误，且输出出现了敏感属性词。 |
| `071-ecommerce-support-routing` | 根据 ticket、订单和政策决定 refund/reship/escalate/information_request；正确处理 VIP、欺诈、矛盾证据和 POD 争议，并写逐票模板与升级团队 CSV。 | 61.905 | 0.8300 | 产物、schema、票据覆盖、升级记录与不过度承诺整体正确；部分 action/policy/priority 的严格映射扣分。 |
| `073-research-repro-package` | 审计研究复现包中的缺原始数据、坏脚本、论文/CSV 指标不一致和缺失附录；逐 CLAIM 写报告及至少 4 条 missing steps，禁止假称复现成功。 | 103.895 | 0.6000 | 报告结构、诚实性、CSV 结构成立；缺失台账没有被 oracle 识别为覆盖 `analysis_driver_unusable` 关键阻断项。 |
| `075-platform-appeal-review` | 根据 moderation policy、修订案、生效日期与 case JSON，输出申诉决定、逐案解释和敏感字段审计；每案需精确条款、置信度和替代方案解释。 | 102.928 | 0.9500 | 决策、条款、逐案解释、日期逻辑、隐私和脱敏路径整体优秀；少量严格校准项扣分。 |
| `076-medical-admin-claim-check` | 只做去标识保险理赔材料完整性检查，不作诊断；处理 plan/字段触发、90 天过期、claim-id 不匹配和 COB，输出 JSON、缺失清单和脱敏 CSV。 | 105.012 | 0.8900 | 文档与隐私大部分正确；对 stale/mismatched/COB 缺口和 admin_notes 中两个明确 trigger 的表述不够完整。 |

逐字题面路径形式为：

```text
D:\agent-evals\sources\harness-bench\tasks\<task-id>\prompt.txt
```

逐题机器结果路径形式为：

```text
D:\agent-evals\results\harnessbench\praxis-auto-minimax\unknown-api\<task-id>.json
```

注意：同一题重复运行时，这个简化结果文件可能被最后一次运行覆盖；重复 rollout 的分数因此也在下一节和运行总账中单独记录。

## 额度临界点的两个不完整运行

| 题目 | Adapter | Oracle | 怎样解释 |
| --- | --- | ---: | --- |
| `079-smallfile-batch-reject-ledger` | FAIL，131.866 秒 | 0.02 | 题目要求递归处理 CSV/JSON/TXT，逐记录标准化，并精确生成 index、reject ledger、summary。输入完整性仍通过，但主要输出未完成；和下一条同时在额度临界点退出，不能用 0.02 评价正常模型能力。 |
| `080-schema-roundtrip-conversion` | FAIL，117.169 秒 | 1.00 | 题目要求把 Markdown/CSV/JSON/YAML 按 JSON > YAML > CSV > Markdown 优先级合并，保留 `"007"`、null、数组和冲突报告。产物实际上被 oracle 全部判对，但 Runtime/adapter 在最终收尾前失败，所以记为“任务产物满分、rollout 无效”，不冒充完整 PASS。 |

这两个结果还暴露出评测适配器的可观测性问题：结果 JSON 只保留 `returncode=1` 和 usage collector 的 `missing responses/`，没有保存 Praxis stream 中的 terminal 错误。后续用直接 CLI 探针才拿到精确错误码。它是评测基础设施问题，不是 Praxis 任务状态机已经丢失错误码。

## 同题重复与长任务压力

在切换到 3 路并发前，先让 6 条 8 路批次中的在途任务自然跑完：

| 题目 | 本批分数 | 说明 |
| --- | --- | --- |
| `040-test-coverage-fill` | 1.00、1.00、0.88 | 两次把测试补到满分；最长一次 1,139.631 秒，79 tests 全过、8/8 mutation 被杀死，但缺 `test_intent` 文档而得 0.88。历史同题也出现过 0.46（模型误改生产源码）与多次 0.88/1.00。 |
| `043-db-migration-safety` | 0.267 | SQL 文本与 preflight 报告大体存在，但迁移执行触发 `FOREIGN KEY constraint failed`，rollback 也不完整。历史同题曾出现 0.985，说明策略方差很大。 |
| `086-sql-migration-preflight-rollback` | 0.70、0.9125 | 0.70 的运行丢失数据保留与 post-check；0.9125 的运行通过迁移、数据保留、幂等和回滚，只缺 post-check 与文档细节。 |

`040`、`043`、`086` 的重复分数变化发生在同一框架、同一 Provider/模型和相同题面下。Runtime 都能启动、调用工具、写文件并交给 oracle；主要变化来自模型选择的实现路线和检查深度。因此不能用单次高分宣称稳定，也不能把单次低分都归因于 Prompt 或 compaction。

## 额度耗尽的机器证据

最终确认分两步：

1. 单路重新运行最小的 `001-file`，5.124 秒内 `adapter_ok=false`，目标文件为空。
2. 使用隔离 `PRAXIS_HOME` 直接调用 Praxis CLI，Prompt 为“只回复 OK，不要调用工具”。Runtime 在模型产生任何 turn/tool/token 前返回：

```json
{
  "state": "failed",
  "topology": "single_agent",
  "terminalCode": "PROVIDER_RATE_LIMITED",
  "error": "The Provider rate limit was reached.",
  "usage": {
    "turns": 0,
    "toolCalls": 0,
    "inputTokens": 0,
    "outputTokens": 0,
    "subagents": 0
  }
}
```

因此停止条件不是“某道题得分低”，而是“单路、最小、无工具请求也被 Provider 在生成前拒绝”。

## 本批暴露出的能力边界

### Praxis 已证明的部分

- `auto` 能稳定进入单 Agent ReAct 工具循环，读取多文件、运行命令、修改代码和生成 JSON/CSV/Markdown/YAML。
- 当前主干能承载分钟级到约 19 分钟的任务，不再被旧 6 分钟墙钟截断。
- 3 路独立进程可以持续执行；单条失败不导致另外两条 Runtime 崩溃。
- Provider 限流会被归类为 `PROVIDER_RATE_LIMITED`，不会伪装成普通 Prompt 失败。
- 多轮 Harness-Bench session 在评测适配器修复后可映射回同一个 Praxis `s-...` session；`007-session-memory` 因此从 0.25 复验到 1.0，`105` 从 0.74 提升到 0.9175。该修复位于 `D:\agent-evals\adapters\praxis-runner.mjs`，不是为题目临时修改 Praxis 主干。

### 本批没有证明的部分

- 没有证明 `auto` 会主动派 Child。本批实际是 `single_agent`、`subagents=0`；自动 Run Tree 委派需要单独的受控与自主 A/B 测评。
- 没有证明 Workflow DAG 能提高这些题的正确率。这里没有让同一道题在 React、Run Tree 和外层 Workflow 三种条件下重复足够次数。
- 没有证明 3 路就是生产安全并发。8 路触发过瞬时限流；安全并发还取决于 Provider 计划、token 速率、每题长度和 Root 是否占用 lane。
- 没有证明隐私、公平与证据克制已经可靠。`099`、`070`、`096` 分别暴露了 PII、敏感属性词和证据不足时过度回答。

## 问题归因

| 现象 | 主要归因 | 理由 |
| --- | --- | --- |
| 隐藏测试失败、SQL/Schema 细节漏项 | 模型策略/实现质量 | Runtime 正常完成，文件存在，oracle 能逐项评分；相同题重复方差很大。 |
| `auto` 没有派 Child | 模型工具偏好 + 委派收益信号不足 | Tool 能力已存在，但本批所有被检查运行都是 single-agent；不能说 Runtime 不支持，也不能说 Prompt 已能稳定触发。 |
| 8 路出现限流、3 路恢复 | Provider 并发/速率约束 | 降并发后最小探针与多批任务恢复成功。 |
| 最终单路 0-turn 限流 | Provider 额度/计划窗口 | 请求在首 token 前被拒绝，和任务、工具、context 无关。 |
| `079/080` 结果未保留 terminal 文本 | 评测适配器可观测性 | Praxis 直接 CLI 有精确 terminal code，但 Harness 结果只留下 returncode。 |
| `007` 早期跨轮记忆失败 | 旧评测 adapter session 映射 | Harness 外部 session id 没转换为 Praxis 内部 `s-...`；修复映射后同题满分。 |

## 给新手的名词解释

- **Planner / auto**：`auto` 让模型和 Runtime 根据任务选择执行拓扑。本批实际落到 `single_agent`，也就是一个 Root Agent 自己循环思考、调用工具、观察结果。
- **ReAct**：Reason + Act 的缩写。模型反复“看当前状态 → 决定动作 → 调工具 → 看结果”，不要求先固定一张完整 DAG。
- **Child / Subagent**：由 Root 派出的另一个 Agent Run。它可以并行或专注处理子任务。本批没有实际派出 Child。
- **Oracle**：benchmark 自带的确定性评分脚本，通常直接检查文件、测试、哈希、字段和业务规则。
- **Adapter**：把 Harness-Bench 的 Prompt、workspace 和 session 转换成 Praxis CLI 调用的薄层代码。
- **墙钟（wall-clock）**：现实世界经过的时间，不是 CPU 时间，也不是 token 数。
- **Mutation test**：故意把生产代码改坏，看新增测试能不能把错误抓出来；`040` 中 8/8 mutations killed 表示测试能发现 8 种故意注入的错误。
- **Hidden test**：模型看不到的验收测试，用于防止只针对公开样例硬编码。
- **Provider rate limit**：模型服务商对并发、每分钟请求/token 或计划总量的限制；它不是 Praxis 自己设置的任务上限。

## 后续怎样维护

下一次额度恢复后，不应直接覆盖本页结论。应新增日期/批次并至少记录：模型、Provider、Planner、Prompt profile、并发、task id、elapsed、adapter terminal、oracle score、turn/tool/subagent usage，以及是否发生 compaction。若要比较新 Planner 与普通 ReAct，应固定同题、同模型、同输入，分别运行多次，并把均值、成功率、token、墙钟和方差一起报告。
