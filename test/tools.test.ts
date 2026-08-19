import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeError } from '@praxis/core-sdk'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'
import type { RuntimeTool } from '../apps/runtime/src/tools/types.js'

test('read, glob, and grep stay inside the workspace by default', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-tools-'))
  try {
    await writeFile(join(workspace, 'note.txt'), 'alpha\nbeta\n', 'utf8')
    await mkdir(join(workspace, 'nested'))
    await writeFile(join(workspace, 'nested', 'deep.txt'), 'nested\n', 'utf8')
    const tools = new ToolRuntime()
    const controller = new AbortController()

    const read = await tools.execute('read', { path: 'note.txt' }, workspace, controller.signal)
    assert.equal(read.ok, true)

    const glob = await tools.execute('glob', { pattern: '*.txt' }, workspace, controller.signal)
    assert.deepEqual(glob.output, ['note.txt'])
    const recursiveGlob = await tools.execute(
      'glob',
      { pattern: '**/*.txt' },
      workspace,
      controller.signal,
    )
    assert.deepEqual((recursiveGlob.output as string[]).sort(), ['nested/deep.txt', 'note.txt'])

    const grep = await tools.execute('grep', { query: 'beta' }, workspace, controller.signal)
    assert.deepEqual(grep.output, {
      matches: [{ path: 'note.txt', line: 2, text: 'beta' }],
      limit: 100,
      truncated: false,
    })
    assert.equal(tools.requiresPermission('read', { path: '../outside.txt' }, workspace), true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('grep exposes a caller-selected lower match limit without exceeding its hard ceiling', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-grep-limit-'))
  try {
    await writeFile(join(workspace, 'many.txt'), 'hit one\nhit two\nhit three\n', 'utf8')
    const tools = new ToolRuntime()
    const signal = new AbortController().signal

    const capped = await tools.execute('grep', { query: 'hit', maxMatches: 2 }, workspace, signal)
    assert.deepEqual(capped.output, {
      matches: [
        { path: 'many.txt', line: 1, text: 'hit one' },
        { path: 'many.txt', line: 2, text: 'hit two' },
      ],
      limit: 2,
      truncated: true,
    })

    const exact = await tools.execute('grep', { query: 'three', maxMatches: 1 }, workspace, signal)
    assert.deepEqual(exact.output, {
      matches: [{ path: 'many.txt', line: 3, text: 'hit three' }],
      limit: 1,
      truncated: false,
    })

    const aboveHardCeiling = await tools.execute(
      'grep',
      { query: 'hit', maxMatches: 101 },
      workspace,
      signal,
    )
    assert.equal(aboveHardCeiling.error?.code, 'TOOL_INPUT_INVALID')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('junction and symlink aliases use the canonical outside target for permission and execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tool-target-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  try {
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'outside-secret', 'utf8')
    await symlink(
      outside,
      join(workspace, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const tools = new ToolRuntime()
    const input = { path: 'alias/secret.txt' }
    const canonicalTarget = await realpath(join(outside, 'secret.txt'))

    assert.deepEqual(tools.permissionRequirement('read', input, workspace), {
      risk: 'medium',
      target: canonicalTarget,
      rule: `read-outside:${canonicalTarget}`,
    })

    const result = await tools.execute('read', input, workspace, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.equal((result.output as { path: string; content: string }).path, canonicalTarget)
    assert.equal((result.output as { path: string; content: string }).content, 'outside-secret')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepared reads reject a same-path file replacement before execution', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-tool-file-identity-'))
  try {
    const path = join(workspace, 'target.txt')
    await writeFile(path, 'authorized', 'utf8')
    const tools = new ToolRuntime()
    const prepared = tools.prepare('read', { path: 'target.txt' }, workspace)

    await rename(path, join(workspace, 'original.txt'))
    await writeFile(path, 'replacement', 'utf8')

    const result = await tools.executePrepared(prepared, new AbortController().signal)
    assert.equal(result.error?.code, 'TOOL_PATH_CHANGED')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('prepared writes reject replacement of the nearest existing parent', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-tool-parent-identity-'))
  try {
    const parent = join(workspace, 'target')
    await mkdir(parent)
    const tools = new ToolRuntime()
    const prepared = tools.prepare('write', { path: 'target/new.txt', content: 'data' }, workspace)

    await rename(parent, join(workspace, 'original-target'))
    await mkdir(parent)

    const result = await tools.executePrepared(prepared, new AbortController().signal)
    assert.equal(result.error?.code, 'TOOL_PATH_CHANGED')
    await assert.rejects(readFile(join(parent, 'new.txt'), 'utf8'), isMissingFile)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('filesystem tool failures keep stable codes without exposing host diagnostics', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-tool-filesystem-errors-'))
  try {
    await mkdir(join(workspace, 'directory'))
    await writeFile(join(workspace, 'file.txt'), 'content', 'utf8')
    const tools = new ToolRuntime()
    const signal = new AbortController().signal

    for (const result of [
      await tools.execute('read', { path: 'missing.txt' }, workspace, signal),
      await tools.execute(
        'edit',
        { path: 'missing.txt', oldText: 'before', newText: 'after' },
        workspace,
        signal,
      ),
      await tools.execute('ls', { path: 'missing' }, workspace, signal),
    ]) {
      assert.deepEqual(result, {
        ok: false,
        summary: 'Target was not found.',
        error: { code: 'TOOL_TARGET_NOT_FOUND', category: 'not_found', retryable: false },
      })
    }

    for (const result of [
      await tools.execute('read', { path: 'directory' }, workspace, signal),
      await tools.execute('write', { path: 'directory', content: 'value' }, workspace, signal),
      await tools.execute('ls', { path: 'file.txt' }, workspace, signal),
      await tools.execute('find', { path: 'file.txt', pattern: '*' }, workspace, signal),
    ]) {
      assert.deepEqual(result, {
        ok: false,
        summary: 'Target has the wrong filesystem type.',
        error: {
          code: 'TOOL_TARGET_TYPE_INVALID',
          category: 'validation',
          retryable: true,
        },
      })
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('unresolvable and outside-workspace targets preserve distinct permission semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tool-path-errors-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace)
    const tools = new ToolRuntime()
    const outsideInput = { path: '../outside/missing.txt' }
    const requirement = tools.permissionRequirement('read', outsideInput, workspace)

    assert.equal(requirement?.risk, 'medium')
    assert.match(requirement?.rule ?? '', /^read-outside:/u)
    assert.deepEqual(
      await tools.execute(
        'read',
        { path: `invalid${String.fromCodePoint(0)}path` },
        workspace,
        new AbortController().signal,
      ),
      {
        ok: false,
        summary: 'Tool target could not be resolved safely.',
        error: {
          code: 'TOOL_PATH_UNRESOLVABLE',
          category: 'permission',
          retryable: false,
        },
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('write and edit report bounded change summaries', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-write-tools-'))
  try {
    const tools = new ToolRuntime()
    const controller = new AbortController()
    const write = await tools.execute(
      'write',
      { path: 'src/example.txt', content: 'before before\n' },
      workspace,
      controller.signal,
    )
    assert.equal(write.ok, true)
    assert.match(write.summary, /Wrote/)
    const canonicalWriteTarget = await realpath(join(workspace, 'src', 'example.txt'))
    assert.deepEqual(write.output, {
      path: canonicalWriteTarget,
      beforeBytes: 0,
      afterBytes: 14,
      created: true,
      beforeDigest: null,
      afterDigest: `sha256:${createHash('sha256').update('before before\n').digest('hex')}`,
    })

    const edit = await tools.execute(
      'edit',
      { path: 'src/example.txt', oldText: 'before before', newText: 'after after' },
      workspace,
      controller.signal,
    )
    assert.equal(edit.ok, true)
    assert.equal(await readFile(join(workspace, 'src', 'example.txt'), 'utf8'), 'after after\n')

    const stale = await tools.execute(
      'edit',
      {
        path: 'src/example.txt',
        oldText: 'after after',
        newText: 'stale write',
        expectedDigest: `sha256:${'0'.repeat(64)}`,
      },
      workspace,
      controller.signal,
    )
    assert.equal(stale.error?.code, 'TOOL_STALE_INPUT')
    assert.equal(await readFile(join(workspace, 'src', 'example.txt'), 'utf8'), 'after after\n')

    const ambiguous = await tools.execute(
      'edit',
      { path: 'src/example.txt', oldText: 'e', newText: 'b' },
      workspace,
      controller.signal,
    )
    assert.equal(ambiguous.ok, false)
    assert.equal(tools.requiresPermission('write', { path: 'src/example.txt' }, workspace), true)
    assert.equal(tools.requiresPermission('edit', { path: 'src/example.txt' }, workspace), true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('read pagination, ls/find, regex context, binary detection, and ignore rules are consistent', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-rich-tools-'))
  try {
    await writeFile(join(workspace, 'lines.txt'), 'zero\none\nTWO\nthree\nfour', 'utf8')
    await writeFile(join(workspace, 'notes.md'), 'notes\n', 'utf8')
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    const tools = new ToolRuntime()
    const signal = new AbortController().signal

    const read = await tools.execute(
      'read',
      { path: 'lines.txt', offset: 1, limit: 2 },
      workspace,
      signal,
    )
    const canonicalReadTarget = await realpath(join(workspace, 'lines.txt'))
    assert.deepEqual(read.output, {
      path: canonicalReadTarget,
      content: 'one\nTWO',
      offset: 1,
      limit: 2,
      totalLines: 5,
      returnedLines: 2,
      rangeStart: 1,
      rangeEnd: 3,
      nextOffset: 3,
      truncated: true,
      encoding: 'utf-8',
      digest: `sha256:${createHash('sha256').update('zero\none\nTWO\nthree\nfour').digest('hex')}`,
    })

    const grep = await tools.execute(
      'grep',
      { query: '^two$', regex: true, ignoreCase: true, before: 1, after: 1 },
      workspace,
      signal,
    )
    assert.deepEqual(grep.output, {
      matches: [{ path: 'lines.txt', line: 3, text: 'TWO', before: ['one'], after: ['three'] }],
      limit: 100,
      truncated: false,
    })

    const preferred = await tools.execute(
      'grep',
      { query: 'TWO', pathPattern: '**/*.txt' },
      workspace,
      signal,
    )
    assert.deepEqual(preferred.output, {
      matches: [{ path: 'lines.txt', line: 3, text: 'TWO' }],
      limit: 100,
      truncated: false,
    })

    const legacy = await tools.execute(
      'grep',
      { query: 'TWO', pattern: '**/*.txt' },
      workspace,
      signal,
    )
    assert.deepEqual(legacy.output, preferred.output)

    const equalAliases = await tools.execute(
      'grep',
      { query: 'TWO', pathPattern: '**/*.txt', pattern: '**/*.txt' },
      workspace,
      signal,
    )
    assert.deepEqual(equalAliases.output, preferred.output)

    const conflictingAliases = await tools.execute(
      'grep',
      { query: 'TWO', pathPattern: '**/*.txt', pattern: '**/*.md' },
      workspace,
      signal,
    )
    assert.equal(conflictingAliases.error?.code, 'TOOL_INPUT_INVALID')

    const binary = await tools.execute('read', { path: 'binary.bin' }, workspace, signal)
    assert.equal(binary.error?.code, 'TOOL_BINARY_FILE')

    const ls = await tools.execute('ls', {}, workspace, signal)
    assert.equal(
      (ls.output as Array<{ path: string }>).some(({ path }) => path === 'lines.txt'),
      true,
    )
    const find = await tools.execute('find', { pattern: '*.txt' }, workspace, signal)
    assert.deepEqual(find.output, ['lines.txt'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shell uses the local platform adapter with timeout handling', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-tools-'))
  try {
    const tools = new ToolRuntime()
    const controller = new AbortController()
    const command = process.platform === 'win32' ? 'Write-Output shell-proof' : 'printf shell-proof'
    const result = await tools.execute('shell', { command }, workspace, controller.signal)
    assert.equal(result.ok, true)
    assert.match(JSON.stringify(result.output), /shell-proof/)

    const stdinProgram = 'process.stdin.pipe(process.stdout)'
    const stdinCommand =
      process.platform === 'win32'
        ? `& ${powershellQuote(process.execPath)} -e ${powershellQuote(stdinProgram)}`
        : `${shellQuote(process.execPath)} -e ${shellQuote(stdinProgram)}`
    const withInput = await tools.execute(
      'shell',
      { command: stdinCommand, stdin: 'first line\nsecond line\n' },
      workspace,
      controller.signal,
    )
    assert.equal(withInput.ok, true)
    assert.equal((withInput.output as { stdout: string }).stdout, 'first line\nsecond line\n')

    const slowCommand = process.platform === 'win32' ? 'Start-Sleep -Seconds 2' : 'sleep 2'
    const timedOut = await tools.execute(
      'shell',
      { command: slowCommand, timeoutMs: 20 },
      workspace,
      controller.signal,
    )
    assert.equal(timedOut.ok, false)
    assert.match(timedOut.summary, /timed out/)
    assert.equal(tools.requiresPermission('shell', { command }, workspace), true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shell resolves one explicit working directory without retaining process state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-cwd-'))
  try {
    await mkdir(join(workspace, 'nested'))
    await writeFile(join(workspace, 'file.txt'), 'not a directory', 'utf8')
    const tools = new ToolRuntime()
    const signal = new AbortController().signal
    const cwdProgram = 'process.stdout.write(process.cwd())'
    const cwdCommand =
      process.platform === 'win32'
        ? `& ${powershellQuote(process.execPath)} -e ${powershellQuote(cwdProgram)}`
        : `${shellQuote(process.execPath)} -e ${shellQuote(cwdProgram)}`
    const canonicalNested = await realpath(join(workspace, 'nested'))

    assert.deepEqual(
      tools.permissionRequirement(
        'shell',
        { command: cwdCommand, workingDirectory: 'nested' },
        workspace,
      ),
      {
        risk: 'high',
        target: canonicalNested,
        rule: `shell:${canonicalNested}`,
      },
    )

    const nested = await tools.execute(
      'shell',
      { command: cwdCommand, workingDirectory: 'nested' },
      workspace,
      signal,
    )
    assert.equal(nested.ok, true)
    assert.equal((nested.output as { stdout: string }).stdout, canonicalNested)

    const missing = await tools.execute(
      'shell',
      { command: cwdCommand, workingDirectory: 'missing' },
      workspace,
      signal,
    )
    assert.equal(missing.error?.code, 'TOOL_TARGET_NOT_FOUND')

    const file = await tools.execute(
      'shell',
      { command: cwdCommand, workingDirectory: 'file.txt' },
      workspace,
      signal,
    )
    assert.equal(file.error?.code, 'TOOL_TARGET_TYPE_INVALID')

    const canonicalParent = await realpath(join(workspace, '..'))
    assert.deepEqual(
      tools.permissionRequirement(
        'shell',
        { command: cwdCommand, workingDirectory: '..' },
        workspace,
      ),
      {
        risk: 'high',
        target: canonicalParent,
        rule: `shell:${canonicalParent}`,
      },
    )

    const changeDirectory = process.platform === 'win32' ? 'Set-Location ..' : 'cd ..'
    await tools.execute('shell', { command: changeDirectory }, workspace, signal)
    const fresh = await tools.execute('shell', { command: cwdCommand }, workspace, signal)
    assert.equal((fresh.output as { stdout: string }).stdout, await realpath(workspace))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shell preserves UTF-8 sequences split across process output chunks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-utf8-chunks-'))
  try {
    const tools = new ToolRuntime()
    const stdoutProgress: string[] = []
    const stderrProgress: string[] = []
    const program = [
      'process.stdout.write(Buffer.from([0xe4]))',
      'process.stderr.write(Buffer.from([0xe9]))',
      'setTimeout(() => {',
      '  process.stdout.write(Buffer.from([0xb8, 0xad]))',
      '  process.stderr.write(Buffer.from([0x94, 0x99]))',
      '}, 50)',
    ].join('\n')
    const command =
      process.platform === 'win32'
        ? `& ${powershellQuote(process.execPath)} -e ${powershellQuote(program)}`
        : `${shellQuote(process.execPath)} -e ${shellQuote(program)}`

    const result = await tools.execute(
      'shell',
      { command },
      workspace,
      new AbortController().signal,
      (update) => {
        if (update.stream === 'stdout' && update.delta) stdoutProgress.push(update.delta)
        if (update.stream === 'stderr' && update.delta) stderrProgress.push(update.delta)
      },
    )

    assert.equal(result.ok, true)
    assert.equal((result.output as { stdout: string }).stdout, '中')
    assert.equal((result.output as { stderr: string }).stderr, '错')
    assert.equal(stdoutProgress.join(''), '中')
    assert.equal(stderrProgress.join(''), '错')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shell progress keeps multibyte deltas within the UTF-8 byte limit', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-progress-bytes-'))
  try {
    const tools = new ToolRuntime()
    const deltas: string[] = []
    const program = "process.stdout.write('中'.repeat(5000))"
    const command =
      process.platform === 'win32'
        ? `& ${powershellQuote(process.execPath)} -e ${powershellQuote(program)}`
        : `${shellQuote(process.execPath)} -e ${shellQuote(program)}`

    const result = await tools.execute(
      'shell',
      { command },
      workspace,
      new AbortController().signal,
      (update) => {
        if (update.stream === 'stdout' && update.delta) deltas.push(update.delta)
      },
    )

    assert.equal(result.ok, true)
    assert.equal((result.output as { stdout: string }).stdout, '中'.repeat(5000))
    assert.ok(deltas.length > 0)
    assert.equal(
      deltas.every((delta) => Buffer.byteLength(delta, 'utf8') <= 4_096),
      true,
    )
    assert.doesNotMatch(deltas.join(''), /\uFFFD/u)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shell forces UTF-8 for PowerShell cmdlet and native child output', {
  skip: process.platform === 'win32' ? false : 'Windows PowerShell encoding behavior',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-windows-utf8-'))
  try {
    const tools = new ToolRuntime()
    const nativeProgram = "process.stdout.write('原生中文'); process.stderr.write('原生错误')"
    const command = [
      "Write-Output '中文输出测试'",
      "[Console]::Error.WriteLine('中文错误测试')",
      `& ${powershellQuote(process.execPath)} -e ${powershellQuote(nativeProgram)}`,
    ].join('; ')

    const result = await tools.execute(
      'shell',
      { command },
      workspace,
      new AbortController().signal,
    )
    const output = result.output as { stdout: string; stderr: string }

    assert.equal(result.ok, true)
    assert.match(output.stdout, /中文输出测试/u)
    assert.match(output.stdout, /原生中文/u)
    assert.match(output.stderr, /中文错误测试/u)
    assert.match(output.stderr, /原生错误/u)
    assert.doesNotMatch(`${output.stdout}${output.stderr}`, /\uFFFD/u)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shell escalates to SIGKILL when a Unix process group ignores SIGTERM', {
  skip: process.platform === 'win32' ? 'Unix process-group behavior' : false,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-escalation-'))
  try {
    const tools = new ToolRuntime()
    const controller = new AbortController()
    const startedAt = Date.now()

    const result = await tools.execute(
      'shell',
      { command: "trap '' TERM; while :; do :; done", timeoutMs: 20 },
      workspace,
      controller.signal,
    )

    assert.equal(result.ok, false)
    assert.match(result.summary, /timed out/)
    assert.ok(Date.now() - startedAt < 2_000)
    assert.equal((result.output as { signal?: string }).signal, 'SIGKILL')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shell timeout and abort reclaim observed descendants under repeated load', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-tree-'))
  const observedPids: number[] = []
  try {
    const tools = new ToolRuntime()
    for (const [iteration, stopMode] of ['timeout', 'abort', 'timeout'].entries()) {
      const relativeWorkingDirectory = `job-${iteration}`
      const workingDirectory = join(workspace, relativeWorkingDirectory)
      const pidPath = join(workingDirectory, 'descendant.pid')
      const markerPath = join(workingDirectory, 'descendant-survived.txt')
      await mkdir(workingDirectory)
      await writeFile(
        join(workingDirectory, 'launcher.cjs'),
        [
          "const { spawn } = require('node:child_process')",
          "const child = spawn(process.execPath, ['descendant.cjs'], {",
          "  cwd: process.cwd(), detached: process.platform === 'win32', stdio: 'ignore'",
          '})',
          'child.unref()',
          'setInterval(() => {}, 1_000)',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(workingDirectory, 'descendant.cjs'),
        [
          "const { writeFileSync } = require('node:fs')",
          "writeFileSync('descendant.pid', String(process.pid))",
          "process.on('SIGTERM', () => {})",
          "setTimeout(() => writeFileSync('descendant-survived.txt', 'survived'), 10_000)",
          'setInterval(() => {}, 1_000)',
        ].join('\n'),
        'utf8',
      )
      const controller = new AbortController()
      const command =
        process.platform === 'win32'
          ? `& ${powershellQuote(process.execPath)} launcher.cjs`
          : `${shellQuote(process.execPath)} launcher.cjs`
      let toolSettled = false
      const execution = tools
        .execute(
          'shell',
          {
            command,
            timeoutMs: stopMode === 'timeout' ? 2_000 : 10_000,
            workingDirectory: relativeWorkingDirectory,
          },
          workspace,
          controller.signal,
        )
        .finally(() => {
          toolSettled = true
        })

      const descendantPid = await waitForPid(pidPath, 1_500)
      observedPids.push(descendantPid)
      assert.equal(toolSettled, false, `iteration ${iteration} observed child after Tool settled`)
      assert.equal(isProcessAlive(descendantPid), true)
      if (stopMode === 'abort') controller.abort()

      const result = await execution
      assert.equal(result.ok, false)
      assert.match(result.summary, stopMode === 'timeout' ? /timed out/ : /cancelled/)
      await waitForCondition(
        () => !isProcessAlive(descendantPid),
        3_000,
        `descendant ${descendantPid} to exit after ${stopMode}`,
      )
      await assert.rejects(readFile(markerPath, 'utf8'), isMissingFile)
    }
  } finally {
    for (const pid of observedPids) {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // The process was reclaimed between the probe and signal.
        }
      }
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('ToolRuntime hides unexpected tool errors but preserves explicit RuntimeErrors', async () => {
  const unexpected: RuntimeTool = {
    definition: { name: 'unexpected', description: 'unexpected', parameters: {} },
    async execute() {
      throw new Error('authorization=secret-token; filesystem details')
    },
  }
  const expected: RuntimeTool = {
    definition: { name: 'expected', description: 'expected', parameters: {} },
    async execute() {
      throw runtimeError('TOOL_POLICY_DENIED', 'tool', 'The tool policy rejected this request.')
    },
  }
  const denied: RuntimeTool = {
    definition: { name: 'denied', description: 'denied', parameters: {} },
    async execute() {
      throw Object.assign(new Error('Access denied at D:\\private\\secret.txt'), { code: 'EACCES' })
    },
  }
  const tools = new ToolRuntime([unexpected, expected, denied])
  const controller = new AbortController()

  assert.deepEqual(await tools.execute('unexpected', {}, process.cwd(), controller.signal), {
    ok: false,
    summary: 'Tool execution failed.',
    error: {
      code: 'TOOL_EXECUTION_FAILED',
      category: 'execution',
      retryable: false,
    },
  })
  assert.deepEqual(await tools.execute('expected', {}, process.cwd(), controller.signal), {
    ok: false,
    summary: 'The tool policy rejected this request.',
    error: {
      code: 'TOOL_POLICY_DENIED',
      category: 'execution',
      retryable: false,
    },
  })
  assert.deepEqual(await tools.execute('denied', {}, process.cwd(), controller.signal), {
    ok: false,
    summary: 'The operating system denied access to the target.',
    error: {
      code: 'TOOL_FILESYSTEM_PERMISSION_DENIED',
      category: 'permission',
      retryable: false,
    },
  })
})

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function waitForPid(path: string, timeoutMilliseconds: number): Promise<number> {
  let pid: number | undefined
  await waitForCondition(
    async () => {
      try {
        const candidate = Number.parseInt(await readFile(path, 'utf8'), 10)
        if (!Number.isSafeInteger(candidate) || candidate <= 0) return false
        pid = candidate
        return true
      } catch (error) {
        if (isMissingFile(error)) return false
        throw error
      }
    },
    timeoutMilliseconds,
    `descendant PID file ${path}`,
  )
  assert.ok(pid !== undefined)
  return pid
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMilliseconds: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (await condition()) return
  assert.fail(`Timed out after ${timeoutMilliseconds}ms waiting for ${description}.`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
