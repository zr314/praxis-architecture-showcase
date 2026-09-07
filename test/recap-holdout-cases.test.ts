import assert from 'node:assert/strict'
import test from 'node:test'
import { holdoutRecapCases } from '../apps/runtime/src/evaluation/recap/holdoutCases.js'
import { digest } from '../apps/runtime/src/recap/recap.js'

test('new suite can be canonically frozen without shared fixture identities', () => {
  assert.equal(digest(holdoutRecapCases()), digest(holdoutRecapCases()))
})

test('heap answers match independent byte occupancy simulation, including failed allocation and policy change', () => {
  for (const task of holdoutRecapCases()[0]!.targets) {
    const policy = JSON.parse(task.files['policy.json']!)
    const ops = JSON.parse(task.files['operations.json']!) as {
      op: string
      id: string
      bytes?: number
    }[]
    const cells = Array<string | null>(policy.heapBytes).fill(null)
    const holes = () => {
      const result: { start: number; bytes: number }[] = []
      for (let start = 0; start < cells.length; start++)
        if (cells[start] === null) {
          let end = start + 1
          while (end < cells.length && cells[end] === null) end++
          result.push({ start, bytes: end - start })
          start = end - 1
        }
      return result
    }
    const allocations = []
    for (const op of ops) {
      if (op.op === 'free') {
        assert.ok(cells.includes(op.id))
        for (let i = 0; i < cells.length; i++) if (cells[i] === op.id) cells[i] = null
        continue
      }
      const bytes = Math.ceil(op.bytes! / policy.alignment) * policy.alignment
      const eligible = holes().filter((h) => h.bytes >= bytes)
      if (policy.placement === 'best_fit')
        eligible.sort((a, b) => a.bytes - b.bytes || a.start - b.start)
      const address = eligible[0]?.start ?? null
      if (address !== null) cells.fill(op.id, address, address + bytes)
      allocations.push({ id: op.id, address, bytes })
    }
    assert.deepEqual({ allocations, freeBlocks: holes() }, task.expected)
  }
})

test('fragment answers preserve all retained source bytes and enforce each condition of the data-image exception', () => {
  for (const task of holdoutRecapCases()[1]!.targets) {
    const policy = JSON.parse(task.files['policy.json']!)
    const fragments = JSON.parse(task.files['fragments.json']!) as {
      id: string
      kind: string
      raw: string
      name?: string
      tag?: string
      valueDecoded?: string
    }[]
    const removed: string[] = []
    let html = ''
    for (const f of fragments) {
      const name = f.name?.toLowerCase() ?? ''
      const value = [...(f.valueDecoded ?? '')]
        .filter((c) => c.charCodeAt(0) > 32)
        .join('')
        .toLowerCase()
      let drop = f.kind === 'script'
      if (f.kind === 'attribute') {
        drop ||= name.startsWith('on')
        if (['href', 'src', 'action', 'xlink:href'].includes(name)) {
          const scheme = value.split(':')[0]
          drop ||= ['javascript', 'vbscript'].includes(scheme!) && value.includes(':')
          if (scheme === 'data' && value.includes(':')) {
            const image =
              policy.allowDataImages &&
              f.tag === 'img' &&
              name === 'src' &&
              ['data:image/png;base64,', 'data:image/jpeg;base64,'].some((p) => value.startsWith(p))
            drop ||= !image
          }
        }
      }
      if (drop) removed.push(f.id)
      else html += f.raw
    }
    assert.deepEqual({ html, removed }, task.expected)
    assert.match(html, /safe &amp; sound/)
    assert.match(html, /alt="a {2}b"/)
    assert.match(html, /\/docs\/javascript:guide/)
  }
})

type Expr = number | boolean | string | Expr[]
type Value = number | boolean | { params: string[]; body: Expr; scope: Scope }
class Scope {
  readonly bindings = new Map<string, Value>()
  constructor(readonly parent?: Scope) {}
  owner(name: string): Scope {
    if (this.bindings.has(name)) return this
    if (this.parent) return this.parent.owner(name)
    throw new Error(`Unbound ${name}`)
  }
  get(name: string): Value {
    return this.owner(name).bindings.get(name)!
  }
}

test('closure answers match lexical reference capture interpreter with independent parallel/sequential let semantics', () => {
  for (const task of holdoutRecapCases()[2]!.targets) {
    const mode = JSON.parse(task.files['policy.json']!).letMode
    const outputs: Value[] = []
    function evaluate(expr: Expr, scope: Scope): Value {
      if (typeof expr === 'number' || typeof expr === 'boolean') return expr
      if (typeof expr === 'string') return scope.get(expr)
      const [form, ...args] = expr
      switch (form) {
        case 'begin': {
          let value: Value = false
          for (const arg of args) value = evaluate(arg, scope)
          return value
        }
        case 'define': {
          const value = evaluate(args[1]!, scope)
          scope.bindings.set(String(args[0]), value)
          return value
        }
        case 'set!': {
          const value = evaluate(args[1]!, scope)
          scope.owner(String(args[0])).bindings.set(String(args[0]), value)
          return value
        }
        case 'lambda':
          return { params: args[0] as string[], body: args[1]!, scope }
        case 'call': {
          const fn = evaluate(args[0]!, scope)
          assert.equal(typeof fn, 'object')
          if (typeof fn !== 'object') throw new Error('Not callable')
          const values = args.slice(1).map((a) => evaluate(a, scope))
          const child = new Scope(fn.scope)
          fn.params.forEach((p, i) => {
            child.bindings.set(p, values[i]!)
          })
          return evaluate(fn.body, child)
        }
        case 'let': {
          const child = new Scope(scope)
          for (const [name, initializer] of args[0] as [string, Expr][])
            child.bindings.set(name, evaluate(initializer, mode === 'parallel' ? scope : child))
          return evaluate(args[1]!, child)
        }
        case '+':
          return args
            .map((a) => evaluate(a, scope))
            .reduce<number>((sum, v) => {
              assert.equal(typeof v, 'number')
              return sum + Number(v)
            }, 0)
        case 'if':
          return evaluate(evaluate(args[0]!, scope) === false ? args[2]! : args[1]!, scope)
        case 'print': {
          const value = evaluate(args[0]!, scope)
          outputs.push(value)
          return value
        }
        default:
          throw new Error(`Unknown form ${form}`)
      }
    }
    evaluate(JSON.parse(task.files['program.json']!) as Expr, new Scope())
    assert.deepEqual({ outputs }, task.expected)
  }
})
