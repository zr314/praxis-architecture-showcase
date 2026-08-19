# 安全策略 / Security Policy

## 中文

请使用 GitHub Private Vulnerability Reporting 向 `uestc-Praxis/praxis` 私下报告疑似漏洞。完成初步
分诊并约定协调披露时间前，不要创建公开 Issue。

报告应包含：受影响版本或 Commit、操作系统、最小且已脱敏的复现、你预期的安全边界、实际行为和影响。
不要附带真实凭据、API Key、原始 Prompt、Session Transcript、Tool Payload、环境转储或私有仓库内容。

Runtime 授权绕过、协议隔离、脱敏、取消/进程回收、Package Integrity 和 Release Provenance 属于范围内。
Praxis Policy 不是 OS Sandbox；仅仅证明已获允许的 Shell/可信插件具有当前用户权限，不构成 Sandbox
绕过。信任边界和明确非目标见[威胁模型](docs/security-threat-model.md)。

## English

Report suspected vulnerabilities with GitHub private vulnerability reporting
for `uestc-Praxis/praxis`. Do not open a public issue until the report has been
triaged and a coordinated disclosure timeline has been agreed.

Do not include credentials, API keys, raw prompts, session transcripts, tool
payloads, environment dumps, or private repository contents in a report.
Provide the smallest redacted reproduction, affected version, operating system,
expected security boundary, and observed behavior.

Praxis policy decisions are not an operating-system sandbox. Reports that show
a bypass of Runtime authorization, protocol isolation, redaction, cancellation,
package integrity, or release provenance are in scope.
