# Praxis 文档中心 / Documentation

本文档中心按“你现在要完成什么”组织，而不是按代码目录堆文件。中文是主要教学语言；类型名、命令、
Schema、错误码和必要英文摘要保留原文，避免产生第二套技术合同。

## 我想先看懂整个项目

如果你是第一次接触 Agent Runtime，建议先读[模块地图](module-map.md)。它从一次 Prompt 的生命周期出发，解释顶层目录、七个 Workspace、Runtime 全部源码域、CLI 模块、公共包和常见纵向改动路径。想集中理解执行与记忆主链路，再读
[Praxis 当前分层架构](planner-prompt-context-storage-guide.md)；其中为新手解释了
Planner、Workflow、ContextView、Checkpoint、Authority、Journal 和 Lease 等术语。

最短阅读顺序是：

1. [根 README](../README.md)：知道产品能做什么；
2. [模块地图](module-map.md)：知道代码放在哪里、为什么这样分层；
3. [Praxis 当前分层架构](planner-prompt-context-storage-guide.md)：按模块层次理解一次 Prompt 怎样规划、
   执行、装配、压缩、落盘和恢复；
4. [当前架构](architecture.md)：知道已经接入的运行链路；
5. [项目状态](project-status.md)：区分已交付、条件可用和未提供；
6. [最终小样本测评](evaluation-final-2026-08-09.md)：区分架构能力与工业级证据。

## 我第一次使用 Praxis

按这个顺序阅读：

1. [根 README](../README.md)：项目全功能地图、边界和十分钟上手；
2. [详细快速开始](quickstart.md)：逐条命令、预期结果和第一次安全任务；
3. [Provider 配置](provider-setup.md)：API key、模型、区域端点和隐私；
4. [CLI 参考](cli-reference.md)：全部命令、Slash Command、按键、退出码和环境变量；
5. [会话恢复](session-recovery.md)：如何查找、恢复、派生、导出和删除会话；
6. [工具与权限](tool-policy.md)：允许一次、持久规则、文件修改和 Shell 风险；
7. [故障排查](troubleshooting.md)：从症状到命令的排查路径。

不知道从哪里开始时，只需要先完成前两项。

## 我想写 Skill、Prompt 或插件

- [插件系统](plugin-system.md)：安装、启用、健康、能力快照、隔离与信任边界；
- [插件开发](plugin-authoring.md)：从 manifest 和最小示例开始；
- [`examples/resources`](../examples/resources)：Prompt、Skill、Theme 示例；
- [`examples/plugins`](../examples/plugins)：MCP server、process Tool、process Provider 示例；
- [Prompt 与上下文](prompt-assembly.md)：当前 Prompt variant、最终装配顺序、cache 与 compaction 规范；
- [兼容性策略](compatibility-policy.md)：版本和 Schema 兼容边界。

## 我想编写自己的客户端

- [Runtime 协议 v1](protocol.md)：initialize、订阅、会话、Prompt、事件和安全规则；
- [协议客户端教程](protocol-client.md)：如何使用 `@praxis/client`；
- [`@praxis/protocol`](../packages/protocol)：类型、JSON Schema 和协议版本；
- [`@praxis/client`](../packages/client)：连接状态机、序列、replay 与重连。

## 我想修改 Runtime

- [模块地图](module-map.md)：七个 Workspace、Runtime/CLI 全部源码域和常见改动路径；
- [当前架构](architecture.md)：进程、权威、组合根、存储和能力边界；
- [Praxis 当前分层架构](planner-prompt-context-storage-guide.md)：面向新手的 Runtime 分层与完整主链路导读；
- [统一 Workflow 与多 Agent](workflow-platform.md)：当前已经接入的 `auto`、Root wait/continue、持久 mailbox、Child 和写隔离；
- [Planner Platform RFC](planner-platform-rfc.md)：长期 HumanTask、远程 Worker、PostgreSQL 与分布式目标（已交付与部署提案会显式区分）；
- [Runtime 源码总览](../apps/runtime/readme.md)：新手代码阅读地图；
- [内核与 AgentLoop](../apps/runtime/docs/01-kernel-and-loop.md)；
- [会话、Prompt 与上下文](../apps/runtime/docs/02-session-memory-prompt.md)；
- [Provider 与路由](../apps/runtime/docs/03-providers-and-routing.md)；
- [Tool、Policy 与安全](../apps/runtime/docs/04-tools-policy-security.md)；
- [扩展、MCP 与 Subagent](../apps/runtime/docs/05-extensions-plugins-subagents.md)；
- [Trace、Evaluation 与运维](../apps/runtime/docs/06-trace-evaluation-operations.md)；
- [CLI 源码导读](../apps/cli/readme.md)；
- [Monorepo 指南](monorepo.md)。

## 我想贡献、审计安全或发布

- [贡献指南](../CONTRIBUTING.md)：第一次本地开发、测试策略和变更清单；
- [Monorepo 指南](monorepo.md)：七个 Workspace、依赖方向和发行合同；
- [安全策略](../SECURITY.md)与[威胁模型](security-threat-model.md)：私下报告和实际信任边界；
- [兼容性策略](compatibility-policy.md)：Protocol、Session、Plugin 与平台支持；
- [CHANGELOG](../CHANGELOG.md)：已发布版本和当前 Unreleased 变化；
- [Verdaccio 运维](../infra/verdaccio/README.md)：Windows 私有 Registry 启动、备份和恢复。

## 当前状态与长期决策

- [项目状态](project-status.md)：唯一的“现在可用 / 条件可用 / 内部组件 / 未提供”功能表；
- [最终小样本测评与优化总结](evaluation-final-2026-08-09.md)：三 benchmark、长任务、compaction/cache、MiniMax、永久修复和证据边界；
- [统一 Workflow 与多 Agent](workflow-platform.md)：当前执行入口、Child/Subagent、Task/Lease、隔离写入与恢复；
- [安全威胁模型](security-threat-model.md)：信任边界、隔离声明和非目标；
- [架构决策记录](adr/README.md)：已经接受、长期有效的决策；
- [Supervisor 名称迁移](supervisor.md)：旧 `direct/supervisor` 名称怎样映射到当前 `solo/workflow`；
- [兼容性策略](compatibility-policy.md)：协议、存储和插件版本演进。

## 审计材料与历史执行证据

- [Prompt 审计索引](prompt-audit/README.md)：Praxis、Pi 与 Claude copy 的 Prompt/装配对照、优化台账和后续上下文研究；
- [最终小样本测评](evaluation-final-2026-08-09.md)：当前统一结论和证据索引；
- [架构决策记录](adr/README.md)：仍然有效的长期设计决策。

审计台账记录当时的输入、版本和结论，不是当前产品功能表。遇到表述冲突时，以 `project-status.md`、current architecture 和现行合同/测试为准。

已完成的实施计划、超长 TODO 和阶段路线图不再放在当前文档树中。它们仍可从 Git 历史恢复，但不会与
当前产品事实竞争权威。

## 文档类型

| 类型 | 回答什么 | 例子 |
| --- | --- | --- |
| 用户指南 | “我怎样完成任务？” | quickstart、provider、session、troubleshooting |
| Reference | “精确命令/字段是什么？” | CLI、protocol、tool policy |
| Current architecture | “现在代码怎样工作？” | architecture、plugin system、源码导读 |
| Module map | “目录、包和源码域分别负责什么？” | module-map、monorepo、源码导读 |
| Design RFC | “目标架构准备怎样演进？” | planner platform RFC；必须显式标注为提案 |
| ADR | “为什么长期选择这个方向？” | `docs/adr/` |
| Status | “已交付还是内部组件？” | project status、workflow platform |

## 维护规则

1. 先改代码和合同，再改 current 文档；文档不能承诺尚未接线的行为。
2. 用户可见命令以真实 `praxis --help` 和测试为准。
3. 类型、RPC、环境变量、错误码和路径保持英文原名。
4. 新手指南解释“为什么、预期看到什么、失败怎么办”，Reference 不复制长教程。
5. 一个事实只有一个权威入口；历史实施计划留在 Git 历史，不保留在当前导航。
6. 新增、移动或删除文档时必须修复全仓本地链接并运行文档合同测试。

## English summary

Documentation is organized by reader task: onboarding, operation, extension
authoring, client integration, Runtime development, status, and durable ADRs.
Chinese is the primary teaching language; commands, types, schemas, error
codes, and concise English summaries retain exact technical vocabulary.
Completed implementation plans and oversized backlogs live in Git history,
not in the current documentation authority tree.
