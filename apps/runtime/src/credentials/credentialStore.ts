import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'

type CredentialFile = {
  version: 1
  credentials: StoredCredential[]
}

export type StoredCredential = {
  provider: string
  name: string
  value: string
  updatedAt: string
  expiresAt?: string
}

export type CredentialProtectionStatus = {
  encrypted: boolean
  backend: string
  osDelegated: boolean
}

export interface CredentialStore {
  get(provider: string, name: string): Promise<StoredCredential | undefined>
  set(credential: StoredCredential): Promise<void>
  delete(provider: string, name?: string): Promise<void>
  list(provider?: string): Promise<Array<Omit<StoredCredential, 'value'>>>
  protectionStatus?(): Promise<CredentialProtectionStatus>
}

export class FileCredentialStore implements CredentialStore {
  readonly #path: string

  constructor(root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')) {
    this.#path = join(root, 'credentials.json')
  }

  async get(provider: string, name: string): Promise<StoredCredential | undefined> {
    const file = await this.#read()
    const found = file.credentials.find(
      (credential) => credential.provider === provider && credential.name === name,
    )
    return found ? { ...found } : undefined
  }

  async set(credential: StoredCredential): Promise<void> {
    validateCredential(credential)
    const file = await this.#read()
    const index = file.credentials.findIndex(
      (stored) => stored.provider === credential.provider && stored.name === credential.name,
    )
    if (index >= 0) file.credentials[index] = { ...credential }
    else file.credentials.push({ ...credential })
    await this.#write(file)
  }

  async delete(provider: string, name?: string): Promise<void> {
    const file = await this.#read()
    file.credentials = file.credentials.filter(
      (credential) =>
        credential.provider !== provider || (name !== undefined && credential.name !== name),
    )
    await this.#write(file)
  }

  async list(provider?: string): Promise<Array<Omit<StoredCredential, 'value'>>> {
    const file = await this.#read()
    return file.credentials
      .filter((credential) => provider === undefined || credential.provider === provider)
      .map(({ value: _value, ...credential }) => ({ ...credential }))
  }

  async protectionStatus(): Promise<CredentialProtectionStatus> {
    return { encrypted: false, backend: 'restrictive-file', osDelegated: false }
  }

  async #read(): Promise<CredentialFile> {
    try {
      await this.#assertPermissions()
      const value = JSON.parse(await readFile(this.#path, 'utf8')) as CredentialFile
      if (
        value.version !== 1 ||
        !Array.isArray(value.credentials) ||
        !value.credentials.every(isStoredCredential)
      ) {
        throw new SyntaxError('Invalid credential store.')
      }
      return {
        version: 1,
        credentials: value.credentials.map((credential) => ({ ...credential })),
      }
    } catch (error) {
      if (isNotFound(error)) return { version: 1, credentials: [] }
      if (isCredentialError(error)) throw error
      throw runtimeError(
        error instanceof SyntaxError ? 'CREDENTIAL_STORE_INVALID' : 'CREDENTIAL_STORE_UNAVAILABLE',
        'configuration',
        'Credential storage is unavailable.',
      )
    }
  }

  async #write(file: CredentialFile): Promise<void> {
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify(file, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(temporary, 0o600)
    await rename(temporary, this.#path)
    await chmod(this.#path, 0o600)
  }

  async #assertPermissions(): Promise<void> {
    if (process.platform === 'win32') return
    try {
      const info = await stat(this.#path)
      if ((info.mode & 0o077) !== 0) {
        throw runtimeError(
          'CREDENTIAL_FILE_PERMISSIONS',
          'configuration',
          'Credential file permissions are too broad.',
        )
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}

function validateCredential(credential: StoredCredential): void {
  if (
    !credential.provider ||
    !credential.name ||
    !credential.value ||
    !Number.isFinite(Date.parse(credential.updatedAt)) ||
    (credential.expiresAt !== undefined && !Number.isFinite(Date.parse(credential.expiresAt)))
  ) {
    throw runtimeError('CREDENTIAL_INVALID', 'configuration', 'Credential record is invalid.')
  }
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object') return false
  const credential = value as StoredCredential
  return (
    typeof credential.provider === 'string' &&
    typeof credential.name === 'string' &&
    typeof credential.value === 'string' &&
    typeof credential.updatedAt === 'string' &&
    (credential.expiresAt === undefined || typeof credential.expiresAt === 'string')
  )
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isCredentialError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('CREDENTIAL_')
  )
}
