import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = resolve(root, 'apps', 'cli', 'src', 'cli.tsx')
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
const userDocumentation = [
  'README.md',
  'docs/README.md',
  'docs/quickstart.md',
  'docs/provider-setup.md',
  'docs/session-recovery.md',
  'docs/troubleshooting.md',
  'docs/cli-reference.md',
  'docs/tool-policy.md',
  'docs/plugin-authoring.md',
  'docs/protocol-client.md',
  'docs/project-status.md',
] as const

test('every repository document remains bilingual UTF-8', async () => {
  const paths = ['README.md', ...(await markdownFiles(resolve(root, 'docs')))]
  for (const path of paths) {
    const source = await readFile(resolve(root, path), 'utf8')
    assert.match(source, /[\u3400-\u9fff]/u, `${path} has no Chinese reader guidance`)
    assert.match(
      source,
      /[A-Za-z]{4,}[ \t]+[A-Za-z]{4,}/u,
      `${path} has no English reader guidance`,
    )
    assert.doesNotMatch(source, /\uFFFD/u, `${path} contains a UTF-8 replacement character`)
  }
})

test('release-facing documentation has no broken local links', async () => {
  const paths = [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    ...(await markdownFiles(resolve(root, 'docs'))),
    ...(await markdownFiles(resolve(root, 'apps'))),
    ...(await markdownFiles(resolve(root, 'infra'))),
  ]
  for (const path of paths) {
    const source = await readFile(resolve(root, path), 'utf8')
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
      const destination = match[1]?.trim()
      if (!destination || destination.startsWith('#') || /^[a-z]+:/iu.test(destination)) continue
      assert.doesNotMatch(
        destination,
        /^[A-Za-z]:[\\/]/u,
        `${path} contains a machine-specific local link: ${destination}`,
      )
      const localPath = destination.replace(/^<|>$/gu, '').split('#', 1)[0]?.split('?', 1)[0]
      if (!localPath) continue
      await assert.doesNotReject(
        access(resolve(dirname(resolve(root, path)), decodeURIComponent(localPath))),
        `${path} links to missing ${destination}`,
      )
    }
  }
})

test('quickstart uses the installed command and the complete restart path', async () => {
  const [readme, quickstart] = await Promise.all([
    readFile(resolve(root, 'README.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'quickstart.md'), 'utf8'),
  ])

  for (const source of [readme, quickstart]) {
    assert.match(source, /npm run install:local/u)
    assert.match(source, /praxis --version/u)
    assert.match(source, /\bpraxis\b/u)
  }
  assert.match(quickstart, /\/login kimi/u)
  assert.match(quickstart, /\/model/u)
  assert.match(quickstart, /\/session/u)
  assert.match(quickstart, /Ctrl\+C/u)
  assert.match(quickstart, /praxis model current/u)
  assert.doesNotMatch(quickstart, /node apps\/cli\/dist\/cli\.js|npm run dev/u)
})

test('credential, preference, precedence, and privacy claims match Runtime storage', async () => {
  const sources = await Promise.all(
    userDocumentation.map((path) => readFile(resolve(root, path), 'utf8')),
  )
  const publicClaims = sources.join('\n')

  assert.doesNotMatch(
    publicClaims,
    /(?:does not|never)[^\n]{0,40}persist credentials|也不持久化凭据/iu,
  )
  for (const claim of [
    'AES-256-GCM',
    'credentials.json',
    'credential.key',
    'settings.json',
    'session-journal-v3/',
    'session-authority.json',
    'policy-audit.jsonl',
    'traces/YYYY-MM-DD/*.jsonl',
    'PRAXIS_HOME',
    'encrypted Provider-scoped store',
    'available saved preference',
    'mock/mock-v1',
    'not an OS keychain',
  ]) {
    assert.ok(publicClaims.includes(claim), `missing documentation claim: ${claim}`)
  }
})

test('Tool policy documents portable multiline shell stdin examples', async () => {
  const policy = await readFile(resolve(root, 'docs', 'tool-policy.md'), 'utf8')
  for (const required of [
    '"command": "python -"',
    '"stdin": "from pathlib import Path\\nprint(Path.cwd())\\n"',
    'powershell.exe -NoProfile -NonInteractive -Command -',
    '"/bin/sh"',
  ]) {
    assert.ok(policy.includes(required), `Tool policy omits ${required}`)
  }
  assert.doesNotMatch(policy, /"here_document"|"script_file"/u)
})

test('Tool policy and project status record the stable Tool closure', async () => {
  const [policy, status] = await Promise.all([
    readFile(resolve(root, 'docs', 'tool-policy.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'project-status.md'), 'utf8'),
  ])

  for (const claim of [
    'pathPattern',
    'deprecated `pattern`',
    'returnedLines',
    'rangeStart',
    'nextOffset',
    'expectedDigest',
    'createOnly',
    'TOOL_ALREADY_EXISTS',
    'whole-file',
  ]) {
    assert.ok(policy.includes(claim), `Tool policy omits ${claim}`)
  }
  assert.match(status, /write.*expectedDigest/su)
  assert.match(status, /可用.*TOCTOU/su)
})

test('release documentation describes the unified Workflow and capability registry', async () => {
  const [readme, architecture, plugins, cli] = await Promise.all([
    readFile(resolve(root, 'README.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'architecture.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'plugin-system.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'cli-reference.md'), 'utf8'),
  ])

  assert.match(readme, /新 Session 默认使用 `auto`/u)
  assert.match(readme, /agent\.delegate/u)
  assert.match(architecture, /SQLite WorkflowAuthority/u)
  assert.match(architecture, /Capability Bundle/u)
  assert.match(plugins, /Current shipping boundary/u)
  assert.match(cli, /auto\\\|solo\\\|workflow/u)
})

test('architecture distinguishes the delivered local slice from future platform stages', async () => {
  const [architecture, status] = await Promise.all([
    readFile(resolve(root, 'docs', 'architecture.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'project-status.md'), 'utf8'),
  ])

  assert.match(architecture, /authenticated Child Runtime/u)
  assert.match(architecture, /Git worktree/u)
  assert.match(architecture, /PostgreSQL authority/u)
  assert.match(status, /已接入产品路径/u)
  assert.match(status, /当前明确未完成/u)
})

test('Runtime source guides preserve child authorization and dual-backend authority contracts', async () => {
  const [overview, kernel, session] = await Promise.all([
    readFile(resolve(root, 'apps', 'runtime', 'readme.md'), 'utf8'),
    readFile(resolve(root, 'apps', 'runtime', 'docs', '01-kernel-and-loop.md'), 'utf8'),
    readFile(resolve(root, 'apps', 'runtime', 'docs', '02-session-memory-prompt.md'), 'utf8'),
  ])
  const childGuides = [overview, kernel].join('\n')
  const journalGuides = [overview, kernel, session].join('\n')

  for (const claim of [
    'AutoWorkflowPlannerV1',
    'SqliteWorkflowAuthorityV1',
    'ChildRuntimeHost',
    'Capability Bundle',
    'credential broker',
    'agent.delegate',
    'workflow.expand',
    'DirectoryWorkspaceIsolationManagerV1',
    'workflow-snapshots',
  ]) {
    assert.ok(childGuides.includes(claim), `Runtime child guide omits ${claim}`)
  }

  for (const claim of [
    'SessionJournalV3',
    'JSONL',
    'SQLite',
    'Workflow SQLite',
    'BEGIN IMMEDIATE',
    'doctor --deep',
    'Projection',
  ]) {
    assert.ok(journalGuides.includes(claim), `Runtime journal guide omits ${claim}`)
  }
  assert.match(journalGuides, /不双写|一次运行不双写/u)
  assert.match(childGuides, /父.*校验.*fast-forward/su)
  assert.match(childGuides, /Child.*不能.*Child/su)
})

test('distribution documentation separates private packages from repository releases', async () => {
  const [contributing, quickstart, monorepo, registry] = await Promise.all([
    readFile(resolve(root, 'CONTRIBUTING.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'quickstart.md'), 'utf8'),
    readFile(resolve(root, 'docs', 'monorepo.md'), 'utf8'),
    readFile(resolve(root, 'infra', 'verdaccio', 'README.md'), 'utf8'),
  ])
  const releaseDocs = [contributing, monorepo, registry].join('\n')

  for (const claim of [
    'http://127.0.0.1:4873/',
    'PRAXIS_NPM_REGISTRY_URL',
    'PRAXIS_NPM_TOKEN',
    'praxis-private-registry',
    'repository_dispatch',
  ]) {
    assert.ok(releaseDocs.includes(claim), `distribution documentation omits ${claim}`)
  }
  assert.doesNotMatch(quickstart, /PRAXIS_NPM_TOKEN|npm config set @praxis:registry/u)
  assert.match(monorepo, /independent delivery channels/iu)
  assert.match(registry, /docker compose[\s\S]+up -d/u)

  assert.doesNotMatch(contributing, /OIDC Trusted Publishing|Trusted Publisher/u)
  assert.doesNotMatch(
    releaseDocs,
    /publishes the GitHub Release only after all registry operations succeed/iu,
  )
  assert.doesNotMatch(releaseDocs, /public GitHub Release|public native artifact/iu)
})

test('CLI reference covers the actual help surface and TUI command catalog', async () => {
  const reference = await readFile(resolve(root, 'docs', 'cli-reference.md'), 'utf8')
  const helpCases = [
    {
      args: ['--help'],
      patterns: [
        'Usage: praxis [options] [command]',
        'auth',
        'doctor',
        'model',
        'session',
        'storage',
        'trace',
        'plugin',
        '--planner',
        '--storage',
      ],
    },
    {
      args: ['auth', '--help'],
      patterns: ['status', 'login', 'logout'],
    },
    {
      args: ['model', '--help'],
      patterns: ['list', 'current', 'set'],
    },
    {
      args: ['session', '--help'],
      patterns: ['list', 'search', 'show', 'rename', 'fork', 'branch', 'export', 'delete'],
    },
    {
      args: ['storage', '--help'],
      patterns: ['migrate'],
    },
    {
      args: ['storage', 'migrate', '--help'],
      patterns: ['<target>', '--home', '--json'],
    },
    {
      args: ['plugin', '--help'],
      patterns: [
        'install',
        'list',
        'inspect',
        'enable',
        'disable',
        'permissions',
        'doctor',
        'update',
        'rollback',
        'uninstall',
      ],
    },
  ] as const

  for (const fixture of helpCases) {
    const output = cliHelp(fixture.args)
    for (const pattern of fixture.patterns) {
      assert.ok(output.includes(pattern), `help omits ${pattern}`)
      const referenceToken = pattern.startsWith('Usage: ')
        ? pattern.slice('Usage: '.length)
        : (pattern.split(' ')[0] ?? pattern)
      assert.ok(reference.includes(referenceToken), `reference omits ${pattern}`)
    }
  }

  for (const command of [
    '/new',
    '/resume',
    '/session',
    '/provider',
    '/login',
    '/logout',
    '/model',
    '/compact',
    '/context',
    '/plan',
    '/planner',
    '/storage',
    '/artifacts',
    '/export',
    '/doctor',
  ]) {
    assert.ok(reference.includes(`\`${command}`), `reference omits ${command}`)
  }
  for (const code of ['0', '1', '2', '3', '4', '5', '130']) {
    assert.ok(reference.includes(`| \`${code}\` |`), `reference omits exit code ${code}`)
  }
})

function cliHelp(args: readonly string[]): string {
  return execFileSync(
    process.execPath,
    [tsxCli, '--tsconfig', 'tsconfig.check.json', cliEntry, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOONSHOT_API_KEY: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    },
  )
}

async function markdownFiles(directory: string): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await markdownFiles(absolute)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      paths.push(absolute.slice(root.length + 1).replaceAll('\\', '/'))
    }
  }
  return paths.sort()
}
