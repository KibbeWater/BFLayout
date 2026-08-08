import { describe, expect, it } from 'vitest'

import {
  countNodes,
  isByml,
  nodeTypeName,
  parseByml,
  walkByml,
  type BymlNode
} from '@shared/formats/byml'
import { FormatParseError, UnsupportedFormatError } from '@shared/binary/errors'
import { buildByml } from './helpers/byml-fixture'

/**
 * These are self-consistency tests: the fixture builder and the parser are two
 * halves of the same understanding of the layout, so agreeing does not prove
 * either is right about the format.
 *
 * The evidence that the parser reads *real* BYML is `pnpm validate:byml`, which
 * parses all 1812 documents this game ships — 15 version-2 big-endian and 1797
 * version-7 little-endian — with zero failures. What the tests below protect is
 * the behaviour around the edges: byte order, malformed input, and the graceful
 * degradation the project requires.
 */

const BOTH_ORDERS = [
  { name: 'little-endian v7', littleEndian: true, version: 7 },
  { name: 'big-endian v2', littleEndian: false, version: 2 }
] as const

describe('byml round trip', () => {
  for (const order of BOTH_ORDERS) {
    it(`reads every scalar type back unchanged (${order.name})`, () => {
      const root: BymlNode = {
        kind: 'map',
        entries: [
          { key: 'aNull', value: { kind: 'null' } },
          { key: 'bTrue', value: { kind: 'bool', value: true } },
          { key: 'cFalse', value: { kind: 'bool', value: false } },
          { key: 'dInt', value: { kind: 'int', value: -12345 } },
          { key: 'eUint', value: { kind: 'uint', value: 4000000000 } },
          { key: 'fFloat', value: { kind: 'float', value: 0.5 } },
          { key: 'gDouble', value: { kind: 'double', value: 1 / 3 } },
          { key: 'hInt64', value: { kind: 'int64', value: -9007199254740993n } },
          { key: 'iUint64', value: { kind: 'uint64', value: 18446744073709551615n } },
          { key: 'jString', value: { kind: 'string', value: 'hello' } }
        ]
      }

      const document = parseByml(buildByml(root, order))
      expect(document.version).toBe(order.version)
      expect(document.littleEndian).toBe(order.littleEndian)
      expect(document.root).toEqual(root)
    })

    it(`reads nested containers back unchanged (${order.name})`, () => {
      const root: BymlNode = {
        kind: 'map',
        entries: [
          {
            key: 'items',
            value: {
              kind: 'array',
              items: [
                { kind: 'int', value: 1 },
                { kind: 'string', value: 'two' },
                {
                  kind: 'map',
                  entries: [{ key: 'deep', value: { kind: 'array', items: [{ kind: 'bool', value: true }] } }]
                }
              ]
            }
          },
          { key: 'empty', value: { kind: 'array', items: [] } },
          { key: 'emptyMap', value: { kind: 'map', entries: [] } }
        ]
      }

      expect(parseByml(buildByml(root, order)).root).toEqual(root)
    })
  }

  it('preserves 64-bit values a number could not hold', () => {
    // 2^63 - 1 loses precision as a double, which is why these are bigint.
    const root: BymlNode = {
      kind: 'array',
      items: [
        { kind: 'int64', value: 9223372036854775807n },
        { kind: 'uint64', value: 18446744073709551615n }
      ]
    }
    const parsed = parseByml(buildByml(root))
    expect(parsed.root).toEqual(root)
  })

  it('keeps binary and file nodes distinct', () => {
    // 0xa1 carries only a length; 0xa2 also carries an alignment. The alignment
    // being present is what tells them apart on the way back out.
    const root: BymlNode = {
      kind: 'map',
      entries: [
        { key: 'blob', value: { kind: 'binary', data: new Uint8Array([1, 2, 3]) } },
        { key: 'file', value: { kind: 'binary', data: new Uint8Array([4, 5]), alignment: 0x1000 } }
      ]
    }
    const parsed = parseByml(buildByml(root))
    expect(parsed.root).toEqual(root)

    const entries = parsed.root?.kind === 'map' ? parsed.root.entries : []
    expect(nodeTypeName(entries[0]!.value)).toBe('binary')
    expect(nodeTypeName(entries[1]!.value)).toBe('file')
  })

  it('reads the undocumented 0x20 hash map', () => {
    // Hashes must ascend: the format keeps them sorted for binary search, and the
    // parser preserves the stored order rather than re-sorting.
    const root: BymlNode = {
      kind: 'hashmap',
      entries: [
        { hash: 0x0fa7d192, value: { kind: 'uint', value: 7 } },
        { hash: 0x820a3195, value: { kind: 'map', entries: [{ key: 'k', value: { kind: 'float', value: 2 } }] } },
        { hash: 0xd05dea82, value: { kind: 'string', value: 'x' } }
      ]
    }
    const parsed = parseByml(buildByml(root))
    expect(parsed.root).toEqual(root)
  })

  it('accepts a document with no root node', () => {
    const file = buildByml({ kind: 'map', entries: [] })
    // A zero root offset is legal and means "empty", not "corrupt".
    file[12] = 0
    file[13] = 0
    file[14] = 0
    file[15] = 0
    expect(parseByml(file).root).toBeNull()
  })
})

describe('byml detection', () => {
  it('recognises both byte orders', () => {
    expect(isByml(buildByml({ kind: 'map', entries: [] }, { littleEndian: true }))).toBe(true)
    expect(isByml(buildByml({ kind: 'map', entries: [] }, { littleEndian: false }))).toBe(true)
  })

  it('rejects other formats and short files', () => {
    expect(isByml(new Uint8Array(0))).toBe(false)
    expect(isByml(new Uint8Array([0x59, 0x42]))).toBe(false)
    // FLYT is a layout, not a BYML document.
    expect(isByml(new Uint8Array([0x46, 0x4c, 0x59, 0x54, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
  })

  it('rejects a plausible magic with an implausible version', () => {
    // "YB" appears in plenty of binaries; the version is what disambiguates.
    const data = new Uint8Array(16)
    data[0] = 0x59
    data[1] = 0x42
    data[2] = 0x99
    data[3] = 0x99
    expect(isByml(data)).toBe(false)
  })
})

describe('byml malformed input', () => {
  it('names the problem when the file is too short', () => {
    expect(() => parseByml(new Uint8Array(4))).toThrow(FormatParseError)
  })

  it('rejects a file that is not BYML at all', () => {
    const data = new Uint8Array(32)
    data.set([0x46, 0x4c, 0x59, 0x54])
    expect(() => parseByml(data)).toThrow(UnsupportedFormatError)
  })

  it('rejects an unsupported version rather than guessing', () => {
    const file = buildByml({ kind: 'map', entries: [] })
    file[2] = 99
    file[3] = 0
    expect(() => parseByml(file)).toThrow(UnsupportedFormatError)
  })

  it('refuses a container offset that points past the end', () => {
    const file = buildByml({ kind: 'map', entries: [{ key: 'a', value: { kind: 'int', value: 1 } }] })
    // Aim the root at an offset well outside the file.
    new DataView(file.buffer).setUint32(12, 0xfffff0, true)
    expect(() => parseByml(file)).toThrow(FormatParseError)
  })

  it('detects a cycle instead of overflowing the stack', () => {
    // A container whose child points back at itself would recurse forever.
    const root: BymlNode = {
      kind: 'map',
      entries: [{ key: 'child', value: { kind: 'map', entries: [{ key: 'x', value: { kind: 'int', value: 1 } }] } }]
    }
    const file = buildByml(root)
    const view = new DataView(file.buffer)
    const rootOffset = view.getUint32(12, true)
    // Point the outer map's only slot back at the outer map.
    view.setUint32(rootOffset + 8, rootOffset, true)
    expect(() => parseByml(file)).toThrow(/cycle/)
  })

  it('refuses a shared-subtree blowup instead of exhausting memory', () => {
    /*
     * Cycle detection is not enough. `visiting` releases each offset on the way back
     * out, so a subtree referenced twice is legitimately parsed twice — which makes
     * the file a DAG, and a few hundred bytes of nested double-references expand
     * exponentially. This runs in the main process, so before the node budget one
     * crafted document could take the whole app down.
     *
     * Built by hand: 24 levels, each an array holding two references to the level
     * below, so the flattened tree is on the order of 2^24 nodes.
     */
    const levels = 24
    const header = 16
    const bytes = new Uint8Array(header + levels * 16 + 16)
    const view = new DataView(bytes.buffer)

    bytes[0] = 0x59
    bytes[1] = 0x42
    view.setUint16(2, 7, true)
    view.setUint32(4, 0, true) // no hash keys
    view.setUint32(8, 0, true) // no strings

    // Deepest level first: a two-item array of nulls.
    const offsetOf = (level: number): number => header + level * 16
    for (let level = 0; level < levels; level++) {
      const at = offsetOf(level)
      // u8 type 0xc0, u24 count 2, then 2 type bytes padded to 4, then 2 slots.
      bytes[at] = 0xc0
      bytes[at + 1] = 2
      const child = level + 1 < levels ? 0xc0 : 0xff
      bytes[at + 4] = child
      bytes[at + 5] = child
      const target = level + 1 < levels ? offsetOf(level + 1) : 0
      view.setUint32(at + 8, target, true)
      view.setUint32(at + 12, target, true)
    }
    view.setUint32(12, offsetOf(0), true)

    expect(() => parseByml(bytes)).toThrow(/more than .* nodes/)
  })

  it('replaces an out-of-range UTF-8 sequence rather than throwing an untyped error', () => {
    // F4 90 80 80 decodes to U+110000, which String.fromCodePoint rejects with a
    // RangeError — an untyped throw escaping the codec's declared error surface.
    const root: BymlNode = { kind: 'map', entries: [{ key: 'k', value: { kind: 'string', value: 'x' } }] }
    const file = buildByml(root)
    const marker = file.indexOf(0x78) // the 'x' of the string table
    expect(marker).toBeGreaterThan(0)
    file[marker] = 0xf4
    file[marker + 1] = 0x90
    file[marker + 2] = 0x80
    file[marker + 3] = 0x80

    const parsed = parseByml(file)
    const entries = parsed.root?.kind === 'map' ? parsed.root.entries : []
    const value = entries[0]?.value
    expect(value?.kind).toBe('string')
    expect(value?.kind === 'string' ? value.value : '').toContain('\ufffd')
  })

  it('reports an out-of-range string index', () => {
    const file = buildByml({ kind: 'array', items: [{ kind: 'string', value: 'a' }] })
    const view = new DataView(file.buffer)
    const rootOffset = view.getUint32(12, true)
    // The array's single value slot sits after the header and padded type bytes.
    view.setUint32(rootOffset + 8, 999, true)
    expect(() => parseByml(file)).toThrow(/string node names index 999/)
  })
})

describe('byml traversal helpers', () => {
  const document: BymlNode = {
    kind: 'map',
    entries: [
      { key: 'name', value: { kind: 'string', value: 'test' } },
      {
        key: 'list',
        value: {
          kind: 'array',
          items: [{ kind: 'int', value: 1 }, { kind: 'map', entries: [{ key: 'deep', value: { kind: 'null' } }] }]
        }
      }
    ]
  }

  it('counts every node including the root', () => {
    // map + string + array + int + map + null
    expect(countNodes(document)).toBe(6)
  })

  it('builds paths that read like the source document', () => {
    const paths: string[] = []
    walkByml(document, (_node, path) => paths.push(path))
    expect(paths).toEqual(['', 'name', 'list', 'list[0]', 'list[1]', 'list[1].deep'])
  })

  it('shows hashed keys as hex, since the names are not in the file', () => {
    const paths: string[] = []
    walkByml({ kind: 'hashmap', entries: [{ hash: 0x0000beef, value: { kind: 'null' } }] }, (_n, p) =>
      paths.push(p)
    )
    expect(paths).toEqual(['', '<0000beef>'])
  })

  it('labels container types with their size', () => {
    expect(nodeTypeName({ kind: 'array', items: [{ kind: 'null' }] })).toBe('array[1]')
    expect(nodeTypeName({ kind: 'map', entries: [] })).toBe('map{0}')
    expect(nodeTypeName({ kind: 'hashmap', entries: [] })).toBe('hashmap{0}')
  })
})
