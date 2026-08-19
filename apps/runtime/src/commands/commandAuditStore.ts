import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type CommandAuditRecordV1, validateCommandAuditRecordV1 } from '@praxis/core-sdk'

export type CommandAuditAppendResultV1 = Readonly<{
  duplicate: boolean
  record: CommandAuditRecordV1
}>

/** Durable append-only boundary used before any Runtime command side effect. */
export interface CommandAuditStoreV1 {
  initialize(): Promise<void>
  append(record: CommandAuditRecordV1): Promise<CommandAuditAppendResultV1>
}

export class JsonlCommandAuditStoreV1 implements CommandAuditStoreV1 {
  readonly #records = new Map<string, CommandAuditRecordV1>()
  #tail = Promise.resolve()

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    await this.#serialize(async () => {
      this.#records.clear()
      let source: string
      try {
        source = await readFile(this.path, 'utf8')
      } catch (error) {
        if (isNotFound(error)) return
        throw auditFailure('COMMAND_AUDIT_READ_FAILED')
      }
      const lines = source.split('\n')
      if (lines.at(-1) === '') lines.pop()
      for (const line of lines) {
        if (!line) throw auditFailure('COMMAND_AUDIT_CORRUPT')
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          throw auditFailure('COMMAND_AUDIT_CORRUPT')
        }
        const record = validateCommandAuditRecordV1(parsed)
        this.#remember(record)
      }
    })
  }

  async append(input: CommandAuditRecordV1): Promise<CommandAuditAppendResultV1> {
    const record = validateCommandAuditRecordV1(input)
    return this.#serialize(async () => {
      const existing = this.#records.get(record.clientRequestId)
      if (existing !== undefined) {
        if (existing.invocationDigest !== record.invocationDigest) {
          throw auditFailure('COMMAND_CLIENT_REQUEST_COLLISION')
        }
        return Object.freeze({ duplicate: true, record: existing })
      }
      try {
        await mkdir(dirname(this.path), { recursive: true })
        const handle = await open(this.path, 'a')
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch {
        throw auditFailure('COMMAND_AUDIT_WRITE_FAILED')
      }
      this.#records.set(record.clientRequestId, record)
      return Object.freeze({ duplicate: false, record })
    })
  }

  #remember(record: CommandAuditRecordV1): void {
    const existing = this.#records.get(record.clientRequestId)
    if (existing === undefined) {
      this.#records.set(record.clientRequestId, record)
      return
    }
    if (existing.invocationDigest !== record.invocationDigest) {
      throw auditFailure('COMMAND_AUDIT_CORRUPT')
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export class MemoryCommandAuditStoreV1 implements CommandAuditStoreV1 {
  readonly records: CommandAuditRecordV1[] = []
  readonly #byRequest = new Map<string, CommandAuditRecordV1>()

  async initialize(): Promise<void> {}

  async append(input: CommandAuditRecordV1): Promise<CommandAuditAppendResultV1> {
    const record = validateCommandAuditRecordV1(input)
    const existing = this.#byRequest.get(record.clientRequestId)
    if (existing !== undefined) {
      if (existing.invocationDigest !== record.invocationDigest) {
        throw auditFailure('COMMAND_CLIENT_REQUEST_COLLISION')
      }
      return Object.freeze({ duplicate: true, record: existing })
    }
    this.records.push(record)
    this.#byRequest.set(record.clientRequestId, record)
    return Object.freeze({ duplicate: false, record })
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

function auditFailure(code: string): Error {
  return Object.assign(new Error(code), { code })
}
