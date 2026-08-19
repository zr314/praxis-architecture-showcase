type SqliteModule = Readonly<{
  DatabaseSync: typeof import('node:sqlite').DatabaseSync
}>

type BunSqliteStatement = Readonly<{
  get: (...values: unknown[]) => unknown
  all: (...values: unknown[]) => unknown[]
  run: (...values: unknown[]) => unknown
}>

type BunSqliteDatabase = Readonly<{
  exec: (sql: string) => unknown
  prepare: (sql: string) => BunSqliteStatement
  close: () => void
}>

type BunSqliteConstructor = new (path: string) => BunSqliteDatabase

let sqliteModule: Promise<SqliteModule> | undefined

/** Loads the host runtime's built-in synchronous SQLite implementation. */
export function loadNodeSqlite(): Promise<SqliteModule> {
  sqliteModule ??= importRuntimeSqlite()
  return sqliteModule
}

async function importRuntimeSqlite(): Promise<SqliteModule> {
  if (typeof Reflect.get(process.versions, 'bun') === 'string') {
    const specifier = 'bun:sqlite'
    const { Database } = (await import(specifier)) as {
      Database: BunSqliteConstructor
    }
    return bunSqliteModule(Database)
  }
  return importNodeSqliteWithoutExperimentalWarning()
}

function bunSqliteModule(Database: BunSqliteConstructor): SqliteModule {
  class BunDatabaseSyncAdapter {
    readonly #database: BunSqliteDatabase

    constructor(path: string) {
      this.#database = new Database(path)
    }

    exec(sql: string): void {
      this.#database.exec(sql)
    }

    prepare(sql: string) {
      const statement = this.#database.prepare(sql)
      return {
        get: (...values: unknown[]) => statement.get(...values) ?? undefined,
        all: (...values: unknown[]) => statement.all(...values),
        run: (...values: unknown[]) => statement.run(...values),
      }
    }

    close(): void {
      this.#database.close()
    }
  }

  return {
    DatabaseSync: BunDatabaseSyncAdapter as unknown as typeof import('node:sqlite').DatabaseSync,
  }
}

async function importNodeSqliteWithoutExperimentalWarning(): Promise<SqliteModule> {
  const original = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    const option = args[0]
    const type =
      typeof option === 'string'
        ? option
        : typeof option === 'object' && option !== null && 'type' in option
          ? Reflect.get(option, 'type')
          : undefined
    if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return
    Reflect.apply(original, process, [warning, ...args])
  }) as typeof process.emitWarning
  try {
    return await import('node:sqlite')
  } finally {
    process.emitWarning = original
  }
}
