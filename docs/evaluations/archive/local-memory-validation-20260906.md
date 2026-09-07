# 本地长期记忆：合同与进程验证

日期：2026-09-06。English summary: deterministic local contract and process validation, not a real-model memory-quality benchmark.

## 范围与结果

验证对象是本轮工作区源码中的 M0/M1 显式长期记忆。测试使用临时 PRAXIS_HOME 和 Mock Provider；未安装新构建、未修改真实记忆配置、未运行 D:\agent-evals 的公开 benchmark，也没有调用付费模型。

最终相关回归（包含文档合同）结果：**86 passed / 0 failed / 0 skipped**。TypeScript `--noEmit`、本轮修改代码的 Biome lint/format 检查通过。终端测试输出是本轮执行依据，未另存原始日志或冻结构建 hash；后续源码变化须重新执行，不能将此记录视为不可变构建认证。

补充执行 Client、Agent SDK、SessionService 和 CLI 退出码回归：**47 passed / 0 failed / 0 skipped**。与上面不同测试文件合计 133 项；不是完整仓库测试套件。

最后将进程测试的写入会话切到默认 `auto`，重新执行 JSONL/SQLite 两项均通过，确认记忆授权写入不只在 solo 模式可用。这个复验不重复计入 133 项。

```powershell
node node_modules/typescript/bin/tsc --project tsconfig.check.json --noEmit --pretty false
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.check.json --test --test-concurrency=2 test/long-term-memory.test.ts test/long-term-memory-runtime.test.ts test/protocol.schema.test.ts test/working-plan.test.ts test/system-prompt.test.ts test/context-management-v2.test.ts test/review-plan-root-tool-binding.test.ts test/workflow-effect-request-binding.test.ts test/trace.test.ts test/documentation-contract.test.ts
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.check.json --test --test-concurrency=2 test/client-v2.test.ts test/agent-sdk.test.ts test/session-service.test.ts test/cli-exit-codes.test.ts
```

## 实际验证了什么

| 层级 | 证据与覆盖 |
| --- | --- |
| 存储/身份 | [合同测试](../../../test/long-term-memory.test.ts)：重启、默认 off、跨项目 by-ID 拒绝、user scope 授权、独立连接 CAS、幂等、原子 import、分页 export、Git worktree/clone、非 Git 子目录/rebind |
| 安全/上下文 | 同文件：权限询问、调用身份绑定、秘密模式过滤、过期、删除/fork/重启撤销、低权限转义、Token 上限、Trace 不带正文 |
| 故障持久性 | 子进程开启未提交 SQLite 写事务后突然退出；重开验证未提交内容未留下，不假装等价于断电/磁盘故障测试 |
| 真实 Runtime 进程 | [进程测试](../../../test/long-term-memory-runtime.test.ts)：分别使用 JSONL/SQLite Session 后端，关闭再启动进程，新 Session 实际 Provider 请求出现记忆；另一项目不出现；删除后旧会话/fork 被阻止，新会话不召回 |
| 产品入口 | 同进程测试：默认 auto 模式下，确定性模型调用 memory.upsert，实际 Host permission 回应后才保存；源码 CLI 依次执行 status/mode/put/list/forget |
| Plan 与协议回归 | memory 写入走独立授权/事务，不作为严格 Plan 的工作区执行证据；既有 Working Plan、上下文、协议 schema 和 Trace 回归 |

新增记忆测试共 22 项（19 项合同/单元 + 3 项进程/CLI）；86 项总数包含既有相关回归和文档检查，不应全部宣传为新记忆场景。

## 边界与后续

没有证明：真实模型会正确应用记忆、任务成功率提升、语义冲突识别、完整隐私擦除、Child 自动继承或自动提炼质量。删除采用阻止已暴露旧会话继续发送的保守方案，原始日志与外部副本不改写。

后续应按[路线图](../../long-term-memory-roadmap.md)做固定模型的多 Session 配对实验，分别记录 memory off 与 explicit 的最终任务行为、错误旧经验、纠正/遗忘和费用。使用合同见[本地长期记忆](../../long-term-memory.md)。
