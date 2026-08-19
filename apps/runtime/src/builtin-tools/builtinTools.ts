import type { RuntimeTool } from '@praxis/core-sdk'
import { EditTool } from '../tools/editTool.js'
import { FindTool } from '../tools/findTool.js'
import { GlobTool } from '../tools/globTool.js'
import { GrepTool } from '../tools/grepTool.js'
import { LsTool } from '../tools/lsTool.js'
import { ReadTool } from '../tools/readTool.js'
import { ShellTool } from '../tools/shellTool.js'
import type { ShellToolOptions } from '../tools/shellTool.js'
import { WriteTool } from '../tools/writeTool.js'

export function createBuiltinTools(options: ShellToolOptions = {}): RuntimeTool[] {
  return [
    new ReadTool(),
    new GlobTool(),
    new GrepTool(),
    new LsTool(),
    new FindTool(),
    new WriteTool(),
    new EditTool(),
    new ShellTool(options),
  ]
}
