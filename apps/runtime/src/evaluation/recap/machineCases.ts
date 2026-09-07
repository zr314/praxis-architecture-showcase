import type { RecapCase } from './cases.js'

const json = (value: unknown) => JSON.stringify(value, null, 2)

/** Original small state machines. These do not reproduce DOOM or graphical G-code OCR. */
export function machineRecapCases(): readonly RecapCase[] {
  const gcodeRules = [
    'This project uses a deliberately specified G-code subset. Start X=0,Y=0,Z=0,E=0; XYZ and E are initially absolute. Units are millimeters.',
    'G90/G91 set XYZ absolute/relative mode only. M82/M83 set E absolute/relative mode only. Neither mode switch resets coordinates.',
    'G92 replaces only explicitly specified coordinate registers without any motion, drawing or extrusion. Omitted registers remain unchanged.',
    'For each G1, omitted axes and E stay unchanged. In relative mode add the supplied number; in absolute mode replace the register. Compute deltaE from the E register before and after this command.',
    'A printed segment requires deltaE>0, a nonzero XY move, and both endpoint Z values exactly equal to current policy.layerZ. Travel, retraction, stationary priming and moves between layers are excluded.',
    'Every G1 updates registers even if its segment is excluded. Negative E values are valid. A later positive relative E is extrusion, even when the resulting E register is negative.',
    'Report included segments in original command order with 1-based line, from:[X,Y,Z], to:[X,Y,Z], deltaE. All fixture movements are axis-aligned; length is abs(deltaX)+abs(deltaY).',
    'Write answer.json as {segments:[{line,from,to,deltaE},...],totalLength:number,final:{X,Y,Z,E}}. Read current policy.json before selecting a layer; do not infer text or add real firmware rules.',
  ].join('\n')
  const commands = [
    'G90',
    'M82',
    'G1 X2 Y1 Z0.2 E0',
    'G1 X8 E2',
    'G1 Y5 E4',
    'G92 E0',
    'G1 X2 E2',
    'M83',
    'G1 E-1',
    'G1 Y1 E0',
    'G1 X8 E1',
    'G91',
    'G1 Y4 E1',
    'G92 X0 E-2',
    'G1 X-6 E1',
    'G90',
    'G1 Z0.4',
    'G1 X0 E1',
    'M82',
    'G92 E0',
    'G1 Y9 E2',
    'G1 X4 E1',
    'G1 Y5 E3',
    'G1 E4',
  ].join('\n')
  const seg = (line: number, from: number[], to: number[], deltaE: number) => ({
    line,
    from,
    to,
    deltaE,
  })
  const cpuRules = [
    'Simulate the specified small 32-bit machine; this is not a full MIPS ISA. Execute each instruction in input order. Memory contains eight initially zero bytes; all registers initially contain zero.',
    'Registers r0 through r11 store unsigned 32-bit bit patterns. All writes wrap modulo 2^32; writes to r0 are discarded and reading r0 always yields zero.',
    'LI rd immediate sets a register. ADDI rd rs immediate adds a signed integer immediate. OR rd rs rt computes bitwise OR.',
    'SW rs address stores four bytes of rs in current policy.endian byte order. LW rd address reads four bytes in that same order. SB rs address stores the low eight bits only.',
    'LB sign-extends one byte to 32 bits; LBU zero-extends it. LH sign-extends two bytes in policy.endian order; LHU zero-extends them. Addresses are absolute byte indexes and all accesses are valid.',
    'SRA rd rs amount interprets rs as signed two-complement and shifts arithmetically; SRL shifts the unsigned bit pattern logically. SLT rd rs rt compares signed values; SLTU compares unsigned values. Comparisons produce 0 or 1.',
    'Sign extension changes upper bits; storing a byte does not overwrite neighboring bytes. Memory byte order affects loads/stores but never changes arithmetic semantics.',
    'Write answer.json as {registers:[r0,r1,...,r11],memory:[byte0,...,byte7]}. Report unsigned decimal register values from 0 to 4294967295. Read the current endian policy, not the historical value.',
  ].join('\n')
  const program = [
    'LI r1 2164195583', // 0x80ff00ff
    'SW r1 0',
    'LB r2 0',
    'LBU r3 0',
    'LH r4 2',
    'LHU r5 0',
    'LI r6 4294967295',
    'ADDI r7 r6 2',
    'SRA r8 r1 24',
    'SRL r9 r1 24',
    'SLT r10 r6 r7',
    'SLTU r11 r6 r7',
    'ADDI r0 r7 9',
    'SB r7 1',
    'LW r5 0',
    'SW r6 4',
    'SB r9 6',
    'LH r4 6',
  ].join('\n')
  return [
    {
      id: 'gcode-state',
      learning: {
        prompt:
          'Study rules.txt, policy.json and incidents.txt; describe reusable state tracking rules. Future commands are unavailable.',
        files: {
          'rules.txt': gcodeRules,
          'policy.json': json({ layerZ: 0.2 }),
          'incidents.txt':
            'Historical mistakes mixed E mode with XYZ mode, counted travel as printed strokes, and treated G92 as motion. Track extrusion differences rather than the sign of the absolute E register. These are authored examples, not measured runs.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt: 'Process commands.txt with the current rules and policy; write answer.json.',
          files: {
            'rules.txt': gcodeRules,
            'policy.json': json({ layerZ: 0.2 }),
            'commands.txt': commands,
          },
          expected: {
            segments: [
              seg(4, [2, 1, 0.2], [8, 1, 0.2], 2),
              seg(5, [8, 1, 0.2], [8, 5, 0.2], 2),
              seg(7, [8, 5, 0.2], [2, 5, 0.2], 2),
              seg(11, [2, 1, 0.2], [8, 1, 0.2], 1),
              seg(13, [8, 1, 0.2], [8, 5, 0.2], 1),
              seg(15, [0, 5, 0.2], [-6, 5, 0.2], 1),
            ],
            totalLength: 32,
            final: { X: 4, Y: 5, Z: 0.4, E: 4 },
          },
        },
        {
          id: 'updated',
          prompt: 'Process commands.txt with the current rules and policy; write answer.json.',
          files: {
            'rules.txt': gcodeRules,
            'policy.json': json({ layerZ: 0.4 }),
            'commands.txt': commands,
          },
          expected: {
            segments: [
              seg(18, [-6, 5, 0.4], [0, 5, 0.4], 1),
              seg(21, [0, 5, 0.4], [0, 9, 0.4], 2),
              seg(23, [4, 9, 0.4], [4, 5, 0.4], 2),
            ],
            totalLength: 14,
            final: { X: 4, Y: 5, Z: 0.4, E: 4 },
          },
        },
      ],
    },
    {
      id: 'byte-machine',
      learning: {
        prompt:
          'Study rules.txt, policy.json and incidents.txt; describe reusable machine execution rules. Future instructions are unavailable.',
        files: {
          'rules.txt': cpuRules,
          'policy.json': json({ endian: 'little' }),
          'incidents.txt':
            'Authored failure examples: confusing LB with LBU; logical shifting a signed negative value; writing r0; using an old byte order; and overwriting a whole word for SB. Wrap register arithmetic and preserve unaffected memory bytes.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt: 'Execute program.txt under the current rules and policy; write answer.json.',
          files: {
            'rules.txt': cpuRules,
            'policy.json': json({ endian: 'little' }),
            'program.txt': program,
          },
          expected: {
            registers: [
              0, 2164195583, 4294967295, 255, 4294967168, 2164195839, 4294967295, 1, 4294967168,
              128, 1, 0,
            ],
            memory: [255, 1, 255, 128, 255, 255, 128, 255],
          },
        },
        {
          id: 'updated',
          prompt: 'Execute program.txt under the current rules and policy; write answer.json.',
          files: {
            'rules.txt': cpuRules,
            'policy.json': json({ endian: 'big' }),
            'program.txt': program,
          },
          expected: {
            registers: [
              0, 2164195583, 4294967168, 128, 4294934783, 2147549439, 4294967295, 1, 4294967168,
              128, 1, 0,
            ],
            memory: [128, 1, 0, 255, 255, 255, 128, 255],
          },
        },
      ],
    },
  ]
}
