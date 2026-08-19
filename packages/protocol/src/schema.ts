import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import pluginManifestSchema from '@praxis/plugin-protocol/manifest-schema'
import eventsSchema from '../schemas/events-v1.schema.json'
import methodsSchema from '../schemas/methods-v1.schema.json'
import protocolSchema from '../schemas/protocol-v1.schema.json'
import type { RuntimeMethod } from './constants.js'
import type { EventNotification, JsonRpcRequest, JsonRpcResponse } from './types.js'

const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addSchema(pluginManifestSchema)
ajv.addSchema(methodsSchema)
ajv.addSchema(eventsSchema)

const validate = ajv.compile(protocolSchema) as ValidateFunction<unknown>
const resultValidators = new Map<RuntimeMethod, ValidateFunction<unknown>>()

const resultDefinitionByMethod: Record<RuntimeMethod, string> = {
  initialize: 'initializeResult',
  'events.subscribe': 'subscribeResult',
  'auth.status': 'authStatusResult',
  'auth.login': 'loginResult',
  'auth.logout': 'okResult',
  'models.list': 'modelListResult',
  'settings.get': 'settingsResult',
  'settings.model.set': 'settingsResult',
  'runtime.doctor': 'doctorResult',
  'commands.list': 'commandCatalogResult',
  'commands.invoke': 'commandInvokeResult',
  'plugin.install': 'pluginStatusResult',
  'plugin.list': 'pluginStatusListResult',
  'plugin.inspect': 'pluginInspectionResult',
  'plugin.enable': 'pluginStatusResult',
  'plugin.disable': 'okResult',
  'plugin.permissions': 'pluginPermissionsResult',
  'plugin.doctor': 'pluginDoctorResult',
  'plugin.update': 'pluginStatusResult',
  'plugin.rollback': 'pluginStatusResult',
  'plugin.uninstall': 'okResult',
  'resource.list': 'resourceListResult',
  'resource.inspect': 'resourceResult',
  'resource.enable': 'resourceResult',
  'resource.disable': 'okResult',
  'session.create': 'sessionResult',
  'session.list': 'sessionListResult',
  'session.search': 'sessionListResult',
  'session.inspect': 'sessionResult',
  'session.resume': 'sessionResult',
  'session.rename': 'sessionResult',
  'session.configure': 'sessionResult',
  'session.close': 'okResult',
  'session.delete': 'trashResult',
  'session.export': 'sessionExportResult',
  'session.transcript': 'sessionTranscriptResult',
  'session.fork': 'sessionResult',
  'session.branch': 'sessionResult',
  'session.compact': 'compactResult',
  'session.plan': 'sessionPlanResult',
  'workflow.get': 'workflowResult',
  'workflow.list': 'workflowListResult',
  'workflow.events': 'workflowEventsResult',
  'workflow.signal': 'acceptedResult',
  'workflow.pause': 'workflowResult',
  'workflow.resume': 'workflowResult',
  'workflow.cancel': 'workflowResult',
  'workflow.terminate': 'workflowResult',
  'workflow.human-tasks.list': 'workflowHumanTaskListResult',
  'workflow.human-task.resolve': 'workflowHumanTaskResult',
  'workflow.retry-node': 'workflowResult',
  'workflow.resolve-unknown': 'workflowResult',
  'artifacts.list': 'artifactListResult',
  'session.prompt': 'runResult',
  'session.follow_up': 'runResult',
  'session.steer': 'steerResult',
  'session.abort': 'acceptedResult',
  'trace.export': 'traceExportResult',
  'permission.decide': 'acceptedResult',
  shutdown: 'acceptedResult',
}

export type ProtocolMessage = JsonRpcRequest | JsonRpcResponse | EventNotification

export class ProtocolCodecError extends Error {
  constructor(
    readonly kind: 'json' | 'schema',
    message: string,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ProtocolCodecError'
  }
}

export function isProtocolMessage(message: unknown): boolean {
  return validate(message)
}

export function assertProtocolMessage(message: unknown): void {
  if (validate(message)) return
  throw new ProtocolCodecError('schema', formatSchemaErrors(validate.errors), messageId(message))
}

export function assertProtocolResult(method: RuntimeMethod, id: string, result: unknown): void {
  let validateResult = resultValidators.get(method)
  if (!validateResult) {
    validateResult = ajv.compile({
      $ref: `praxis://schemas/methods-v1.json#/$defs/${resultDefinitionByMethod[method]}`,
    })
    resultValidators.set(method, validateResult)
  }
  if (validateResult({ jsonrpc: '2.0', id, result })) return
  throw new ProtocolCodecError(
    'schema',
    `Protocol result validation failed for ${method}: ${formatSchemaErrors(validateResult.errors)}`,
    id,
  )
}

export function parseProtocolMessage(source: string): ProtocolMessage {
  let message: unknown
  try {
    message = JSON.parse(source)
  } catch {
    throw new ProtocolCodecError('json', 'Invalid protocol JSON.')
  }
  assertProtocolMessage(message)
  return message as ProtocolMessage
}

function messageId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || !('id' in message)) return undefined
  return typeof message.id === 'string' && message.id.length > 0 ? message.id : undefined
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  const summary = (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
  return `Protocol schema validation failed: ${summary}`
}
