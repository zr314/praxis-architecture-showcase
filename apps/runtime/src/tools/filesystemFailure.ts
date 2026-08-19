import type { ToolResult } from './types.js'

export function filesystemFailure(error: unknown): ToolResult | undefined {
  const code = errnoCode(error)
  if (code === 'ENOENT') {
    return {
      ok: false,
      summary: 'Target was not found.',
      error: { code: 'TOOL_TARGET_NOT_FOUND', category: 'not_found', retryable: false },
    }
  }
  if (['ENOTDIR', 'EISDIR', 'ERR_FS_EISDIR'].includes(code ?? '')) {
    return targetTypeFailure()
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      ok: false,
      summary: 'The operating system denied access to the target.',
      error: {
        code: 'TOOL_FILESYSTEM_PERMISSION_DENIED',
        category: 'permission',
        retryable: false,
      },
    }
  }
  return undefined
}

export function targetTypeFailure(): ToolResult {
  return {
    ok: false,
    summary: 'Target has the wrong filesystem type.',
    error: { code: 'TOOL_TARGET_TYPE_INVALID', category: 'validation', retryable: true },
  }
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined
}
