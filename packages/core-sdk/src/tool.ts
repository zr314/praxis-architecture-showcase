import type { VerifiedPlanControlFactV1 } from './review-plan.js'
import type { PlanExecutionBindingV1 } from './workflow-execution.js'

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execution?: {
    sideEffect: 'none' | 'read' | 'write' | 'process' | 'network'
    target: { kind: 'none' } | { kind: 'workspace' } | { kind: 'input_path'; field: string }
    parallelSafe: boolean
    conflictScope: 'target' | 'workspace' | 'global'
    maxInlineBytes: number
    timeoutMs?: number
  }
}

export type ArtifactReference = {
  artifactId: string
  digest: string
  mimeType: string
  bytes: number
}

export type ToolProgressUpdate = {
  message: string
  stream?: 'stdout' | 'stderr'
  delta?: string
  bytes?: number
}

export type ToolResult = {
  ok: boolean
  summary: string
  output?: unknown
  artifacts?: ArtifactReference[]
  error?: {
    code: string
    category: 'validation' | 'permission' | 'not_found' | 'execution' | 'truncated'
    retryable: boolean
  }
}

export type ToolRequest = {
  name: string
  input: Record<string, unknown>
  cwd: string
  resolvedTarget?: string
  signal: AbortSignal
  deadlineAt?: string
  executionContext?: ToolExecutionContextV1
  onUpdate?: (update: ToolProgressUpdate) => void
}

export type PlanToolInvocationContextV1 = Readonly<{
  invocationId: `pti_${string}`
  sessionId: string
  runId: string
  providerTurnId: string
  providerToolCallId: string
}>

export type ToolExecutionContextV1 = Readonly<{
  invocation: PlanToolInvocationContextV1
  planBinding?: PlanExecutionBindingV1
  planControlGrant?: VerifiedPlanControlFactV1
}>

export type ToolExecutionDescriptor = {
  sideEffect: NonNullable<ToolDefinition['execution']>['sideEffect']
  parallelSafe: boolean
  target?: string
  conflictKey: string
  maxInlineBytes: number
  timeoutMs?: number
}

export type PermissionRequirement = {
  risk: 'medium' | 'high'
  target?: string
  rule: string
}

export type ToolTargetIdentity = {
  path: string
  device: string
  inode: string
  birthtimeNs: string
}

export type PreparedToolInvocation = {
  name: string
  input: Record<string, unknown>
  cwd: string
  descriptor: ToolExecutionDescriptor
  targetIdentity?: ToolTargetIdentity
  permission?: PermissionRequirement
  executionContext?: ToolExecutionContextV1
}

/** Capability-neutral tool contract used by plugins and execution loops. */
export interface RuntimeTool {
  readonly definition: ToolDefinition
  execute(request: ToolRequest): Promise<ToolResult>
}
