import { spawn, type ChildProcess } from 'node:child_process'

const TERMINATION_GRACE_MS = 250

/** Reclaims one process group on POSIX and one descendant tree on Windows. */
export async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolveTermination) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => resolveTermination())
      killer.once('exit', () => resolveTermination())
    })
    return
  }
  signalProcessTree(pid, 'SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS))
  signalProcessTree(pid, 'SIGKILL')
}

export async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolveExit) => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.removeListener('exit', onExit)
      resolveExit(exited)
    }
    const onExit = () => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The process already exited.
    }
  }
}
