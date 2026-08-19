import { Command, CommanderError, Option } from '@commander-js/extra-typings'
import { isPluginGrantArray, type PluginGrant } from '@praxis/plugin-protocol'
import { render } from 'ink'
import type { OutputFormat } from '@praxis/protocol'
import { migrateSessionStorageV3, type SessionStoreKindV3 } from '@praxis/runtime/storage'
import cliManifest from '../package.json' with { type: 'json' }
import { startLocalRuntime } from './bridge/localRuntime.js'
import { executeManagementAction, type ManagementAction, renderActionResult } from './cliActions.js'
import { renderNonInteractive } from './render/nonInteractive.js'
import { App } from './ui/App.js'
import { createClientCommandRegistryV1 } from './ui/clientCommandRegistry.js'
import { commandCatalogFromSnapshots } from './ui/commandCatalog.js'
import { executeSlashCommand } from './ui/slashCommands.js'
import { TUI_RENDER_OPTIONS } from './ui/renderOptions.js'
import { NativeTerminalOutput } from './ui/terminalOutput.js'
import { loadPolicyFile, policyDecision } from './policyFile.js'

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  let managementAction: ManagementAction | undefined
  let storageMigration:
    | Readonly<{ target: SessionStoreKindV3; home?: string; json: boolean }>
    | undefined

  const program = new Command()
    .name('praxis')
    .description('Praxis terminal frontend')
    .version(cliManifest.version)
    .enablePositionalOptions()
    .exitOverride()
    .option('-p, --print <prompt>', 'print response and exit')
    .option('--commands', 'list the active slash-command catalog and exit')
    .addOption(
      new Option('--output-format <format>', 'output format for --print')
        .choices(['text', 'json', 'stream-json'])
        .default('text'),
    )
    .option('--provider <id>', 'provider id for the session')
    .option('--model <id>', 'model id for the session')
    .option('--session <id>', 'resume an existing session')
    .addOption(
      new Option(
        '--planner <mode>',
        'override Planner policy for a newly created session (default: auto)',
      ).choices(['auto', 'solo', 'workflow', 'direct', 'supervisor']),
    )
    .addOption(
      new Option(
        '--storage <store>',
        'V3 Session storage backend for this Runtime process',
      ).choices(['jsonl', 'sqlite']),
    )
    .option('--context-tokens <count>', 'session context token limit', positiveInteger)
    .option('--max-turns <count>', 'maximum Provider turns', positiveInteger)
    .option('--max-tool-calls <count>', 'maximum Tool calls', nonNegativeInteger)
    .option('--max-tokens <count>', 'maximum run tokens', positiveInteger)
    .option('--timeout-ms <milliseconds>', 'run deadline in milliseconds', positiveInteger)
    .option('--policy-file <path>', 'non-interactive Tool policy JSON')
    .action(() => {})

  const auth = program
    .command('auth')
    .description('manage Runtime provider credentials')
    .action(() => missingCommand(auth, 'status, login, or logout'))

  auth
    .command('status')
    .description('show Provider authentication status')
    .argument('[provider]', 'provider id', 'kimi')
    .option('--json', 'emit one JSON document')
    .action((provider, options) => {
      managementAction = { kind: 'auth.status', provider, json: options.json ?? false }
    })

  auth
    .command('login')
    .description('connect a Provider securely')
    .argument('[provider]', 'provider id', 'kimi')
    .option('--stdin', 'read the API key from standard input')
    .option('--json', 'emit one JSON document')
    .action((provider, options) => {
      managementAction = {
        kind: 'auth.login',
        provider,
        stdin: options.stdin ?? false,
        json: options.json ?? false,
      }
    })

  auth
    .command('logout')
    .description('remove stored credentials for a Provider')
    .argument('[provider]', 'provider id', 'kimi')
    .option('--json', 'emit one JSON document')
    .action((provider, options) => {
      managementAction = { kind: 'auth.logout', provider, json: options.json ?? false }
    })

  program
    .command('doctor')
    .description('diagnose Runtime, Provider, storage, and isolation health')
    .option('--workspace <path>', 'workspace to diagnose')
    .option('--deep', 'replay and verify all SessionJournal commits and projections')
    .option('--json', 'emit one JSON document')
    .action((options) => {
      managementAction = {
        kind: 'doctor',
        workspace: options.workspace,
        deep: options.deep ?? false,
        json: options.json ?? false,
      }
    })

  const model = program
    .command('model')
    .description('inspect and select models')
    .action(() => missingCommand(model, 'list, current, or set'))

  model
    .command('list')
    .description('list catalog models')
    .option('--provider <id>', 'filter by provider id')
    .option('--json', 'emit one JSON document')
    .action((options) => {
      managementAction = {
        kind: 'model.list',
        provider: options.provider,
        json: options.json ?? false,
      }
    })

  model
    .command('current')
    .description('show the persisted default Provider/model')
    .option('--json', 'emit one JSON document')
    .action((options) => {
      managementAction = { kind: 'model.current', json: options.json ?? false }
    })

  model
    .command('set')
    .description('persist the default Provider/model')
    .argument('<provider>', 'provider id')
    .argument('<model>', 'model id')
    .option('--json', 'emit one JSON document')
    .action((provider, modelId, options) => {
      managementAction = {
        kind: 'model.set',
        provider,
        model: modelId,
        json: options.json ?? false,
      }
    })

  const sessionCommand = program
    .command('session')
    .description('inspect and manage durable sessions')
    .action(() =>
      missingCommand(sessionCommand, 'list, search, show, rename, fork, branch, export, or delete'),
    )

  sessionCommand
    .command('list')
    .description('list sessions newest first')
    .option('--workspace <path>', 'filter by exact canonical workspace')
    .option('--json', 'emit one JSON document')
    .action((options) => {
      managementAction = {
        kind: 'session.list',
        workspace: options.workspace,
        json: options.json ?? false,
      }
    })

  const storageCommand = program
    .command('storage')
    .description('inspect or migrate the V3 Session storage authority')
    .action(() => missingCommand(storageCommand, 'migrate'))

  storageCommand
    .command('migrate')
    .description('offline verified migration between JSONL and SQLite')
    .argument('<target>', 'target backend', (value) => sessionStoreKind(value))
    .option('--home <path>', 'explicit PRAXIS_HOME to migrate')
    .option('--json', 'emit one JSON document')
    .action((target, migrationOptions) => {
      storageMigration = {
        target,
        home: migrationOptions.home,
        json: migrationOptions.json ?? false,
      }
    })

  sessionCommand
    .command('search')
    .description('search session names, IDs, workspaces, and labels')
    .argument('<query>', 'search query')
    .option('--json', 'emit one JSON document')
    .action((query, options) => {
      managementAction = { kind: 'session.search', query, json: options.json ?? false }
    })

  sessionCommand
    .command('show')
    .description('inspect a session without reopening it')
    .argument('<id>', 'exact session id')
    .option('--json', 'emit one JSON document')
    .action((sessionId, options) => {
      managementAction = { kind: 'session.show', sessionId, json: options.json ?? false }
    })

  sessionCommand
    .command('rename')
    .description('rename a session')
    .argument('<id>', 'exact session id')
    .argument('<name>', 'new session name')
    .option('--json', 'emit one JSON document')
    .action((sessionId, name, options) => {
      managementAction = {
        kind: 'session.rename',
        sessionId,
        name,
        json: options.json ?? false,
      }
    })

  sessionCommand
    .command('fork')
    .description('fork a session transcript')
    .argument('<id>', 'exact source session id')
    .option('--name <name>', 'child session name')
    .option('--through-message <count>', 'copy through this message count', nonNegativeInteger)
    .option('--json', 'emit one JSON document')
    .action((sessionId, options) => {
      managementAction = {
        kind: 'session.fork',
        sessionId,
        name: options.name,
        throughMessage: options.throughMessage,
        json: options.json ?? false,
      }
    })

  sessionCommand
    .command('branch')
    .description('resolve a session tree to its active leaf (not a Git branch)')
    .argument('<id>', 'exact session id')
    .option('--json', 'emit one JSON document')
    .action((sessionId, options) => {
      managementAction = { kind: 'session.branch', sessionId, json: options.json ?? false }
    })

  sessionCommand
    .command('export')
    .description('export a versioned session document')
    .argument('<id>', 'exact session id')
    .requiredOption('-o, --output <path>', 'output JSON file')
    .option('--force', 'replace an existing output file')
    .option('--json', 'emit one JSON document')
    .action((sessionId, options) => {
      managementAction = {
        kind: 'session.export',
        sessionId,
        output: options.output,
        force: options.force ?? false,
        json: options.json ?? false,
      }
    })

  sessionCommand
    .command('delete')
    .description('move an exact session to recoverable trash')
    .argument('<id>', 'exact session id')
    .option('--yes', 'skip interactive exact-ID confirmation')
    .option('--json', 'emit one JSON document')
    .action((sessionId, options) => {
      managementAction = {
        kind: 'session.delete',
        sessionId,
        yes: options.yes ?? false,
        json: options.json ?? false,
      }
    })

  const trace = program
    .command('trace')
    .description('manage diagnostic traces')
    .action(() => missingCommand(trace, 'export'))

  trace
    .command('export')
    .description('export a diagnostic trace bundle')
    .argument('<traceId>', 'trace ID')
    .requiredOption('-o, --output <path>', 'output directory')
    .action((traceId, options) => {
      managementAction = { kind: 'trace.export', traceId, output: options.output }
    })

  const plugin = program.command('plugin').description('manage Runtime extensions')
  plugin
    .command('install')
    .argument('<source>', 'local plugin source directory')
    .action((source) => {
      managementAction = { kind: 'plugin.install', source }
    })
  plugin
    .command('list')
    .option('--workspace <path>', 'show enablement for a workspace')
    .action((pluginOptions) => {
      managementAction = { kind: 'plugin.list', workspace: pluginOptions.workspace }
    })
  plugin
    .command('inspect')
    .argument('<id>', 'plugin id')
    .option('--version <version>', 'installed version')
    .action((id, pluginOptions) => {
      managementAction = { kind: 'plugin.inspect', id, version: pluginOptions.version }
    })
  plugin
    .command('enable')
    .argument('<id>', 'plugin id')
    .requiredOption('--version <version>', 'fixed installed version')
    .option('--workspace <path>', 'workspace', process.cwd())
    .option('--grants <json>', 'approved grants JSON array', '[]')
    .action((id, pluginOptions) => {
      managementAction = {
        kind: 'plugin.enable',
        id,
        version: pluginOptions.version,
        workspace: pluginOptions.workspace,
        grants: parseGrantJson(pluginOptions.grants),
      }
    })
  plugin
    .command('disable')
    .argument('<id>', 'plugin id')
    .option('--workspace <path>', 'workspace', process.cwd())
    .action((id, pluginOptions) => {
      managementAction = {
        kind: 'plugin.disable',
        id,
        workspace: pluginOptions.workspace,
      }
    })
  plugin
    .command('permissions')
    .argument('<id>', 'plugin id')
    .option('--workspace <path>', 'workspace', process.cwd())
    .action((id, pluginOptions) => {
      managementAction = {
        kind: 'plugin.permissions',
        id,
        workspace: pluginOptions.workspace,
      }
    })
  plugin.command('doctor').action(() => {
    managementAction = { kind: 'plugin.doctor' }
  })
  plugin
    .command('update')
    .argument('<source>', 'local plugin source directory')
    .option('--workspace <path>', 'workspace', process.cwd())
    .option('--grants <json>', 'approved grants JSON array', '[]')
    .action((source, pluginOptions) => {
      managementAction = {
        kind: 'plugin.update',
        source,
        workspace: pluginOptions.workspace,
        grants: parseGrantJson(pluginOptions.grants),
      }
    })
  plugin
    .command('rollback')
    .argument('<id>', 'plugin id')
    .option('--workspace <path>', 'workspace', process.cwd())
    .action((id, pluginOptions) => {
      managementAction = {
        kind: 'plugin.rollback',
        id,
        workspace: pluginOptions.workspace,
      }
    })
  plugin
    .command('uninstall')
    .argument('<id>', 'plugin id')
    .requiredOption('--version <version>', 'installed version')
    .action((id, pluginOptions) => {
      managementAction = { kind: 'plugin.uninstall', id, version: pluginOptions.version }
    })

  const resource = program.command('resource').description('manage Skills and data resources')
  resource
    .command('list')
    .option('--workspace <path>', 'workspace', process.cwd())
    .action((resourceOptions) => {
      managementAction = {
        kind: 'resource.list',
        workspace: resourceOptions.workspace,
      }
    })
  resource
    .command('inspect')
    .argument('<id>', 'resource capability id')
    .option('--workspace <path>', 'workspace', process.cwd())
    .option('--content', 'include the bounded resource content')
    .action((id, resourceOptions) => {
      managementAction = {
        kind: 'resource.inspect',
        id,
        workspace: resourceOptions.workspace,
        includeContent: resourceOptions.content ?? false,
      }
    })
  resource
    .command('enable')
    .argument('<id>', 'resource capability id')
    .option('--workspace <path>', 'workspace', process.cwd())
    .option('--trust-project', 'explicitly trust project Skill discovery for this selection')
    .action((id, resourceOptions) => {
      managementAction = {
        kind: 'resource.enable',
        id,
        workspace: resourceOptions.workspace,
        projectTrusted: resourceOptions.trustProject ?? false,
      }
    })
  resource
    .command('disable')
    .argument('<id>', 'resource capability id')
    .option('--workspace <path>', 'workspace', process.cwd())
    .action((id, resourceOptions) => {
      managementAction = {
        kind: 'resource.disable',
        id,
        workspace: resourceOptions.workspace,
      }
    })

  try {
    program.parse([...argv])
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return
    throw error
  }
  const options = program.opts()
  if (storageMigration !== undefined) {
    const report = await migrateSessionStorageV3(storageMigration.target, {
      ...(storageMigration.home === undefined ? {} : { root: storageMigration.home }),
    })
    process.stdout.write(
      storageMigration.json
        ? `${JSON.stringify(report)}\n`
        : `${[
            `Session storage: ${report.source} -> ${report.target}`,
            report.changed ? 'Migration verified and activated.' : 'No migration was required.',
            `Sessions: ${report.sessionCount}; commits: ${report.commitCount}; entries: ${report.entryCount}.`,
            ...(report.backupDirectory === undefined
              ? []
              : [`Source backup: ${report.backupDirectory}`]),
          ].join('\n')}\n`,
    )
    return
  }
  const runtimeEnvironment = {
    ...process.env,
    ...(options.planner === undefined ? {} : { PRAXIS_PLANNER_MODE: options.planner }),
    ...(options.storage === undefined ? {} : { PRAXIS_SESSION_STORE: options.storage }),
    ...(managementAction?.kind === 'doctor' && managementAction.deep
      ? { PRAXIS_SESSION_SCRUB: 'deep' }
      : {}),
  }
  const bridge = await startLocalRuntime(undefined, runtimeEnvironment)
  if (managementAction) {
    try {
      renderActionResult(await executeManagementAction(bridge, managementAction))
    } finally {
      await bridge.dispose()
    }
    return
  }

  const session = options.session
    ? await bridge.resumeSession(options.session)
    : await bridge.createSession({
        cwd: process.cwd(),
        provider: options.provider,
        model: options.model,
        plannerMode: options.planner,
        contextLimitTokens: options.contextTokens,
      })

  if (options.print) {
    try {
      const format = options.outputFormat as OutputFormat
      const command = await executeSlashCommand(options.print, {
        bridge,
        session,
        cwd: session.cwd,
      })

      if (options.commands) {
        try {
          const runtimeCatalog = await bridge.listCommands(session.cwd)
          const clientCatalog = createClientCommandRegistryV1().snapshot({
            workspaceId: runtimeCatalog.workspaceId,
            workspaceTrusted: runtimeCatalog.workspaceTrusted,
            capabilityIds: runtimeCatalog.capabilityIds,
          })
          const lines = commandCatalogFromSnapshots([clientCatalog, runtimeCatalog]).map(
            ({ usage, description }) => `${usage.padEnd(28)} ${description}`,
          )
          process.stdout.write(`${lines.join('\n')}\n`)
        } finally {
          await bridge.dispose()
        }
        return
      }
      if (command.handled) {
        const data = {
          handled: true,
          ...(command.message === undefined ? {} : { message: command.message }),
          ...(command.action === undefined ? {} : { action: command.action }),
          ...(command.session === undefined ? {} : { session: command.session }),
        }
        process.stdout.write(
          `${format === 'text' ? (command.message ?? JSON.stringify(data, undefined, 2)) : JSON.stringify(data)}\n`,
        )
        return
      }
      const policy = options.policyFile ? await loadPolicyFile(options.policyFile) : undefined
      await renderNonInteractive(
        bridge.prompt({
          sessionId: session.sessionId,
          text: command.prompt ?? options.print,
          ...(command.commandInvocationId === undefined
            ? {}
            : { commandInvocationId: command.commandInvocationId }),
          budget: {
            maxTurns: options.maxTurns,
            maxToolCalls: options.maxToolCalls,
            maxTokens: options.maxTokens,
          },
          timeoutMs: options.timeoutMs,
        }),
        format,
        (requestId, decision) => bridge.decidePermission(requestId, decision),
        policy ? (event) => policyDecision(policy, event) : undefined,
      )
    } finally {
      await bridge.dispose()
    }
    return
  }

  const terminalOutput = new NativeTerminalOutput(process.stdout)
  const app = render(<App bridge={bridge} session={session} />, {
    ...TUI_RENDER_OPTIONS,
    stdout: terminalOutput as unknown as NodeJS.WriteStream,
  })
  try {
    await app.waitUntilExit()
  } finally {
    terminalOutput.finish()
    await bridge.dispose()
  }
}

function parseGrantJson(value: string): PluginGrant[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('--grants must be valid JSON.')
  }
  if (!isPluginGrantArray(parsed)) {
    throw new Error('--grants must match the Praxis plugin grant contract.')
  }
  return parsed
}

function sessionStoreKind(value: string): SessionStoreKindV3 {
  if (value === 'jsonl' || value === 'sqlite') return value
  throw new Error('storage target must be jsonl or sqlite.')
}

function missingCommand(command: Command, expected: string): never {
  return command.error(`error: missing required command (${expected})`, {
    exitCode: 2,
    code: 'commander.missingCommand',
  })
}

function positiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('Expected a positive integer.')
  return parsed
}

function nonNegativeInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('Expected a non-negative integer.')
  return parsed
}

export function cliExitCode(error: unknown): 1 | 2 | 3 | 4 | 5 | 130 {
  if (error instanceof CommanderError) return 2
  const code = rpcCode(error)
  if (code === 'INVALID_PARAMS') return 2
  if (code === 'AUTH_REQUIRED') return 3
  if (code === 'CLI_CANCELLED') return 130
  if (code.includes('PERMISSION_DENIED') || code.includes('POLICY_DENIED')) return 4
  if (
    code.includes('TIMEOUT') ||
    code.includes('DEADLINE') ||
    code.includes('CANCELLED') ||
    code.includes('ABORTED')
  ) {
    return 5
  }
  return 1
}

function rpcCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  if ('code' in error && typeof error.code === 'string') return error.code
  if (!('rpc' in error)) return ''
  const rpc = error.rpc
  return rpc && typeof rpc === 'object' && 'code' in rpc && typeof rpc.code === 'string'
    ? rpc.code
    : ''
}
