# 兼容性与支持策略 / Compatibility and Support Policy

> 本页定义已发布合同怎样演进，不承诺内部组件的发布日期。当前功能是否开放以
> [项目状态](project-status.md)为准；Release 历史以根目录 [CHANGELOG](../CHANGELOG.md)为准。

## 中文

Praxis 对已发布包使用语义化版本。稳定协议版本必须保持已记录字段的向后兼容；必要的 Wire
变更通过能力协商或新协议版本交付。会话 Schema 迁移只向前执行并保留备份；V3 JSONL/SQLite
Authority 切换使用离线校验 Export/Import，禁止双写。插件 API 与 Manifest 版本在执行前校验。

在 `1.0` 之前，支持窗口为最新 Minor 版本及其前一个 Minor 的关键安全修复。Node.js 支持
范围以各包 `engines` 为准，CI 覆盖所声明的操作系统。默认 V3 JSONL 遵守该最低版本；显式 SQLite
还要求运行时提供 `node:sqlite`，不可用时 Fail Closed。强制 Sandbox 能力按运行主机动态报告，
不等同于一般 Runtime 支持。

预 `1.0` 阶段计划按月发布，必要时可带外发布安全修复。正式发布必须通过检查、测试、离线
评测、安装包 Smoke、所有已声明 Native 产物的原生 Smoke、Checksum、SBOM、Provenance
以及 Fail-closed 发布门禁。

在 Release Matrix 出现原生 Smoke Runner 前，不承诺 Linux ARM64 和 Windows ARM64 独立
产物；仅能交叉编译不足以作出支持声明。

## English

Praxis uses semantic versions for published packages. A stable protocol version
remains backward compatible for its documented fields; required wire changes
use capability negotiation or a new protocol version. Session schema migrations
are forward-only and preserve a backup. V3 JSONL/SQLite authority changes use
verified offline export/import and never dual-write. Plugin API and manifest
versions are validated before execution.

The current pre-1.0 support window is the latest minor release plus the
immediately preceding minor for critical security fixes. Supported Node.js
versions are declared in package `engines`; CI covers the declared operating
systems. The default V3 JSONL backend follows that minimum; explicit SQLite also
requires a runtime that provides `node:sqlite` and fails closed otherwise.
Enforced sandbox support is reported dynamically and is separate from general
Runtime support.

Releases are intended monthly while pre-1.0, with out-of-band security releases
when necessary. A release requires checks, tests, offline evaluations, package
install smoke tests, native smoke tests on every claimed artifact, checksums,
SBOM, provenance, and fail-closed publication.

Linux ARM64 and Windows ARM64 standalone artifacts remain unclaimed until a
native smoke runner is present in the release matrix. Cross-compilation alone
does not satisfy that condition.
