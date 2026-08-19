# ADR-005：Kimi API 与 API Key 认证 / Kimi API with API-Key Authentication

状态 / Status: Phase 1 已接受 / Accepted for Phase 1

## 中文

**背景：**Praxis 需要一个支持流式响应与本地 Tool Orchestration 的真实 Provider。消费者
浏览器订阅不是稳定 API 凭据流，也会把 Runtime 耦合到产品 UI。

**决策：**首个真实 Provider 使用 Kimi Open Platform Chat Completions API，通过 OpenAI
Node SDK 连接 `https://api.moonshot.cn/v1`。Phase 1 只从 `MOONSHOT_API_KEY` 读取 Key，
不写入配置、Event、stdout、History 或普通 Log；默认真实模型为 `kimi-k2.6`。

Provider 默认 Streaming，并接收每次请求选中的内存上下文。Runtime 独立拥有和持久化完整
Session History，Provider 不拥有历史存储。

**后果：**`auth.status/login/logout` 描述 API 凭据而非浏览器订阅；缺 Key 时返回
`unauthenticated` / `AUTH_REQUIRED`，无 Key 环境仍使用确定性 Mock。该 ADR 记录 Phase 1
起点；当前加密凭据存储和更多 Provider 的实现以
[Provider 配置](../provider-setup.md)及路线图为准。

Status: Accepted for Phase 1

## Context

Praxis needs one real Provider that supports streaming responses and local tool
orchestration. The project has a Kimi API credential available for development
validation. Consumer browser subscriptions are not a stable API credential flow
and would couple the Runtime to a product UI.

## Decision

The first real Provider is the Kimi Open Platform Chat Completions API through
the OpenAI Node SDK configured with `https://api.moonshot.cn/v1`. Phase 1 reads
the API key only from `MOONSHOT_API_KEY`; it is never written to configuration,
events, stdout, history, or ordinary logs. The default real model is
`kimi-k2.6`, configurable per Session.

The Provider streams by default. It receives the in-memory context selected for
each Provider request. Durable Session history is owned by the Runtime and is
persisted independently of the Provider; the Provider never owns history
storage.

## Consequences

`auth.status`, `auth.login`, and `auth.logout` describe API credential state,
not consumer browser subscription state. A missing key results in
`unauthenticated` / `AUTH_REQUIRED`, while the deterministic Mock Provider
remains the default where no key is configured. Anthropic remains a future
Provider adapter rather than a Phase 1 prerequisite.
