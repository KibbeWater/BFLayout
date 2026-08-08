import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import { decodeBfttf, isBfcpx, isBfttf, parseBfcpx } from '@shared/formats/font'

import vectors from './fixtures/font-vectors.json'

/**
 * Real files, not synthesised ones.
 *
 * A synthesised BFTTF would only prove the decoder is self-consistent — and the whole
 * question here is whether the XOR key is right, which self-consistency cannot answer. So
 * the fixture carries the smallest face and the smallest descriptor from a shipped font
 * archive, and the assertions are the two independent invariants that identify the key: a
 * valid sfnt signature, and a declared length matching the payload.
 */
const face = (): Uint8Array => Uint8Array.from(Buffer.from(vectors.face.base64, 'base64'))
const complex = (): Uint8Array => Uint8Array.from(Buffer.from(vectors.complex.base64, 'base64'))

describe('bfttf detection', () => {
  it('recognises a real face', () => {
    expect(isBfttf(face())).toBe(true)
  })

  it('rejects anything else, including a bare sfnt', () => {
    // The decoded output must not look like the wrapper, or a second decode could be
    // attempted on an already-decoded font.
    expect(isBfttf(decodeBfttf(face()).sfnt)).toBe(false)
    expect(isBfttf(new Uint8Array(0))).toBe(false)
    expect(isBfttf(new Uint8Array([0x46, 0x43, 0x50, 0x58, 0, 0, 0, 0]))).toBe(false)
  })
})

describe('bfttf decoding', () => {
  it('produces a font with a valid signature', () => {
    const decoded = decodeBfttf(face())
    expect(decoded.kind).toBe('otf')
    expect([...decoded.sfnt.subarray(0, 4)]).toEqual([0x4f, 0x54, 0x54, 0x4f]) // 'OTTO'
  })

  it('produces exactly the payload the wrapper declares', () => {
    expect(decodeBfttf(face()).sfnt.length).toBe(face().length - 8)
  })

  it('produces a structurally valid sfnt table directory', () => {
    /*
     * The strongest available check that the key is right, short of rendering: every
     * table in the directory has to declare an offset and length inside the file, and the
     * tags have to be real. A wrong key gives noise that cannot satisfy either.
     */
    const { sfnt } = decodeBfttf(face())
    const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength)
    const tables = view.getUint16(4, false)
    expect(tables).toBeGreaterThan(4)

    const tags: string[] = []
    for (let index = 0; index < tables; index++) {
      const at = 12 + index * 16
      tags.push(String.fromCharCode(...sfnt.subarray(at, at + 4)))
      const offset = view.getUint32(at + 8, false)
      const length = view.getUint32(at + 12, false)
      expect(offset + length).toBeLessThanOrEqual(sfnt.length)
    }

    // A font cannot be used without these, so their presence is meaningful.
    expect(tags).toContain('head')
    expect(tags).toContain('cmap')
    expect(tags).toContain('hmtx')
  })

  it('reports an unrecognised wrapper rather than returning noise', () => {
    const bytes = face().slice()
    bytes[0] = 0
    expect(() => decodeBfttf(bytes)).toThrow(FormatParseError)
  })

  it('reports a truncated font rather than a short one', () => {
    // The declared length is what catches this; without checking it a truncated file
    // would decode to a font that renders as garbage with no indication why.
    expect(() => decodeBfttf(face().slice(0, 512))).toThrow(FormatParseError)
  })

  it('reports a file too small to hold a wrapper', () => {
    expect(() => decodeBfttf(new Uint8Array(4))).toThrow(FormatParseError)
  })
})

describe('bfcpx font complexes', () => {
  it('recognises a real descriptor', () => {
    expect(isBfcpx(complex())).toBe(true)
    expect(isBfcpx(face())).toBe(false)
  })

  it('reads the fallback chain in order', () => {
    const { faces } = parseBfcpx(complex())
    expect(faces.length).toBeGreaterThan(0)
    // Every name is a typeface file, and none is a stray run of printable bytes.
    for (const name of faces) expect(name).toMatch(/\.bf[ot]tf$/)
    // The chain ends in the main typeface; this descriptor is the single-face Ruby one.
    expect(faces[faces.length - 1]).toBe('FOT-UDKAKUGO_LARGEPR6-DB.bfotf')
  })

  it('lists each face once', () => {
    // A repeated family in a CSS fallback list is harmless, but it means something is
    // being read twice.
    const { faces } = parseBfcpx(complex())
    expect(new Set(faces).size).toBe(faces.length)
  })

  it('rejects a file that is not a descriptor', () => {
    expect(() => parseBfcpx(face())).toThrow(FormatParseError)
  })

  it('rejects a descriptor claiming to be longer than it is', () => {
    const bytes = complex().slice()
    new DataView(bytes.buffer).setUint32(12, 0xffff, true)
    expect(() => parseBfcpx(bytes)).toThrow(FormatParseError)
  })
})
