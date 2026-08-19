import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  PRIVATE_REGISTRY_URL,
  WORKSPACES,
  publishWorkspaces,
  resolveNpmInvocation,
  resolvePrivateRegistry,
} from '../scripts/publish-workspaces-lib.mjs'

type NpmResult = { status: number; stdout: string; stderr: string }
type NpmCall = { args: string[]; allowFailure: boolean }

const EXPECTED_WORKSPACES = [
  '@praxis/core-sdk',
  '@praxis/protocol',
  '@praxis/plugin-protocol',
  '@praxis/client',
  '@praxis/plugin-sdk',
  '@praxis/runtime',
  '@praxis/cli',
]

test('npm subprocesses use the active Node runtime instead of a Windows command shim', () => {
  const execPath = resolve('runtime', 'node.exe')
  const npmExecPath = resolve('runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js')

  assert.deepEqual(resolveNpmInvocation({ execPath, npmExecPath }), {
    command: execPath,
    prefixArgs: [npmExecPath],
  })
  assert.throws(
    () => resolveNpmInvocation({ execPath: 'node', npmExecPath }),
    /absolute Node executable/u,
  )
  assert.throws(
    () => resolveNpmInvocation({ execPath, npmExecPath: 'npm.cmd' }),
    /absolute npm CLI/u,
  )
})

test('private registry validation accepts only the approved loopback endpoint', () => {
  for (const invalid of [
    undefined,
    '',
    'not a URL',
    'https://registry.npmjs.org/',
    'https://REGISTRY.NPMJS.ORG',
    'http://localhost:4873/',
    'http://127.0.0.1:4874/',
    'http://192.168.1.10:4873/',
    'http://user:secret@127.0.0.1:4873/',
    'http://127.0.0.1:4873/?token=secret',
    'http://127.0.0.1:4873/#secret',
  ]) {
    assert.throws(() => resolvePrivateRegistry(invalid), /private registry/iu)
  }
  assert.equal(resolvePrivateRegistry('http://127.0.0.1:4873'), PRIVATE_REGISTRY_URL)
  assert.equal(resolvePrivateRegistry(PRIVATE_REGISTRY_URL), PRIVATE_REGISTRY_URL)
})

test('private publisher uses dependency order, explicit registry, and restricted access', async () => {
  const calls: NpmCall[] = []
  const runNpm = (args: string[], allowFailure = false): NpmResult => {
    calls.push({ args, allowFailure })
    if (args[0] === 'pack') {
      const workspace = args[args.indexOf('--workspace') + 1]
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            filename: `${workspace?.replace('@praxis/', 'praxis-')}-0.1.0.tgz`,
            integrity: `sha512-${workspace}`,
          },
        ]),
        stderr: '',
      }
    }
    if (args[0] === 'view') return { status: 1, stdout: '', stderr: 'npm error E404' }
    return { status: 0, stdout: '', stderr: '' }
  }

  await publishWorkspaces({
    version: '0.1.0',
    registry: PRIVATE_REGISTRY_URL,
    runNpm,
    writeOutput: () => {},
  })

  assert.deepEqual(
    calls.filter((call) => call.args[0] === 'pack').map((call) => call.args[3]),
    EXPECTED_WORKSPACES,
  )
  assert.deepEqual(WORKSPACES, EXPECTED_WORKSPACES)
  for (const call of calls.filter((entry) => entry.args[0] === 'view')) {
    assert.equal(call.allowFailure, true)
    assert.deepEqual(call.args.slice(-2), ['--registry', PRIVATE_REGISTRY_URL])
  }
  for (const call of calls.filter((entry) => entry.args[0] === 'publish')) {
    assert.deepEqual(call.args.slice(-6), [
      '--access',
      'restricted',
      '--tag',
      'latest',
      '--registry',
      PRIVATE_REGISTRY_URL,
    ])
  }
  const staging = calls.find((call) => call.args[0] === 'pack')?.args.at(-1)
  assert.ok(staging)
  await assert.rejects(access(staging))
})

test('private publisher skips only identical package integrity', async () => {
  let publishCalls = 0
  const runNpm = (args: string[]): NpmResult => {
    if (args[0] === 'pack') {
      return {
        status: 0,
        stdout: JSON.stringify([{ filename: 'fixture.tgz', integrity: 'sha512-identical' }]),
        stderr: '',
      }
    }
    if (args[0] === 'view') {
      return { status: 0, stdout: JSON.stringify('sha512-identical'), stderr: '' }
    }
    publishCalls += 1
    return { status: 0, stdout: '', stderr: '' }
  }

  await publishWorkspaces({
    version: '0.1.0',
    registry: PRIVATE_REGISTRY_URL,
    runNpm,
    writeOutput: () => {},
  })

  assert.equal(publishCalls, 0)
})

test('private publisher rejects integrity mismatches and non-404 inspection failures', async () => {
  const pack: NpmResult = {
    status: 0,
    stdout: JSON.stringify([{ filename: 'fixture.tgz', integrity: 'sha512-local' }]),
    stderr: '',
  }
  for (const view of [
    { status: 0, stdout: JSON.stringify('sha512-remote'), stderr: '' },
    { status: 1, stdout: '', stderr: 'npm error E401 authentication required' },
  ]) {
    await assert.rejects(
      publishWorkspaces({
        version: '0.1.0-next.1',
        registry: PRIVATE_REGISTRY_URL,
        runNpm: (args: string[]) => (args[0] === 'pack' ? pack : view),
        writeOutput: () => {},
      }),
      view.status === 0 ? /different package integrity/u : /Unable to inspect/u,
    )
  }
})
