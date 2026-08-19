import type {
  PermissionRequirement,
  PreparedToolInvocation,
  RuntimeTool,
  ToolExecutionDescriptor,
  ToolProgressUpdate,
  ToolRequest,
  ToolResult,
} from '@praxis/core-sdk'
import { isRuntimeError, runtimeError } from '@praxis/core-sdk'
import type { ErrorObject, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { createBuiltinTools } from '../builtin-tools/builtinTools.js'
import { canonicalDeadlineAfter } from '../longDurationTimer.js'
import { ArtifactReadTool } from './artifactReadTool.js'
import { filesystemFailure } from './filesystemFailure.js'
import { MutationCoordinator } from './mutationCoordinator.js'
import { matchesTargetIdentity, resolveWorkspacePath } from './workspacePathResolver.js'

type RegisteredTool = {
  tool: RuntimeTool
  validateInput: ValidateFunction<unknown>
  validateOutput: ValidateFunction<unknown>
}

export type ToolRuntimeOptions = {
  artifactStore?: ArtifactStore
  exposeArtifactTool?: boolean
  executionBroker?: ToolExecutionBrokerV1
}

export interface ToolExecutionBrokerV1 {
  execute(
    prepared: PreparedToolInvocation,
    signal: AbortSignal,
    invoke: () => Promise<ToolResult>,
  ): Promise<ToolResult>
}

export class ToolRuntime {
  private readonly tools = new Map<string, RegisteredTool>()
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false })
  private readonly artifactStore: ArtifactStore
  private readonly executionBroker?: ToolExecutionBrokerV1
  private readonly mutations = new MutationCoordinator()

  constructor(
    tools: Iterable<RuntimeTool> = createBuiltinTools(),
    options: ToolRuntimeOptions = {},
  ) {
    this.artifactStore = options.artifactStore ?? new ArtifactStore()
    this.executionBroker = options.executionBroker
    for (const tool of tools) this.register(tool)
    if ((options.exposeArtifactTool ?? true) && !this.tools.has('artifact_read')) {
      this.register(new ArtifactReadTool(this.artifactStore))
    }
  }

  register(tool: RuntimeTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw runtimeError(
        'CAPABILITY_CONFLICT',
        'plugin',
        'Tool capability ID is already registered.',
        {
          capabilityId: tool.definition.name,
        },
      )
    }
    try {
      const execution = tool.definition.execution
      if (
        execution !== undefined &&
        (!Number.isSafeInteger(execution.maxInlineBytes) || execution.maxInlineBytes < 1)
      ) {
        throw new TypeError('maxInlineBytes must be a positive integer')
      }
      this.tools.set(tool.definition.name, {
        tool,
        validateInput: this.ajv.compile(tool.definition.parameters),
        validateOutput: this.ajv.compile(tool.definition.outputSchema ?? {}),
      })
    } catch {
      throw runtimeError(
        'TOOL_SCHEMA_INVALID',
        'plugin',
        'Tool capability has an invalid schema or execution descriptor.',
        { capabilityId: tool.definition.name },
      )
    }
  }

  definitions() {
    return [...this.tools.values()].map(({ tool }) => tool.definition)
  }

  /**
   * Parent-brokered views retain this ToolRuntime's validation, permission,
   * conflict and Workflow effect pipeline instead of exposing raw Tool objects.
   */
  brokeredTools(names?: ReadonlySet<string>): RuntimeTool[] {
    return [...this.tools.values()]
      .filter(({ tool }) => names === undefined || names.has(tool.definition.name))
      .map(({ tool }) => ({
        definition: structuredClone(tool.definition),
        execute: (request: ToolRequest) =>
          this.execute(
            tool.definition.name,
            request.input,
            request.cwd,
            request.signal,
            request.onUpdate,
          ),
      }))
  }

  fork(
    additional: Iterable<RuntimeTool> = [],
    options: Readonly<{ executionBroker?: ToolExecutionBrokerV1 }> = {},
  ): ToolRuntime {
    return new ToolRuntime(
      [...this.tools.values()].map(({ tool }) => tool).concat([...additional]),
      {
        artifactStore: this.artifactStore,
        exposeArtifactTool: false,
        executionBroker: options.executionBroker ?? this.executionBroker,
      },
    )
  }

  readOnlyFork(additional: Iterable<RuntimeTool> = []): ToolRuntime {
    const tools = [...this.tools.values()]
      .map(({ tool }) => tool)
      .concat([...additional])
      .filter((tool) => {
        const effect = tool.definition.execution?.sideEffect
        return effect === 'none' || effect === 'read'
      })
    return new ToolRuntime(tools, {
      artifactStore: this.artifactStore,
      exposeArtifactTool: false,
      executionBroker: this.executionBroker,
    })
  }

  validateInput(name: string, input: Record<string, unknown>): ToolResult | undefined {
    const registration = this.tools.get(name)
    if (!registration) {
      return {
        ok: false,
        summary: `Unknown tool: ${name}`,
        error: { code: 'TOOL_NOT_FOUND', category: 'not_found', retryable: false },
      }
    }
    if (registration.validateInput(input)) return undefined
    return {
      ok: false,
      summary: schemaValidationSummary(
        'Tool input did not match its registered schema',
        registration.validateInput.errors,
      ),
      error: { code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: true },
    }
  }

  executionDescriptor(
    name: string,
    input: Record<string, unknown>,
    cwd: string,
  ): ToolExecutionDescriptor | undefined {
    return this.tools.has(name) ? this.prepare(name, input, cwd).descriptor : undefined
  }

  requiresPermission(name: string, input: Record<string, unknown>, cwd: string): boolean {
    return this.permissionRequirement(name, input, cwd) !== undefined
  }

  permissionRequirement(
    name: string,
    input: Record<string, unknown>,
    cwd: string,
  ): PermissionRequirement | undefined {
    return this.tools.has(name) ? this.prepare(name, input, cwd).permission : undefined
  }

  prepare(name: string, input: Record<string, unknown>, cwd: string): PreparedToolInvocation {
    const registration = this.tools.get(name)
    if (!registration) {
      throw runtimeError('TOOL_NOT_FOUND', 'tool', `Unknown tool: ${name}`)
    }
    const execution = registration.tool.definition.execution ?? conservativeExecution()
    const workspace = resolveWorkspacePath(cwd, '.')
    const pathField = execution.target.kind === 'input_path' ? execution.target.field : undefined
    const requestedPath =
      pathField === undefined
        ? undefined
        : typeof input[pathField] === 'string' && input[pathField].length > 0
          ? input[pathField]
          : '.'
    const resolvedTarget =
      execution.target.kind === 'none'
        ? undefined
        : execution.target.kind === 'workspace'
          ? workspace
          : resolveWorkspacePath(workspace.workspace, requestedPath!)
    const target = resolvedTarget?.canonical
    const conflictKey =
      execution.conflictScope === 'global'
        ? 'global'
        : execution.conflictScope === 'workspace'
          ? `workspace:${workspace.workspace}`
          : target === undefined
            ? `tool:${name}`
            : `target:${target}`
    const descriptor: ToolExecutionDescriptor = {
      sideEffect: execution.sideEffect,
      parallelSafe: execution.parallelSafe,
      ...(target === undefined ? {} : { target }),
      conflictKey,
      maxInlineBytes: execution.maxInlineBytes,
      ...(execution.timeoutMs === undefined ? {} : { timeoutMs: execution.timeoutMs }),
    }
    const permission = permissionFor(name, resolvedTarget, execution)
    return {
      name,
      input: { ...input },
      cwd: workspace.workspace,
      descriptor,
      ...(resolvedTarget === undefined ? {} : { targetIdentity: resolvedTarget.identity }),
      ...(permission === undefined ? {} : { permission }),
    }
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    cwd: string,
    signal: AbortSignal,
    onUpdate?: (update: ToolProgressUpdate) => void,
  ): Promise<ToolResult> {
    const invalid = this.validateInput(name, input)
    if (invalid) return invalid
    try {
      return await this.executePrepared(this.prepare(name, input, cwd), signal, onUpdate)
    } catch (error) {
      return toolFailureResult(error)
    }
  }

  async executePrepared(
    prepared: PreparedToolInvocation,
    signal: AbortSignal,
    onUpdate?: (update: ToolProgressUpdate) => void,
  ): Promise<ToolResult> {
    const registration = this.tools.get(prepared.name)
    if (!registration) {
      return {
        ok: false,
        summary: `Unknown tool: ${prepared.name}`,
        error: { code: 'TOOL_NOT_FOUND', category: 'not_found', retryable: false },
      }
    }
    const invalid = this.validateInput(prepared.name, prepared.input)
    if (invalid) return invalid
    const descriptor = prepared.descriptor
    const request: ToolRequest = {
      name: prepared.name,
      input: prepared.input,
      cwd: prepared.cwd,
      ...(descriptor.target === undefined ? {} : { resolvedTarget: descriptor.target }),
      signal,
      ...(descriptor.timeoutMs === undefined
        ? {}
        : { deadlineAt: canonicalDeadlineAfter(Date.now(), descriptor.timeoutMs) }),
      ...(onUpdate === undefined
        ? {}
        : {
            onUpdate: (update: ToolProgressUpdate) => {
              if (typeof update.message !== 'string' || update.message.length === 0) return
              onUpdate({
                message: update.message.slice(0, 512),
                ...(update.stream === undefined ? {} : { stream: update.stream }),
                ...(update.delta === undefined ? {} : { delta: update.delta.slice(0, 4_096) }),
                ...(update.bytes === undefined
                  ? {}
                  : { bytes: Math.max(0, Math.floor(update.bytes)) }),
              })
            },
          }),
    }
    try {
      const invoke = () => {
        assertPreparedTarget(prepared, registration.tool)
        return registration.tool.execute(request)
      }
      const execute = () =>
        descriptor.sideEffect === 'write'
          ? this.mutations.run(descriptor.conflictKey, invoke)
          : invoke()
      const result =
        this.executionBroker === undefined
          ? await execute()
          : await this.executionBroker.execute(prepared, signal, execute)
      if (
        typeof result !== 'object' ||
        result === null ||
        typeof result.ok !== 'boolean' ||
        typeof result.summary !== 'string'
      ) {
        return {
          ok: false,
          summary: 'Tool returned an invalid result envelope.',
          error: { code: 'TOOL_RESULT_INVALID', category: 'validation', retryable: false },
        }
      }
      if (result.output !== undefined && !registration.validateOutput(result.output)) {
        return {
          ok: false,
          summary: 'Tool output did not match its registered schema.',
          error: { code: 'TOOL_OUTPUT_INVALID', category: 'validation', retryable: false },
        }
      }
      const boundedResult =
        result.ok || result.error !== undefined
          ? result
          : {
              ...result,
              error: {
                code: 'TOOL_RETURNED_ERROR',
                category: 'execution' as const,
                retryable: true,
              },
            }
      const bytes = boundedResult.output === undefined ? 0 : serializedBytes(boundedResult.output)
      if (!Number.isFinite(bytes)) {
        return {
          ok: false,
          summary: 'Tool output was not serializable.',
          error: { code: 'TOOL_OUTPUT_INVALID', category: 'validation', retryable: false },
        }
      }
      if (boundedResult.output !== undefined && bytes > descriptor.maxInlineBytes) {
        const artifact = await this.artifactStore.put(boundedResult.output)
        return {
          ...boundedResult,
          output: { type: 'artifact_ref', artifact },
          artifacts: [...(boundedResult.artifacts ?? []), artifact],
        }
      }
      return boundedResult
    } catch (error) {
      return toolFailureResult(error)
    }
  }
}

/**
 * Give the model enough schema feedback to self-correct without echoing input
 * values. Ajv messages contain schema constraints and instance paths only;
 * control characters are removed and both item count and total length are
 * bounded before the result re-enters model context.
 */
function schemaValidationSummary(
  prefix: string,
  errors: readonly ErrorObject[] | null | undefined,
): string {
  const details = (errors ?? [])
    .slice(0, 3)
    .map((error) => {
      const additionalProperty =
        error.keyword === 'additionalProperties' &&
        typeof error.params.additionalProperty === 'string'
          ? error.params.additionalProperty
          : undefined
      const path = boundedSchemaFeedback(
        additionalProperty === undefined
          ? error.instancePath || '/'
          : `${error.instancePath}/${jsonPointerSegment(additionalProperty)}`,
      )
      if (additionalProperty !== undefined) return `${path} is not allowed by schema`
      const message = boundedSchemaFeedback(error.message ?? error.keyword)
      return `${path} ${message}`
    })
    .filter((value) => value.length > 1)
  if (details.length === 0) return `${prefix}.`
  return `${prefix}: ${details.join('; ')}`.slice(0, 1_024).replace(/[.;:\s]*$/u, '.')
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function boundedSchemaFeedback(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, 256)
}

function conservativeExecution(): NonNullable<RuntimeTool['definition']['execution']> {
  return {
    sideEffect: 'process',
    target: { kind: 'workspace' },
    parallelSafe: false,
    conflictScope: 'global',
    maxInlineBytes: 65_536,
  }
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function toolFailureResult(error: unknown): ToolResult {
  const expectedFilesystemFailure = filesystemFailure(error)
  if (expectedFilesystemFailure) return expectedFilesystemFailure
  const failure = isRuntimeError(error)
    ? error
    : runtimeError('TOOL_EXECUTION_FAILED', 'tool', 'Tool execution failed.')
  return {
    ok: false,
    summary: failure.message,
    error: {
      code: failure.code,
      category: failure.category === 'permission' ? 'permission' : 'execution',
      retryable: failure.retryable,
    },
  }
}

function permissionFor(
  name: string,
  target: ReturnType<typeof resolveWorkspacePath> | undefined,
  execution: NonNullable<RuntimeTool['definition']['execution']>,
): PermissionRequirement | undefined {
  if (['read', 'ls', 'find'].includes(name) && target && !target.contained) {
    return {
      risk: 'medium',
      target: target.canonical,
      rule: `read-outside:${target.canonical}`,
    }
  }
  if ((name === 'write' || name === 'edit') && target) {
    return { risk: 'high', target: target.canonical, rule: `${name}:${target.canonical}` }
  }
  if (name === 'shell' && target) {
    return { risk: 'high', target: target.canonical, rule: `shell:${target.canonical}` }
  }
  if (
    (name.startsWith('mcp__') || name.startsWith('process__')) &&
    execution.sideEffect === 'process' &&
    target
  ) {
    return {
      risk: 'high',
      target: target.canonical,
      rule: `process-tool:${name}:${target.canonical}`,
    }
  }
  return undefined
}

function assertPreparedTarget(prepared: PreparedToolInvocation, tool: RuntimeTool): void {
  const execution = tool.definition.execution ?? conservativeExecution()
  if (execution.target.kind === 'none' || prepared.descriptor.target === undefined) return
  const requestedInput =
    execution.target.kind === 'workspace' ? '.' : prepared.input[execution.target.field]
  const requested =
    typeof requestedInput === 'string' && requestedInput.length > 0 ? requestedInput : '.'
  const current = resolveWorkspacePath(prepared.cwd, requested)
  if (
    current.canonical === prepared.descriptor.target &&
    prepared.targetIdentity !== undefined &&
    matchesTargetIdentity(prepared.targetIdentity)
  ) {
    return
  }
  throw runtimeError('TOOL_PATH_CHANGED', 'permission', 'Tool target changed after authorization.')
}
