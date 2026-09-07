# Project recap：实验入口验证

日期：2026-09-06。English summary: deterministic integration evidence for a new project-recap experiment harness; no live-model learning claim.

## 已验证范围

独立 recap 模块、Host 指定工作区注入、none / compact / recap / structured 对照与共享快照消融已接线。实验设计、题目限制及命令见[实验说明](../../research/project-recap-experiment.md)。本次没有启动付费真实模型测评，不记入公开 benchmark 成绩。

| 检查 | 结果 |
| --- | --- |
| 全量 `npm test` | 1172 tests：1167 pass、5 skip、0 fail；322.4 秒 |
| 最后补充的公开消息投影与 reasoning canary，复跑 `project-recap.test.ts` | 5 pass、0 fail；21.9 秒 |
| 最终 `npm run check` | format、lint、typecheck 全部通过 |
| 最终 `npm run build` | 退出码 0 |
| 最终 `eval:recap --mode smoke --omit failure` | 5 个 trial 全部 completed 且正确写出 transport marker |

全量回归之后对实验脚手架补充了公开 transcript 投影、过滤 thinking_delta、遇到 transcript 获取错误时标记 infrastructure_error，以及 Mock reasoning canary；相关 5 项测试和最终 smoke 已在这些改动后重新运行。其余 Runtime 接线由前述全量回归覆盖。

smoke 真实创建进程、Session、隔离目录和 Runtime 工具调用；测试断言实际请求中的 recap digest 与 manifest 一致、目标输入 digest 相同、structured 与消融共享快照、工具能力受限，私有 reasoning 标记不进入导出的 episode/events。Runtime 自己的 Session 存储仍遵循原有持久化合同。

5/5 仅说明脚手架运行正确。Mock 固定输出，不能证明模型正确理解记忆，也不能据此声称准确率或效率提高。

## 证据位置

- 最终可检查样例：仓库根目录 `artifacts/recap-smoke-20260906/results.json`，同目录含 manifest、探索前缀、快照、逐组事件及真实装配记录。
- 回归日志：`.tmp/recap-full-tests.log`、`.tmp/recap-tests-final.log`、`.tmp/recap-check-final.log`、`.tmp/recap-build.log`、`.tmp/recap-smoke-final.log`。
- 历史选题证据：`artifacts/recap-development-20260906/candidate-selection.json`，记录外部 result.json 路径及 SHA-256；只用于筛选 KV 和榜单两类候选。

开发期曾发现脚手架拒绝了写答案权限，后改为只批准当前 workspace 的 answer.json，并在工具执行层限制输入只读。增加 reasoning canary 时也曾构造不完整的 Mock stream，Runtime 按协议拒绝；补全 start/end 后复验通过。失败样例保留在开发产物目录，不混入最终 5/5。

下一阶段先跑一个项目、一次重复的 live pilot，检查实际笔记注入和总费用，再增加独立任务；当前不存在真实模型效果数字。
