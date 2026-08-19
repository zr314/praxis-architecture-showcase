import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'
import type {
  CredentialProtectionStatus,
  CredentialStore,
  StoredCredential,
} from './credentialStore.js'

type EncryptedRecord = Omit<StoredCredential, 'value'> & {
  nonce: string
  ciphertext: string
  tag: string
}

type EncryptedFile = {
  version: 2
  protection: 'aes-256-gcm-key-file'
  credentials: EncryptedRecord[]
}

type LegacyFile = {
  version: 1
  credentials: StoredCredential[]
}

/** Encrypted-at-rest store with a restrictive per-user key-file fallback. */
export class EncryptedFileCredentialStore implements CredentialStore {
  readonly #path: string
  readonly #keyPath: string

  constructor(root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')) {
    this.#path = join(root, 'credentials.json')
    this.#keyPath = join(root, 'credential.key')
  }

  async get(provider: string, name: string): Promise<StoredCredential | undefined> {
    const credentials = await this.#readPlain()
    const found = credentials.find(
      (credential) => credential.provider === provider && credential.name === name,
    )
    return found ? { ...found } : undefined
  }

  async set(credential: StoredCredential): Promise<void> {
    validateCredential(credential)
    const credentials = await this.#readPlain()
    const index = credentials.findIndex(
      (stored) => stored.provider === credential.provider && stored.name === credential.name,
    )
    if (index >= 0) credentials[index] = { ...credential }
    else credentials.push({ ...credential })
    await this.#writePlain(credentials)
  }

  async delete(provider: string, name?: string): Promise<void> {
    await this.#writePlain(
      (await this.#readPlain()).filter(
        (credential) =>
          credential.provider !== provider || (name !== undefined && credential.name !== name),
      ),
    )
  }

  async list(provider?: string): Promise<Array<Omit<StoredCredential, 'value'>>> {
    return (await this.#readPlain())
      .filter((credential) => provider === undefined || credential.provider === provider)
      .map(({ value: _value, ...metadata }) => ({ ...metadata }))
  }

  async protectionStatus(): Promise<CredentialProtectionStatus> {
    return { encrypted: true, backend: 'aes-256-gcm-key-file', osDelegated: false }
  }

  async #readPlain(): Promise<StoredCredential[]> {
    let parsed: EncryptedFile | LegacyFile
    try {
      await this.#assertPermissions(this.#path)
      parsed = JSON.parse(await readFile(this.#path, 'utf8')) as EncryptedFile | LegacyFile
    } catch (error) {
      if (isNotFound(error)) return []
      throw credentialError('CREDENTIAL_STORE_UNAVAILABLE')
    }
    if (parsed.version === 1) {
      if (!Array.isArray(parsed.credentials) || !parsed.credentials.every(isStoredCredential)) {
        throw credentialError('CREDENTIAL_STORE_INVALID')
      }
      await this.#writePlain(parsed.credentials)
      return parsed.credentials.map((credential) => ({ ...credential }))
    }
    if (
      parsed.version !== 2 ||
      parsed.protection !== 'aes-256-gcm-key-file' ||
      !Array.isArray(parsed.credentials)
    ) {
      throw credentialError('CREDENTIAL_STORE_INVALID')
    }
    const key = await this.#key(false)
    return parsed.credentials.map((record) => decryptRecord(record, key))
  }

  async #writePlain(credentials: StoredCredential[]): Promise<void> {
    const key = await this.#key(true)
    const file: EncryptedFile = {
      version: 2,
      protection: 'aes-256-gcm-key-file',
      credentials: credentials.map((credential) => encryptRecord(credential, key)),
    }
    await atomicSecretWrite(this.#path, `${JSON.stringify(file, undefined, 2)}\n`)
  }

  async #key(create: boolean): Promise<Buffer> {
    try {
      await this.#assertPermissions(this.#keyPath)
      const key = Buffer.from((await readFile(this.#keyPath, 'utf8')).trim(), 'base64')
      if (key.byteLength !== 32) throw credentialError('CREDENTIAL_KEY_INVALID')
      return key
    } catch (error) {
      if (!isNotFound(error) || !create) throw error
      const key = randomBytes(32)
      await mkdir(dirname(this.#keyPath), { recursive: true, mode: 0o700 })
      await writeFile(this.#keyPath, `${key.toString('base64')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await chmod(this.#keyPath, 0o600)
      return key
    }
  }

  async #assertPermissions(path: string): Promise<void> {
    if (process.platform === 'win32') return
    try {
      if (((await stat(path)).mode & 0o077) !== 0) {
        throw credentialError('CREDENTIAL_FILE_PERMISSIONS')
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}

function encryptRecord(credential: StoredCredential, key: Buffer): EncryptedRecord {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(credential.value, 'utf8'), cipher.final()])
  const { value: _value, ...metadata } = credential
  return {
    ...metadata,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

function decryptRecord(record: EncryptedRecord, key: Buffer): StoredCredential {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64'))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    const value = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const { nonce: _nonce, ciphertext: _ciphertext, tag: _tag, ...metadata } = record
    const credential = { ...metadata, value }
    validateCredential(credential)
    return credential
  } catch {
    throw credentialError('CREDENTIAL_DECRYPT_FAILED')
  }
}

async function atomicSecretWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function validateCredential(credential: StoredCredential): void {
  if (
    !credential.provider ||
    !credential.name ||
    !credential.value ||
    !Number.isFinite(Date.parse(credential.updatedAt)) ||
    (credential.expiresAt !== undefined && !Number.isFinite(Date.parse(credential.expiresAt)))
  ) {
    throw credentialError('CREDENTIAL_INVALID')
  }
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object') return false
  const credential = value as StoredCredential
  return (
    typeof credential.provider === 'string' &&
    typeof credential.name === 'string' &&
    typeof credential.value === 'string' &&
    typeof credential.updatedAt === 'string'
  )
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function credentialError(code: string) {
  return runtimeError(code, 'configuration', `Credential storage failed (${code}).`)
}
