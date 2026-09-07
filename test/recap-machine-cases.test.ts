import assert from 'node:assert/strict'
import test from 'node:test'
import { machineRecapCases } from '../apps/runtime/src/evaluation/recap/machineCases.js'
import { digest } from '../apps/runtime/src/recap/recap.js'

test('machine suite freezes deterministically and byte-machine answers match Buffer operations', () => {
  assert.equal(digest(machineRecapCases()), digest(machineRecapCases()))
  for (const task of machineRecapCases()[1]!.targets) {
    const little = JSON.parse(task.files['policy.json']!).endian === 'little'
    const memory = Buffer.alloc(8)
    const registers = Array<number>(12).fill(0)
    const reg = (s: string) => Number(s.slice(1))
    for (const line of task.files['program.txt']!.split('\n')) {
      const [op, dst, a, b] = line.split(' ') as [string, string, string, string]
      const d = reg(dst)
      const addr = Number(a)
      let value: number | undefined
      switch (op) {
        case 'LI':
          value = Number(a)
          break
        case 'ADDI':
          value = registers[reg(a)]! + Number(b)
          break
        case 'SW':
          little
            ? memory.writeUInt32LE(registers[d]!, addr)
            : memory.writeUInt32BE(registers[d]!, addr)
          break
        case 'SB':
          memory.writeUInt8(registers[d]! & 255, addr)
          break
        case 'LW':
          value = little ? memory.readUInt32LE(addr) : memory.readUInt32BE(addr)
          break
        case 'LB':
          value = memory.readInt8(addr)
          break
        case 'LBU':
          value = memory.readUInt8(addr)
          break
        case 'LH':
          value = little ? memory.readInt16LE(addr) : memory.readInt16BE(addr)
          break
        case 'LHU':
          value = little ? memory.readUInt16LE(addr) : memory.readUInt16BE(addr)
          break
        case 'SRA':
          value = registers[reg(a)]! >> Number(b)
          break
        case 'SRL':
          value = registers[reg(a)]! >>> Number(b)
          break
        case 'SLT':
          value = Number((registers[reg(a)]! | 0) < (registers[reg(b)]! | 0))
          break
        case 'SLTU':
          value = Number(registers[reg(a)]! < registers[reg(b)]!)
          break
        default:
          throw new Error(`Unknown instruction ${op}`)
      }
      if (value !== undefined && d !== 0) registers[d] = value >>> 0
    }
    assert.deepEqual({ registers, memory: [...memory] }, task.expected)
  }
})

test('G-code expected segments match independent modal register simulation', () => {
  for (const task of machineRecapCases()[0]!.targets) {
    const layer = JSON.parse(task.files['policy.json']!).layerZ
    const pos: Record<string, number> = { X: 0, Y: 0, Z: 0, E: 0 }
    let xyzRelative = false
    let eRelative = false
    let totalLength = 0
    const segments = []
    for (const [index, line] of task.files['commands.txt']!.split('\n').entries()) {
      const [op, ...words] = line.split(' ')
      if (op === 'G90' || op === 'G91') {
        xyzRelative = op === 'G91'
        continue
      }
      if (op === 'M82' || op === 'M83') {
        eRelative = op === 'M83'
        continue
      }
      assert.ok(op === 'G92' || op === 'G1')
      const before = { ...pos }
      for (const word of words) {
        const axis = word[0]!
        const relative = axis === 'E' ? eRelative : xyzRelative
        pos[axis] = (op === 'G1' && relative ? pos[axis]! : 0) + Number(word.slice(1))
      }
      if (op === 'G92') continue
      const deltaE = pos.E! - before.E!
      const length = Math.abs(pos.X! - before.X!) + Math.abs(pos.Y! - before.Y!)
      if (deltaE > 0 && length > 0 && before.Z === layer && pos.Z === layer) {
        segments.push({
          line: index + 1,
          from: [before.X, before.Y, before.Z],
          to: [pos.X, pos.Y, pos.Z],
          deltaE,
        })
        totalLength += length
      }
    }
    assert.deepEqual({ segments, totalLength, final: pos }, task.expected)
  }
})
