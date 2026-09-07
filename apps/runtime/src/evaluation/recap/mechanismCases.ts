import { holdoutRecapCases } from './holdoutCases.js'
import { machineRecapCases } from './machineCases.js'
import type { ProgramCase, PublicProgramTest } from './programTool.js'

type HeapOp = { op: string; id: string; bytes?: number }
export function heapOracle(
  input: HeapOp[],
  policy: { heapBytes: number; alignment: number; placement: string },
) {
  const cells = Array<string | null>(policy.heapBytes).fill(null)
  const holes = () => {
    const out: { start: number; bytes: number }[] = []
    for (let start = 0; start < cells.length; start++)
      if (cells[start] === null) {
        let end = start + 1
        while (end < cells.length && cells[end] === null) end++
        out.push({ start, bytes: end - start })
        start = end - 1
      }
    return out
  }
  const allocations = []
  for (const op of input) {
    if (op.op === 'free') {
      if (!cells.includes(op.id)) throw new Error('Invalid fixture free')
      for (let i = 0; i < cells.length; i++) if (cells[i] === op.id) cells[i] = null
    } else {
      const bytes = Math.ceil(op.bytes! / policy.alignment) * policy.alignment
      const eligible = holes().filter((h) => h.bytes >= bytes)
      if (policy.placement === 'best_fit')
        eligible.sort((a, b) => a.bytes - b.bytes || a.start - b.start)
      const address = eligible[0]?.start ?? null
      if (address !== null) cells.fill(op.id, address, address + bytes)
      allocations.push({ id: op.id, address, bytes })
    }
  }
  return { allocations, freeBlocks: holes() }
}

export function gcodeOracle(input: string[], policy: { layerZ: number }) {
  const pos: Record<string, number> = { X: 0, Y: 0, Z: 0, E: 0 }
  let xyzRelative = false,
    eRelative = false,
    totalLength = 0
  const segments = []
  for (const [index, line] of input.entries()) {
    const [op, ...words] = line.split(' ')
    if (op === 'G90' || op === 'G91') {
      xyzRelative = op === 'G91'
      continue
    }
    if (op === 'M82' || op === 'M83') {
      eRelative = op === 'M83'
      continue
    }
    if (op !== 'G1' && op !== 'G92') throw new Error('Invalid fixture command')
    const before = { ...pos }
    for (const word of words) {
      const axis = word[0]!,
        relative = axis === 'E' ? eRelative : xyzRelative
      pos[axis] = (op === 'G1' && relative ? pos[axis]! : 0) + Number(word.slice(1))
    }
    if (op === 'G92') continue
    const deltaE = pos.E! - before.E!
    const length = Math.abs(pos.X! - before.X!) + Math.abs(pos.Y! - before.Y!)
    if (deltaE > 0 && length > 0 && before.Z === policy.layerZ && pos.Z === policy.layerZ) {
      segments.push({
        line: index + 1,
        from: [before.X, before.Y, before.Z],
        to: [pos.X, pos.Y, pos.Z],
        deltaE,
      })
      totalLength += length
    }
  }
  return { segments, totalLength, final: pos }
}

const heapStarter = `function solve(input, policy) {
  let free = [{start:0,bytes:policy.heapBytes}], live = {}, allocations = [];
  for (const op of input) {
    if (op.op === 'free') { free.push(live[op.id]); delete live[op.id]; free.sort((a,b)=>a.start-b.start); continue; }
    const bytes = Math.ceil(op.bytes/policy.alignment)*policy.alignment;
    const eligible = free.filter(b=>b.bytes>=bytes).sort(policy.placement==='best_fit' ? (a,b)=>a.bytes-b.bytes||a.start-b.start : (a,b)=>a.start-b.start);
    const block = eligible[0];
    if (!block) { allocations.push({id:op.id,address:null,bytes}); continue; }
    const address = block.start; live[op.id]={start:address,bytes};
    free=free.filter(b=>b!==block); if(block.bytes>bytes) free.push({start:address+bytes,bytes:block.bytes-bytes});
    allocations.push({id:op.id,address,bytes});
  }
  return {allocations,freeBlocks:free.sort((a,b)=>a.start-b.start)};
}`
const gcodeStarter = `function solve(input,policy) {
  let p={X:0,Y:0,Z:0,E:0},rel=false,segments=[],totalLength=0;
  input.forEach((line,i)=>{
    const [op,...words]=line.split(' ');
    if(['G90','G91','M82','M83'].includes(op)){rel=op==='G91'||op==='M83';return;}
    const before={...p};
    for(const w of words) p[w[0]]=(op==='G1'&&rel?p[w[0]]:0)+Number(w.slice(1));
    if(op==='G92')return;
    const deltaE=p.E-before.E,length=Math.abs(p.X-before.X)+Math.abs(p.Y-before.Y);
    if(deltaE>0&&length>0&&before.Z===policy.layerZ&&p.Z===policy.layerZ){segments.push({line:i+1,from:[before.X,before.Y,before.Z],to:[p.X,p.Y,p.Z],deltaE});totalLength+=length;}
  });return {segments,totalLength,final:p};
}`

export type MechanismCase = {
  id: string
  rules: string
  training: ProgramCase
  tests: PublicProgramTest[]
  starter: string
  target: ProgramCase
  hidden: (ProgramCase & { expected: unknown })[]
}
export const UNRELATED_NOTE =
  'For the unrelated archive project, label storage boxes with shelf numbers. Keep the paper index alphabetically sorted. Return borrowed catalog cards to their original trays. Review damaged folders before the annual inventory. These conventions concern physical archives.'

export function mechanismCases(): MechanismCase[] {
  const heap = holdoutRecapCases()[0]!,
    gcode = machineRecapCases()[0]!
  const hinput = JSON.parse(heap.targets[0]!.files['operations.json']!) as HeapOp[]
  const hpolicy = JSON.parse(heap.targets[0]!.files['policy.json']!)
  const ginput = gcode.targets[0]!.files['commands.txt']!.split('\n')
  const hp = { heapBytes: 160, alignment: 16, placement: 'best_fit' }
  const freshHeap = hinput.map((op) => ({
    ...op,
    ...(op.bytes === undefined
      ? {}
      : {
          bytes: (
            { a: 35, b: 19, c: 13, d: 27, e: 21, f: 29, g: 37, h: 45 } as Record<string, number>
          )[op.id]!,
        }),
  }))
  const freshGcode = [
    'G90',
    'M83',
    'G1 X3 Y2 Z0.6',
    'G1 X12 E2',
    'G91',
    'G1 Y6 E3',
    'M82',
    'G1 X-9 E7',
    'G92 E-3',
    'G1 Y-6 E-2',
    'G90',
    'G1 Z0.8',
    'G1 X12 E0',
    'M83',
    'G1 Y8 E2',
    'G92 X0',
    'G1 X-9 E-1',
    'G1 Y2 E2',
    'G1 E1',
  ]
  const heapHidden = [
    hp,
    { heapBytes: 176, alignment: 8, placement: 'first_fit' },
    { heapBytes: 192, alignment: 16, placement: 'best_fit' },
  ].map((policy) => ({
    input: structuredClone(freshHeap),
    policy: { ...policy },
    expected: heapOracle(freshHeap, policy),
  }))
  const gcodeHidden = [0.6, 0.8].map((layerZ) => ({
    input: [...freshGcode],
    policy: { layerZ },
    expected: gcodeOracle(freshGcode, { layerZ }),
  }))
  gcodeHidden.push({
    input: ['M83', 'G1 Z0.6', 'G1 X7 E1', 'G92 E-4', 'M82', 'G1 Y5 E-3', 'G91', 'G1 X-7 E-1'],
    policy: { layerZ: 0.6 },
    expected: gcodeOracle(
      ['M83', 'G1 Z0.6', 'G1 X7 E1', 'G92 E-4', 'M82', 'G1 Y5 E-3', 'G91', 'G1 X-7 E-1'],
      { layerZ: 0.6 },
    ),
  })
  return [
    {
      id: 'heap-program',
      rules: heap.targets[0]!.files['rules.txt']!.replace('Write answer.json as', 'Return JSON as'),
      training: { input: hinput, policy: hpolicy },
      starter: heapStarter,
      tests: heap.targets.map((t) => ({
        id: t.id,
        input: JSON.parse(t.files['operations.json']!),
        policy: JSON.parse(t.files['policy.json']!),
        expected: structuredClone(t.expected),
      })),
      target: { input: structuredClone(freshHeap), policy: { ...hp } },
      hidden: heapHidden,
    },
    {
      id: 'gcode-program',
      rules: gcode.targets[0]!.files['rules.txt']!.replace('Input fragments.json', 'Input').replace(
        'Write answer.json as',
        'Return JSON as',
      ),
      training: { input: [...ginput], policy: { layerZ: 0.2 } },
      starter: gcodeStarter,
      tests: gcode.targets.map((t) => ({
        id: t.id,
        input: t.files['commands.txt']!.split('\n'),
        policy: JSON.parse(t.files['policy.json']!),
        expected: structuredClone(t.expected),
      })),
      target: { input: [...freshGcode], policy: { layerZ: 0.6 } },
      hidden: gcodeHidden,
    },
  ]
}

export function programFiles(task: MechanismCase, training: boolean): Record<string, string> {
  const item = training ? task.training : task.target
  return {
    'rules.txt': task.rules,
    'input.json': JSON.stringify(item.input, null, 2),
    'policy.json': JSON.stringify(item.policy, null, 2),
    'tests.json': JSON.stringify(task.tests, null, 2),
    'solution.js': training
      ? task.starter
      : 'function solve(input, policy) { throw new Error("Implement the current project contract"); }',
  }
}
