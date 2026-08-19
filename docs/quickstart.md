# Praxis 新手快速入门

这份指南假设你第一次使用命令行 Agent。完成后你会知道怎样安装、登录、开始对话、让 Agent 修改代码、选择 `auto/solo/workflow`、恢复 Session、切换 JSONL/SQLite，并在出错时找到证据。

## 1. 先理解两个进程

执行 `praxis` 后会出现 TUI，但真正的模型和工具运行在独立 Runtime 进程中：

```text
你的键盘 -> CLI/TUI -> NDJSON JSON-RPC -> Runtime -> Provider/Tool/Storage
```

这样做的好处是：TUI 重绘不会阻塞模型；Runtime 可以统一持久化、审批和恢复；Child Agent 也能复用同一套正式 Runtime。

## 2. 安装

确认版本：

```powershell
node --version
npm --version
git --version
```

Node.js 必须至少为 20。然后：

```powershell
git clone https://github.com/uestc-Praxis/praxis.git
cd praxis
npm install
npm run build
npm run install:local
praxis --version
praxis --help
```

如果 `praxis` 找不到，关闭并重新打开终端，再执行 `npm prefix -g` 检查 npm 全局命令目录是否在 PATH。

## 3. 配置 Provider

以 Kimi 为例：

```powershell
praxis auth login kimi
```

按提示输入 API Key。凭证保存在用户 Praxis 目录的加密存储中，不写入项目。进入 TUI 后也可执行：

```text
/login
/login kimi
/models
/model
/session
```

如果某个模型持续返回 429，先换模型确认。Praxis 会把 429 与暂时性 5xx 标记为可重试错误，但不会无限重试。
可以用 `praxis model current` 检查非交互模式将采用的模型。

## 4. 第一次对话

进入一个练习项目：

```powershell
cd D:\**
praxis
```

输入：

```text
先只读检查当前项目，说明目录结构和可以改进的地方。
```

按 Enter 发送，Shift+Enter 换行。常见快捷键：

| 键 | 功能 |
| --- | --- |
| Enter | 发送 |
| Shift+Enter | 输入换行 |
| Ctrl+L | 模型选择 |
| Ctrl+P | 切换模型 |
| Ctrl+E | 外部编辑器 |
| 鼠标滚轮 | 回看 Transcript |
| Ctrl+C | 退出 |

流式输出时仍可向前滚动。Composer、Transcript 和 Spinner 是独立渲染区域，历史不会每 80ms 全量重画。

## 5. 默认 auto 到底做什么

无需输入 `/planner auto`，也无需先切换“Supervisor”。新 Session 默认就是 `auto`，TUI 右侧会显示 `PLANNER AUTO`。每条 Prompt 都创建一个持久 Workflow 和根 AgentTask。可信系统提示会明确告诉根模型：它已经位于 Praxis Runtime 内、当前策略是 `auto`，并可自主选择：

- 简单问题：直接回答；
- 普通代码任务：自己调用 read/edit/shell；
- 需要独立调查或审查：调用 `agent.delegate`；
- 多步骤、并行或有依赖：调用 `workflow.expand`。

模型只有提案权。Runtime 会检查权限、Profile、预算、路径、依赖和副作用，然后才启动 Child。

你可以明确要求，但不必写特殊语法：

```text
分析这个仓库；如果独立调查或验证能提高质量，请自行委派合适的 Agent，最后统一修改并运行测试。
```

## 6. 三个策略

查看当前策略：

```text
/planner
```

只有需要覆盖默认值时才设置下一次 Run：

```text
/planner auto
/planner solo
/planner workflow
```

- `auto`：推荐。让模型在同一 Workflow 内自主选择。
- `solo`：禁止 Child，适合低成本、严格单 Agent 场景。
- `workflow`：要求复杂副作用前图化，适合审计要求较高的任务。

活动 Run 期间不能修改。旧命令 `/planner direct` 与 `/planner supervisor` 仍被接受，但会分别保存为 `solo` 与 `workflow`。

启动时也可指定：

```powershell
praxis --planner solo
praxis --planner workflow
```

## 7. 让 Child 修改代码

根 Agent 可把一个实现任务委派给 `coder`。Child 不能直接写主目录：Git 项目使用 worktree，普通目录使用位于 Praxis home 的私有快照仓库；Child 在隔离目录修改和测试，再由父侧验证并合并或回写。

Git 项目要成功合并，需要：

- 当前目录是 Git 仓库；
- 主目录 HEAD 仍与创建 worktree 时相同；
- 主目录没有未提交修改；
- 候选提交只有一个父提交；
- changed files、patch digest 和授权路径匹配；
- `git merge --ff-only` 成功。

如果主目录本来就很脏，Child 的结果会保留在 recovery path，不会覆盖你的修改。你可以让根 Agent 自己在当前目录继续，或先提交/暂存自己的改动。

## 8. Session 与 Workflow

Session 是对话；Workflow 是一次 Prompt 的执行。一个 Session 可以有很多 Workflow。

常用命令：

```text
/sessions
/resume <session-id>
/fork
/branch
/compact
/plan
```

`/plan` 显示最新 Workflow，不是模型写的一段“计划文本”。面板状态来自 SQLite projection，节点会显示 `scheduled/leased/running/succeeded/failed/unknown` 等真实状态。

退出再运行 `praxis` 后，可从 Session 列表恢复对话。Workflow authority 会在 Runtime 启动时回收过期 Lease；安全任务可重试，未知副作用不会盲目重复。

## 9. JSONL 与 SQLite Session 后端

Praxis 有两个可选的 V3 Session 后端：

```powershell
praxis --storage jsonl
praxis --storage sqlite
```

或：

```powershell
$env:PRAXIS_SESSION_STORE='sqlite'
praxis
```

这不是双写。每次启动只选择一个 Session authority：

- JSONL：默认，易检查和迁移；启动读取 Catalog/Projection 快速路径。
- SQLite：事务查询更强，适合 Session 较多时使用。

Workflow 本身始终使用独立的 `workflow-platform-v1.sqlite`，不随 Session 后端切换。

完整检查：

```powershell
praxis doctor
praxis doctor --deep
```

`--deep` 会完整重放/校验，可能明显更慢；普通启动不会做这项工作。

## 10. 非交互模式

适合脚本或快速提问：

```powershell
praxis --print "列出所有 Python 文件" --output-format text
praxis --print "运行测试并解释失败；需要时自行委派 Agent" --output-format text
```

机器处理建议使用 `json` 或 `stream-json`。不要从终端装饰文本推断状态；应读取结构化事件和 terminal code。

## 11. Skills、MCP 和插件

### Skill

项目或用户目录中的 `SKILL.md` 会进入 Skill catalog。你可以说“使用 xxx skill”，也可用 `/skill:<name>`。Skill 是工作说明，不自动获得额外权限。

### MCP

配置并启用 MCP stdio server 后，其工具与内置工具一起出现在 ToolRuntime。Child 通过父 broker 调用被批准的 MCP，API Key 不会传进 Child Prompt。

### 插件

插件可添加 Tool、Provider 和资源。先检查，再授予最小工作区权限：

```text
/plugins
```

详细操作见 [插件系统](plugin-system.md) 和 [插件开发](plugin-authoring.md)。

## 12. 常见问题

### 启动报 Session storage 错误

执行：

```powershell
praxis doctor --deep
```

不要直接删除用户数据。先记录具体错误码、当前 `PRAXIS_SESSION_STORE` 和 Praxis home。

### 启动慢

确认没有强制设置 `PRAXIS_SESSION_SCRUB=deep`。普通 JSONL 启动应走已校验 Projection；深度重放只用于诊断。

### 输入或滚动慢

确认使用最新本地安装：

```powershell
cd D:\praxis
npm run install:local
```

### Child 失败但父继续了

查看 `WORKFLOW` 面板和 `/plan`。父会收到结构化 Tool error、部分 output、Artifact 或 recovery path；不会把失败说成成功。节点失败码比模型解释更可信。

### 非 Git 目录中的写 Child

不需要先执行 `git init`。Runtime 会复制允许的工作区内容到 `~/.praxis/workflow-snapshots/` 中的临时 Git 仓库；`.env`、私钥、凭据、`.git`、`.praxis`、虚拟环境和依赖目录不会复制。权限确认仍显示用户工作区中的目标路径，而不是内部快照路径。Child 成功后，父 Runtime 校验主目录基线未变化、changed files 与授权范围一致，再受控回写；若 Child 在完成写工具后才超时，匹配的工具证据与候选差异也可继续验证。冲突或验证失败时主目录不接收候选结果，快照路径会作为 recovery path 保留。

更多见 [故障排查](troubleshooting.md)。

## 下一步阅读

- [README：全部功能](../README.md)
- [统一 Workflow 与多 Agent](workflow-platform.md)
- [CLI 完整参考](cli-reference.md)
- [Provider 配置](provider-setup.md)
- [Session 恢复](session-recovery.md)
- [当前架构](architecture.md)
