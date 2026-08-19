import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readChildBootstrapProfileFromProcess } from '../../apps/runtime/src/subagent/childBootstrapProfile.js'

const bootstrapProfile = readChildBootstrapProfileFromProcess()
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  const request = JSON.parse(line) as {
    id: string
    method: string
    params: Record<string, unknown>
  }
  if (request.method === 'initialize') write(request.id, { ready: true })
  if (request.method === 'child.execute' || request.method === 'session.prompt') {
    if (request.params.mode === 'malformed') {
      process.stdout.write('not-json\n')
      return
    }
    if (request.params.mode === 'oversized') {
      process.stdout.write(`${'x'.repeat(64 * 1024 + 1)}\n`)
      return
    }
    if (request.params.mode === 'timeout') return
    if (request.params.mode === 'early_exit') {
      process.nextTick(() => process.exit(17))
      return
    }
    if (request.params.mode === 'notification') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'child.notice', params: { value: 'ready' } })}\n`,
      )
      write(request.id, { echoed: 'notification' })
      return
    }
    if (request.params.mode === 'stderr') {
      process.stderr.write(`stderr-prefix:${'x'.repeat(4 * 1024)}`)
      write(request.id, { echoed: 'stderr' })
      return
    }
    if (request.params.mode === 'process_tree') {
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      setInterval(() => {}, 1_000)
      write(request.id, { descendantPid: descendant.pid })
      return
    }
    if (request.params.mode === 'bootstrap') {
      write(request.id, {
        parentRunId: bootstrapProfile?.parentRunId,
        childRunId: bootstrapProfile?.childRunId,
        workspace: bootstrapProfile?.workspace,
        methodAllowlist: bootstrapProfile?.methodAllowlist,
        budget: bootstrapProfile?.budget,
        admission: bootstrapProfile?.admission,
        launchEnvironmentScrubbed:
          process.env.PRAXIS_CHILD_BOOTSTRAP === undefined &&
          process.env.PRAXIS_CHILD_BOOTSTRAP_KEY === undefined,
      })
      return
    }
    if (request.params.mode === 'environment') {
      write(request.id, {
        path: hasEnvironment('PATH'),
        timezone: hasEnvironment('TZ'),
        openai: hasEnvironment('OPENAI_API_KEY'),
        anthropic: hasEnvironment('ANTHROPIC_API_KEY'),
        praxisHome: hasEnvironment('PRAXIS_HOME'),
        customSecret: hasEnvironment('CUSTOM_CHILD_SECRET'),
      })
      return
    }
    write(request.id, { echoed: request.params.value })
  }
  if (request.method === 'shutdown') {
    write(request.id, { accepted: true })
    input.close()
  }
})

function write(id: string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function hasEnvironment(name: string): boolean {
  return Object.keys(process.env).some((key) => key.toUpperCase() === name)
}
