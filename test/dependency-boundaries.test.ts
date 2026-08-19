import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const runtimeRoot = new URL('../apps/runtime/src/', import.meta.url)

async function source(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, runtimeRoot)), 'utf8')
}

test('planner-api exposes only core-sdk execution contracts', async () => {
  const plannerApi = await source('planner-api/index.ts')

  assert.match(plannerApi, /from ['"]@praxis\/core-sdk['"]/)
  assert.match(plannerApi, /SubagentExecutor/)
  assert.doesNotMatch(plannerApi, /\.\.\/loop\/|\.\.\/session\/|\.\.\/framework\//)
  assert.doesNotMatch(
    plannerApi,
    /ChildRuntimeHost|ChildProcess|stdio|credential|reservation|ledger|\.\.\/subagent\//,
  )
})

test('SerialSupervisor depends on the opaque executor port, never the child host', async () => {
  const supervisor = await source('planner/serialSupervisor.ts')

  assert.match(supervisor, /SubagentExecutor/)
  assert.doesNotMatch(
    supervisor,
    /ChildRuntimeHost|ChildProcess|stdio|credential|reservation|ledger|\.\.\/subagent\//,
  )
})

test('RuntimeKernel uses one workflow planner and projects the parent tool snapshot plus policy budgets', async () => {
  const kernel = await source('framework/runtimeKernel.ts')

  assert.match(kernel, /new PlannerRouter\(\s*options\.planner \?\?/)
  assert.doesNotMatch(kernel, /ProductSupervisor|executeProductSupervisor|CompactPlan/)
  assert.match(kernel, /AutoWorkflowPlannerV1/)
  assert.match(kernel, /const plannerRoute = this\.plannerRouter\.route\(plannerMode\)/)
  assert.match(kernel, /const planner = this\.requirePlanner\(plannerMode\)/)
  assert.match(kernel, /capabilities\.tools\.fork\(additionalTools\)/)
  assert.match(kernel, /\.\.\.plannerRoute\.childBudget/)
})

test('agent loop consumes core domain ports rather than bridge protocol types', async () => {
  const loop = await source('loop/index.ts')

  assert.doesNotMatch(loop, /bridge\/types/)
  assert.match(loop, /AgentEvent/)
  assert.match(loop, /PermissionDecision/)
})

test('generic PluginManager remains independent from concrete capability implementations', async () => {
  const manager = await source('plugin/pluginManager.ts')

  assert.doesNotMatch(
    manager,
    /from ['"][^'"]*(?:builtin-tools|llm-provider|tools\/types|providers\/types)/,
  )
  assert.match(manager, /from ['"]@praxis\/core-sdk['"]/)
})

test('ExtensionService owns plugin lifecycle and capability assembly without framework concerns', async () => {
  const extensions = await source('extensions/extensionService.ts')

  assert.match(extensions, /PluginManager/)
  assert.match(extensions, /BuiltinPlugin/)
  assert.match(extensions, /ToolRuntime/)
  assert.doesNotMatch(
    extensions,
    /@praxis\/protocol|jsonrpc|JsonRpc|SessionService|CredentialService|CLI/,
  )
})

test('RuntimeKernel delegates extension lifecycle and capability assembly', async () => {
  const kernel = await source('framework/runtimeKernel.ts')

  assert.match(kernel, /RuntimeExtensions/)
  assert.doesNotMatch(kernel, /PluginManager|BuiltinPlugin|capabilityIds\(|\.tool\(|\.planner\(/)
  assert.doesNotMatch(kernel, /from ['"][^'"]*(?:tools\/toolRuntime|planner-api)/)
})

test('legacy tools contracts are compatibility exports from core-sdk', async () => {
  const legacyTools = await source('tools/types.ts')

  assert.match(legacyTools, /from ['"]@praxis\/core-sdk['"]/)
  assert.doesNotMatch(legacyTools, /interface RuntimeTool|type ToolDefinition =/)
})
