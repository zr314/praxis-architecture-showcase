# Tool、Policy 与安全源码导航

English summary: tool descriptions are requests; Runtime authorization and effect records remain authoritative.

入口依次是 tools/toolRuntime.ts、builtin-tools、policy/security 和 workflow/workflowEffectBroker.ts，路径相对 apps/runtime/src。

模型提供 name/input；Runtime 校验 Schema、解析实际目标、检查权限和路径、进行冲突调度，再调用实现。可信 beforeTool middleware 的改写必须发生在这些检查之前，不能沿用旧目标授权新操作。

普通 optional 工作不必绑定 Plan Item Attempt，但仍经过权限与 effect broker；required 另有严格执行绑定与 prepared fence。移除 Plan 门槛不等于移除安全边界。

write/edit 的 expectedDigest 检查并发变化，createOnly 防覆盖；Shell 返回码和截断标志必须作为实际观察。成功 receipt 不是任务语义证明，unknown effect 不能盲目重试。Child 外部工具使用父 broker，同样不能绕过 policy。

参数、Windows/POSIX stdin 示例与稳定错误码只维护在[Tool Policy](../../../docs/tool-policy.md)。攻击边界见[安全模型](../../../docs/security-threat-model.md)，Runtime hooks 见[middleware](../../../docs/runtime-middleware.md)。
