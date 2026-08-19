import { CommanderError } from '@commander-js/extra-typings'
import { runRuntime } from '@praxis/runtime/run'
import { isRuntimeChild } from './processMode.js'
import { cliExitCode, runCli } from './runCli.js'

if (isRuntimeChild(process.argv)) {
  runRuntime()
} else {
  await runCli().catch((error) => {
    const exitCode = cliExitCode(error)
    if (!(error instanceof CommanderError)) {
      process.stderr.write(`praxis: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = exitCode
  })
}
