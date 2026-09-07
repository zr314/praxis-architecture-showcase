import { prepareMechanism, runMechanism } from './mechanismRunner.js'

const args = process.argv.slice(2)
if (args.includes('--help'))
  process.stdout.write(
    'Usage: npm run eval:memory-mechanism -- --output <directory> [--phase all|prepare|run] [--provider minimax-cn --model MiniMax-M3] [--repeats 3] [--concurrency 1|2]\nNo Run turn/tool/token/deadline limits. Each pure program test has a 10-second computation watchdog. Prepare freezes actual repair histories and all memory snapshots before targets. Run resumes only already-settled rows; interrupted trial directories are never overwritten.\n',
  )
else {
  const values = new Map<string, string>(),
    allowed = new Set(['output', 'phase', 'provider', 'model', 'repeats', 'concurrency'])
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!.replace(/^--/u, '')
    if (
      !args[i]!.startsWith('--') ||
      !allowed.has(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith('--')
    )
      throw new Error('Invalid arguments; use --help')
    values.set(key, args[i + 1]!)
  }
  const output = values.get('output'),
    phase = values.get('phase') ?? 'all',
    concurrency = Number(values.get('concurrency') ?? 1)
  if (!output || !['all', 'prepare', 'run'].includes(phase) || ![1, 2].includes(concurrency))
    throw new Error('Explicit output and valid phase/concurrency required')
  if (phase !== 'run') {
    if (!values.get('provider') || !values.get('model'))
      throw new Error('Explicit provider/model required')
    await prepareMechanism({
      output,
      provider: values.get('provider')!,
      model: values.get('model')!,
      repeats: Number(values.get('repeats') ?? 3),
      concurrency: concurrency as 1 | 2,
    })
  }
  if (phase !== 'prepare') await runMechanism(output)
}
