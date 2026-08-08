import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import {
  AAMP_VERIFIED_TYPES,
  addAampNames,
  crc32,
  isAamp,
  parseAamp,
  resolveAampName,
  walkAamp
} from '@shared/formats/aamp'

/**
 * AAMP built by hand, byte by byte.
 *
 * The builder below is the point of these tests as much as the assertions are: it lays a tree out
 * under the rule the parser claims — every child offset is in 4-byte units *relative to the node
 * holding it* — so a parser that read absolute offsets, or units of one byte, or put the count
 * where the offset goes, could not satisfy any of them.
 *
 * Breadth evidence lives elsewhere. `pnpm validate:aamp` walks a real dump: 26 files, all parsed,
 * all with walked list/object/parameter totals equal to what their own headers declare.
 */

const LIST_SIZE = 12
const OBJECT_SIZE = 8
const PARAMETER_SIZE = 8
const HEADER_SIZE = 0x30

interface ParameterSpec {
  /** A string is hashed; a number is used as the hash directly, for the unresolvable case. */
  readonly name: string | number
  readonly type: number
  /** Byte offset into the value blob (`data` then `strings`), or an absolute override. */
  readonly at: number
  readonly absolute?: boolean
}
interface ObjectSpec {
  readonly name: string | number
  readonly parameters: readonly ParameterSpec[]
}
interface ListSpec {
  readonly name: string | number
  readonly lists?: readonly ListSpec[]
  readonly objects?: readonly ObjectSpec[]
}

interface BuildSpec {
  readonly typeName: string
  readonly root: ListSpec
  /** The data section: 4-byte-aligned value bytes. */
  readonly data?: readonly number[]
  /** The string section, which follows the data section and ends the file. */
  readonly strings?: readonly number[]
  readonly version?: number
  readonly flags?: number
  /** Overrides, so a test can declare counts the tree does not match. */
  readonly declare?: { lists?: number; objects?: number; parameters?: number }
}

function build(spec: BuildSpec): Uint8Array {
  const typeBytes: number[] = []
  for (const character of spec.typeName) typeBytes.push(character.charCodeAt(0))
  typeBytes.push(0)
  while (typeBytes.length % 4 !== 0) typeBytes.push(0)

  /*
   * Positions are assigned before any bytes are written, because a node's own position is the base
   * its children's offsets are measured from. Lists are laid out breadth-first, which is what
   * shipped files do — a list's sublists sit contiguously so that `offset + index * 12` finds them.
   */
  const rootAt = HEADER_SIZE + typeBytes.length
  let cursor = rootAt + LIST_SIZE

  interface PlacedList {
    spec: ListSpec
    at: number
    listsAt: number
    objectsAt: number
    children: PlacedList[]
    objects: { spec: ObjectSpec; at: number; parametersAt: number }[]
  }

  const place = (list: ListSpec, at: number): PlacedList => {
    const sublists = list.lists ?? []
    const objects = list.objects ?? []
    const listsAt = cursor
    cursor += sublists.length * LIST_SIZE
    const objectsAt = cursor
    cursor += objects.length * OBJECT_SIZE

    const placedObjects = objects.map((object, index) => {
      const parametersAt = cursor
      cursor += object.parameters.length * PARAMETER_SIZE
      return { spec: object, at: objectsAt + index * OBJECT_SIZE, parametersAt }
    })
    const children = sublists.map((sublist, index) => place(sublist, listsAt + index * LIST_SIZE))
    return { spec: list, at, listsAt, objectsAt, children, objects: placedObjects }
  }
  const root = place(spec.root, rootAt)

  const data = [...(spec.data ?? [])]
  const strings = [...(spec.strings ?? [])]
  const valueBase = cursor
  const fileSize = valueBase + data.length + strings.length

  const bytes = new Uint8Array(fileSize)
  const view = new DataView(bytes.buffer)
  const u16 = (at: number, value: number): void => view.setUint16(at, value, true)
  const u32 = (at: number, value: number): void => view.setUint32(at, value, true)

  let lists = 0
  let objects = 0
  let parameters = 0
  const write = (node: PlacedList): void => {
    lists++
    u32(node.at, hashOf(node.spec.name))
    // The offset is in 4-byte units from the node's own start; the count is the u16 beside it.
    u16(node.at + 4, (node.listsAt - node.at) / 4)
    u16(node.at + 6, node.children.length)
    u16(node.at + 8, (node.objectsAt - node.at) / 4)
    u16(node.at + 10, node.objects.length)

    for (const object of node.objects) {
      objects++
      u32(object.at, hashOf(object.spec.name))
      u16(object.at + 4, (object.parametersAt - object.at) / 4)
      u16(object.at + 6, object.spec.parameters.length)
      object.spec.parameters.forEach((parameter, index) => {
        parameters++
        const at = object.parametersAt + index * PARAMETER_SIZE
        u32(at, hashOf(parameter.name))
        const target = parameter.absolute === true ? parameter.at : valueBase + parameter.at
        // u24 offset, then the type byte in the top byte of the same word.
        u32(at + 4, (((target - at) / 4) & 0xffffff) | (parameter.type << 24))
      })
    }
    for (const child of node.children) write(child)
  }
  write(root)

  for (let index = 0; index < typeBytes.length; index++) bytes[HEADER_SIZE + index] = typeBytes[index]!
  for (let index = 0; index < data.length; index++) bytes[valueBase + index] = data[index]!
  for (let index = 0; index < strings.length; index++) {
    bytes[valueBase + data.length + index] = strings[index]!
  }

  const magic = 'AAMP'
  for (let index = 0; index < magic.length; index++) bytes[index] = magic.charCodeAt(index)
  u32(0x04, spec.version ?? 2)
  u32(0x08, spec.flags ?? 3)
  u32(0x0c, fileSize)
  u32(0x10, 0)
  u32(0x14, typeBytes.length)
  u32(0x18, spec.declare?.lists ?? lists)
  u32(0x1c, spec.declare?.objects ?? objects)
  u32(0x20, spec.declare?.parameters ?? parameters)
  u32(0x24, data.length)
  u32(0x28, strings.length)
  u32(0x2c, 0)
  return bytes
}

function hashOf(name: string | number): number {
  return typeof name === 'number' ? name : crc32(name)
}

/** Little-endian f32 as four bytes, so fixtures read as the numbers they encode. */
function f32(value: number): number[] {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setFloat32(0, value, true)
  return [...bytes]
}
function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}
function cstring(text: string): number[] {
  const out: number[] = []
  for (const character of text) out.push(character.charCodeAt(0))
  out.push(0)
  while (out.length % 4 !== 0) out.push(0)
  return out
}

describe('aamp detection', () => {
  it('recognises the signature', () => {
    expect(isAamp(build({ typeName: 'aglcube', root: { name: 'param_root' } }))).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isAamp(new Uint8Array(0))).toBe(false)
    // Too short to hold a header, even with the right first four bytes.
    expect(isAamp(new Uint8Array([0x41, 0x41, 0x4d, 0x50]))).toBe(false)
    // A BYML is the neighbour most likely to be handed to it by mistake.
    expect(isAamp(new Uint8Array(64).fill(0x42))).toBe(false)
  })
})

describe('aamp name hashing', () => {
  it('hashes param_root to the value every real file carries', () => {
    // The one hash that can be checked against the format itself: the root list in all 26 files.
    expect(crc32('param_root')).toBe(0xa4f6cb6c)
    expect(resolveAampName(0xa4f6cb6c)).toBe('param_root')
  })

  it('returns null for a hash with no candidate, rather than something name-shaped', () => {
    expect(resolveAampName(0x12345678)).toBeNull()
  })

  it('takes extra names for hashes the built-in table does not cover', () => {
    const hash = crc32('a_name_no_shipped_table_would_have')
    expect(resolveAampName(hash)).toBeNull()
    expect(addAampNames(['a_name_no_shipped_table_would_have'])).toBe(1)
    expect(resolveAampName(hash)).toBe('a_name_no_shipped_table_would_have')
    // Additive only: adding the same name twice adds nothing.
    expect(addAampNames(['a_name_no_shipped_table_would_have'])).toBe(0)
  })
})

describe('aamp parsing', () => {
  it('reads the header, one object and its values', () => {
    const bytes = build({
      typeName: 'aglcube',
      root: {
        name: 'param_root',
        objects: [
          {
            name: 'cubemap_unit_0',
            parameters: [
              { name: 'enable', type: 0, at: 0 },
              { name: 'Intensity', type: 1, at: 4 },
              { name: 'Direction', type: 4, at: 8 },
              { name: 'name', type: 7, at: 20 }
            ]
          }
        ]
      },
      data: [...u32le(1), ...f32(2.5), ...f32(0), ...f32(1), ...f32(-0.5)],
      strings: cstring('Cube')
    })

    const document = parseAamp(bytes)
    expect(document.version).toBe(2)
    expect(document.typeName).toBe('aglcube')
    expect(document.littleEndian).toBe(true)
    expect(document.utf8).toBe(true)
    expect(document.fileSize).toBe(bytes.length)
    expect(document.counts).toEqual({ lists: 1, objects: 1, parameters: 4 })
    expect(document.warnings).toEqual([])

    expect(document.root.name).toBe('param_root')
    expect(document.root.label).toBe('param_root')
    const object = document.root.objects[0]!
    expect(object.name).toBe('cubemap_unit_0')
    expect(object.parameters.map((p) => [p.typeName, p.value])).toEqual([
      ['bool', { kind: 'bool', value: true, raw: 1 }],
      ['f32', { kind: 'f32', value: 2.5 }],
      ['vec3', { kind: 'floats', value: [0, 1, -0.5] }],
      ['string32', { kind: 'string', value: 'Cube', truncated: false }]
    ])
  })

  it('walks a nested list, with every offset relative to its own node', () => {
    const bytes = build({
      typeName: 'aglenvset',
      root: {
        name: 'param_root',
        lists: [
          {
            name: 'set_array',
            lists: [{ name: '0', objects: [{ name: 'name', parameters: [{ name: 'file', type: 2, at: 0 }] }] }],
            objects: [{ name: 'setting', parameters: [{ name: 'num', type: 17, at: 4 }] }]
          },
          { name: 'name_array' }
        ]
      },
      data: [...u32le(-7 >>> 0), ...u32le(0xfffffff0)]
    })

    const document = parseAamp(bytes)
    expect(document.counts).toEqual({ lists: 4, objects: 2, parameters: 2 })

    const setArray = document.root.lists[0]!
    expect(setArray.name).toBe('set_array')
    expect(document.root.lists[1]!.name).toBe('name_array')
    expect(setArray.lists[0]!.name).toBe('0')
    // int is signed and u32 is not, which is the only difference between types 2 and 17.
    expect(setArray.lists[0]!.objects[0]!.parameters[0]!.value).toEqual({ kind: 'int', value: -7 })
    expect(setArray.objects[0]!.parameters[0]!.value).toEqual({ kind: 'u32', value: 0xfffffff0 })

    const seen: string[] = []
    walkAamp(document.root, (node, kind, depth) => seen.push(`${depth}:${kind}:${node.label}`))
    expect(seen).toEqual([
      '0:list:param_root',
      '1:list:set_array',
      '2:list:0',
      '3:object:name',
      '4:parameter:file',
      '2:object:setting',
      '3:parameter:num',
      '1:list:name_array'
    ])
  })

  it('reads a curve4 as four 128-byte curves', () => {
    /*
     * The curve struct was measured from `default.baglccr`, where four Curve4 parameters share one
     * value at 0x370 and the `9, 7, 0, 0, 0.5, …` pattern repeats every 128 bytes. This fixture
     * encodes that shape: two leading integers then thirty floats, four times over.
     */
    const curve = (tag: number): number[] => {
      const out = [...u32le(tag), ...u32le(7)]
      for (let index = 0; index < 30; index++) out.push(...f32(index / 2))
      return out
    }
    const bytes = build({
      typeName: 'aglccr',
      root: {
        name: 'param_root',
        objects: [{ name: 'color_correction', parameters: [{ name: 'curve0', type: 12, at: 0 }] }]
      },
      data: [...curve(9), ...curve(10), ...curve(11), ...curve(12)]
    })

    const value = parseAamp(bytes).root.objects[0]!.parameters[0]!.value
    expect(value.kind).toBe('curves')
    if (value.kind !== 'curves') throw new Error('unreachable')
    expect(value.value).toHaveLength(4)
    expect(value.value.map((c) => c.ints)).toEqual([
      [9, 7],
      [10, 7],
      [11, 7],
      [12, 7]
    ])
    expect(value.value[0]!.floats).toHaveLength(30)
    expect(value.value[3]!.floats[29]).toBeCloseTo(14.5)
  })

  it('lets two parameters share overlapping value bytes', () => {
    /*
     * Real files deduplicate values and let them overlap: a vec2 whose floats match the first two
     * of a vec4 points into the middle of that vec4. Nothing here may size a value from the
     * distance to its neighbour, and this is the fixture that would catch it.
     */
    const bytes = build({
      typeName: 'aglmf',
      root: {
        name: 'param_root',
        objects: [
          {
            name: 'param',
            parameters: [
              { name: 'param0', type: 5, at: 0 },
              { name: 'param1', type: 3, at: 4 },
              { name: 'param2', type: 1, at: 12 }
            ]
          }
        ]
      },
      data: [...f32(1), ...f32(2), ...f32(3), ...f32(4)]
    })

    const parameters = parseAamp(bytes).root.objects[0]!.parameters
    expect(parameters[0]!.value).toEqual({ kind: 'floats', value: [1, 2, 3, 4] })
    expect(parameters[1]!.value).toEqual({ kind: 'floats', value: [2, 3] })
    expect(parameters[2]!.value).toEqual({ kind: 'f32', value: 4 })
  })

  it('labels an unresolvable hash as hex rather than inventing a name', () => {
    const bytes = build({
      typeName: 'glght',
      root: { name: 0x12345678, objects: [{ name: 0x9abcdef0, parameters: [] }] }
    })
    const document = parseAamp(bytes)
    expect(document.root.name).toBeNull()
    expect(document.root.label).toBe('0x12345678')
    expect(document.root.objects[0]!.label).toBe('0x9abcdef0')
    expect(document.unresolvedNames).toBe(2)
  })
})

describe('aamp degrading rather than guessing', () => {
  it('reports a type byte it does not model, with the byte', () => {
    const bytes = build({
      typeName: 'aglenv',
      root: {
        name: 'param_root',
        objects: [{ name: 'setting', parameters: [{ name: 'flg', type: 250, at: 0 }] }]
      },
      data: u32le(0x11223344)
    })

    const parameter = parseAamp(bytes).root.objects[0]!.parameters[0]!
    expect(parameter.typeName).toBe('unknown(250)')
    expect(parameter.verified).toBe(false)
    expect(parameter.value.kind).toBe('unknown')
    if (parameter.value.kind !== 'unknown') throw new Error('unreachable')
    expect(parameter.value.typeByte).toBe(250)
    // The reason has to name the byte, since that is the only actionable thing about it.
    expect(parameter.value.reason).toContain('250')
  })

  it('flags a type the reference names but real files never exercised', () => {
    // bufferBinary (19) has a decoder built from the reference alone; nothing in the dump uses it.
    expect(AAMP_VERIFIED_TYPES).not.toContain(19)
    const bytes = build({
      typeName: 'aglenv',
      root: {
        name: 'param_root',
        objects: [{ name: 'setting', parameters: [{ name: 'arg', type: 19, at: 4 }] }]
      },
      data: [...u32le(3), 0xaa, 0xbb, 0xcc, 0x00]
    })

    const parameter = parseAamp(bytes).root.objects[0]!.parameters[0]!
    expect(parameter.typeName).toBe('bufferBinary')
    expect(parameter.verified).toBe(false)
    expect(parameter.value).toEqual({
      kind: 'buffer',
      element: 'binary',
      length: 3,
      value: [0xaa, 0xbb, 0xcc]
    })
  })

  it('reports a value pointing outside the file instead of throwing', () => {
    const bytes = build({
      typeName: 'aglenv',
      root: {
        name: 'param_root',
        objects: [{ name: 'setting', parameters: [{ name: 'far', type: 5, at: 0 }] }]
      },
      data: u32le(0)
    })
    // Point the lone parameter's vec4 far past the end. The tree is still perfectly readable.
    const at = bytes.length - 4 - 8
    new DataView(bytes.buffer).setUint32(at + 4, 0x0500ffff, true)

    const parameter = parseAamp(bytes).root.objects[0]!.parameters[0]!
    expect(parameter.typeName).toBe('vec4')
    expect(parameter.value.kind).toBe('unknown')
    if (parameter.value.kind !== 'unknown') throw new Error('unreachable')
    expect(parameter.value.reason).toContain('outside the file')
  })

  it('warns when the walk finds fewer nodes than the header declares', () => {
    const bytes = build({
      typeName: 'aglenv',
      root: { name: 'param_root', objects: [{ name: 'setting', parameters: [] }] },
      declare: { objects: 4 }
    })
    const document = parseAamp(bytes)
    expect(document.counts.objects).toBe(1)
    expect(document.declared.objects).toBe(4)
    expect(document.warnings.join(' ')).toContain('declares 4 objects')
  })
})

describe('aamp rejecting malformed input', () => {
  const good = (): Uint8Array =>
    build({
      typeName: 'aglenv',
      root: {
        name: 'param_root',
        objects: [{ name: 'setting', parameters: [{ name: 'far', type: 1, at: 0 }] }]
      },
      data: f32(1)
    })

  it('rejects a file that is not an AAMP', () => {
    expect(() => parseAamp(new Uint8Array(64))).toThrow(FormatParseError)
  })

  it('rejects a version it has never measured', () => {
    const bytes = good()
    new DataView(bytes.buffer).setUint32(0x04, 1, true)
    expect(() => parseAamp(bytes)).toThrow(/version 1 is not supported/)
  })

  it('refuses a big-endian flag word rather than reading it byte-flipped', () => {
    const bytes = good()
    new DataView(bytes.buffer).setUint32(0x08, 2, true)
    expect(() => parseAamp(bytes)).toThrow(/bit 0 clear/)
  })

  it('rejects a header claiming more bytes than it has', () => {
    const bytes = good()
    new DataView(bytes.buffer).setUint32(0x0c, 0xffff, true)
    expect(() => parseAamp(bytes)).toThrow(/only \d+ are present/)
  })

  it('rejects a type string that leaves no room for the root list', () => {
    const bytes = good()
    new DataView(bytes.buffer).setUint32(0x14, 0xfff0, true)
    expect(() => parseAamp(bytes)).toThrow(FormatParseError)
  })

  it('rejects an object whose parameters run past the end of the file', () => {
    const bytes = good()
    // The object sits right after the 12-byte root list; widen its parameter count absurdly.
    const objectAt = 0x30 + 8 + 12
    new DataView(bytes.buffer).setUint16(objectAt + 6, 0x1000, true)
    expect(() => parseAamp(bytes)).toThrow(/runs past the end of the file/)
  })

  it('rejects a tree holding more nodes than its own header declares', () => {
    // This is the shape a cyclic or misaligned offset takes, and the bound that stops the walk.
    const bytes = build({
      typeName: 'aglenv',
      root: {
        name: 'param_root',
        objects: [
          { name: 'setting', parameters: [] },
          { name: 'config', parameters: [] }
        ]
      },
      declare: { objects: 1 }
    })
    expect(() => parseAamp(bytes)).toThrow(/more than the 1 objects the header declares/)
  })

  it('rejects a list pointing back at itself instead of recursing forever', () => {
    const bytes = build({
      typeName: 'aglenv',
      root: { name: 'param_root', lists: [{ name: 'set_array' }] },
      declare: { lists: 4096 }
    })
    // Aim the root's sublist array at the root itself: each level then finds the same node again.
    new DataView(bytes.buffer).setUint16(0x38 + 4, 0, true)
    expect(() => parseAamp(bytes)).toThrow(FormatParseError)
  })

  it('says so when a string runs to the end of the file with no terminator', () => {
    /*
     * The string section is the last thing in the file, so an unterminated string is the one case
     * where "what was read" and "the string" differ with nothing to signal it. Reporting
     * `truncated` and a warning is the difference between a short string and a wrong one.
     */
    const bytes = build({
      typeName: 'aglenv',
      root: {
        name: 'param_root',
        objects: [{ name: 'setting', parameters: [{ name: 'name', type: 7, at: 0 }] }]
      },
      strings: [0x41, 0x42, 0x43, 0x44]
    })

    const document = parseAamp(bytes)
    expect(document.root.objects[0]!.parameters[0]!.value).toEqual({
      kind: 'string',
      value: 'ABCD',
      truncated: true
    })
    expect(document.warnings.join(' ')).toContain('no terminator')
  })
})
