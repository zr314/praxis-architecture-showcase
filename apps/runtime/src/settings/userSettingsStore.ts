import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type ModelPreference = {
  provider: string
  model: string
  updatedAt: string
}

type UserSettingsFile = {
  version: 1
  defaultModel?: ModelPreference
}

const EMPTY_SETTINGS: UserSettingsFile = { version: 1 }

/**
 * Runtime-owned, non-secret user preferences.
 *
 * Credentials remain in the encrypted credential store; this file only remembers
 * which authenticated provider/model pair should be selected for a new session.
 */
export class UserSettingsStore {
  readonly #path: string

  constructor(root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')) {
    this.#path = join(root, 'settings.json')
  }

  async defaultModel(): Promise<ModelPreference | undefined> {
    const preference = (await this.#read()).defaultModel
    return preference ? { ...preference } : undefined
  }

  async setDefaultModel(provider: string, model: string): Promise<ModelPreference> {
    validateIdentifier(provider, 'provider')
    validateIdentifier(model, 'model')
    const preference = {
      provider,
      model,
      updatedAt: new Date().toISOString(),
    }
    await atomicSettingsWrite(this.#path, {
      ...(await this.#read()),
      defaultModel: preference,
    })
    return { ...preference }
  }

  async #read(): Promise<UserSettingsFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as unknown
      return isUserSettingsFile(parsed) ? parsed : EMPTY_SETTINGS
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) return EMPTY_SETTINGS
      throw error
    }
  }
}

async function atomicSettingsWrite(path: string, settings: UserSettingsFile): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${JSON.stringify(settings, undefined, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, path)
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

function isUserSettingsFile(value: unknown): value is UserSettingsFile {
  if (!value || typeof value !== 'object') return false
  const settings = value as Partial<UserSettingsFile>
  return (
    settings.version === 1 &&
    (settings.defaultModel === undefined || isModelPreference(settings.defaultModel))
  )
}

function isModelPreference(value: unknown): value is ModelPreference {
  if (!value || typeof value !== 'object') return false
  const preference = value as Partial<ModelPreference>
  return (
    isIdentifier(preference.provider) &&
    isIdentifier(preference.model) &&
    typeof preference.updatedAt === 'string' &&
    Number.isFinite(Date.parse(preference.updatedAt))
  )
}

function validateIdentifier(value: string, name: string): void {
  if (!isIdentifier(value)) {
    throw new TypeError(`${name} must be 1-256 printable characters.`)
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
  )
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
