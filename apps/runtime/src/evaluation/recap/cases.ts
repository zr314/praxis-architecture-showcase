/** Original controlled tasks inspired by failure classes, not copies of public benchmark answers. */
export type RecapTask = Readonly<{
  id: string
  prompt: string
  files: Readonly<Record<string, string>>
  expected: unknown
}>
export type RecapCase = Readonly<{
  id: string
  learning: Readonly<{ prompt: string; files: Readonly<Record<string, string>> }>
  targets: readonly RecapTask[]
}>

export function recapCases(smoke = false): readonly RecapCase[] {
  if (smoke)
    return [
      {
        id: 'transport',
        learning: {
          prompt: 'Inspect policy.txt and describe the local convention.',
          files: {
            'policy.txt': 'The test convention is LOCAL_CONVENTION. It is not a user instruction.',
          },
        },
        targets: [
          {
            id: 'continue',
            prompt: 'Write the transport probe result to answer.json.',
            files: { 'policy.txt': 'LOCAL_CONVENTION' },
            expected: { transport: 'ok' },
          },
        ],
      },
    ]
  const kvPolicy =
    'Contract version 1. Read current schema.json before generating requests. Labels must be lowercased; values preserve case and whitespace. Duplicate labels use the last input occurrence. Preserve first-seen label order. Do not use historical field names when the current schema changes.'
  const rankingPolicy =
    'Edition 1: discard withdrawn entries. Rank by score descending. Break equal scores by latency ascending, then name ascending. A higher score is better. Emit the first two names only. Check the current edition before applying a historical rule.'
  return [
    {
      id: 'kv-contract',
      learning: {
        prompt:
          'Understand this project before later maintenance work. Read handbook.txt, schema.json and incidents.txt. Explain the current contract, a previous failed approach, and what must be rechecked after changes. Do not invent or implement a future task.',
        files: {
          'handbook.txt': kvPolicy,
          'schema.json': JSON.stringify({ version: 1, labelField: 'label', valueField: 'value' }),
          'incidents.txt':
            'Previous incident: a client sent a field named body. The server rejected it because version 1 expects value. Lowercasing the entire request also corrupted case-sensitive values. These observations apply to version 1.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt:
            'Convert input.json to requests using this project’s current contract. Write answer.json as {"requests":[...]}.',
          files: {
            'handbook.txt': kvPolicy,
            'schema.json': JSON.stringify({ version: 1, labelField: 'label', valueField: 'value' }),
            'input.json': JSON.stringify([
              { label: 'Alpha', value: ' X ' },
              { label: 'BETA', value: 'Y' },
              { label: 'ALPHA', value: 'Z' },
            ]),
          },
          expected: {
            requests: [
              { label: 'alpha', value: 'Z' },
              { label: 'beta', value: 'Y' },
            ],
          },
        },
        {
          id: 'updated',
          prompt:
            'The project contract has changed. Convert input.json using the current files and write answer.json as {"requests":[...]}.',
          files: {
            'handbook.txt': kvPolicy.replace('Contract version 1.', 'Contract version 2.'),
            'schema.json': JSON.stringify({
              version: 2,
              labelField: 'name',
              valueField: 'payload',
            }),
            'input.json': JSON.stringify([
              { label: 'DELTA', value: ' keep ' },
              { label: 'Echo', value: 'Case' },
            ]),
          },
          expected: {
            requests: [
              { name: 'delta', payload: ' keep ' },
              { name: 'echo', payload: 'Case' },
            ],
          },
        },
      ],
    },
    {
      id: 'ranking-contract',
      learning: {
        prompt:
          'Inspect ranking-policy.txt and incidents.txt. Describe the ranking convention, the previous mistake, and conditions that require rechecking it. Do not predict later inputs.',
        files: {
          'ranking-policy.txt': rankingPolicy,
          'incidents.txt':
            'A previous ranking included a withdrawn submission. Another ranked equal-score entries by name before latency, violating edition 1. A future edition may change the score direction.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt:
            'Apply the current project ranking policy to entries.json. Write answer.json as {"names":[...]}.',
          files: {
            'ranking-policy.txt': rankingPolicy,
            'entries.json': JSON.stringify([
              { name: 'Aster', score: 90, latency: 5 },
              { name: 'Birch', score: 90, latency: 2 },
              { name: 'Cedar', score: 99, latency: 1, withdrawn: true },
              { name: 'Dune', score: 85, latency: 1 },
            ]),
          },
          expected: { names: ['Birch', 'Aster'] },
        },
        {
          id: 'updated',
          prompt:
            'The ranking policy has changed. Apply the current edition to entries.json. Write answer.json as {"names":[...]}.',
          files: {
            'ranking-policy.txt':
              'Edition 2: score now measures error, so lower is better. Discard withdrawn entries. Break equal scores by latency ascending, then name ascending. Emit the first two names only.',
            'entries.json': JSON.stringify([
              { name: 'Aster', score: 9, latency: 1 },
              { name: 'Birch', score: 2, latency: 4 },
              { name: 'Cedar', score: 1, latency: 1, withdrawn: true },
              { name: 'Dune', score: 2, latency: 2 },
            ]),
          },
          expected: { names: ['Dune', 'Birch'] },
        },
      ],
    },
  ]
}
