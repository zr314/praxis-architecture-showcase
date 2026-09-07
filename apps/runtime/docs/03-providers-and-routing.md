# Provider 源码导航

English summary: provider adapters translate the common request; routing does not choose a planning strategy.

阅读顺序：llm-provider 的 catalog/router/composition → providers 中的具体 adapter → credentials 中的认证存储。路径相对 apps/runtime/src，实际公开配置见[Provider 配置](../../../docs/provider-setup.md)。

ProviderRouter 处理候选、能力、认证、错误分类和 fallback；它不是把任务分到 Direct 或 DAG 的规划模型。AgentLoop 决定何时发起下一轮，模型决定调用什么工具。

排查一次调用时同时看：选定 provider/model、最终上下文、Tool Schema、responseFormat/toolChoice、stream 完整性、错误码、usage 和重试原因。已知 usage 才计为实际消耗，未收到不能凭预算推算。

Child 通过 credential broker 代理调用，不接收 API key。Review 和 compaction 是独立辅助模型请求，统计时不能只看 Root provider.completed。咨询 Reviewer 与严格 Reviewer 共用传输但合同不同。

具体模型请求和 wire 映射见[模型请求目录](../../../docs/model-request-catalog.md)；缓存和 native/semantic 边界见[Prompt 装配](../../../docs/prompt-assembly.md)。不在这里复制供应商参数表或历史 smoke 分数。
