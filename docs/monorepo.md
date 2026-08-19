# Monorepo 指南 / Monorepo Guide

## 中文导读

Praxis 使用 npm Workspaces，并以“可部署应用”和“可发布契约”划分所有权：

- `apps/cli` 是终端产品与 Runtime Bridge；`apps/runtime` 是独立执行进程和能力组合根。
- `packages/core-sdk`、`protocol`、`plugin-protocol`、`client` 与 `plugin-sdk`
  分别保存领域契约、Wire Schema、进程插件协议、类型化客户端和扩展 SDK。
- 完整目录职责和新手阅读路径见[模块地图](module-map.md)。
- `packages/*` 不得导入应用；Runtime 不得导入 CLI 或 Ink。跨 Workspace 变更必须有集成
  测试或依赖边界测试。
- `npm run check`、`npm test`、`npm run build`、`npm run package:npm` 和
  `npm run release:check` 构成主要本地门禁。
- 所有 Workspace 版本同步移动，内部依赖版本也必须与 Tag 一致。
- GitHub Release 的独立可执行文件与 Windows Verdaccio 的私有 npm 包是两个独立发行
  渠道；Release 不携带 npm Tarball，也不等待私有 Registry 发布完成。

下方英文正文包含精确 Workspace 表、依赖方向、命令、变更策略与发布编排。

Praxis uses npm workspaces. The repository is organized around deployable
applications and publishable contracts instead of one source tree with implicit
ownership.

## Workspaces

| Workspace | Package | Responsibility |
|---|---|---|
| `apps/cli` | `@praxis/cli` | Ink terminal UI, local Runtime bridge, CLI distribution |
| `apps/runtime` | `@praxis/runtime` | NDJSON Runtime process and capability assembly |
| `packages/core-sdk` | `@praxis/core-sdk` | implementation-free Runtime contracts |
| `packages/protocol` | `@praxis/protocol` | NDJSON types and protocol schemas |
| `packages/plugin-protocol` | `@praxis/plugin-protocol` | process-plugin protocol contracts |
| `packages/client` | `@praxis/client` | typed protocol client |
| `packages/plugin-sdk` | `@praxis/plugin-sdk` | extension authoring SDK |

The root owns workspace orchestration, cross-package integration tests, shared
TypeScript settings, CI, and the backwards-compatible `dist/` mirror.

## Dependency Rules

Arrows point from a workspace to the internal workspaces it imports. This is
the dependency graph declared by the current workspace manifests:

```text
@praxis/cli
  -> @praxis/runtime, @praxis/client, @praxis/protocol,
     @praxis/core-sdk, @praxis/plugin-protocol

@praxis/runtime
  -> @praxis/client, @praxis/protocol,
     @praxis/core-sdk, @praxis/plugin-protocol

@praxis/client
  -> @praxis/protocol

@praxis/protocol
  -> @praxis/core-sdk, @praxis/plugin-protocol

@praxis/core-sdk
  -> @praxis/plugin-protocol

@praxis/plugin-sdk
  -> @praxis/plugin-protocol

@praxis/plugin-protocol
  -> no Praxis workspace
```

`packages/*` must not import either application. The Runtime must not import
CLI or Ink modules. `core-sdk`, `protocol`, and `plugin-protocol` must remain
implementation-free contracts and may depend only on lower-level contract
packages shown above. `client` and `plugin-sdk` may implement their narrow SDK
responsibilities, but must not acquire Runtime, CLI, database, or UI ownership.
Root integration tests may import every workspace.

## Commands

```bash
npm ci
npm run check
npm test
npm run build
npm run verify:pack
npm run package:npm
npm run package:binary -- --target windows-x64
npm run release:check -- --tag v<version>
node dist/cli.js --provider mock -p "smoke"
```

`npm run build` builds packages in dependency order and mirrors the CLI and
Runtime entry into root `dist/` for existing users. Each workspace also creates
its own `dist/` directory, which is the only published payload for that package.

Pull-request CI intentionally keeps one packaging gate instead of a source-test
matrix:

- Ubuntu with Node 24 runs the supply-chain policy and `package:npm`.
- The packaged output must import every public Workspace and complete one CLI
  smoke run.
- Full tests, the focused Windows compatibility suite, static checks and
  deterministic evaluations remain explicit local and release-readiness
  commands; they do not block ordinary pull requests.

Push CI runs only on `main`; pull requests run once and superseded commits are
cancelled. Tag release, scheduled dependency audit and the self-hosted private
registry publisher remain separate workflows because they have different
permissions, triggers and failure semantics.

## Change Policy

- Changes crossing a workspace boundary require an integration test or a
  dependency-boundary test.
- Protocol schema and type changes are versioned contract changes; update both
  fixtures and the relevant ADR before relying on them.
- A publishable package must keep `files`, `exports`, `types`, and `prepack`
  aligned with its package-local `dist/` output.
- CI validates source tests, built CLI behavior, direct workspace imports, and
  package manifests. Do not bypass those checks with root-only aliases.

`@praxis/plugin-protocol` is the implementation-free public contract package
for plugin manifests, process handshakes, Tool execution descriptors, Provider
capability descriptors, and the closed v1 process RPC/event vocabulary.
Runtime owns validation, policy, supervision, and publication; the public
package contains no Runtime implementation. Current activation boundaries are
summarized in [project-status.md](project-status.md).

## Release Rules

All workspace versions move together. A `v*` tag must exactly match the root
and workspace versions and every internal dependency range.

GitHub Release and private npm publication are independent delivery channels.
The hosted tag workflow builds each standalone binary on a matching native
runner, then publishes release notes, checksums, SBOM, provenance, and the four
executables. It carries no npm tarballs and does not wait for Verdaccio.

After publishing the Release, the finalize job sends a
`praxis_private_registry_publish` `repository_dispatch`. This explicit handoff
avoids GitHub's recursion suppression for ordinary events created with
`GITHUB_TOKEN`. It starts the separate workflow on the Windows self-hosted
runner labeled `praxis-private-registry`. The workflow also accepts
`release.published` for maintainer-published Releases and manual dispatch for
recovery. It publishes all seven packages in dependency order to
`http://127.0.0.1:4873/`. An identical registry version is skipped only when
its integrity matches; a mismatch stops publication.
