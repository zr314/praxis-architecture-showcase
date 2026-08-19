# 参与 Praxis 开发 / Contributing to Praxis

感谢参与 Praxis。本页面向第一次给 TypeScript Monorepo 提交修改的开发者，说明怎样准备环境、找到正确
模块、验证变更，以及哪些合同必须同步更新。先阅读[项目状态](docs/project-status.md)，避免把内部组件误接
成普通产品能力。

## 第一次贡献 / First contribution

### 1. 准备环境

需要 Node.js 22.13 或更高、npm 和 Git：

```bash
node --version
npm --version
git --version
npm ci
```

`npm ci` 严格按 `package-lock.json` 安装。除非确实修改依赖，不要删除或重新生成 Lockfile。

### 2. 先跑离线 Smoke

```bash
npm run dev -- --provider mock --model mock-v1 --print "contribution smoke"
```

预期得到确定性的 Mock 响应并以退出码 `0` 结束。它不需要 API Key，也不会产生模型费用。若要测试安装后
的真实命令：

```bash
npm run install:local
praxis --version
praxis --provider mock --model mock-v1 --print "installed smoke"
```

### 3. 找到修改位置

第一次跨层修改时，先看[模块地图](docs/module-map.md)。它列出七个 Workspace、Runtime/CLI
全部源码域，以及 Provider、RPC、Tool、Workflow、Prompt 和插件改动通常穿过的层。

| 想修改什么 | 从哪里开始 |
| --- | --- |
| 参数、TUI、Print 输出 | [`apps/cli/readme.md`](apps/cli/readme.md) |
| AgentLoop、Session、Provider、Tool | [`apps/runtime/readme.md`](apps/runtime/readme.md) |
| 客户端—Runtime Wire | [`docs/protocol.md`](docs/protocol.md)、`packages/protocol` |
| 插件 Manifest/process Wire | [`docs/plugin-system.md`](docs/plugin-system.md)、`packages/plugin-protocol` |
| 公共领域类型 | `packages/core-sdk` |
| 类型化客户端 | [`docs/protocol-client.md`](docs/protocol-client.md)、`packages/client` |
| 插件作者 API | [`docs/plugin-authoring.md`](docs/plugin-authoring.md)、`packages/plugin-sdk` |
| 用户行为或边界 | 根 `README.md`、`docs/project-status.md` 和对应专题页 |

七个 Workspace 的发布规则见 [Monorepo 指南](docs/monorepo.md)。`packages/*` 不能依赖
`apps/*`，Runtime 不能依赖 CLI/Ink。

## 开发循环 / Development loop

1. 为要改变的行为先添加一个聚焦的失败测试；
2. 做最小实现，使该测试通过；
3. 补充无效输入、取消、并发、持久化或权限失败路径；
4. 更新用户文档、Schema/Fixture 或 ADR；
5. 运行与风险相称的本地门禁。

测试放在 `test/`。跨 Workspace 的变化必须包含 Integration 或 Dependency-boundary 测试。协议变化必须
同时更新 TypeScript types、JSON Schema、fixtures、兼容测试和相关 ADR；不能只改其中一层。

推荐先运行聚焦测试，再运行完整门禁：

```bash
npm run check
npm test
npm run test:compat
npm run build
npm run verify:pack
```

PR CI 只保留一个 Ubuntu/Node 24 打包门禁：供应链检查、`package:npm`、公共 Workspace import 和打包后 CLI smoke。完整 `npm test`、`npm run test:compat`、静态检查与确定性评估仍是本地和发布前验证命令，但不再阻塞普通 PR。Feature branch 的 `push` 不单独触发 CI，PR 事件是唯一分支检查入口。

Provider/网络行为应尽量通过 Mock 和离线合同测试验证。真实 Provider Smoke 必须有小 Token/Timeout 上限，
不得成为普通贡献的必需条件。

## 按变更类型检查 / Change-specific checklist

### CLI 或 TUI

- `praxis --help`、子命令 Help 和 [CLI 参考](docs/cli-reference.md)一致；
- TUI 与 `--print` 仍通过同一个 Runtime Bridge；
- `text`、`json`、`stream-json` 保持稳定；
- Ctrl+C、终端恢复和所有退出码均有失败路径覆盖。

### Runtime、Session 或 Prompt

- Runtime 仍是状态、授权、Provider、Tool、预算和审计的唯一权威；
- 一个接受的 Run 只有一个 terminal event；
- durable finalization 先于对外成功终态；
- Compaction 不删除原始历史，项目指令不能授予权限；
- Session migration、checksum、writer lock 和 restart recovery 有测试。

### Tool、Policy 或插件

- 输入/输出 Schema 与 canonical target 在授权前后保持一致；
- 高风险 mutation 有 TOCTOU、取消和并发测试；
- 安装不执行代码，启用固定 digest 并要求显式 grant；
- process boundary 不得被文档称作 sandbox，除非平台确实报告 enforced isolation；
- Tool discovery 不自动创建 Slash Command；命令映射必须显式、命名空间化并通过 Schema。

### 文档

- 新手指南写清楚前置条件、命令、预期结果和失败后的下一步；
- Current 文档只描述已经接线的行为，未来设计放 ADR 或明确标注内部边界；
- 不重新引入完成的实施计划、超长 TODO 或与状态页竞争的 Roadmap；
- 修复所有本地 Markdown Link，运行文档合同测试；
- 命令、路径、类型、Schema、环境变量和错误码保持精确英文。

## 安全与隐私 / Security and privacy

不要在测试、Fixture、Issue、Trace 或提交中加入真实 API Key、Prompt、Session Transcript、私有仓库内容或
环境转储。安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

高风险代码审查至少要问：权限由谁授予？输入是否有界？进程/网络/文件副作用能否取消？失败是否会被
误报为成功？日志是否可能泄漏原始 Payload？平台隔离声明是否与事实一致？

## Commit 与提交范围 / Commits and scope

保持提交聚焦，避免顺手改写无关用户变更。可使用简洁 Conventional Commit：

```text
feat: add self-spawning runtime mode
fix: preserve protocol cancellation outcome
docs: rebuild beginner documentation map
```

生成目录（如各 Workspace 的 `dist/`）由构建创建；不要把临时文件、个人 `PRAXIS_HOME` 或真实凭据加入
Git。提交前查看 `git diff --check` 和 `git status --short`。

## 版本与发布 / Versions and releases

All seven publishable workspaces and the private root use one SemVer. Update
every manifest and internal `@praxis/*` dependency together. Run the release
preflight before creating a tag:

```bash
npm run package:npm
npm run release:check -- --tag v0.2.0
```

After the version commit is merged and CI passes, create the exact matching
tag. The tag workflow verifies packaging, builds four native binaries, creates
checksums, release notes, an SBOM and provenance, then publishes the
repository-scoped GitHub Release independently. Releases contain no npm
tarballs.

After Release publication, the finalize job emits the explicit
`praxis_private_registry_publish` `repository_dispatch`. It starts the separate
private workflow on the dedicated
`[self-hosted, Windows, X64, praxis-private-registry]` runner. A
`release.published` trigger remains available for maintainer-created Releases.
Configure the repository variable and Actions secret:

```text
PRAXIS_NPM_REGISTRY_URL=http://127.0.0.1:4873/
PRAXIS_NPM_TOKEN=<GitHub Actions secret>
```

The publisher rejects every other registry, including npmjs. It uses a
temporary npm configuration and removes it even when publication fails.
Prerelease versions use `next`; stable versions use `latest`.

If private publication stops after one package is stored, rerun the manually
dispatchable workflow with the same tag. It skips an existing version only
when registry integrity equals the locally packed artifact; a mismatch stops
publication for investigation. Private-registry failure does not retract or
block the repository-scoped GitHub Release: these are independent delivery
channels.

## English summary

Install with `npm ci`, prove the local path with the Mock Provider, begin from
the owning workspace guide, and use a failing-test/minimal-change/passing-test
loop. Cross-workspace and protocol changes need boundary tests and synchronized
types, schemas, fixtures, ADRs, and documentation. Run `npm run check`,
`npm test`, `npm run build`, and `npm run verify:pack` before handoff. Never put
real credentials or private session content in tests or reports.
