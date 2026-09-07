# Plan-and-Review 通用优化：2026-09-05

> 版本化测评记录：题面、结果和归因对应本文注明的构建与策略，不代表当前默认模式或同版全量成绩。

这是一份代码修改与本地回归记录，不是新增 benchmark 成绩。没有调用 MiniMax，没有重跑 ReAct，也没有把旧失败改写为通过。

## 修改原则

不根据题目名称、目标答案、特定网站、数据格式实例或领域公式分支。Runtime 负责证据和生命周期可靠；领域知识由模型或 Host 注册的验证器提供。原始任务优先，Plan 是可纠正的操作性解释。

## 已实现

| 通用问题 | 实现 | 验证方式 |
| --- | --- | --- |
| Item 只看模型自拟标准 | Item/final 均传原任务，Final 仍单独检查全任务覆盖 | 检查真实协调器的请求输入 |
| 未检查被标成通过 | deterministic results 使用 deferred；只要实际机械检查失败，就不会语义放行 | 断言语义项待审状态与已有机械检查行为 |
| 只有 summary，修复目标不清 | plan.review 返回逐条件 findings，保留完整 decision Artifact | 验证返回条件 ID、状态、原因、引用 |
| 截断导致盲审 | read_review_evidence 只读取冻结 Manifest 的范围；补读与 verdict 分轮 | 越权引用被拒；活文件变化不影响冻结文件尾部 |
| 不知道结果属于哪次调用 | 工具结果包含 invocation、Plan revision、Attempt、时间及按既有敏感值策略处理的输入 | Root broker 回归；保留 inputDigest，脱敏输入不是原始字节证明 |
| 缺少通用确定性验证扩展点 | Host 注册带 id/version/digest/success-contract 的检查器，动态发布到 Plan Tool | 未注册时不暴露；版本或成功码不符拒绝执行 |
| Reviewer 用量漏算 | 当前 Run 汇总新发生的实际调用，按 call ID 去重；无效响应仍保留已知 usage | 多次补读汇总、失败响应计量、重复 ID 去重 |
| 无法解释压缩降级 | provenance 增加 failureCode、failedGeneratorDurationMs，兼容旧持久化 | JSONL/SQLite checkpoint 回归 |
| 历史意图重新变待办 | 最新 assistant 意图替代旧 intent；非空语义 continuation 不再被旧基线无条件加回 | 两次摘要跨历史意图替换，原任务仍保留 |

## 检查器怎样接入

入口是 `RuntimeKernelOptions.reviewChecks`，类型定义在 `apps/runtime/src/review-plan/registeredChecks.ts`。

宿主提供 id、version、digest、description、expectedExitCodes 和异步 evaluate。evaluate 获得参数、当前冻结证据副本和 AbortSignal，返回 exitCode、reason、evidenceRefs。成功退出码和实现身份由 Host 固定，模型不能把失败码重新声明成成功。检查函数是受信进程内扩展，必须遵守取消信号；这不是沙箱，也不能运行模型提供的代码。

默认不附带领域检查器。JSON Schema、编译报告、服务契约、数值容差等可以由 Host 用此接口实现；不宣称一个通用 Runtime 已经知道所有领域的正确答案。即使注册检查通过，仍保留语义任务覆盖判断。

## 证据与用量边界

- 初始 evidence 内容预算仍为 64 KiB；补读最多 8 次、每次最多 16,384 UTF-16 字符，整个独立审查仍有消息体预算。这是防止无限审查与失控 payload 的边界，不是任务墙钟上限。
- 文件内容按已有单文件 8 MiB、合计 32 MiB 捕获额度冻结，超出用 frozenTruncated 明示；非 UTF-8 内容保留 base64，不用损坏的文本假装原始内容。完整文件摘要与可见文本范围是两回事。文件路径、调用身份和时间等短元数据放入 context，即使正文截断也可见。
- Reviewer 没有 live 文件访问、shell、网络、Child 或 Plan 修改权限。可读取的是准备好的 Artifact 内容，不是模型给出的路径。
- ReviewCallStore 保留最终决策、汇总实际 usage 及补读 ref/offset/length/responseDigest，已有 SQLite 表自动增加可选列，旧行仍可读。
- 当前 Run 只汇总新发生的调用，恢复复用旧 decision 不重新计费；历史调用仍在原账本，不会自动改写旧 Harbor 报告。部分 stream 中断时，已知 usage 计入当前 Run，未知部分仍标为未知，预留值不当作账单。
- 结构化摘要失败时，已测得 usage 随 fallback 返回；摘要因压缩收益不足（low_gain）未被采用时，也返回实际 usage。不能把“没有生成新 checkpoint”当作“没有模型调用”。规则摘要保留历史决策和显式 TODO，仅替换临时意图；非空语义结果可以重新解释哪些任务仍未完成。
- 数据可信、摘要正确、引用存在，都不等于业务结论成立。Prompt 改进不能保证模型不再错误接受或错误拒绝。

## 本地验证

新增通用回归位于 `test/review-generalization.test.ts`，不依赖任何 benchmark 答案。验证记录：

- 全量 `npm test` 复跑：1104 项中 1099 通过、5 项按条件跳过、0 失败，约 274 秒。
- 最后补充低收益摘要计量、旧 SQLite 表升级等边界后，针对最终源码再跑 13 个相关测试文件：106/106 通过，覆盖 Review、Plan 工具、输入脱敏、compaction、JSONL/SQLite 持久化与恢复、离线场景。
- `npm run check`（format/lint/typecheck）与 `npm run build` 已通过；构建产物更新，不包含新 benchmark 运行。

第一轮全量发现临时意图清理误丢历史决策，已修正为“历史决策与显式 TODO 保留，临时 intent 可替换”，并通过 iterative-compaction 场景。旧 provenance 精确比较测试同步新增可选诊断字段。一项未修改的旧 DAG collect_partial 测试首轮失败，单独复跑及第二轮全量均通过；未为此放宽测试或改写旧 DAG 运行逻辑。

这批回归证明机制行为，不证明真实任务成功率提高。下一轮真实测评应冻结新 bundle，与旧实验分开标记，记录 Review 是修代码、补证据、纠正验收条件，还是误判。

## 对历史归因的更正

KV-store 的 P&R 最终 7/7、P&E 5/7 属于有效成绩差异；但 P&R 首次 proto 已包含正确 value 字段。Reviewer 曾错误要求把 int32 改成 int，不能描述为“Reviewer 纠正字段名带来提升”。Scheme 的五次 needs_fix 包含证据补齐和矛盾日志澄清，也不能一律记为五个代码缺陷修复。原始分数不变，收紧因果解释。
