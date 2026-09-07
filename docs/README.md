# Praxis 文档

以当前代码为准，最后核对：2026-09-06。English summary: current behavior, source references, and versioned evaluation evidence.

只想理解新 Planner：先读[Working Plan](working-plan.md)，再读[当前架构](architecture.md)。默认是自主 ReAct + 可选动态清单 + 咨询 Review，不是必须先设计 DAG，也不是默认严格验收。

## 1. 使用指南

最新研究记录：[固定历史与操作经验机制实验](evaluations/archive/project-memory-mechanism-20260906.md)。包含真实 MiniMax 对照、提炼失败、成本及经验语义错误；未证明稳定收益。

| 文档 | 回答的问题 |
| --- | --- |
| [快速入门](quickstart.md) | 怎样安装、登录、开始和恢复会话？ |
| [Provider 配置](provider-setup.md) | 模型、凭据、默认选择与环境变量放哪里？ |
| [CLI 参考](cli-reference.md) | 命令、参数、TUI 操作和退出码是什么？ |
| [Session 恢复](session-recovery.md) | 两个存储后端、分支、迁移和 doctor 怎样用？ |
| [本地长期记忆](long-term-memory.md) | 怎样启用项目记忆、纠正、删除和控制跨项目偏好？ |
| [故障排查](troubleshooting.md) | 怎样区分模型、网络、工具和 Runtime 错误？ |
| [Tool 权限](tool-policy.md) | 文件和 Shell 的参数、审批与安全约束是什么？ |
| [插件开发](plugin-authoring.md) | 怎样安装、授权和编写扩展？ |

## 2. 架构与源码阅读

推荐按前四页顺序阅读；不用一次读完全部源码。

| 文档 | 唯一职责 |
| --- | --- |
| [名词表](runtime-glossary.md) | 新手术语和容易混淆的概念 |
| [当前架构](architecture.md) | 组件、进程、状态的归属 |
| [Working Plan](working-plan.md) | 默认 optional 计划和 advisory Review 合同 |
| [运行全链路](agent-runtime-lifecycle.md) | 一次 Prompt 从开始到终态和恢复 |
| [Prompt 装配](prompt-assembly.md) | 固定指令、动态数据、缓存与 compaction 规则 |
| [模型请求目录](model-request-catalog.md) | 当前代码中的精确 Prompt 与请求结构，包括未接线兼容入口 |
| [Child 与 Workflow](workflow-platform.md) | Run Tree、授权、等待、工作区隔离及 legacy 图接口 |
| [严格 ReviewPlan](strict-review-plan.md) | 仅 Host 显式 required 的验收约束，不是默认模式 |
| [模块地图](module-map.md) | 包、源码目录与改动落点 |
| [项目状态](project-status.md) | 已实现和未实现的能力，不复述测试分数 |
| [Runtime 源码导航](../apps/runtime/readme.md) | 按调用链进入具体实现 |
| [CLI 源码导航](../apps/cli/readme.md) | 交互和 Bridge 的实现入口 |

## 3. 接口、扩展与维护参考

- [Agent SDK](agent-sdk.md)、[Runtime middleware](runtime-middleware.md)。
- [协议总览](protocol.md)、[协议客户端](protocol-client.md)、[前端通信全表](frontend-runtime-communication.md)。
- [插件系统](plugin-system.md)、[安全威胁模型](security-threat-model.md)。
- [Monorepo 与发布](monorepo.md)、[兼容策略](compatibility-policy.md)、[贡献指南](../CONTRIBUTING.md)、[安全报告](../SECURITY.md)。

## 4. 测评记录

[测评索引](evaluations/README.md)管理已通过题目、平台实验、运行总账、问题处理和带日期报告。这里保留历史题目原文、分数及失败过程；不同模型、构建、策略和任务版本不能混算。

旧设计草案、旧 Prompt 审计副本和被取代的路线图已从仓库移除。当前架构规则不再另存一份“历史设计”供读者猜测哪个有效。

## 5. 调研与后续设计

源码审计与外部框架对比见[2026-09-06 Harness 调研](research/harness-landscape-20260906.md)。它是带日期的研究判断，区分当前工作区、历史测评和官方滚动文档，不替代产品操作合同。

- [长期记忆路线图](long-term-memory-roadmap.md)：本地显式记忆的阶段状态与后续自动提炼/检索计划；当前操作合同见上面的本地长期记忆页。
- [同项目经验继承实验](research/project-recap-experiment.md)：独立 recap 模块、四组对照、共享快照消融与运行命令；[首轮真实 pilot](evaluations/archive/project-recap-live-pilot-20260906.md)未观察到净收益，并发现空消融问题。
- [MiniMax 新题型实验](evaluations/archive/project-recap-minimax-transfer-20260906.md)：已用 Token Plan 执行事务恢复、批处理与日志边界场景；区分任务错误、提炼失败及超预算未注入。
- [原文摘录记忆与新题复验](evaluations/archive/project-recap-extractive-20260906.md)：异步 cleanup 和约束排程，记录提炼接口简化、读回过滤、题面歧义与分批对照。
- [冻结策略后的错题型扩展](evaluations/archive/project-recap-frozen-expansion-20260906.md)：堆分配、HTML 片段和闭包求值，固定 extractive-v2 后对照无记忆。
- [取消执行预算后的复验](evaluations/archive/project-recap-unlimited-20260906.md)：40 个配置、G-code/字节序新题、无执行上限与记忆候选数量门槛修复。

## 文档维护规则

- 行为改变时更新其唯一职责页；其他页面用链接引用，不复制长篇规则。
- 源码是行为依据，Schema 是输入输出合同，测试是特定条件下的证据；三者不能互相代替。
- 当前页面不堆积“某日补充”或已经结束的迁移计划。保留兼容行为时明确入口和适用条件。
- 数字成绩、Token 和缺陷修复经过放入测评目录；未完成的实验不得写为通过。
- Prompt 文本以源码为准，修改后同步模型请求目录；不要通过改文档宣称已经改了模型行为。
