/**
 * Ink emits complete, unthrottled frames to DifferentialTerminalOutput.
 * Praxis owns the actual terminal diff so the same behavior is exercised on
 * Windows, Linux, and macOS.
 */
export const TUI_RENDER_OPTIONS = {
  debug: true,
  exitOnCtrlC: false,
  incrementalRendering: false,
  patchConsole: false,
} as const
