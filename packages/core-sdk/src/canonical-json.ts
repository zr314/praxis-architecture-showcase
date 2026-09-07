import { createHash } from 'node:crypto'
import { runtimeError } from './contracts.js'

export type CanonicalJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValueV1[]
  | Readonly<{ [key: string]: CanonicalJsonValueV1 }>

export function canonicalJsonV1(value: unknown): string {
  return serialize(value, new WeakSet<object>())
}

export function canonicalBytesV1(value: unknown): Uint8Array {
  return Buffer.from(canonicalJsonV1(value), 'utf8')
}

export function canonicalDigestV1(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalBytesV1(value)).digest('hex')}`
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') invalid()
  if (seen.has(value)) invalid()
  seen.add(value)

  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value)
    if (
      ownKeys.some((key) => typeof key === 'symbol') ||
      ownKeys.some((key) =>
        typeof key === 'string' && key !== 'length' ? !/^(0|[1-9][0-9]*)$/u.test(key) : false,
      ) ||
      Object.keys(value).length !== value.length
    ) {
      invalid()
    }
    return `[${value.map((entry) => serialize(entry, seen)).join(',')}]`
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol') ||
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined,
    )
  ) {
    invalid()
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort(compareCodeUnits)
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key], seen)}`)
    .join(',')}}`
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalid(): never {
  throw runtimeError(
    'CANONICAL_JSON_INVALID',
    'configuration',
    'Canonical JSON input must contain only finite JSON values with unique plain-object identity.',
  )
}
