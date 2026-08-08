import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import { isAinb, parseAinb } from '@shared/formats/ainb'

/**
 * AINB built by hand, byte by byte.
 *
 * The format has no signature per section and no size per section, so every offset in the header is
 * load-bearing: a fixture is the only way to hold the parser to the arithmetic it depends on
 * (command stride 0x18, node stride 0x3c, the seven-slot global header, the derived list lengths).
 * The breadth evidence — all 2,574 graphs in a real dump parsing, 62,749 nodes, no file reporting a
 * region that did not add up — comes from `scripts/validate-ainb.ts`, which needs a dump and cannot
 * live in the unit suite.
 */

const HEADER_SIZE = 0x74
const COMMAND_SIZE = 0x18
const NODE_SIZE = 0x3c

interface Command {
  name: string
  entryNodeIndex: number
}

interface Node {
  type: number
  name: string
  flags?: number
}

interface GlobalSlot {
  /** Slot order is string, int, unknown, float, bool, vec3f, pointer — not the node order. */
  slot: number
  name: string
  notes?: string
}

/** A pool of NUL-terminated UTF-8 strings, plus the offset of each one. */
class Pool {
  readonly bytes: number[] = []
  private readonly offsets = new Map<string, number>()

  offsetOf(text: string): number {
    const existing = this.offsets.get(text)
    if (existing !== undefined) return existing
    const at = this.bytes.length
    for (const byte of utf8(text)) this.bytes.push(byte)
    this.bytes.push(0)
    this.offsets.set(text, at)
    return at
  }
}

function utf8(text: string): number[] {
  const out: number[] = []
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return out
}

/**
 * Builds a whole file, laying the sections out in the order real files use.
 *
 * `immediate` and `io` are given as entry *counts* per type, and this writes the offset tables that
 * imply them — which is the point: the parser has to recover those counts from byte spans, since the
 * format stores no count anywhere.
 */
function build(options: {
  name: string
  category?: string
  version?: number
  commands?: Command[]
  nodes?: Node[]
  globals?: GlobalSlot[]
  /** Entries per type, in node-parameter order: int, bool, float, string, vec3f, pointer. */
  immediate?: number[]
  /** Entries per type for inputs, same order. */
  inputs?: number[]
  /** Entries per type for outputs, same order. */
  outputs?: number[]
}): Uint8Array {
  const IMMEDIATE_STRIDES = [12, 12, 12, 12, 20, 12]
  const IO_STRIDES = [16, 4, 16, 4, 16, 4, 16, 4, 24, 4, 20, 8]

  const commands = options.commands ?? []
  const nodes = options.nodes ?? []
  const globals = options.globals ?? []
  const immediate = options.immediate ?? [0, 0, 0, 0, 0, 0]
  const inputs = options.inputs ?? [0, 0, 0, 0, 0, 0]
  const outputs = options.outputs ?? [0, 0, 0, 0, 0, 0]

  const pool = new Pool()
  pool.offsetOf(options.name) // the file name is the first string in every real file
  const category = pool.offsetOf(options.category ?? 'AI')

  // Sorted so a slot's entries are contiguous and the running index behaves like the real files'.
  const sortedGlobals = [...globals].sort((a, b) => a.slot - b.slot)

  /*
   * Every string has to be in the pool before the layout is sized, in the order real files use:
   * the file name, the category, then command and node names. Interning them lazily while writing
   * grew the pool after the buffer had already been allocated.
   */
  for (const command of commands) pool.offsetOf(command.name)
  for (const node of nodes) pool.offsetOf(node.name)
  for (const parameter of sortedGlobals) {
    pool.offsetOf(parameter.name)
    pool.offsetOf(parameter.notes ?? '')
  }
  const globalCounts = Array.from({ length: 7 }, (_, slot) =>
    sortedGlobals.filter((parameter) => parameter.slot === slot).length
  )
  // Only vec3f (slot 5) carries a wide default; everything but the pointer slot carries one word.
  const globalValueSizes = [4, 4, 4, 4, 4, 12, 0]

  const nodesAt = HEADER_SIZE + commands.length * COMMAND_SIZE
  const globalsAt = nodesAt + nodes.length * NODE_SIZE
  const globalEntriesAt = globalsAt + 7 * 8
  const globalDefaultsAt = globalEntriesAt + sortedGlobals.length * 8
  let defaultBytes = 0
  for (let slot = 0; slot < 7; slot++) defaultBytes += globalCounts[slot]! * globalValueSizes[slot]!

  const immediateTableAt = globalDefaultsAt + defaultBytes
  const immediateEntriesAt = immediateTableAt + 6 * 4
  let immediateBytes = 0
  for (let type = 0; type < 6; type++) immediateBytes += immediate[type]! * IMMEDIATE_STRIDES[type]!

  const ioTableAt = immediateEntriesAt + immediateBytes
  const ioEntriesAt = ioTableAt + 12 * 4
  const ioCounts: number[] = []
  for (let type = 0; type < 6; type++) ioCounts.push(inputs[type]!, outputs[type]!)
  let ioBytes = 0
  for (let list = 0; list < 12; list++) ioBytes += ioCounts[list]! * IO_STRIDES[list]!

  const tailAt = ioEntriesAt + ioBytes // where every trailing section this build does not read sits
  const resolveAt = tailAt + 4 // the 4 zero bytes that always precede the pool
  const poolAt = resolveAt + 4

  const bytes = new Uint8Array(poolAt + pool.bytes.length)
  const view = new DataView(bytes.buffer)
  const u32 = (at: number, value: number): void => view.setUint32(at, value, true)
  const u16 = (at: number, value: number): void => view.setUint16(at, value, true)

  for (let at = 0; at < 4; at++) bytes[at] = 'AIB '.charCodeAt(at)
  u32(0x04, options.version ?? 0x408)
  u32(0x08, 0) // file name offset: the first string
  u32(0x0c, commands.length)
  u32(0x10, nodes.length)
  u32(0x20, globalsAt)
  u32(0x24, poolAt)
  u32(0x28, resolveAt)
  u32(0x2c, immediateTableAt)
  u32(0x30, tailAt)
  u32(0x34, ioTableAt)
  u32(0x38, tailAt)
  u32(0x3c, immediateTableAt)
  u32(0x40, immediateTableAt)
  u32(0x44, 0)
  u32(0x48, tailAt)
  u32(0x4c, tailAt)
  u32(0x50, tailAt)
  u32(0x5c, tailAt)
  u32(0x60, category)
  u32(0x68, tailAt)
  u32(0x6c, tailAt)
  u32(0x70, tailAt)

  commands.forEach((command, index) => {
    const at = HEADER_SIZE + index * COMMAND_SIZE
    u32(at, pool.offsetOf(command.name))
    for (let byte = 0; byte < 16; byte++) bytes[at + 4 + byte] = index * 16 + byte
    u16(at + 0x14, command.entryNodeIndex)
  })

  nodes.forEach((node, index) => {
    const at = nodesAt + index * NODE_SIZE
    u16(at, node.type)
    u16(at + 2, index)
    bytes[at + 6] = node.flags ?? 0
    u32(at + 8, pool.offsetOf(node.name))
    u32(at + 0x0c, 0x11223344)
    u32(at + 0x14, globalDefaultsAt + defaultBytes) // node bodies sit after the globals
    for (let byte = 0; byte < 16; byte++) bytes[at + 0x2c + byte] = 0xa0 + byte
  })

  let running = 0
  let valueOffset = 0
  for (let slot = 0; slot < 7; slot++) {
    const at = globalsAt + slot * 8
    u16(at, globalCounts[slot]!)
    u16(at + 2, running)
    u32(at + 4, valueOffset)
    running += globalCounts[slot]!
    valueOffset += globalCounts[slot]! * globalValueSizes[slot]!
  }
  sortedGlobals.forEach((parameter, index) => {
    const at = globalEntriesAt + index * 8
    u32(at, pool.offsetOf(parameter.name))
    u32(at + 4, pool.offsetOf(parameter.notes ?? ''))
  })

  let cursor = immediateEntriesAt
  for (let type = 0; type < 6; type++) {
    u32(immediateTableAt + type * 4, cursor)
    cursor += immediate[type]! * IMMEDIATE_STRIDES[type]!
  }
  cursor = ioEntriesAt
  for (let list = 0; list < 12; list++) {
    u32(ioTableAt + list * 4, cursor)
    cursor += ioCounts[list]! * IO_STRIDES[list]!
  }

  bytes.set(pool.bytes, poolAt)
  return bytes
}

describe('ainb detection', () => {
  it('recognises the signature, trailing space and all', () => {
    expect(isAinb(build({ name: 'Empty.root' }))).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isAinb(new Uint8Array(0))).toBe(false)
    expect(isAinb(new Uint8Array(256))).toBe(false)
    // "AIB" without the trailing space is the mistake the magic invites.
    const nearly = build({ name: 'Empty.root' })
    nearly[3] = 0
    expect(isAinb(nearly)).toBe(false)
    // A BYML is the neighbour most likely to be handed to it, since AINB ships beside .aidefn.byml.
    expect(isAinb(new Uint8Array([0x42, 0x59, 0x00, 0x02, 0, 0, 0, 0]))).toBe(false)
  })

  it('rejects a file too short to hold a header', () => {
    const short = build({ name: 'Empty.root' }).slice(0, 0x40)
    expect(isAinb(short)).toBe(false)
    expect(() => parseAinb(short)).toThrow(FormatParseError)
  })
})

describe('ainb parsing', () => {
  it('reads the header, commands and nodes', () => {
    const document = parseAinb(
      build({
        name: 'TutorialMoveTo.root',
        commands: [{ name: 'Run', entryNodeIndex: 1 }],
        nodes: [
          { type: 0, name: 'NoResultAction', flags: 4 },
          { type: 400, name: '' },
          { type: 0, name: 'Child.module' }
        ]
      })
    )

    expect(document.version).toBe(0x408)
    expect(document.versionText).toBe('4.8')
    expect(document.name).toBe('TutorialMoveTo.root')
    expect(document.category).toBe('AI')
    expect(document.commandCount).toBe(1)
    expect(document.commandsTruncated).toBe(false)
    expect(document.commands).toEqual([
      { name: 'Run', entryNodeIndex: 1, guid: '000102030405060708090a0b0c0d0e0f' }
    ])

    expect(document.nodeCount).toBe(3)
    expect(document.nodesTruncated).toBe(false)
    expect(document.nodes.map((node) => [node.index, node.type, node.name])).toEqual([
      [0, 0, 'NoResultAction'],
      [1, 400, ''],
      [2, 0, 'Child.module']
    ])
    // Only type 0 carries a name, which is the one thing the type field reliably tells you.
    expect(document.nodes.map((node) => node.userDefined)).toEqual([true, false, true])
    expect(document.nodes[0]!.flags).toBe(4)
    expect(document.nodes[0]!.nameHash).toBe(0x11223344)
    expect(document.nodeTypeCounts).toEqual([
      { type: 0, count: 2 },
      { type: 400, count: 1 }
    ])
    expect(document.problems).toEqual([])
  })

  it('resolves every name through the string pool, including multi-byte notes', () => {
    /*
     * Names, commands, categories and global notes are all offsets into one pool, so a fixture that
     * shares strings between them is what proves the resolution rather than a lucky read. The
     * Japanese note is not decoration: authoring notes in real files are Japanese, and a per-byte
     * decoder turns them into mojibake without failing.
     */
    const document = parseAinb(
      build({
        name: 'Shared.root',
        commands: [{ name: 'Run', entryNodeIndex: 0 }],
        nodes: [{ type: 0, name: 'Run' }],
        globals: [
          { slot: 0, name: 'ResultMessageFile', notes: '訓導後のMiiTouch用' },
          { slot: 6, name: 'Mii0' }
        ]
      })
    )

    expect(document.nodes[0]!.name).toBe('Run')
    expect(document.commands[0]!.name).toBe('Run')
    expect(document.globalParameters).toEqual([
      { name: 'ResultMessageFile', type: 'string', notes: '訓導後のMiiTouch用', index: 0 },
      { name: 'Mii0', type: 'pointer', notes: '', index: 1 }
    ])
    // The pool is one sequence and every name above is an offset into it.
    expect(document.strings).toContain('Shared.root')
    expect(document.strings).toContain('訓導後のMiiTouch用')
    expect(document.stringCount).toBe(document.strings.length)
    expect(document.stringsTruncated).toBe(false)
  })

  it('counts global parameters by slot, including the seventh with no default value', () => {
    const document = parseAinb(
      build({
        name: 'Globals.root',
        globals: [
          { slot: 0, name: 'ResultMessageLabel' },
          { slot: 1, name: 'MiiListNum' },
          { slot: 3, name: 'MinWaitSecondForOpening' },
          { slot: 4, name: 'IsRarePattern' },
          { slot: 5, name: 'CenterPos' },
          { slot: 6, name: 'Mii0' },
          { slot: 6, name: 'Mii1' }
        ]
      })
    )

    expect(document.globalParameterCount).toBe(7)
    expect(document.globalParameters.map((parameter) => parameter.type)).toEqual([
      'string',
      'int',
      'float',
      'bool',
      'vec3f',
      'pointer',
      'pointer'
    ])
    expect(document.problems).toEqual([])
  })

  it('recovers parameter counts from byte spans, which is all the format stores', () => {
    /*
     * There is no count field for any of these lists: the six immediate offsets and the twelve
     * input/output offsets delimit each other, and the number of entries is the span divided by that
     * type's stride. Asking for a vec3f in each table is the case that catches a wrong stride,
     * since it is the only type whose entry is not the same width as its neighbours'.
     */
    const document = parseAinb(
      build({
        name: 'Params.root',
        immediate: [3, 1, 0, 2, 1, 4],
        inputs: [1, 2, 3, 4, 5, 6],
        outputs: [6, 5, 4, 3, 2, 1]
      })
    )

    expect(document.immediateParameterCounts).toEqual({
      int: 3,
      bool: 1,
      float: 0,
      string: 2,
      vec3f: 1,
      pointer: 4
    })
    expect(document.inputParameterCounts).toEqual({
      int: 1,
      bool: 2,
      float: 3,
      string: 4,
      vec3f: 5,
      pointer: 6
    })
    expect(document.outputParameterCounts).toEqual({
      int: 6,
      bool: 5,
      float: 4,
      string: 3,
      vec3f: 2,
      pointer: 1
    })
    expect(document.problems).toEqual([])
  })

  it('reports a list whose span is not a whole number of entries instead of rounding it', () => {
    const bytes = build({ name: 'Ragged.root', immediate: [2, 0, 0, 0, 0, 0] })
    const view = new DataView(bytes.buffer)
    // Move the second immediate list forward 4 bytes, leaving the first list 20 bytes for 12-byte
    // entries. A parser that floors quietly claims one parameter and hides that it lost the other.
    const table = view.getUint32(0x2c, true)
    view.setUint32(table, view.getUint32(table, true) + 4, true)
    const document = parseAinb(bytes)
    expect(document.problems).toHaveLength(1)
    expect(document.problems[0]).toContain('not a whole number of 12-byte entries')
    // The count still reports what fits rather than pretending the odd bytes were a parameter.
    expect(document.immediateParameterCounts.int).toBe(1)
  })

  it('lists every declared region, marking the ones it does not interpret', () => {
    const document = parseAinb(build({ name: 'Sections.root', nodes: [{ type: 0, name: 'A' }] }))

    const read = document.sections.filter((section) => section.read)
    expect(read.map((section) => section.label)).toEqual([
      'global parameters, then per-node bodies (bodies not read)',
      'immediate parameters',
      'input/output parameters',
      'string pool'
    ])
    // Fields sharing one address are grouped, so a region is never counted twice.
    const offsets = document.sections.map((section) => section.offset)
    expect(new Set(offsets).size).toBe(offsets.length)
    expect(document.sections.some((section) => !section.read)).toBe(true)
    // Every region has a derived extent, since the format itself declares none.
    expect(document.sections.every((section) => section.size >= 0)).toBe(true)
    expect(document.sections.at(-1)!.label).toBe('string pool')
    expect(document.sections.at(-1)!.size).toBe(document.stringPoolBytes)
  })
})

describe('ainb refusals', () => {
  it('refuses a version it has not been checked against', () => {
    // The revisions move header fields, so reading 0x407 with this header size would report a node
    // count taken from the wrong word — a plausible number describing a different graph.
    expect(() => parseAinb(build({ name: 'Old.root', version: 0x407 }))).toThrow(FormatParseError)
    expect(() => parseAinb(build({ name: 'Old.root', version: 0x407 }))).toThrow(/0x407/)
  })

  it('refuses a node count that does not fit in the file', () => {
    const bytes = build({ name: 'Truncated.root', nodes: [{ type: 0, name: 'A' }] })
    new DataView(bytes.buffer).setUint32(0x10, 0x1000, true)
    expect(() => parseAinb(bytes)).toThrow(FormatParseError)
  })

  it('refuses a node array that overruns the section after it', () => {
    // The node array ends exactly where the next section starts in every real file; an overlap means
    // the command or node stride is wrong, and then every field read after it is wrong too.
    const bytes = build({
      name: 'Overlap.root',
      nodes: [{ type: 0, name: 'A' }, { type: 0, name: 'B' }]
    })
    const view = new DataView(bytes.buffer)
    view.setUint32(0x20, view.getUint32(0x20, true) - 4, true)
    expect(() => parseAinb(bytes)).toThrow(FormatParseError)
  })

  it('refuses a string pool starting past the end of the file', () => {
    const bytes = build({ name: 'NoPool.root' })
    new DataView(bytes.buffer).setUint32(0x24, bytes.length + 16, true)
    expect(() => parseAinb(bytes)).toThrow(FormatParseError)
  })

  it('refuses a truncated file rather than reading whatever is left', () => {
    const bytes = build({ name: 'Cut.root', nodes: [{ type: 0, name: 'A' }] })
    expect(() => parseAinb(bytes.slice(0, bytes.length - 40))).toThrow(FormatParseError)
  })
})

describe('ainb bounds', () => {
  it('caps the node list and says so, reporting the true total beside it', () => {
    /*
     * A damaged header can claim any node count, and materialising it would be a hang rather than an
     * error. The cap is 4,096 — well above the 454 of the largest real file — so this fixture is the
     * only place it is exercised. The point of the test is that the count and the type histogram
     * still describe the whole file while the list is short.
     */
    const nodes = Array.from({ length: 4100 }, (_, index) => ({
      type: index % 2 === 0 ? 0 : 3,
      name: index % 2 === 0 ? `Node${index}` : ''
    }))
    const document = parseAinb(build({ name: 'Huge.root', nodes }))

    expect(document.nodeCount).toBe(4100)
    expect(document.nodes).toHaveLength(4096)
    expect(document.nodesTruncated).toBe(true)
    // The histogram is built from every node, not just the ones that survived the cap.
    expect(document.nodeTypeCounts.reduce((sum, entry) => sum + entry.count, 0)).toBe(4100)
  })

  it('does not throw on a header claiming counts it cannot back', () => {
    // Every one of these is a lie the file could tell; none may become an unhandled read.
    const bytes = build({ name: 'Liar.root', nodes: [{ type: 0, name: 'A' }] })
    const view = new DataView(bytes.buffer)
    for (const at of [0x2c, 0x34, 0x38]) {
      const copy = bytes.slice()
      new DataView(copy.buffer).setUint32(at, bytes.length - 2, true)
      const document = parseAinb(copy)
      expect(document.problems.length).toBeGreaterThan(0)
    }
    // A global slot count larger than the file can hold degrades to no parameters, not a throw.
    const globalsAt = view.getUint32(0x20, true)
    const copy = bytes.slice()
    new DataView(copy.buffer).setUint16(globalsAt + 6 * 8, 0xffff, true)
    const document = parseAinb(copy)
    expect(document.globalParameters).toEqual([])
    expect(document.problems.length).toBeGreaterThan(0)
  })
})
