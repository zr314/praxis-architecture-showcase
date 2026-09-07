# 扩展与 Child 源码导航

English summary: extensible tools and instructions with attenuated child capabilities.

| 源码域（apps/runtime/src 下） | 作用 |
| --- | --- |
| extensions/ | 资源发现、Skill、Prompt 和 MCP/Process activation |
| plugin/ | 安装、清单、授权与生命周期 |
| subagent/ | ChildRuntimeHost、bootstrap、认证、凭据和结果协议 |
| workflow/agentRunTreeTools.ts | 默认 Root 的 spawn/wait/result/cancel/steer |
| workflow/localWorkflowAgentWorker.ts | 将获准 Task 转成 Child 执行及结果合并 |

Skills 是按需加载且带 digest 的指令资源；MCP stdio 是 JSON-RPC 工具服务，激活后的工具走同一个 ToolRuntime。发现、启用、工作区授权是不同步骤，发现不等于能调用。远程 MCP HTTP/OAuth 不是当前已接线能力。

Child 就是 Subagent，不需要一套单独的 coder/reviewer 执行器。角色说明和配置可不同，实际能力由父 grant、Profile 和请求求交；当前 Child 不能再派 Child。

Root 不自动接收全部 Child 对话，只通过持久生命周期、消息和 Artifact 结果协作。Git worktree 与非 Git 目录快照都要父级校验后合并。

详细协议和示例见[插件系统](../../../docs/plugin-system.md)、[插件开发](../../../docs/plugin-authoring.md)及[Child 与 Workflow](../../../docs/workflow-platform.md)。
