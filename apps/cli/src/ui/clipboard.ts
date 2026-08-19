import { spawn } from 'node:child_process'

export type ClipboardCommand = {
  command: string
  args: string[]
}

export function clipboardCommands(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === 'win32') return [{ command: 'clip.exe', args: [] }]
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }]
  if (platform === 'linux') {
    return [
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
    ]
  }
  return []
}

export function osc52Sequence(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`
}

export async function copyTextToClipboard(text: string): Promise<void> {
  for (const candidate of clipboardCommands(process.platform)) {
    if (await writeClipboardCommand(candidate, text)) return
  }

  if (process.stdout.isTTY) {
    process.stdout.write(osc52Sequence(text))
    return
  }
  throw new Error('Clipboard integration is unavailable in this terminal.')
}

function writeClipboardCommand(candidate: ClipboardCommand, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, candidate.args, {
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
    child.stdin.once('error', () => finish(false))
    child.stdin.end(text, 'utf8')
  })
}
