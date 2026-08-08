import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import { isMsbt, parseMsbt } from '@shared/formats/msbt'

/**
 * MSBT built by hand, byte by byte.
 *
 * Unlike the font tests there is no need for a real file here: the format is small enough to
 * construct, and constructing it is what pins down the offsets the parser depends on. The breadth
 * evidence — all 3,406 tables in a real dump parsing, 333,671 strings all labelled — comes from
 * `pnpm validate:msbt`, which needs a dump and cannot live in the unit suite.
 */

/** Little-endian u16/u32 writers, so the fixtures below read like the format's own layout. */
function build(sections: { signature: string; body: number[] }[], encoding: 0 | 1): Uint8Array {
  const out: number[] = []
  const u16 = (value: number): void => {
    out.push(value & 0xff, (value >> 8) & 0xff)
  }
  const u32 = (value: number): void => {
    u16(value & 0xffff)
    u16((value >>> 16) & 0xffff)
  }

  for (const character of 'MsgStdBn') out.push(character.charCodeAt(0))
  out.push(0xff, 0xfe) // BOM: little-endian
  out.push(0, 0)
  out.push(encoding, 3)
  u16(sections.length)
  out.push(0, 0)
  const sizeAt = out.length
  u32(0) // patched below
  while (out.length < 0x20) out.push(0)

  for (const section of sections) {
    for (const character of section.signature) out.push(character.charCodeAt(0))
    u32(section.body.length)
    for (let index = 0; index < 8; index++) out.push(0)
    out.push(...section.body)
    while (out.length % 16 !== 0) out.push(0xab)
  }

  const bytes = new Uint8Array(out)
  new DataView(bytes.buffer).setUint32(sizeAt, bytes.length, true)
  return bytes
}

/** `LBL1`: one group holding one label pointing at string `index`. */
function labelSection(name: string, index: number): number[] {
  const body: number[] = []
  const u32 = (value: number): void => {
    body.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
  }

  u32(1) // one group
  u32(1) // holding one label
  u32(12) // at offset 12, immediately after this table
  body.push(name.length)
  for (const character of name) body.push(character.charCodeAt(0))
  u32(index)
  return body
}

/** `TXT2` holding UTF-16 strings. */
function textSection(strings: string[]): number[] {
  const body: number[] = []
  const u32 = (value: number): void => {
    body.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
  }

  const encoded = strings.map((text) => {
    const units: number[] = []
    for (const character of text) {
      const code = character.charCodeAt(0)
      units.push(code & 0xff, (code >> 8) & 0xff)
    }
    units.push(0, 0) // NUL terminator, as shipped files have
    return units
  })

  u32(strings.length)
  let offset = 4 + strings.length * 4
  for (const units of encoded) {
    u32(offset)
    offset += units.length
  }
  for (const units of encoded) body.push(...units)
  return body
}

describe('msbt detection', () => {
  it('recognises the signature', () => {
    expect(isMsbt(build([{ signature: 'TXT2', body: textSection(['hi']) }], 1))).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isMsbt(new Uint8Array(0))).toBe(false)
    expect(isMsbt(new Uint8Array(64))).toBe(false)
    // A BFLYT is the neighbour most likely to be handed to it by mistake.
    expect(isMsbt(new Uint8Array([0x46, 0x4c, 0x59, 0x54, 0xff, 0xfe, 0, 0]))).toBe(false)
  })
})

describe('msbt parsing', () => {
  it('reads strings and pairs them with their labels', () => {
    const bytes = build(
      [
        { signature: 'LBL1', body: labelSection('Greeting', 1) },
        { signature: 'TXT2', body: textSection(['first', 'second']) }
      ],
      1
    )
    const document = parseMsbt(bytes)
    expect(document.encoding).toBe('utf-16')
    expect(document.messages).toHaveLength(2)
    expect(document.messages[0]).toEqual({ label: '', index: 0, text: 'first' })
    expect(document.messages[1]).toEqual({ label: 'Greeting', index: 1, text: 'second' })
  })

  it('skips sections it does not model rather than failing on them', () => {
    // Real files carry ATR1, ATO1 and TSY1 between the two sections that matter; following the
    // declared size is what lets an unknown signature cost nothing.
    const document = parseMsbt(
      build(
        [
          { signature: 'ATO1', body: [1, 2, 3, 4] },
          { signature: 'LBL1', body: labelSection('Only', 0) },
          { signature: 'WXYZ', body: [9, 9] },
          { signature: 'TXT2', body: textSection(['kept']) }
        ],
        1
      )
    )
    expect(document.sections).toEqual(['ATO1', 'LBL1', 'WXYZ', 'TXT2'])
    expect(document.messages[0]).toEqual({ label: 'Only', index: 0, text: 'kept' })
  })

  it('renders control sequences as placeholders instead of characters', () => {
    /*
     * Inline commands — colour, button glyphs, variable substitution — are `0x0E` followed by
     * group, type and a length-prefixed payload. Decoding them as text gives garbage, and dropping
     * them hides that a variable is being interpolated, so they become visible placeholders.
     */
    const body: number[] = []
    const u32 = (value: number): void => {
      body.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
    }
    const u16 = (value: number): void => {
      body.push(value & 0xff, (value >> 8) & 0xff)
    }

    u32(1)
    u32(8)
    u16('A'.charCodeAt(0))
    u16(0x0e)
    u16(200) // group
    u16(4) // type
    u16(2) // two bytes of payload
    u16(0x1234)
    u16('B'.charCodeAt(0))
    u16(0)

    const document = parseMsbt(build([{ signature: 'TXT2', body }], 1))
    expect(document.messages[0]!.text).toBe('A{n:200.4}B')
  })

  it('reads UTF-8 tables without a DOM decoder', () => {
    // `shared` has no DOM, so UTF-8 is hand-rolled; multi-byte sequences are where that goes wrong.
    const body: number[] = []
    const u32 = (value: number): void => {
      body.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
    }
    u32(1)
    u32(8)
    // "aé漢" plus a NUL: one, two and three-byte sequences together.
    body.push(0x61, 0xc3, 0xa9, 0xe6, 0xbc, 0xa2, 0x00)

    const document = parseMsbt(build([{ signature: 'TXT2', body }], 0))
    expect(document.encoding).toBe('utf-8')
    expect(document.messages[0]!.text).toBe('aé漢')
  })

  it('replaces malformed UTF-8 rather than throwing', () => {
    const body: number[] = []
    const u32 = (value: number): void => {
      body.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
    }
    u32(1)
    u32(8)
    // A lone continuation byte, then a valid character: one bad string must not lose the rest.
    body.push(0x80, 0x61, 0x00)

    const document = parseMsbt(build([{ signature: 'TXT2', body }], 0))
    expect(document.messages[0]!.text).toBe('�a')
  })

  it('rejects a header claiming more bytes than it has', () => {
    const bytes = build([{ signature: 'TXT2', body: textSection(['x']) }], 1)
    new DataView(bytes.buffer).setUint32(0x12, 0xffff, true)
    expect(() => parseMsbt(bytes)).toThrow(FormatParseError)
  })

  it('rejects a section running past the end of the file', () => {
    const bytes = build([{ signature: 'TXT2', body: textSection(['x']) }], 1)
    // The section size sits 4 bytes into its header, at 0x24.
    new DataView(bytes.buffer).setUint32(0x24, 0xffff, true)
    expect(() => parseMsbt(bytes)).toThrow(FormatParseError)
  })

  it('rejects a file that is not an MSBT', () => {
    expect(() => parseMsbt(new Uint8Array(64))).toThrow(FormatParseError)
  })
})
