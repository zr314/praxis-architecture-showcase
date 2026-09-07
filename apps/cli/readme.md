# CLI 源码导航

English summary: terminal presentation and transport, not model or tool execution.

CLI 通过 NDJSON JSON-RPC 连接独立 Runtime。它拥有启动、连接、用户输入和渲染；Provider、权限决定、Tool 和执行恢复属于 Runtime。

| 入口 | 责任 |
| --- | --- |
| src/cli.tsx | 命令入口 |
| src/runCli.tsx | 参数、模式和启动编排 |
| src/bridge/localRuntime.ts | Runtime 启动选择 |
| src/bridge/childProtocolConnection.ts | 子进程字节传输和关闭 |
| src/bridge/ndjsonBridge.ts | 高层协议操作 |
| src/render/nonInteractive.ts | print 模式和退出结果 |
| src/ui/App.tsx | TUI 组合与交互 |
| src/ui/tuiModel.ts | UI 状态与事件处理 |
| src/ui/useSessionHistory.ts | 持久历史读取 |
| src/ui/useWorkflowGraph.ts | 查询并展示执行 projection |

完整命令不在此重复，见[CLI 参考](../../docs/cli-reference.md)。全部 RPC/Event 与重连边界见[前端通信](../../docs/frontend-runtime-communication.md)。

/plan 查询 Session 的当前 Working Plan/严格状态及相关执行信息；UI 不能只按旧 steps/state 解析，轻量清单使用 items/status。普通 Item blocked 与 prompt_blocked 是两回事。

流式文本不是已提交终态；必须区分 prompt_completed、prompt_failed、prompt_blocked 和 prompt_aborted。stderr 是诊断，stdout 是协议，不能将普通日志写入协议流。

Composer、Transcript 与 Spinner 分离，历史窗口化渲染；UI 缓冲不等于 Session Journal。断线恢复以 Runtime 查询和持久记录为准，不靠屏幕内存猜测执行结果。

新增接口时按[协议](../../docs/protocol.md)同步类型、Schema、Runtime handler、client 和 UI；CLI 不得绕过 Runtime 直接执行工具。
