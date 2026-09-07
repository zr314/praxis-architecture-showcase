# Harness 审计发现的两项实现缺陷与修复

日期：2026-09-06。English summary: reproducible source-launch and workspace-effect fixes, not a model-quality benchmark.

## 范围

本次在 Windows / Node.js 24.13.1，基于已有大量未提交修改的工作区进行源码审查。HEAD `a25770b` 不包含全部被审计内容；最终源码摘要见[证据清单](../../research/harness-audit-evidence-20260906.json)。没有调用真实模型、运行新的公开 benchmark、改全局安装或发布。既有原始测评的只读复核见[调研报告](../../research/harness-landscape-20260906.md)。

## 1. 源码 Child 加载旧公共包导出

**现象：** typecheck 通过，但真实 Child、Skill/MCP 进程用例报 `CHILD_RUNTIME_EXITED`。直接启动日志为 `@praxis/core-sdk` 没有 `isMemoryToolNameV1` 导出。

**根因：** 顶层测试使用 `tsconfig.check.json` 的源码 paths，`node --import tsx` Child 默认读取根配置，旧根配置没有这些映射，于是落入 Workspace 的陈旧 `dist`。

**复现与修复：** 构建后原失败用例通过，确认与模型无关；新增临时项目进程测试，在没有 dist 时稳定失败。将源码映射集中到 `tsconfig.source.json`，根/检查配置共同继承；无 dist 和旧导出两种场景均通过。没有改变发布包的 Workspace exports，没有扩大 Child 的环境继承权限。

**源码：** [source config](../../../tsconfig.source.json)、[root config](../../../tsconfig.json)、[check config](../../../tsconfig.check.json)。[进程回归](../../../test/source-process-resolution.test.ts)及 Child/MCP/依赖/CI 相邻回归共 40 项通过。

## 2. 新写入被误当成旧写入重试

**现象：** 同一 Workflow 将文件写为 A，再改为 B，最后再次写 A；第三次 Tool 返回成功，但文件实际仍为 B。

**根因：** `WorkflowEffectBroker` 为工作区写入自动生成 `workspace-<tool/input digest>` 键。后来的相同内容复用了第一次成功回执，将新的操作误判为重试。修复前全套测试通过也没有发现这个缺口。

**复现与修复：** 两项真实文件测试分别覆盖有/无 invocation，修复前均在最后一步读到 B。自动键现绑定 Runtime invocation；同调用重试可重放，相同身份不同输入仍拒绝，新调用参数相同也正常执行。缺少调用身份的内部入口产生新键，显式外部 idempotencyKey 行为不变。

**源码：** [EffectBroker](../../../apps/runtime/src/workflow/workflowEffectBroker.ts)、[回归测试](../../../test/workflow-effect-broker.test.ts)。相关 effect/SQLite/严格绑定/调用身份回归共 25 项通过；与完整测试重叠，不重复累计。

旧 receipt 保留，不通过历史内容摘要自动认领新调用，也不补造旧 invocation。跨系统 exactly-once、所有升级恢复窗口与真实模型任务成功率不在本次证明范围内。

## 3. 本地执行记录

- 修复前，重新构建后的完整测试为 1164 项：1159 通过、5 跳过、0 失败。
- 两项修复都有先失败、后通过的专项回归。
- 最终完整复跑为 1167 项：1162 通过、5 跳过、0 失败。上一轮曾有一次 Windows Journal 锁文件 `EPERM`，该用例单独与全套复跑均通过，根因尚未定位。
- 修复后 `npm run check`、`npm run build` 和 15 项文档合同检查通过；完整测试及 Windows Journal 锁文件偶发失败记录见[调研报告验证段](../../research/harness-landscape-20260906.md#8-本次执行验证与文档修订)。

原始终端日志保存在本地 `.tmp/harness-audit-20260906/`：`child-repro.log`、`child-repro-built.log`、`source-fix-tests.log`、`effect-repro.log`、`effect-fix-tests.log`、`tests-final.log`、`tests-final-repeat.log`、`dag-recheck.log`、`check-final.log`、`build-final.log`、`documentation-final.log`。这些日志不是公开原始数据归档，源码变更后需要重新验证。
