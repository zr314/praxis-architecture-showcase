import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  SESSION_EVENT_TYPES,
  SUPPORTED_PROTOCOL_VERSIONS,
  type RuntimeMethod,
  type SessionEvent,
} from '@praxis/protocol'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type Assert<Value extends true> = Value

const methodTypesMatch: Assert<Equal<RuntimeMethod, (typeof RUNTIME_METHODS)[number]>> = true
const eventTypesMatch: Assert<Equal<SessionEvent['type'], (typeof SESSION_EVENT_TYPES)[number]>> =
  true
void methodTypesMatch
void eventTypesMatch

test('protocol constants match every method and event discriminator in the v1 schemas', async () => {
  const methods = JSON.parse(
    await readFile(
      new URL('../packages/protocol/schemas/methods-v1.schema.json', import.meta.url),
      'utf8',
    ),
  ) as { $defs: Record<string, unknown> }
  const events = JSON.parse(
    await readFile(
      new URL('../packages/protocol/schemas/events-v1.schema.json', import.meta.url),
      'utf8',
    ),
  ) as { $defs: Record<string, unknown> }

  assert.deepEqual(
    [...collectConstants(methods.$defs.request, methods.$defs, 'method')].sort(),
    [...RUNTIME_METHODS].sort(),
  )
  assert.deepEqual(
    [...collectConstants(events.$defs.sessionEvent, events.$defs, 'type')].sort(),
    [...SESSION_EVENT_TYPES].sort(),
  )
})

test('v1 negotiation advertises the preferred and supported versions explicitly', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, [1])
})

function collectConstants(
  schema: unknown,
  definitions: Record<string, unknown>,
  property: string,
  seen = new Set<unknown>(),
): Set<string> {
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return new Set()
  seen.add(schema)
  const value = schema as Record<string, unknown>
  const constants = new Set<string>()

  if (typeof value.$ref === 'string') {
    const name = value.$ref.split('/').at(-1)
    if (name && definitions[name]) {
      for (const constant of collectConstants(definitions[name], definitions, property, seen)) {
        constants.add(constant)
      }
    }
  }
  const properties = value.properties as Record<string, unknown> | undefined
  const propertySchema = properties?.[property] as Record<string, unknown> | undefined
  if (typeof propertySchema?.const === 'string') constants.add(propertySchema.const)

  for (const keyword of ['oneOf', 'allOf', 'anyOf'] as const) {
    const children = value[keyword]
    if (!Array.isArray(children)) continue
    for (const child of children) {
      for (const constant of collectConstants(child, definitions, property, seen)) {
        constants.add(constant)
      }
    }
  }
  return constants
}
