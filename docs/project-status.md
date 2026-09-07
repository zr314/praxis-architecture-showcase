# 项目状态

核对日期：2026-09-06。English summary: source-wired capabilities and explicit limitations, not a benchmark leaderboard.

本页判断代码是否已接入产品路径。真实题目、成功率、Token 和故障复验统一见[测评档案](evaluations/README.md)。

## 已接入产品路径

| 领域 | 当前能力 |
| --- | --- |
| 接入 | 独立 Runtime、NDJSON JSON-RPC、Ink TUI、非交互输出、Agent SDK |
| 主循环 | 默认 auto；Root 自主 ReAct，可按需建立 Working Plan 或派 Child；solo 禁止 Child |
| 轻量计划 | 五个 plan.* Tool；清单持久、可动态更新/重开/放弃；done 自报，不要求最终 Review |
| 咨询审查 | advisory-v1 独立 Prompt/Schema；原始任务 + 配对 Tool 参数/结果，冻结快照，unavailable 不阻断 optional |
| 严格验收 | 显式 required 的 ReviewPlan、Item Attempt、执行绑定、证据冻结、检查器和 final gate |
| Child | 真实独立进程/Session，spawn/wait/result/cancel/steer，all/any/quorum，结构化结果与 Artifact |
| 授权 | Capability Bundle 求交、签名 bootstrap、credential broker、父级外部 Tool broker |
| 写隔离 | Git detached worktree + 候选校验合并；非 Git 目录快照 + 基线摘要和受控回写 |
| 执行持久化 | SQLite Task/Lease、Node/Attempt、mailbox、effect reservation/receipt、执行快照、预算 |
| 调度恢复 | durable Worker、Provider-aware capacity、过期 Lease 接管、安全重试和 unknown 分流 |
| Legacy Workflow | 显式 workflow 的 DAG、条件、join、无环展开 loop、非递归 subworkflow、HumanTask/Timer |
| Session | SessionJournalV3 JSONL 或 SQLite 单权威，恢复、分支、离线迁移、Projection 快速启动 |
| 长期记忆 | opt-in 本地 SQLite、项目隔离/user 读取白名单、显式授权写入、CAS/回执、有界召回、删除后保守阻止旧 Session 重放；见[使用合同](long-term-memory.md) |
| 上下文 | iron-law-lean-v1 1.3.0、逐字任务保护、动态 Plan、Run-stable ContextView、Provider-only editing |
| Compaction | portable semantic checkpoint；适用 OpenAI Responses 路径可叠加精确绑定 native state |
| 扩展 | Skills、已安装获准的 MCP stdio、Process Tool/Provider、插件生命周期 |
| 观测 | Session/Run/Workflow/Tool/Provider Trace、usage、Artifact、doctor、协议终态 |

auto/solo/legacy workflow 共用执行底座；optional Working Plan 与 required ReviewPlan 是不同工具合同，不能只看工具名判断。`workflow + required` 被入口拒绝，避免没有对应工具却要求验收。

ReviewCallStore 单独保存辅助模型尝试、已知 usage 与有界脱敏诊断，旧在途冻结合同仍按旧解析器恢复。格式有效和兼容 accepted 标签不等于题目正确。完整 Reviewer 请求见[请求目录](model-request-catalog.md)。

## 稳定 Tool closure

可用的 write/edit 支持 expectedDigest：真实写入前检测 TOCTOU，不覆盖检查后被其他人修改的内容。createOnly、whole-file edit、分页 read、Shell stdin 和错误码以[Tool Policy](tool-policy.md)为准。

默认长期运行不隐式限制累计 turns/tools/tokens/墙钟或 Child 总数；显式预算仍执行。资源并发、上下文窗口、单次输出、权限和审查有限重试不能取消，否则会把长任务支持误变成失控执行。

## 当前明确未完成

- Child 仍固定 solo，不能递归 spawn；不能宣称任意深度 Run Tree 已交付。
- 没有公共 Web Search、完整 JavaScript 浏览器或登录态网站自动化产品入口。
- 长期记忆没有自动提炼、跨 key 语义冲突识别、文件/环境适用条件验证、远程共享或全副本擦除；会话 checkpoint 仍不是长期记忆。后续见[路线图](long-term-memory-roadmap.md)。
- MCP 只接线本地 stdio；远程 Streamable HTTP、OAuth 生命周期和远程连接治理未完成。
- OS 沙箱并未覆盖所有执行路径：内置 Shell/MCP stdio 直接启动进程；Linux Process 插件后端需 bubblewrap/prlimit，缺失时拒绝启动；Windows/macOS 默认 trusted-only。工作区隔离不等于进程沙箱，见[威胁模型](security-threat-model.md)。
- 没有 PostgreSQL authority、多租户公平配额/持久分布式熔断、高可用通知和工业级 SLA。认证远程 Authority 是单写入点协议。
- 自动补偿仍依赖具体连接器和 Host 处理，已有账本不代表可对任意外部系统自动补偿，也不承诺 exactly-once。
- 没有默认按需 Tool Search、Anthropic 服务端 compaction/thinking clearing 或显式 cache blocks 的完整产品接线。
- 严格 ReviewPlan 的远程 unknown-effect 受信 resolution、全部 checker、所有跨库/Child reconciliation 窗口仍不能宣称完整产品化；未接线 checker 失败关闭。
- 没有全量固定构建的多随机种子质量结论、规模化重复崩溃统计或长期线上评测控制面。单次通过不能推出普遍可靠性。
- 动态 Plan 位于稳定 ContextView 之前，修改可影响缓存前缀；这属于当前装配取舍。
- 模型 Reviewer 可能把错误实现判为支持原题；Schema、receipt 和冻结输入只能提高可审计性，不能保证语义判断。

未完成项是边界说明，不是未来实施承诺。当前操作合同见[架构](architecture.md)、[Working Plan](working-plan.md)、[严格 ReviewPlan](strict-review-plan.md)。

## 验证与维护

普通 CI：`npm ci → npm run check → npm test → npm run build`。发布、原生构建和供应链检查保留专用 workflow。`npm run install:local` 用于本地更新安装，不是普通 CI 的额外阶段。

完整测试包含 Runtime/PTY 进程，超时或跳过不得写成通过。具体日期和计数记录在测评或变更记录，不在能力表里长期复制一个会失效的数字。

源码 Child 与顶层测试通过 `tsconfig.source.json` 共用公共包映射，避免新增导出后混用旧 `dist`。无构建输出和陈旧导出场景有进程回归；完整 clean checkout 的 CI 仍以实际 CI 结果为准，详见[贡献指南](../CONTRIBUTING.md#开发循环--development-loop)。
