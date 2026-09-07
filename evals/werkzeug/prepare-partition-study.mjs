// Freeze the next case without spending model tokens or touching the running cohort.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(process.argv[2])
const preflight = resolve(process.argv[3])
const feasibility = JSON.parse(await readFile(join(preflight, 'results.json'), 'utf8'))
if (!feasibility.ready) throw new Error('Feasibility checks are not ready')
const protocol = JSON.parse(await readFile(join(preflight, 'protocol.json'), 'utf8'))
const cohort = join(root, 'artifacts/werkzeug-memory-minimax-20260906-v2')
const historical = JSON.parse(await readFile(join(cohort, '0-none.json'), 'utf8'))
const historyBytes = await readFile(join(historical.directory, 'episode.json'))
const history = JSON.parse(historyBytes)
if (history.status !== 'completed' || history.messages.length !== 130)
  throw new Error('Expected complete, unmodified fixed historical episode')
await mkdir(output)
await writeFile(join(output, 'history.json'), historyBytes)
await cp(protocol.baseline.path, join(output, 'baseline'), { recursive: true })
await cp(
  join(preflight, 'frozen/partition_public.py'),
  join(output, 'baseline/reproduce_upload.py'),
)
const prompt = `Fix a multipart decoding regression in this canonical Werkzeug 3.1.7 checkout. The same valid multipart body produces different field or file contents when delivered in small fragments. reproduce_upload.py demonstrates this with in-memory input. Diagnose the implementation and add regression tests. Standard CRLF multipart requests must preserve binary bytes exactly, including empty parts and legitimate leading or trailing CR/LF bytes, independently of fragmentation. Keep existing upstream compatibility tests passing and preserve incremental output for large bodies; buffering the entire request until EOF is not a solution. This checkout contains the upstream release, not a previous agent's patch. Run the reproduction and relevant existing tests, then summarize the change, actual checks, and remaining uncertainty.`
await writeFile(join(output, 'target-prompt.txt'), prompt + '\n')
const sourcePaths = [
  'apps/runtime/src/evaluation/recap/checkpointTool.ts',
  'apps/runtime/src/evaluation/recap/checkpointRuntime.ts',
  'evals/werkzeug/trajectory.mjs',
  'evals/werkzeug/prepare-partition-study.mjs',
]
const hashes = {}
for (const path of sourcePaths)
  hashes[path] = createHash('sha256')
    .update(await readFile(join(root, path)))
    .digest('hex')
await writeFile(
  join(output, 'design.json'),
  JSON.stringify(
    {
      version: 1,
      status: 'fixture_prepared_not_model_run',
      createdAt: new Date().toISOString(),
      modelCalls: 0,
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      preflight,
      historicalEpisode: historical.directory,
      historySha256: createHash('sha256').update(historyBytes).digest('hex'),
      historyRule:
        'First no-memory completed repair in the preceding cohort; all 130 public messages preserved. No host grading or B2 material added to history.',
      baseline: protocol.baseline,
      image: protocol.image,
      fixtureHashes: protocol.hashes,
      implementationHashes: hashes,
      promptSha256: createHash('sha256')
        .update(prompt + '\n')
        .digest('hex'),
      arms: ['none', 'compact', 'structured'],
      memoryTokens: 4096,
      extractionTargetTokens: 1200,
      repeats: 3,
      order: [
        '0-none',
        '0-compact',
        '0-structured',
        '1-compact',
        '1-structured',
        '1-none',
        '2-structured',
        '2-none',
        '2-compact',
      ],
      primary:
        'First post-command source checkpoint passing all 300 fixed checks; zero-based baseline is also graded. No hidden grading feedback to the model.',
      secondary: [
        'Pre-pass main-loop input/output/cache and tool calls',
        'First-use extraction charge separately',
        'Post-pass tokens/tool calls',
        'Reintroduction of previously fixed byte-preservation regression',
        'Final patch correctness',
        'Model termination status',
        'Evidence export status',
      ],
      interpretation:
        'One related same-subsystem task, three repetitions; exploratory near transfer, not statistical significance or broad lifelong-learning evidence.',
      launchRequirements: [
        'Freeze complete runner, provider, compaction implementation and memories before any target',
        'Keep model terminal status distinct from transcript-export failure',
        'Use checkpointRuntime; prove every changed source state is captured in a no-model integration check',
        'Run grading only after model termination; snapshots and grading files stay off model mounts',
      ],
    },
    null,
    2,
  ) + '\n',
)
console.log(JSON.stringify({ output, status: 'fixture_prepared_not_model_run', modelCalls: 0 }))
