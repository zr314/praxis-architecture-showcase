import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export type ExitResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

export class SemanticTerminal {
  columns: number
  rows: number
  constructor(columns: number, rows: number)
  write(chunk: string | Buffer): void
  resize(columns: number, rows: number): void
  rawOutput(): string
  viewportLines(): Promise<string[]>
  viewportText(): Promise<string>
  scrollBufferLines(): string[]
  scrollBufferText(): string
  baseY(): number
  diagnostics(): string
  dispose(): void
}

export function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMilliseconds: number,
  description: string,
  diagnostics?: () => string,
): Promise<void>

export function waitForChildCondition(
  child: ChildProcessWithoutNullStreams,
  condition: () => boolean | Promise<boolean>,
  timeoutMilliseconds: number,
  description: string,
  capture: SemanticTerminal,
): Promise<void>

export function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMilliseconds: number,
  capture: SemanticTerminal,
): Promise<ExitResult>

export function formatExit(exit: ExitResult): string
export function shellQuote(value: string): string
