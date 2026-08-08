import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import {
  findSarcEntry,
  parseSarc,
  recoverSarcNames,
  replaceSarcEntry,
  sarcHash,
  writeSarc,
  type SarcArchive
} from '@shared/formats/sarc'

const encoder = new TextEncoder()

/**
 * Builds an archive from scratch through the writer. Entries carry no original
 * layout, so this exercises the repack path.
 */
function buildArchive(
  files: ReadonlyArray<{ name: string; data: Uint8Array; alignment?: number }>,
  options?: { littleEndian?: boolean }
): SarcArchive {
  return {
    littleEndian: options?.littleEndian ?? true,
    version: 0x0100,
    hashKey: 0x65,
    hasNames: true,
    originalDataOffset: 0,
    entries: files.map((file) => ({
      nameHash: sarcHash(file.name, 0x65),
      name: file.name,
      data: file.data,
      originalOffset: 0,
      originalLength: -1,
      alignment: file.alignment ?? 4
    }))
  }
}

const sampleFiles = [
  { name: 'blyt/HeaderMain.bflyt', data: encoder.encode('FLYT layout bytes here') },
  { name: 'anim/HeaderMain_Loop.bflan', data: encoder.encode('FLAN animation bytes') },
  { name: 'timg/Header.bntx', data: encoder.encode('BNTX texture bytes'), alignment: 0x1000 }
]

describe('SARC hashing', () => {
  it('matches the documented multiply-accumulate hash', () => {
    // hash = ((('a' * 0x65) + 'b') * 0x65) + 'c'
    const expected = ((((97 * 0x65 + 98) >>> 0) * 0x65 + 99) >>> 0) >>> 0
    expect(sarcHash('abc', 0x65)).toBe(expected)
  })

  it('stays inside 32 bits for long names', () => {
    const hash = sarcHash('blyt/AVeryLongLayoutFileNameIndeed.bflyt', 0x65)
    expect(Number.isInteger(hash)).toBe(true)
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('SARC round-trip', () => {
  it('writes then reads back every entry', () => {
    const written = writeSarc(buildArchive(sampleFiles))
    const parsed = parseSarc(written)

    expect(parsed.entries).toHaveLength(3)
    expect(parsed.hasNames).toBe(true)
    for (const file of sampleFiles) {
      const entry = findSarcEntry(parsed, file.name)
      expect(entry, file.name).toBeDefined()
      expect([...entry!.data]).toEqual([...file.data])
    }
  })

  it('is byte-identical when re-writing an untouched archive', () => {
    const original = writeSarc(buildArchive(sampleFiles))
    const reWritten = writeSarc(parseSarc(original))
    expect([...reWritten]).toEqual([...original])
  })

  it('stays byte-identical across repeated parse/write cycles', () => {
    let bytes = writeSarc(buildArchive(sampleFiles))
    for (let i = 0; i < 3; i++) {
      const next = writeSarc(parseSarc(bytes))
      expect([...next]).toEqual([...bytes])
      bytes = next
    }
  })

  it('orders nodes by hash so lookups by hash work', () => {
    const parsed = parseSarc(writeSarc(buildArchive(sampleFiles)))
    const hashes = parsed.entries.map((entry) => entry.nameHash)
    expect([...hashes].sort((a, b) => a - b)).toEqual(hashes)
  })

  it('honours per-entry alignment when repacking', () => {
    const parsed = parseSarc(writeSarc(buildArchive(sampleFiles)))
    const bntx = findSarcEntry(parsed, 'timg/Header.bntx')!
    expect(bntx.alignment % 0x1000).toBe(0)
  })

  it('round-trips big-endian archives', () => {
    const written = writeSarc(buildArchive(sampleFiles, { littleEndian: false }))
    const parsed = parseSarc(written)
    expect(parsed.littleEndian).toBe(false)
    expect([...findSarcEntry(parsed, 'timg/Header.bntx')!.data]).toEqual([
      ...sampleFiles[2]!.data
    ])
  })
})

describe('SARC editing', () => {
  it('replaces one entry and leaves the others intact', () => {
    const parsed = parseSarc(writeSarc(buildArchive(sampleFiles)))
    const replacement = encoder.encode('a considerably longer set of layout bytes than before')
    const edited = replaceSarcEntry(parsed, 'blyt/HeaderMain.bflyt', replacement)

    const reparsed = parseSarc(writeSarc(edited))
    expect([...findSarcEntry(reparsed, 'blyt/HeaderMain.bflyt')!.data]).toEqual([...replacement])
    expect([...findSarcEntry(reparsed, 'timg/Header.bntx')!.data]).toEqual([
      ...sampleFiles[2]!.data
    ])
  })

  it('rejects replacing an entry that does not exist', () => {
    const parsed = parseSarc(writeSarc(buildArchive(sampleFiles)))
    expect(() => replaceSarcEntry(parsed, 'blyt/Nope.bflyt', new Uint8Array(1))).toThrow(
      /no entry named/
    )
  })
})

describe('SARC name recovery', () => {
  it('recovers names for a hash-only archive from candidate strings', () => {
    const parsed = parseSarc(writeSarc(buildArchive(sampleFiles)))

    // Simulate an archive shipped without a name table.
    const anonymous: SarcArchive = {
      ...parsed,
      hasNames: false,
      entries: parsed.entries.map((entry) => ({ ...entry, name: null }))
    }
    expect(() => writeSarc(anonymous)).toThrow(/recover names first/)

    const recovered = recoverSarcNames(anonymous, [
      'timg/Header.bntx',
      'blyt/HeaderMain.bflyt',
      'anim/HeaderMain_Loop.bflan',
      'blyt/SomethingUnrelated.bflyt'
    ])

    expect(recovered.hasNames).toBe(true)
    expect(recovered.entries.every((entry) => entry.name !== null)).toBe(true)
    expect([...writeSarc(recovered)]).toEqual([...writeSarc(parsed)])
  })

  it('leaves entries unnamed when no candidate hashes match', () => {
    const parsed = parseSarc(writeSarc(buildArchive(sampleFiles)))
    const anonymous: SarcArchive = {
      ...parsed,
      hasNames: false,
      entries: parsed.entries.map((entry) => ({ ...entry, name: null }))
    }
    const recovered = recoverSarcNames(anonymous, ['nothing/matches.bin'])
    expect(recovered.entries.every((entry) => entry.name === null)).toBe(true)
  })
})

describe('SARC validation', () => {
  it('rejects a buffer without the signature', () => {
    expect(() => parseSarc(new Uint8Array(0x20))).toThrow(FormatParseError)
  })

  it('rejects an unrecognised byte-order mark', () => {
    const bytes = writeSarc(buildArchive(sampleFiles))
    bytes[6] = 0x12
    bytes[7] = 0x34
    expect(() => parseSarc(bytes)).toThrow(/byte-order mark/)
  })

  it('rejects a header claiming more bytes than exist', () => {
    const bytes = writeSarc(buildArchive(sampleFiles))
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    view.setUint32(8, 0x00ff_ffff, true)
    expect(() => parseSarc(bytes)).toThrow(/only .* are present/)
  })

  it('rejects an entry whose data range escapes the archive', () => {
    const bytes = writeSarc(buildArchive(sampleFiles))
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    // Third u32 of the first SFAT node is its begin offset.
    view.setUint32(0x14 + 0x0c + 8, 0x00ff_0000, true)
    expect(() => parseSarc(bytes)).toThrow(/outside the archive/)
  })
})
