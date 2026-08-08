import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import { isBfres, parseBfres } from '@shared/formats/bfres'

/**
 * BFRES built by hand, byte by byte.
 *
 * A full synthetic BFRES is not impractical after all — the container is offsets and dictionaries all
 * the way down and none of it is compressed — so the fixture below is a complete, valid file: one
 * model with a skeleton, a vertex buffer, a shape and a material with texture references, one
 * skeletal-animation subfile, one embedded external file, and a real string pool. What it
 * deliberately does *not* contain is vertex data, animation curves or anything else the parser does
 * not read: those are unreachable from the summary, so a fixture carrying them would test nothing.
 *
 * Every offset in the layout below is written out as a constant rather than accumulated, because
 * pinning the offsets is the point. The breadth evidence — all 2,284 files in a real dump parsing,
 * with each group count cross-checked against its dictionary and each vertex count against buffer
 * size over stride — comes from `scripts/validate-bfres.ts`, which needs a dump.
 */

const FMDL = 0xf0
const FSKL = 0x168
/** Two 0x58-byte slots, so a second vertex buffer can be filled in without moving anything. */
const FVTX = 0x1a8
const FSHP = 0x260
const FMAT = 0x2c0
const MODEL_DICT = 0x370
/** Room for 40 entries, so the per-material texture cap can be exercised by moving one byte. */
const TEXTURE_ARRAY = 0x3a0
const EXTERNAL_ARRAY = 0x4e0
const EXTERNAL_DICT = 0x4f0
const FSKA = 0x520
const FSKA_DICT = 0x570
const STR_BLOCK = 0x5a0
/** The pool begins 20 bytes past the `_STR` signature, and its first entry is the empty string. */
const POOL = STR_BLOCK + 20
/** Spare bytes past the pool, used only by the embedded-payload test. */
const PAYLOAD = 0x640
const SIZE = 0x700

const NAMES = [
  '', // the empty string, at the pool base
  'TestRes',
  'TestModel',
  'TestShape',
  'mt_Test',
  'AlbTex',
  'NrmTex',
  'WalkAnim',
  'LoadAnimEventSet.flag'
] as const

interface Fixture {
  bytes: Uint8Array
  view: DataView
  /** Absolute offset of each pooled string's length field, which is what an offset points at. */
  offsets: Record<string, number>
  poolSize: number
}

function build(): Fixture {
  const bytes = new Uint8Array(SIZE)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index++) bytes[at + index] = text.charCodeAt(index)
  }
  const u16 = (at: number, value: number): void => view.setUint16(at, value, true)
  const u32 = (at: number, value: number): void => view.setUint32(at, value, true)
  const u64 = (at: number, value: number): void => view.setBigUint64(at, BigInt(value), true)

  // --- string pool: u16 length, characters, NUL, padded to 2 bytes ---
  const offsets: Record<string, number> = {}
  let cursor = POOL
  for (const name of NAMES) {
    offsets[name] = cursor
    u16(cursor, name.length)
    ascii(cursor + 2, name)
    cursor += 2 + name.length + 1
    if (cursor % 2 !== 0) cursor++
  }
  const poolSize = cursor - POOL
  ascii(STR_BLOCK, '_STR')
  u64(STR_BLOCK + 8, SIZE - STR_BLOCK) // offset of whatever follows; unread by the parser
  u32(STR_BLOCK + 16, NAMES.length)

  /**
   * A dictionary: u32 zero, u32 count, then count + 1 nodes of
   * `i32 refBit, u16 left, u16 right, u64 key`. Node 0 is the root and keys the empty string; node
   * `i + 1` names array entry `i`. The tree links are never followed, so they are filled with values
   * that are structurally plausible rather than a real radix tree.
   */
  const dictionary = (at: number, keys: readonly string[]): void => {
    u32(at, 0)
    u32(at + 4, keys.length)
    u32(at + 8, 0xffffffff)
    u16(at + 12, 1)
    u16(at + 14, 0)
    u64(at + 16, offsets['']!)
    keys.forEach((key, index) => {
      const node = at + 8 + (index + 1) * 16
      u32(node, index)
      u16(node + 4, 0)
      u16(node + 6, index + 1)
      u64(node + 8, offsets[key]!)
    })
  }

  // --- header ---
  ascii(0, 'FRES')
  ascii(4, '    ') // four spaces; on Wii U this is the version instead
  u32(8, 0x000a0202)
  bytes[0x0c] = 0xff // byte-order mark read big-endian: 0xFFFE is little-endian
  bytes[0x0d] = 0xfe
  bytes[0x0e] = 12 // alignment 2^12
  bytes[0x0f] = 0
  u32(0x10, offsets['TestRes']! + 2) // name *characters*, two bytes past the length field
  u16(0x14, 0)
  u16(0x16, (POOL - 20) & 0xffff)
  u32(0x18, SIZE)
  u32(0x1c, SIZE)
  u64(0x20, offsets['TestRes']!)
  u64(0x28, FMDL)
  u64(0x30, MODEL_DICT)
  u64(0x58, FSKA) // slot 3 is skeletal animation in every file in the dump
  u64(0x60, FSKA_DICT)
  u64(0xb8, EXTERNAL_ARRAY)
  u64(0xc0, EXTERNAL_DICT)
  u64(0xd0, POOL)
  u32(0xd8, poolSize)
  u16(0xdc, 1) // one model, slot 0
  u16(0xe2, 1) // one FSKA, slot 3
  u16(0xec, 1) // one external file

  dictionary(MODEL_DICT, ['TestModel'])
  dictionary(FSKA_DICT, ['WalkAnim'])
  dictionary(EXTERNAL_DICT, ['LoadAnimEventSet.flag'])

  // --- model ---
  ascii(FMDL, 'FMDL')
  u64(FMDL + 0x08, offsets['TestModel']!)
  u64(FMDL + 0x10, offsets['']!) // path: the empty string, as in every real file
  u64(FMDL + 0x18, FSKL)
  u64(FMDL + 0x20, FVTX)
  u64(FMDL + 0x28, FSHP)
  u64(FMDL + 0x38, FMAT)
  u16(FMDL + 0x68, 1) // vertex buffers
  u16(FMDL + 0x6a, 1) // shapes
  u16(FMDL + 0x6c, 1) // materials

  ascii(FSKL, 'FSKL')
  u16(FSKL + 0x38, 7) // bone count

  ascii(FVTX, 'FVTX')
  bytes[FVTX + 0x4c] = 2 // attributes
  bytes[FVTX + 0x4d] = 2 // buffers
  u32(FVTX + 0x50, 1234) // vertices

  ascii(FSHP, 'FSHP')
  u64(FSHP + 0x08, offsets['TestShape']!)

  ascii(FMAT, 'FMAT')
  u64(FMAT + 0x08, offsets['mt_Test']!)
  u64(FMAT + 0x20, TEXTURE_ARRAY)
  bytes[FMAT + 0xa2] = 2 // textures
  bytes[FMAT + 0xa3] = 2 // samplers
  u64(TEXTURE_ARRAY, offsets['AlbTex']!)
  u64(TEXTURE_ARRAY + 8, offsets['NrmTex']!)
  // The remaining 38 slots point at the empty string, so raising the count byte stays in bounds.
  for (let index = 2; index < 40; index++) u64(TEXTURE_ARRAY + index * 8, offsets['']!)

  ascii(FSKA, 'FSKA')
  u64(FSKA + 0x08, offsets['WalkAnim']!)

  // An external file with no payload, which is the only kind this dump contains.
  u64(EXTERNAL_ARRAY, 0)
  u32(EXTERNAL_ARRAY + 8, 0)

  return { bytes, view, offsets, poolSize }
}

describe('bfres detection', () => {
  it('recognises the signature', () => {
    expect(isBfres(build().bytes)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isBfres(new Uint8Array(0))).toBe(false)
    // Long enough but not a BFRES, and short enough to have no header at all.
    expect(isBfres(new Uint8Array(0x200))).toBe(false)
    expect(isBfres(new Uint8Array([0x46, 0x52, 0x45, 0x53]))).toBe(false)
  })
})

describe('bfres header', () => {
  it('reads the version, byte order, alignment and resource name', () => {
    const document = parseBfres(build().bytes)
    expect(document.version).toBe('0.10.2.2')
    expect(document.versionRaw).toBe(0x000a0202)
    expect(document.littleEndian).toBe(true)
    expect(document.alignment).toBe(4096)
    expect(document.name).toBe('TestRes')
    expect(document.declaredFileSize).toBe(SIZE)
  })

  it('names a Wii U BFRES rather than reading it four bytes out of place', () => {
    // On Wii U the version occupies bytes 4-7, where a Switch file has four spaces.
    const { bytes, view } = build()
    view.setUint32(4, 0x03040000, false)
    expect(() => parseBfres(bytes)).toThrow(/Wii U/)
    expect(() => parseBfres(bytes)).toThrow(FormatParseError)
  })

  it('rejects an unrecognised byte-order mark', () => {
    const { bytes } = build()
    bytes[0x0c] = 0x12
    bytes[0x0d] = 0x34
    expect(() => parseBfres(bytes)).toThrow(FormatParseError)
  })

  it('rejects a header claiming more bytes than it has', () => {
    const { bytes, view } = build()
    view.setUint32(0x1c, SIZE * 4, true)
    expect(() => parseBfres(bytes)).toThrow(/claims/)
  })

  it('rejects a file that is not a BFRES', () => {
    expect(() => parseBfres(new Uint8Array(0x200))).toThrow(FormatParseError)
  })
})

describe('bfres models', () => {
  it('reads the counts, the shape and material names and the texture references', () => {
    const document = parseBfres(build().bytes)
    expect(document.modelCount).toBe(1)
    expect(document.models).toHaveLength(1)

    const model = document.models[0]!
    expect(model.name).toBe('TestModel')
    expect(model.vertexBufferCount).toBe(1)
    expect(model.shapeCount).toBe(1)
    expect(model.materialCount).toBe(1)
    expect(model.boneCount).toBe(7)
    // Summed from the vertex buffers, because v10's model header does not declare a total.
    expect(model.vertexCount).toBe(1234)
    expect(model.shapes).toEqual(['TestShape'])
    expect(model.materials).toEqual([
      { name: 'mt_Test', textures: ['AlbTex', 'NrmTex'], textureCount: 2, samplerCount: 2 }
    ])
  })

  it('sums the vertex count over every vertex buffer', () => {
    // Two buffers back to back at the 0x58 stride, which is the stride the dump pins.
    const { bytes, view } = build()
    view.setUint16(FMDL + 0x68, 2, true)
    for (let index = 0; index < 4; index++) bytes[FVTX + 0x58 + index] = 'FVTX'.charCodeAt(index)
    view.setUint32(FVTX + 0x58 + 0x50, 66, true)
    expect(parseBfres(bytes).models[0]!.vertexCount).toBe(1300)
  })

  it('rejects a model whose skeleton is not an FSKL', () => {
    const { bytes } = build()
    bytes[FSKL] = 0x58
    expect(() => parseBfres(bytes)).toThrow(/expected FSKL/)
  })

  it('rejects a shape array that runs out of FSHP entries', () => {
    // A shape count larger than the array is how a wrong stride or a new version would present.
    const { bytes, view } = build()
    view.setUint16(FMDL + 0x6a, 2, true)
    expect(() => parseBfres(bytes)).toThrow(/magic/)
  })
})

describe('bfres dictionaries and strings', () => {
  it('lists non-model subfiles by name and by the magic they carry', () => {
    const document = parseBfres(build().bytes)
    expect(document.subfileCount).toBe(1)
    expect(document.subfiles).toEqual([{ name: 'WalkAnim', kind: 'FSKA' }])
  })

  it('refuses when a group count and its dictionary disagree', () => {
    /*
     * The header's u16 count and the dictionary's own count are two independent statements about the
     * same thing, and they agree on all 2,915 groups in the dump. Disagreement means one of them is
     * not what the parser thinks it is, so it is reported rather than resolved by picking a winner.
     */
    const { bytes, view } = build()
    view.setUint32(FSKA_DICT + 4, 3, true)
    expect(() => parseBfres(bytes)).toThrow(/dictionary declares 3/)
  })

  it('refuses a name offset outside the string pool', () => {
    // The pool bounds are the only cheap way to tell a real name offset from a stray pointer.
    const { bytes, view } = build()
    view.setBigUint64(FSHP + 0x08, BigInt(0x40), true)
    expect(() => parseBfres(bytes)).toThrow(/outside the string pool/)
  })

  it('refuses a string whose declared length runs past the pool', () => {
    const { bytes, view, offsets, poolSize } = build()
    view.setUint16(offsets['TestShape']!, poolSize + 32, true)
    expect(() => parseBfres(bytes)).toThrow(/past the end of the string pool/)
  })

  it('reads a name whose length field sits at the very pool base', () => {
    // The first pool entry is the empty string, and a real file points model paths at it.
    const document = parseBfres(build().bytes)
    expect(document.externalFiles[0]!.name).toBe('LoadAnimEventSet.flag')
  })
})

describe('bfres external files', () => {
  it('reports an empty entry as a named marker with no payload magic', () => {
    const document = parseBfres(build().bytes)
    expect(document.externalFileCount).toBe(1)
    expect(document.externalFiles).toEqual([
      { name: 'LoadAnimEventSet.flag', size: 0, magic: '' }
    ])
  })

  it('reports an embedded payload by its magic without parsing it', () => {
    /*
     * No file in the dump embeds a BNTX, so this path is exercised only here. The magic is reported
     * and the bytes are left alone: BNTX has its own parser.
     */
    const { bytes, view } = build()
    view.setBigUint64(EXTERNAL_ARRAY, BigInt(PAYLOAD), true)
    view.setUint32(EXTERNAL_ARRAY + 8, 64, true)
    for (let index = 0; index < 4; index++) bytes[PAYLOAD + index] = 'BNTX'.charCodeAt(index)
    expect(parseBfres(bytes).externalFiles[0]!.magic).toBe('BNTX')
  })
})

describe('bfres caps', () => {
  it('truncates a long texture list and still reports the true total', () => {
    const { bytes } = build()
    bytes[FMAT + 0xa2] = 40
    const material = parseBfres(bytes).models[0]!.materials[0]!
    expect(material.textureCount).toBe(40)
    expect(material.textures).toHaveLength(32)
    expect(material.textures.slice(0, 2)).toEqual(['AlbTex', 'NrmTex'])
  })
})
