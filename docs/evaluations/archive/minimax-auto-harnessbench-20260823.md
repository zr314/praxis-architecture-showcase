# MiniMax M3 + Auto 代表性续测（2026-08-23）

## 1. 本轮要回答什么

本轮在 MiniMax 额度恢复后继续使用 Praxis `auto` 模式运行 Harness-Bench。本轮不只看分数，还逐项排查以下六层：

1. **Praxis Runtime**：进程、Tool、权限、状态机、长任务和终态是否正常；
2. **Prompt**：模型是否得到足够而准确的工作规则，Prompt 是否能装进预算；
3. **模型行为**：模型是否正确理解题意、实现、复查并遵守精确格式；
4. **Provider**：MiniMax 是否限流、长时间不返回或在生成前失败；
5. **题目合同**：题面是否把隐藏验收需要的语义说清楚；
6. **Oracle/Runner**：评分器和外层运行器是否正确。

这样做很重要：`prompt_completed` 只能证明 Runtime 正常收尾，不能证明答案正确；反过来，oracle 低分也不自动等于 Praxis 主干有缺陷。

运行环境为 Windows、PowerShell 5.1、MiniMax M3、Planner `auto`。需要访问本地 HTTP 服务的题目使用 Harness-Bench 已提供的 `HARNESSBENCH_PUBLIC_URL_TEMPLATE={local_url}` 钩子，仍只访问题目自己的 mock server，没有使用公共互联网。原始题面位于 `D:\agent-evals\sources\harness-bench\tasks\<task-id>\prompt.txt`，原始运行结果位于 `D:\agent-evals\results\harnessbench\praxis-auto-minimax\unknown-api\`。

## 2. 先看结论

| 题目 | 实际题意简述 | Oracle 原始分 | 合同调整后 | Runtime | 主要归因 |
| --- | --- | ---: | ---: | --- | --- |
| `022-local-rest-api-summary` | 翻页读取三个本地 REST 端点，处理 429/503，联表汇总 | **1.0000** | **1.0000** | PASS | 完整通过 |
| `023-web-form-extraction` | 读取 CSRF/隐藏字段，提交查询与确认表单 | 0.9474 | **1.0000** | PASS | oracle 使用陈旧 fixture 哈希 |
| `041-frontend-state-bug`，lean 1.0 | 修购物车不可变状态、优惠券、持久化、undo/redo | 0.5925 | 0.5925 | PASS | 模型写了与题意相反的自测 |
| `041`，baseline 1.1 | 同题 Prompt A/B | 0.5925 | 0.5925 | PASS | 通过优惠券，遗漏 legacy JSON 字符串输入 |
| `041`，lean 1.1 | 同题修复后复验 | 0.5962 | 0.5962 | PASS | 无 future 的 redo 被实现成抛错；隐藏语义未明确 |
| `078-local-api-cursor-retry-ledger` | cursor 翻页、429/503、cursor expired/checkpoint、精确账本 | **0.7778** | **0.7778** | PASS | 修复后 JSON/header/inventory/checkpoint 通过；ledger/report 漏一次性 429 证据 |
| `079-smallfile-batch-reject-ledger` | 离线扫描多格式小文件，规范化、去重、拒绝账本 | 0.4102 | 不调整 | PASS | 题面未定义 canonical schema；模型验收只查文件/哈希 |
| `080-schema-roundtrip-conversion`，lean 1.0 | 四格式冲突合并并导出 JSON/YAML/CSV | 0.9130 | 0.9130 | PASS | 冲突报告遗漏 |
| `080`，lean 1.1 | 同题 Prompt 修复复验 | 0.8261 | **1.0000** | PASS | 唯一差异是题面未要求的 CSV 末尾换行 |
| `081-local-html-dom-form-extract` | 解析本地 DOM、表单交互并抽取结构化结果 | **1.0000** | **1.0000** | PASS | 完整通过 |
| `088-api-contract-mock-client-compat` | 修 Python v1/v2 API 客户端、分页、重试、错误映射 | 0.5000 | 部分调整 | PASS | 两项 oracle/隐藏输入问题；公开测试和真实 API 通过 |
| `093-jsonl-sessionization-analysis` | JSONL 清洗、身份拼接、30 分钟会话化、汇总 | 0.5918 | 部分调整 | PASS | 14/16；归因字段/汇总类型在题面中未定义完整 |
| `096-offline-knowledge-qa-insufficient-evidence` | 只依赖离线知识库回答并识别证据不足 | 0.6500 | **1.0000** | PASS | oracle 把正确的否定说明当成“编造” |
| `099-privacy-dsar-intake-review` | DSAR 完整性、路由、对外回复和脱敏审计 | **1.0000** | **1.0000** | PASS | 首次 0.6000 的 PII 泄露在后续有效复验中纠正 |

“合同调整后”不是偷偷改分，而是把**模型真正违反题面**和**评分器额外假设**分开。排行榜或复现实验仍应保留原始分；产品决策可以同时参考调整后的任务语义结果。

本轮最重要的判断是：

- Praxis 能稳定运行本地文件、代码修复、本地 API、表单和 8 分钟级长任务；所有表中有效运行均正常进入 Runtime 终态。
- 本轮被详细检查的有效任务均没有发生 compaction 或 truncation。最长的 `078` 最大上下文约 65,045 tokens，远低于 MiniMax 本次配置的 1M 上下文，因此不能把这些低分归因给上下文压缩。
- cache 并不低：例如 `078` 累计 input 98,081、cache read 1,006,969；`088` input 23,102、cache read 292,040。它们是逐轮累计 token，不能简单相除宣称一个“命中率”，但足以证明稳定前缀被大量复用。
- `auto` 在这些任务中均由 Root 直接完成，没有 Child。它说明模型认为委派收益不足，不表示 `agent.spawn/wait/result/cancel/steer` 不可用；本轮目的也不是重复已经通过的 Run Tree 合同测试。
- 真正需要改 Praxis 的新问题只有一项确定性缺陷：默认 system Prompt 预算过小，会使 `baseline-v1` 在长 Windows 路径下在请求 Provider 之前失败。
- Prompt 可以减少遗漏，但不能机械保证模型遵守。新增 Windows shell 事实后，`078` 仍用 PowerShell 5.1 写出 BOM；新增最终验收合同后，模型在 `080` 补齐冲突报告，但又因一个未要求的末尾换行丢失原始分。

## 3. 每道题实际测了什么、结果如何

### 3.1 `022-local-rest-api-summary`：本地 REST、翻页和重试

**实际题目**：只能使用 `MOCK_API_BASE`，分别翻页读取 `/projects`、`/users`、`/incidents`。第一次请求可能返回 429 或 503，模型要短暂退避后重试；随后按 owner/project 关联数据，统计 active budget、open incidents、最高严重级别，处理重复项目、缺失 owner 和孤儿 incident，写 JSON 与数据质量报告。

**结果**：74.436 秒，12/12 oracle 检查通过，原始分 1.0。模型实际触发并处理本地 429/503。Runtime、Prompt 服从和任务正确性都通过。

**补充**：更早一次运行在 Provider 生成任何 token 前失败，属于额度/Provider 样本，未计入本题有效成绩；额度恢复后的运行才是当前代表。

### 3.2 `023-web-form-extraction`：HTML 表单完整交互

**实际题目**：访问本地首页，提取 CSRF token 和 hidden field，用 `order_id=A-1042`、`region=emea` 提交查询，继续确认步骤，把订单信息、两个 marker 和交互轨迹写入文件，并禁止修改输入页。

**结果**：28.288 秒，10/11 检查通过，原始分 0.9474。业务 JSON、CSRF、hidden field、提交、确认和最终 marker 都正确。

**异常归因**：唯一失败项 `source_index` 是 evaluator 缺陷。源 fixture 与 sandbox 输入的 SHA-256 均为 `52c1...`、长度均为 665 bytes，彼此完全相同；oracle 却硬编码了另一个陈旧哈希 `d4d...`。因此合同调整后为 1.0，不应修改 Praxis 或模型来迎合错误哈希。

### 3.3 `041-frontend-state-bug`：代码修复与 Prompt A/B

**实际题目**：修复 JavaScript 购物车的共享状态变异、非法数量、失效 selector、持久化共享引用；实现 undo/redo、优惠券、schema version 和 legacy v1 迁移；保证外部 item 后续被修改时不污染 cart，并通过公开与隐藏的组合操作。

**lean 1.0 结果**：91.516 秒，原始分 0.5925。模型的自写测试明确断言“优惠券不影响 subtotal”，与题面“known code 应减少固定金额”正相反。这里是模型理解/自验错误，不是 Runtime 或 compaction。

**baseline 1.1 结果**：90.985 秒，原始分仍为 0.5925。它修对优惠券语义，却只接受 legacy object，没有兼容 JSON 字符串。题面说“legacy v1 payload shaped like JSON”，没有明确 `restoreCart` 会直接收到字符串；因此同时包含模型鲁棒性不足和隐藏合同含糊。

**lean 1.1 结果**：161.064 秒，原始分 0.5962。隐藏测试推进到“没有 future 时调用 redo”，实现选择抛错，oracle 期待 no-op 返回当前 cart。题面只说 future clearing，没有定义该边界语义。本次不能证明 baseline 比 lean 更好；三次单样本几乎同分，失败点却不同，显示模型 rollout 方差和隐藏合同敏感性。

### 3.4 `078-local-api-cursor-retry-ledger`：本轮最长、最有诊断价值的任务

**实际题目**：读取本地 API contract，分别完整拉取 datasets、jobs、artifacts；处理 cursor pagination、429、503 和一次 `cursor_expired`，通过 checkpoint endpoint 恢复；去重 artifact，排除 orphan，并输出精确 JSON、CSV 重试账本和数据质量报告。CSV header 必须恰好是五列。

**首次尝试**：Harness 外层 1,200 秒超时，Praxis 当时仍在运行，已经进行 48 turns/50 tools，最大上下文约 64,159，未 compaction/truncation。外层超时阻止正常清理，留下两个命令行精确匹配该 sandbox 的进程；核对 PID 和命令行后只终止了这两个孤儿进程。这个样本是 runner timeout，不是 Praxis 自己的长任务上限。

**第一轮有效复跑**：将外层 `AgentTimeoutMs` 调到 3,600,000 后，531.484 秒正常结束，54 turns、64 tools；input 98,081、output 26,112、cache read 1,006,969、0 Child、0 compaction、0 truncation。原始分 0.2593。

模型确实访问了 dataset/job/artifact/checkpoint 端点，也处理过异常，但最终产物存在以下问题：

- PowerShell 5.1 `Set-Content -Encoding UTF8` 给 JSON/CSV/Markdown 都加了 UTF-8 BOM，JSON oracle 因此无法按普通 UTF-8 解析；
- CSV 比题面规定的五列多了 `detail`，header 不精确；
- 模型为修业务内容多次重跑脚本，后一次运行覆盖了先前 ledger，最终只留下 200，丢失曾发生的 429/503/cursor-expired 证据；
- 报告写了 duplicate/orphan，但遗漏 cursor、429、503 等要求；
- inventory 的核心业务内容其实大体正确，低原始分主要由 BOM 导致 JSON 整组检查无法继续。

**归因**：Runtime 长任务、Tool、终态和上下文都健康；主要是模型没有把“生产结果”和“验收证据”当成单调累积状态，且没有检查字节编码和 exact header。Prompt 的 Windows shell 提示当时也不完整，所以随后补充了 shell dialect；但仅给提示仍不能强制模型不用 `Set-Content`。最终又补充了跨任务的验收合同，要求收尾前重读 acceptance criteria 并检查 parseability、encoding、schema、exact headers 和 material semantics。

**修复后当前代表**：后续有效运行 92.447 秒、13 turns、17 tools，原始分提升到 0.7778。JSON 可解析、source URL、全部 inventory 业务字段、CSV 精确 header、四类端点访问、checkpoint 和服务器侧 retry 均通过。剩余两项失败有同一个原因：模型在正式采集脚本前先探测 `/datasets?cursor=START`，提前消耗了 mock server 的一次性 429；最终脚本只能看见 200，所以 ledger 没有 429 行，报告也漏了 `429` 术语。这是模型对有副作用探测的处理问题，没有新的 Runtime 故障。证据为 canonical `078-local-api-cursor-retry-ledger.json`；0.2593 的旧运行保存在 `.run1-20260823.json`。

### 3.5 `079-smallfile-batch-reject-ledger`：多格式批处理

**实际题目**：递归扫描 dropbox；解析 customer CSV、order JSON、note TXT；为每个有效记录写一份 normalized JSON；全局 record id 去重；将未知扩展、畸形、缺字段、非法状态/金额和重复 ID 写入拒绝账本；生成精确 index、reject ledger 和 summary。

**结果**：146.696 秒，24 turns、44 tools，原始分 0.4102。Runtime 正常，最大上下文约 46,451，无 compaction/truncation。

**归因**：题面没有定义 normalized JSON 的 canonical 字段结构，也没有定义 summary 的完整 keys/types，oracle 却要求 `record_id`、`record_type` 等固定字段。模型又只验证文件存在性/哈希，没有验证业务语义；当时 lean runtime facts 也没说明 Windows 下不能用 `&&`、`$(pwd)` 和 POSIX `head`，造成多次无效 shell。这里是“题面/Oracle 不完整 + 模型验收不足 + Prompt 环境信息不足”的组合，不应归为单一主干缺陷。

### 3.6 `080-schema-roundtrip-conversion`：精确格式和冲突合并

**实际题目**：按 schema 把 Markdown、CSV、JSON、YAML 合并为 canonical records，优先级为 JSON > YAML > CSV > Markdown；保留 `"007"`、null、数组、escaped pipes 和 YAML aliases，并把冲突写进 conversion report，同时导出三种精确格式。

**lean 1.0**：34.028 秒，8/9，原始分 0.9130；三种 canonical 输出均正确，只漏 conflict report。

**lean 1.1**：255.053 秒，JSON/YAML/type/report/conflict 全部通过，唯一失败是 CSV 最后没有 trailing newline，原始分反降为 0.8261。题面没有要求 EOF newline，内容字节在最后换行之外与 ground truth 完全相同，因此合同调整后为 1.0。

这组 A/B 说明新增验收合同帮助模型补齐了冲突报告，但单次 raw score 仍会受模型方差和脆弱 exact-byte oracle 影响，不能拿 0.913→0.826 宣称 Prompt 退化。

### 3.7 `081-local-html-dom-form-extract`：DOM 与本地服务

**实际题目**：只能读取本地站点的 HTML/DOM、hidden fields、form actions/data attributes 和表单响应；完成首页、详情、筛选、确认流程，输出结构化 case、步骤状态、访问 URL 和交互轨迹，不能复制整页或 hidden bait。

**结果**：22.701 秒，9/9，原始分 1.0。实际 server access 覆盖 `/`、detail、search 和 confirm。证明没有浏览器工具时，模型仍能通过本地 HTTP/HTML 处理完成 DOM 型任务；它不等于支持真实浏览器的 JavaScript 渲染、登录态、截图或外部网页搜索。

### 3.8 `088-api-contract-mock-client-compat`：真实客户端兼容修复

**实际题目**：阅读 Python client contract 和 sample request；兼容 `/v1/users` page-number 与 `/v2/users` cursor；归一化 user shape，处理 nullable email、429 retry 和 API error envelope；运行 pytest，真实调用 mock API，并写兼容报告。禁止修改 fixtures/tests/mock API。

**结果**：139.381 秒，原始分 0.5。公开 pytest 2/2 通过，真实 local API、实现质量和报告检查通过。

两项失败需要拆开看：

- `fixture_integrity` 为 evaluator 缺陷。三个受保护文件在 source 与 workspace 中逐字节相同，但 oracle 的三个 MD5 都已陈旧；
- `hidden_api_compat` 的隐藏用例把完整的 `/v2/users?cursor=bad` URL 作为 `base_url` 传给 `list_users`。实现按公开合同继续在 base 后追加 endpoint/cursor，形成循环并超时。题面只要求 base URL，没有要求容忍“已包含 endpoint 和坏 cursor 的 base URL”。直接调用内部 `_get_json(bad)` 能正确把 400 转为 `ApiError`。

因此它不能记成整题通过，但也不能用原始 0.5 推断 Praxis 只能完成一半。Runtime 22 turns/29 tools，最大上下文约 32,667，无 compaction/truncation；失败集中在隐藏输入合同和 evaluator。

### 3.9 `093-jsonl-sessionization-analysis`：数据清洗与会话化

**实际题目**：逐行解析 clickstream JSONL；记录 malformed/missing/unknown；排除 bot；按 timestamp 排序；event_id 去重；anonymous login 后进行 identity stitching；超过 30 分钟才开新 session；输出 exact-header CSV、summary、reject ledger 和 notes。

**结果**：57.787 秒，14/16，原始分 0.5918；历史同题约 0.24，本次有明显改善，但这只是单样本信号。

唯一 session 差异是 `U200-2.campaign_source`：模型留空，oracle 期待把更早 session 的 `email` 延续到新 session；题面和 `session_rules.md` 没定义跨 session campaign attribution。summary 中模型给 `excluded_bot_users: 2`，oracle 期待 `['U300']`；题面只列出字段名，没有定义类型。模型看起来也有一次计数错误，因为实际只有一个 bot user/event。归因为题面/Oracle 欠定义并夹杂模型聚合错误。

### 3.10 `096-offline-knowledge-qa-insufficient-evidence`：不编造与负面证据

**实际题目**：只能使用本地 KB 和 questions；每题输出 answered/partial/insufficient_evidence，提供相对 source path、evidence id、signal 和缺失证据；不得用常识补空白。

**结果**：44.184 秒，前 7 项关于格式、覆盖、状态、事实、来源、证据和 missing evidence 全部通过；原始分 0.65，只失败 `no_fabrication`。

**异常归因**：oracle 在整个 answer row 中搜索禁用字符串，因此正确的否定说明或引用（例如“某电话号码从未获批”“临时允许但后来被替代”）也被当成模型采用了禁用事实。这是负面证据扫描器的误报。合同调整后为 1.0。

### 3.11 `099-privacy-dsar-intake-review`：隐私输出边界

**实际题目**：读取 DSAR policy、data map、redaction rules、request packet、账户和 support notes；逐请求给 intake decision、next step、policy clause、eligible systems/retention exception；生成 requester-facing 回复和 redaction audit。任何输出都不得含完整 email、电话、第三方/内部信息，也不得声称删除已经执行。

**首次结果**：40.152 秒，14/15，原始分 0.6。决策、路由、格式、回复语气和“不承诺已删除”等主体都通过；失败项 `no_forbidden_pii` 是真实模型错误：模型在 redaction audit 的解释中写入了题面明确禁止在**任何输出**出现的完整 PII。这里没有 evaluator 歧义，也不是 Prompt/Runtime/compaction 失败。

**当前代表**：后续有效复验运行 161.287 秒，原始分 1.0，全部 oracle 检查通过。旧失败保存在 `.run1-20260823.json`，canonical 文件指向满分运行。它证明该错误在后续 rollout 中已纠正；两次样本仍不足以证明隐私服从具有统计稳定性。

## 4. 为本轮发现做了哪些永久修改

### 4.1 统一并扩大 system Prompt 预算

**问题**：尝试 `baseline-v1` A/B 时，较长 Windows sandbox 路径使 SystemPromptComposer 在 Provider 调用前返回 `PROMPT_BUDGET_TOO_SMALL`。这不是 MiniMax 限流，而是 Praxis 原有 1,536-token 默认预算容不下完整 Prompt。

**修改**：在 `promptRegistry.ts` 增加唯一常量 `DEFAULT_SYSTEM_PROMPT_TOKEN_BUDGET = 4096`，`RuntimeKernel` 和测试都引用该入口，不再在调用点复制数字。4,096 是 Prompt 装配预算，不是任务总 token、上下文或运行寿命上限。

**复验**：现实长 Windows 路径下 baseline/lean Prompt 都能装配；baseline 真实 A/B 能进入 Provider 并完成。专项 system Prompt 测试 12/12 和全 workspace build 通过。

### 4.2 把 shell 方言做成 Runtime facts

**问题**：Windows 模型多次使用 `&&`、`$(pwd)`、`head`，并用 PowerShell 5.1 `Set-Content -Encoding UTF8` 产生 BOM。

**修改**：lean 的 `runtime_facts.workspace.shellDialect` 现在明确给出：

- PowerShell 版本语义 `windows-powershell-5.1`；
- 命令分隔符 `;`；
- 不可用的 POSIX 语法；
- 多行输入使用 shell Tool 的 `stdin`；
- 精确文本优先使用 `write/edit`；必须用 shell 写 UTF-8 时使用无 BOM 编码。

这属于环境事实，不写成高层安全政策，也不会扩大权限。

### 4.3 增加跨任务的最终验收合同

**问题**：`041` 的自测改变了题意，`078/079/080` 均出现“文件写了、自己的检查过了，但没有按用户合同核对真实产物”的情况。

**修改**：baseline 与 lean 1.1.0 都追加同一条通用合同：多要求任务完成前必须重读用户 acceptance criteria，并按任务需要验证 parseability、encoding、schema、exact required headers 和 material semantics；自写测试不能重新定义用户要求。

它没有硬编码任何 benchmark 字段，因此是通用 Prompt 修复。真实 `080` 复验补齐了原先遗漏的 conflicts；`041` 也推进到不同隐藏边界。不过 `078` 说明文字提示不是机械保证，未来如需强保证，应该由 artifact validator/typed output contract 执行，而不是继续堆 Prompt。

### 4.4 没有修改的部分

- 没有为陈旧哈希、CSV 最后一行换行、负面证据误报等 oracle 问题给 Praxis 加特判；
- 没有因为本轮低分修改 compaction，因为没有证据显示它触发或丢失信息；
- 没有强迫 `auto` 每题 spawn Child；委派收益应由模型判断，委派率本身不是成功指标；
- 没有把外层 benchmark timeout 再放宽成 Praxis 产品的隐式永久上限。Praxis 主路径仍支持长任务，runner 应单独配置观察窗口。

## 5. 对 Praxis 当前能力的更新判断

已经有实际证据的能力：

- Windows 本地文件读写、代码修改和测试；
- CSV/JSON/YAML/Markdown/JSONL 结构化处理；
- 本地 REST、page/cursor pagination、429/503 retry、checkpoint recovery；
- 本地 HTML/DOM 与普通表单交互；
- 8 分钟级、54 turns、64 tools、约 1M 累计 cache-read token 的单 Agent 任务；
- Prompt variant A/B、Provider 错误分类、Runtime usage 和上下文观察。

仍未覆盖或不能宣称的能力：

- `003-browser` 和 `006-access-bilibili` 需要真实浏览器/外部网站；当前 Praxis 没有完整 browser/web-search 工具面，因此本轮未把它们作为失败运行。未来补 Web Search 后再测；
- 单次 A/B 不能证明 Prompt 统计显著更优，需要固定模型、题面和环境，多次重复并报告方差；
- `auto` 是否通过 Child 提升任务成功率仍缺配对 benchmark；现有证据只证明 Child 生命周期和 Run Tree 合同可用；
- 本轮不包含 compaction 压力、跨日恢复或多 Worker 高并发，不能用本轮替代已有专项测评。

## 6. 建议下一轮怎样测

1. 修复或版本化 Harness-Bench 的陈旧哈希、负面证据扫描和 hidden input 合同，再对 `023/088/096` regrade，不必重新消耗模型额度。
2. 为 `041/080/093` 做至少 3 次 lean/baseline paired rollout，固定 MiniMax 模型、Prompt 以外的所有配置，比较均值、通过率、token、墙钟和方差。
3. 增加一个 Runtime-owned artifact validator 实验：让 schema/header/UTF-8-no-BOM 成为可调用 verifier，再比较“只有 Prompt”与“Prompt + 机械 verifier”。
4. Web Search/Browser 工具接入后再运行 `003/006`，并区分静态 HTTP、JavaScript 浏览器、登录态和公开互联网四种能力。
5. 若要测 Child 的任务收益，选择可自然拆成独立证据分支的任务，比较 `solo/auto` 多次运行；不要用“是否 spawn”代替最终任务质量。

## 7. 新手术语

- **Harness / Agent Harness**：给模型提供 Prompt、Tool、权限、记忆、恢复和执行循环的框架；Praxis 属于这一层。
- **Benchmark**：一组固定题目和评分规则，用于比较能力。
- **Oracle / Verifier**：读取最终产物并判断对错的程序。它也可能有 bug。
- **Raw score**：未经人工解释、由 oracle 直接给出的原始分。
- **Contract-adjusted score**：只按公开题面语义重新解释后的结果；不能替代 raw score，但能识别 evaluator 误罚。
- **Fixture**：benchmark 提供的输入文件或本地 mock 服务。
- **Hidden test**：模型看不到的测试，防止针对公开样例硬编码；如果它要求题面从未声明的行为，也可能造成合同歧义。
- **BOM**：某些工具写在 UTF-8 文件最开头的三个字节 `EF BB BF`。部分解析器接受，部分精确评分器会拒绝。
- **Compaction**：上下文过长时，把较早内容压成可恢复 checkpoint。本轮有效任务未触发它。
- **Truncation**：直接裁掉内容；与有语义 checkpoint 的 compaction 不同。
- **Cache read tokens**：Provider 从缓存复用的输入 token。它按每轮累计，不能直接和总 input 做简单百分比。
- **Rollout**：模型从收到一道题到结束的一次完整运行。同题重跑是不同 rollout。
- **A/B**：除一个变量外其他条件尽量相同的对照实验；本轮 baseline/lean 单次对照只能提供线索，不能给统计结论。
- **Subagent / Child**：Root 动态创建的独立 AgentTask。Runtime 负责其生命周期、等待和结果；模型不需要先写完整 DAG。

## 8. 证据索引

| 证据 | 路径 |
| --- | --- |
| 本轮 Harness 原始结果 | `D:\agent-evals\results\harnessbench\praxis-auto-minimax\unknown-api\<task-id>.json` |
| 保留的 lean 079 | `...\079-smallfile-batch-reject-ledger.lean-20260823.json` |
| 保留的 lean 080 | `...\080-schema-roundtrip-conversion.lean-20260823.json` |
| 保留的 lean 041 | `...\041-frontend-state-bug.lean-20260823.json` |
| 保留的 baseline 041 | `...\041-frontend-state-bug.baseline-20260823.json` |
| 保留的 093 Prompt 前样本 | `...\093-jsonl-sessionization-analysis.pre-prompt-1.1.json` |
| 逐字题面 | `D:\agent-evals\sources\harness-bench\tasks\<task-id>\prompt.txt` |

结果目录不在 Praxis Git 仓库中。归档或清理磁盘时，应让本文、原始 JSON、sandbox 产物和 evaluator 版本一起保存，否则以后只能看到结论，不能复核证据。
