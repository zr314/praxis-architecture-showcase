import { preflightRepository, prepareRepository, runRepository } from './repositoryRunner.js'

const [phase, output, preflight, provider, model, reuseLearning] = process.argv.slice(2)
if (!output || !['preflight', 'prepare', 'run', 'all'].includes(phase ?? ''))
  throw new Error(
    'Usage: tsx repositoryCli.ts preflight OUTPUT | prepare/all OUTPUT PREFLIGHT PROVIDER MODEL | run OUTPUT',
  )
if (phase === 'preflight') await preflightRepository(output)
else {
  if (phase === 'prepare' || phase === 'all') {
    if (!preflight || !provider || !model)
      throw new Error('Explicit preflight/provider/model required')
    await prepareRepository(output, preflight, provider, model, reuseLearning)
  }
  if (phase === 'run' || phase === 'all') await runRepository(output)
}
