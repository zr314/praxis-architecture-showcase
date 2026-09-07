import type { RecapCase } from './cases.js'

const json = (value: unknown) => JSON.stringify(value, null, 2)

/** New cases after extractive-v2 was frozen. Original simulations, not official benchmark scores. */
export function holdoutRecapCases(): readonly RecapCase[] {
  const heapRules = [
    'Simulate a byte heap [0,policy.heapBytes), initially entirely free. Process operations in input order.',
    'An allocation reserves ceil(requestedBytes/policy.alignment)*policy.alignment bytes, starting at the beginning of one free block. No headers or other overhead exist.',
    'policy.placement=first_fit chooses the eligible free block with lowest start address.',
    'policy.placement=best_fit chooses the smallest eligible free block; break equal-size ties by lowest start address.',
    'Split any unused suffix into a free block. Allocation failure returns address=null and changes no heap state; still report its rounded byte count.',
    'A free operation releases the entire reserved block for that live id. Every free in this input is valid. Immediately merge all adjacent free blocks.',
    'Total free space does not imply a sufficiently large contiguous block. Failed allocations do not create live ids.',
    'Read current policy.json before reusing a historical placement rule.',
    'Write answer.json as {"allocations":[{"id":string,"address":number|null,"bytes":number},...],"freeBlocks":[{"start":number,"bytes":number},...]}. Include every alloc in operation order, even failed ones. Final freeBlocks are maximal contiguous intervals sorted by start.',
  ].join('\n')
  const operations = [
    { op: 'alloc', id: 'a', bytes: 41 },
    { op: 'alloc', id: 'b', bytes: 25 },
    { op: 'alloc', id: 'c', bytes: 17 },
    { op: 'alloc', id: 'd', bytes: 17 },
    { op: 'free', id: 'a' },
    { op: 'free', id: 'c' },
    { op: 'alloc', id: 'e', bytes: 17 },
    { op: 'alloc', id: 'f', bytes: 25 },
    { op: 'free', id: 'd' },
    { op: 'alloc', id: 'g', bytes: 33 },
    { op: 'free', id: 'b' },
    { op: 'alloc', id: 'h', bytes: 41 },
  ]
  const allocation = (id: string, address: number | null, bytes: number) => ({ id, address, bytes })
  const heapPrefix = [
    allocation('a', 0, 48),
    allocation('b', 48, 32),
    allocation('c', 80, 24),
    allocation('d', 104, 24),
  ]

  const htmlRules = [
    'Input fragments.json is an already-tokenized ordered stream. Each fragment raw is an exact source slice; no HTML parsing or entity decoding is required.',
    'Remove every fragment with kind=script. Keep every kind=text fragment unchanged, even when it mentions JavaScript or contains escaped markup.',
    'For kind=attribute, compare name case-insensitively. Remove names starting with on. Other ordinary attributes remain byte-for-byte unchanged.',
    'URL attributes are href, src, action and xlink:href. For detection only, lowercase valueDecoded and remove every ASCII character U+0000 through U+0020 anywhere in it.',
    'Remove a URL attribute when that detection value starts with javascript: or vbscript:. A scheme word elsewhere in a relative URL is not a scheme.',
    'Remove URL attributes starting with data: unless policy.allowDataImages=true AND tag is img AND name is src AND detection value starts with data:image/png;base64, or data:image/jpeg;base64,. Both allowed prefixes require all three preceding conditions.',
    'No other schemes or attributes are removed by this limited policy. It is not a complete browser sanitizer. Do not apply real-world extra sanitization rules.',
    'Read the current policy. Never normalize whitespace, quotation marks, attribute order, entities or tag spelling in retained raw slices.',
    'Write answer.json as {"html":string,"removed":string[]}. html is retained raw slices concatenated with no added separator. removed lists removed fragment ids in original order.',
  ].join('\n')
  const fragments = [
    { id: 't0', kind: 'text', raw: '<DIV  class="keep">\n  <a' },
    {
      id: 'a0',
      kind: 'attribute',
      tag: 'a',
      name: 'HREF',
      valueDecoded: 'JaVa\tScRiPt:alert(1)',
      raw: ' HREF = "JaVa&#9;ScRiPt:alert(1)"',
    },
    {
      id: 'a1',
      kind: 'attribute',
      tag: 'a',
      name: 'data-note',
      valueDecoded: 'javascript: is text',
      raw: " data-note='javascript: is text'",
    },
    {
      id: 'a2',
      kind: 'attribute',
      tag: 'a',
      name: 'OnClick',
      valueDecoded: 'alert(2)',
      raw: ' OnClick="alert(2)"',
    },
    { id: 't1', kind: 'text', raw: '>safe &amp; sound</a>\n  <img' },
    {
      id: 'a3',
      kind: 'attribute',
      tag: 'img',
      name: 'src',
      valueDecoded: 'data:image/png;base64,AA==',
      raw: " src='data:image/png;base64,AA=='",
    },
    {
      id: 'a4',
      kind: 'attribute',
      tag: 'img',
      name: 'alt',
      valueDecoded: 'a  b',
      raw: '  alt="a  b"',
    },
    { id: 't2', kind: 'text', raw: '>\n  <a' },
    {
      id: 'a5',
      kind: 'attribute',
      tag: 'a',
      name: 'href',
      valueDecoded: 'data:image/png;base64,AA==',
      raw: ' href="data:image/png;base64,AA=="',
    },
    { id: 't3', kind: 'text', raw: '>not an image element</a>\n  <img' },
    {
      id: 'a6',
      kind: 'attribute',
      tag: 'img',
      name: 'src',
      valueDecoded: 'data:image/svg+xml;base64,AA==',
      raw: ' src="data:image/svg+xml;base64,AA=="',
    },
    { id: 't4', kind: 'text', raw: '>\n  <a' },
    {
      id: 'a7',
      kind: 'attribute',
      tag: 'a',
      name: 'href',
      valueDecoded: '/docs/javascript:guide',
      raw: " href='/docs/javascript:guide'",
    },
    { id: 't5', kind: 'text', raw: '>guide</a>\n  ' },
    { id: 's0', kind: 'script', raw: '<script>run()</script>' },
    { id: 't6', kind: 'text', raw: '&lt;script&gt;text&lt;/script&gt;\n</DIV>' },
  ]
  const cleanHtml = (image: string) =>
    `<DIV  class="keep">\n  <a data-note='javascript: is text'>safe &amp; sound</a>\n  <img${image}  alt="a  b">\n  <a>not an image element</a>\n  <img>\n  <a href='/docs/javascript:guide'>guide</a>\n  &lt;script&gt;text&lt;/script&gt;\n</DIV>`

  const languageRules = [
    'Interpret program.json as a small Lisp AST. Numbers and booleans are literals; bare strings are variable references; arrays are forms.',
    'begin evaluates forms in order and returns the last value. define creates or replaces a binding in the current environment; set! updates the nearest existing binding.',
    'lambda has parameter-name list and one body AST. Capture the definition environment by reference, not a snapshot. call evaluates the function and arguments left-to-right, then executes in a new child of the captured environment.',
    'let has a list of [name,initializer] bindings and one body. It always creates a fresh child environment for the body.',
    'Read policy.letMode: parallel evaluates every initializer in the surrounding environment before adding all bindings to the child. sequential evaluates and installs each binding in the child before evaluating the next initializer there.',
    'Changing letMode never changes lexical closure scope or reference capture. Calling a closure inside a let does not make it capture the caller environment.',
    '+ sums numeric operands. if evaluates only the chosen branch; only boolean false is false, so numeric zero is true.',
    'print appends its evaluated value to outputs and returns that value. No other form appends output. All names are defined before use; there are no implicit global resets between forms.',
    'Write answer.json as {"outputs":[...]} with print values in order. Preserve closure-local mutation across calls, and check current letMode rather than assuming past semantics.',
  ].join('\n')
  const program = [
    'begin',
    ['define', 'x', 10],
    ['define', 'y', 5],
    ['define', 'f', ['lambda', ['y'], ['+', 'x', 'y']]],
    [
      'print',
      [
        'let',
        [
          ['x', 3],
          ['y', 'x'],
        ],
        ['+', 'x', 'y'],
      ],
    ],
    ['print', ['let', [['x', 20]], ['call', 'f', 2]]],
    ['set!', 'x', 7],
    ['print', ['call', 'f', 2]],
    ['print', ['if', 0, 1, 2]],
    [
      'define',
      'counter',
      ['let', [['n', 0]], ['lambda', [], ['begin', ['set!', 'n', ['+', 'n', 1]], 'n']]],
    ],
    ['print', ['call', 'counter']],
    ['print', ['call', 'counter']],
    [
      'print',
      [
        'let',
        [
          ['x', 100],
          ['z', ['call', 'f', 1]],
        ],
        ['+', 'x', 'z'],
      ],
    ],
    [
      'print',
      [
        'let',
        [
          ['x', 2],
          ['y', ['+', 'x', 1]],
          ['z', ['+', 'x', 'y']],
        ],
        ['+', 'x', 'y', 'z'],
      ],
    ],
    ['print', 'x'],
  ]
  return [
    {
      id: 'heap-placement',
      learning: {
        prompt:
          'Study rules.txt, policy.json and incidents.txt. Describe reusable heap rules and pitfalls; no future operations are available.',
        files: {
          'rules.txt': heapRules,
          'policy.json': json({ heapBytes: 128, alignment: 8, placement: 'first_fit' }),
          'incidents.txt':
            'A prior allocator confused requested and reserved bytes, counted disconnected free space as one block, and forgot to coalesce after free. A failed allocation must not consume space. Placement policy is independent of alignment.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt: 'Simulate operations.json using the current rules and policy; write answer.json.',
          files: {
            'rules.txt': heapRules,
            'policy.json': json({ heapBytes: 128, alignment: 8, placement: 'first_fit' }),
            'operations.json': json(operations),
          },
          expected: {
            allocations: [
              ...heapPrefix.map((entry) => ({ ...entry })),
              allocation('e', 0, 24),
              allocation('f', null, 32),
              allocation('g', 80, 40),
              allocation('h', 24, 48),
            ],
            freeBlocks: [
              { start: 72, bytes: 8 },
              { start: 120, bytes: 8 },
            ],
          },
        },
        {
          id: 'updated',
          prompt: 'Simulate operations.json using the current rules and policy; write answer.json.',
          files: {
            'rules.txt': heapRules,
            'policy.json': json({ heapBytes: 128, alignment: 8, placement: 'best_fit' }),
            'operations.json': json(operations),
          },
          expected: {
            allocations: [
              ...heapPrefix.map((entry) => ({ ...entry })),
              allocation('e', 80, 24),
              allocation('f', 0, 32),
              allocation('g', null, 40),
              allocation('h', 32, 48),
            ],
            freeBlocks: [{ start: 104, bytes: 24 }],
          },
        },
      ],
    },
    {
      id: 'html-fragment-policy',
      learning: {
        prompt:
          'Study rules.txt, policy.json and incidents.txt. Describe reusable fragment filtering rules and pitfalls; no future fragments are available.',
        files: {
          'rules.txt': htmlRules,
          'policy.json': json({ allowDataImages: false }),
          'incidents.txt':
            'A prior sanitizer removed javascript words inside safe relative URLs, decoded retained entities, changed quote styles and attribute spacing, and allowed data SVG by confusing it with a permitted PNG. A documentation word javascript is not executable by itself.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt: 'Filter fragments.json under the current rules and policy and write answer.json.',
          files: {
            'rules.txt': htmlRules,
            'policy.json': json({ allowDataImages: false }),
            'fragments.json': json(fragments),
          },
          expected: { html: cleanHtml(''), removed: ['a0', 'a2', 'a3', 'a5', 'a6', 's0'] },
        },
        {
          id: 'updated',
          prompt: 'Filter fragments.json under the current rules and policy and write answer.json.',
          files: {
            'rules.txt': htmlRules,
            'policy.json': json({ allowDataImages: true }),
            'fragments.json': json(fragments),
          },
          expected: {
            html: cleanHtml(" src='data:image/png;base64,AA=='"),
            removed: ['a0', 'a2', 'a5', 'a6', 's0'],
          },
        },
      ],
    },
    {
      id: 'closure-binding',
      learning: {
        prompt:
          'Study rules.txt, policy.json and incidents.txt. Describe reusable interpreter rules and pitfalls; no future AST is available.',
        files: {
          'rules.txt': languageRules,
          'policy.json': json({ letMode: 'parallel' }),
          'incidents.txt':
            'A prior interpreter treated zero as false, copied captured environments so set! was invisible to closures, and evaluated parallel let bindings as sequential. Another implementation used caller scope for closure free variables and reset the counter state on every call.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt: 'Interpret program.json under the current rules and policy; write answer.json.',
          files: {
            'rules.txt': languageRules,
            'policy.json': json({ letMode: 'parallel' }),
            'program.json': json(program),
          },
          expected: { outputs: [13, 12, 9, 1, 1, 2, 108, 22, 7] },
        },
        {
          id: 'updated',
          prompt: 'Interpret program.json under the current rules and policy; write answer.json.',
          files: {
            'rules.txt': languageRules,
            'policy.json': json({ letMode: 'sequential' }),
            'program.json': json(program),
          },
          expected: { outputs: [6, 12, 9, 1, 1, 2, 108, 10, 7] },
        },
      ],
    },
  ]
}
