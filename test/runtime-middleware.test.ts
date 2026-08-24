import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderRequest, ProviderTurnResult, ToolResult } from '@praxis/core-sdk'
import {
  resolveRegisteredRuntimeMiddleware,
  RuntimeMiddlewarePipeline,
  type RuntimeModelMiddlewareContext,
  type RuntimeToolMiddlewareContext,
} from '../apps/runtime/src/framework/runtimeMiddleware.js'

test('Runtime middleware composes before hooks forward and after hooks in reverse', async () => {
  const lifecycle: string[] = []
  const pipeline = new RuntimeMiddlewarePipeline([
    {
      name: 'outer',
      beforeModel(_context, request) {
        lifecycle.push('outer.beforeModel')
        return { ...request, instructions: `${request.instructions} outer` }
      },
      afterModel() {
        lifecycle.push('outer.afterModel')
      },
      beforeTool(context) {
        lifecycle.push(`outer.beforeTool:${context.toolName}`)
        return { input: { path: 'outer.txt' } }
      },
      afterTool(_context, result) {
        lifecycle.push('outer.afterTool')
        return { ...result, summary: `${result.summary}:outer` }
      },
    },
    {
      name: 'inner',
      beforeModel(_context, request) {
        lifecycle.push(`inner.beforeModel:${request.instructions}`)
        return { ...request, instructions: `${request.instructions} inner` }
      },
      afterModel() {
        lifecycle.push('inner.afterModel')
      },
      beforeTool(context) {
        lifecycle.push(`inner.beforeTool:${JSON.stringify(context.input)}`)
        return { name: 'read' }
      },
      afterTool(_context, result) {
        lifecycle.push(`inner.afterTool:${result.summary}`)
        return { ...result, summary: `${result.summary}:inner` }
      },
    },
  ])
  const modelContext = runtimeModelContext()
  const request = providerRequest(modelContext.signal)

  const preparedRequest = await pipeline.beforeModel(modelContext, request)
  await pipeline.afterModel(modelContext, providerTurn())
  const toolContext = runtimeToolContext(modelContext.signal)
  const toolCall = await pipeline.beforeTool(toolContext, {
    id: 'call-1',
    name: 'inspect',
    input: { path: 'original.txt' },
  })
  const result = await pipeline.afterTool(toolContext, {
    ok: true,
    summary: 'done',
  })

  assert.equal(preparedRequest.instructions, 'base outer inner')
  assert.deepEqual(toolCall, {
    id: 'call-1',
    name: 'read',
    input: { path: 'outer.txt' },
  })
  assert.equal(result.summary, 'done:inner:outer')
  assert.deepEqual(lifecycle, [
    'outer.beforeModel',
    'inner.beforeModel:base outer',
    'inner.afterModel',
    'outer.afterModel',
    'outer.beforeTool:inspect',
    'inner.beforeTool:{"path":"outer.txt"}',
    'inner.afterTool:done',
    'outer.afterTool',
  ])
  assert.equal(request.instructions, 'base')
})

test('Runtime middleware fails closed when model authority or Tool envelopes are replaced', async () => {
  const modelContext = runtimeModelContext()
  const request = providerRequest(modelContext.signal)
  const replacementSignal = new AbortController().signal
  const modelPipeline = new RuntimeMiddlewarePipeline([
    {
      name: 'unsafe-model-hook',
      beforeModel(_context, current) {
        return { ...current, signal: replacementSignal }
      },
    },
  ])
  await assert.rejects(() => modelPipeline.beforeModel(modelContext, request), middlewareFailure)

  const toolPipeline = new RuntimeMiddlewarePipeline([
    {
      name: 'invalid-tool-hook',
      afterTool() {
        return { ok: true } as ToolResult
      },
    },
  ])
  await assert.rejects(
    () =>
      toolPipeline.afterTool(runtimeToolContext(modelContext.signal), {
        ok: true,
        summary: 'valid',
      }),
    middlewareFailure,
  )

  const forgedErrorPipeline = new RuntimeMiddlewarePipeline([
    {
      name: 'forged-error-hook',
      beforeModel() {
        throw { code: 'RUNTIME_MIDDLEWARE_CIRCUIT_OPEN', secret: 'do-not-project' }
      },
    },
  ])
  await assert.rejects(
    () => forgedErrorPipeline.beforeModel(modelContext, request),
    middlewareFailure,
  )
})

test('Runtime middleware enforces a cooperative hook deadline and reports bounded health', async () => {
  let hookSignalAborted = false
  const pipeline = new RuntimeMiddlewarePipeline(
    [
      {
        name: 'slow-audit',
        beforeModel(context) {
          return new Promise((_resolve) => {
            context.hookSignal.addEventListener(
              'abort',
              () => {
                hookSignalAborted = true
              },
              { once: true },
            )
          })
        },
      },
    ],
    { hookTimeoutMs: 10, consecutiveFailureThreshold: 1 },
  )

  await assert.rejects(
    () =>
      pipeline.beforeModel(runtimeModelContext(), providerRequest(new AbortController().signal)),
    (error: unknown) => middlewareCode(error, 'RUNTIME_MIDDLEWARE_TIMEOUT'),
  )
  assert.equal(hookSignalAborted, true)
  const snapshot = pipeline.snapshot()
  assert.equal(snapshot.middleware[0]?.state, 'open')
  assert.equal(snapshot.middleware[0]?.hooks.beforeModel.calls, 1)
  assert.equal(snapshot.middleware[0]?.hooks.beforeModel.failures, 1)
  assert.equal(snapshot.middleware[0]?.hooks.beforeModel.timeouts, 1)
  assert.equal(JSON.stringify(snapshot).includes('hello'), false)
  assert.equal(Object.isFrozen(snapshot), true)
})

test('Runtime middleware circuit rejects work until one cooldown probe succeeds', async () => {
  let now = 1_000
  let attempts = 0
  let failing = true
  const pipeline = new RuntimeMiddlewarePipeline(
    [
      {
        name: 'flaky-policy',
        beforeModel() {
          attempts += 1
          if (failing) throw new Error('private failure')
          return undefined
        },
      },
    ],
    {
      consecutiveFailureThreshold: 2,
      circuitCooldownMs: 50,
      now: () => now,
    },
  )
  const context = runtimeModelContext()
  const request = providerRequest(context.signal)

  await assert.rejects(() => pipeline.beforeModel(context, request), middlewareFailure)
  await assert.rejects(() => pipeline.beforeModel(context, request), middlewareFailure)
  await assert.rejects(
    () => pipeline.beforeModel(context, request),
    (error: unknown) => middlewareCode(error, 'RUNTIME_MIDDLEWARE_CIRCUIT_OPEN'),
  )
  assert.equal(attempts, 2)
  assert.equal(pipeline.snapshot().middleware[0]?.hooks.beforeModel.circuitRejections, 1)

  now += 50
  failing = false
  await pipeline.beforeModel(context, request)
  assert.equal(attempts, 3)
  assert.equal(pipeline.snapshot().middleware[0]?.state, 'closed')
  assert.equal(pipeline.snapshot().middleware[0]?.consecutiveFailures, 0)
})

test('Child Runtime middleware requires stable registered factories', () => {
  const portable = {
    name: 'portable-audit',
    childId: 'audit.v1',
    beforeTool: () => undefined,
  } as const
  const pipeline = new RuntimeMiddlewarePipeline([portable], { hookTimeoutMs: 123 })
  assert.deepEqual(pipeline.portableProfile(), {
    ids: ['audit.v1'],
    policy: {
      hookTimeoutMs: 123,
      consecutiveFailureThreshold: 3,
      circuitCooldownMs: 30_000,
    },
  })
  assert.equal(
    resolveRegisteredRuntimeMiddleware(['audit.v1'], { 'audit.v1': () => portable })[0]?.name,
    'portable-audit',
  )
  assert.throws(() => resolveRegisteredRuntimeMiddleware(['missing.v1'], {}), /not registered/u)
  assert.throws(
    () =>
      resolveRegisteredRuntimeMiddleware(['audit.v1'], {
        'audit.v1': () => ({ childId: 'other.v1' }),
      }),
    /does not match/u,
  )
  assert.throws(
    () => new RuntimeMiddlewarePipeline([{ childId: 'duplicate' }, { childId: 'duplicate' }]),
    /must be unique/u,
  )
})

function providerRequest(signal: AbortSignal): ProviderRequest {
  return {
    model: 'mock-v1',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    instructions: 'base',
    signal,
  }
}

function providerTurn(): ProviderTurnResult {
  return {
    content: [{ type: 'text', text: 'answer' }],
    toolCalls: [],
    stopReason: 'end_turn',
  }
}

function runtimeModelContext(): Omit<RuntimeModelMiddlewareContext, 'hookSignal'> {
  const signal = new AbortController().signal
  return Object.freeze({
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    workspace: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
    trace: Object.freeze({
      traceId: 'trace-1',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
    }),
    signal,
  })
}

function runtimeToolContext(signal: AbortSignal): Omit<RuntimeToolMiddlewareContext, 'hookSignal'> {
  return Object.freeze({
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    workspace: 'D:/workspace',
    toolCallId: 'call-1',
    toolName: 'inspect',
    input: Object.freeze({ path: 'original.txt' }),
    trace: Object.freeze({
      traceId: 'trace-1',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
    }),
    signal,
  })
}

function middlewareFailure(error: unknown): boolean {
  assert.ok(typeof error === 'object' && error !== null)
  assert.equal((error as { code?: string }).code, 'RUNTIME_MIDDLEWARE_FAILED')
  assert.equal((error as { category?: string }).category, 'configuration')
  return true
}

function middlewareCode(error: unknown, code: string): boolean {
  assert.ok(typeof error === 'object' && error !== null)
  assert.equal((error as { code?: string }).code, code)
  assert.equal((error as { category?: string }).category, 'configuration')
  return true
}
