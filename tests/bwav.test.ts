import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import {
  bwavChannelCount,
  bwavHeaderSize,
  describeBwavCodec,
  isBars,
  isBwav,
  isBwavCodecDecodable,
  parseBarsIndex,
  parseBwav
} from '@shared/formats/bwav'

/**
 * BWAV headers built by hand, byte by byte.
 *
 * The format is fixed-width, so constructing it is what pins down the offsets — and the offsets are
 * the whole parser. What these cannot show is breadth: that all 2,949 headers in a real dump parse,
 * that the two sample-count fields differ only inside a `.bars`, and that the declared sample counts
 * account for every byte of all 946 loose files comes from `scripts/validate-bwav.ts`, which needs a
 * dump and cannot live here.
 */

const NO_LOOP = 0xffffffff

interface Channel {
  codec?: number
  layout?: number
  sampleRate?: number
  streamSamples?: number
  storedSamples?: number
  coefficients?: number[]
  dataOffset?: number
  loopEnd?: number
  loopStart?: number
  predictorScale?: number
  history1?: number
  history2?: number
}

/** A whole BWAV header, laid out the way the real files are. */
function build(channels: Channel[], header?: { version?: number; prefetch?: number; checksum?: number }): Uint8Array {
  const out: number[] = []
  const u16 = (value: number): void => {
    out.push(value & 0xff, (value >> 8) & 0xff)
  }
  const u32 = (value: number): void => {
    u16(value & 0xffff)
    u16((value >>> 16) & 0xffff)
  }

  for (const character of 'BWAV') out.push(character.charCodeAt(0))
  out.push(0xff, 0xfe) // BOM at 0x04, before anything read with it — as BFLYT does.
  u16(header?.version ?? 1)
  u32(header?.checksum ?? 0xdeadbeef)
  u16(header?.prefetch ?? 0)
  u16(channels.length)

  for (const channel of channels) {
    u16(channel.codec ?? 1)
    u16(channel.layout ?? 0)
    u32(channel.sampleRate ?? 48000)
    u32(channel.streamSamples ?? 48000)
    u32(channel.storedSamples ?? channel.streamSamples ?? 48000)
    const coefficients = channel.coefficients ?? new Array<number>(16).fill(0)
    for (let index = 0; index < 16; index++) u16(coefficients[index]! & 0xffff)
    u32(channel.dataOffset ?? 0xc0)
    u32(channel.dataOffset ?? 0xc0) // +0x34 repeats the offset in every real file.
    u32(1) // +0x38, unidentified, 1 everywhere.
    u32(channel.loopEnd ?? NO_LOOP)
    u32(channel.loopStart ?? 0)
    u16(channel.predictorScale ?? 0)
    u16((channel.history1 ?? 0) & 0xffff)
    u16((channel.history2 ?? 0) & 0xffff)
    u16(0) // +0x4a, zero everywhere.
  }
  return new Uint8Array(out)
}

describe('bwav detection', () => {
  it('recognises the signature', () => {
    expect(isBwav(build([{}]))).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isBwav(new Uint8Array(0))).toBe(false)
    expect(isBwav(new Uint8Array(0x40))).toBe(false)
    // BARS is the neighbour most likely to be handed to it by mistake — it holds these.
    expect(isBwav(new Uint8Array([0x42, 0x41, 0x52, 0x53, 0, 0, 0, 0, 0xff, 0xfe, 2, 1, 0, 0, 0, 0]))).toBe(false)
  })

  it('rejects a buffer too short to hold the file header', () => {
    expect(isBwav(build([{}]).subarray(0, 8))).toBe(false)
  })
})

describe('bwav parsing', () => {
  it('reads a mono non-looping file', () => {
    // Mono files in the dump use layout 2 and put their data at 0x80; stereo uses 0/1 and 0xc0.
    const header = parseBwav(build([{ layout: 2, sampleRate: 48000, streamSamples: 96000, dataOffset: 0x80 }]))

    expect(header.littleEndian).toBe(true)
    expect(header.version).toBe(1)
    expect(header.checksum).toBe(0xdeadbeef)
    expect(header.prefetch).toBe(false)
    expect(header.channelCount).toBe(1)
    expect(header.sampleRate).toBe(48000)
    expect(header.durationSeconds).toBe(2)
    expect(header.looping).toBe(false)
    expect(header.loop).toBeNull()

    const channel = header.channels[0]!
    expect(channel.codec).toBe(1)
    expect(channel.codecName).toBe('dsp-adpcm')
    expect(channel.channelLayout).toBe(2)
    expect(channel.streamSampleCount).toBe(96000)
    expect(channel.storedSampleCount).toBe(96000)
    expect(channel.dataOffset).toBe(0x80)
    expect(channel.adpcmCoefficients).toHaveLength(16)
    expect(channel.unknown38).toBe(1)
  })

  it('reads a two-channel looping file', () => {
    /*
     * The loop fields are the reverse of what a reading of a sibling format suggests: end sits at
     * +0x3c and start at +0x40. The real dump is what settles it — across 2,713 channels +0x3c is
     * only ever the stream length or the 0xFFFFFFFF sentinel — so a test that got the order wrong
     * would produce a loop starting at the last sample.
     */
    const channel = { loopEnd: 240000, loopStart: 48000, predictorScale: 0x16, history1: -154, history2: -124 }
    const header = parseBwav(
      build([
        { ...channel, layout: 0, streamSamples: 240000, dataOffset: 0xc0 },
        { ...channel, layout: 1, streamSamples: 240000, dataOffset: 0x21000 }
      ])
    )

    expect(header.channelCount).toBe(2)
    expect(header.looping).toBe(true)
    expect(header.loop).toEqual({ startSample: 48000, endSample: 240000 })
    expect(header.durationSeconds).toBe(5)
    expect(header.channels.map((each) => each.channelLayout)).toEqual([0, 1])
    expect(header.channels.map((each) => each.dataOffset)).toEqual([0xc0, 0x21000])
    // History is non-zero at a non-zero loop point, which is what a decoder would need to seek.
    expect(header.channels[0]!.adpcmContext).toEqual({
      predictorScale: 0x16,
      history1: -154,
      history2: -124
    })
  })

  it('separates the stream length from what a prefetch stub actually stores', () => {
    /*
     * The two counts are equal in all 946 loose files, so only the `.bars` entries show they are
     * different fields: prefetch stubs there hold 14,336 samples of a much longer stream. Duration
     * has to come from the stream count, or every prefetched BGM would be reported as 0.3 seconds.
     */
    const header = parseBwav(
      build([{ streamSamples: 1417939, storedSamples: 14336, loopEnd: 1417939, loopStart: 92 }], {
        prefetch: 1
      })
    )

    expect(header.prefetch).toBe(true)
    expect(header.channels[0]!.streamSampleCount).toBe(1417939)
    expect(header.channels[0]!.storedSampleCount).toBe(14336)
    expect(header.durationSeconds).toBeCloseTo(29.54, 2)
  })

  it('reports an unrecognised codec as its raw value rather than naming it', () => {
    // Opus is the codec this format is known to carry elsewhere and this build has never seen; the
    // point is that whatever the value is, it stays a number and does not become a guess.
    const header = parseBwav(build([{ codec: 2 }]))

    expect(header.channels[0]!.codec).toBe(2)
    expect(header.channels[0]!.codecName).toBeNull()
    expect(header.channels[0]!.adpcmCoefficients).toBeNull()
    expect(header.channels[0]!.adpcmContext).toBeNull()
    expect(describeBwavCodec(2)).toBe('unknown codec 2')
    // Everything else still reads, which is the point of degrading rather than failing.
    expect(header.sampleRate).toBe(48000)
    expect(header.durationSeconds).toBe(1)
    expect(header.undecodableReason).toContain('unknown codec 2')
  })

  it('names the codecs it does know and claims none of them decode', () => {
    expect(describeBwavCodec(0)).toBe('16-bit PCM')
    expect(describeBwavCodec(1)).toBe('Nintendo DSP ADPCM')
    for (const codec of [0, 1, 2, 3, 255]) expect(isBwavCodecDecodable(codec)).toBe(false)
    expect(parseBwav(build([{}])).decodable).toBe(false)
    expect(parseBwav(build([{}])).undecodableReason).toContain('metadata only')
  })

  it('declines to summarise fields the channels disagree about', () => {
    // No file in the dump disagrees, so this can only be tested by hand — and a preview that showed
    // one channel's rate as the file's would be stating something false about the other.
    const header = parseBwav(
      build([
        { sampleRate: 48000, streamSamples: 48000 },
        { sampleRate: 24000, streamSamples: 24000, codec: 0 }
      ])
    )

    expect(header.sampleRate).toBeNull()
    expect(header.codec).toBeNull()
    expect(header.durationSeconds).toBeNull()
    // Per-channel values are still exact; only the summary declines.
    expect(header.channels.map((each) => each.sampleRate)).toEqual([48000, 24000])
    expect(header.channels.map((each) => each.durationSeconds)).toEqual([1, 1])
  })

  it('works on a prefix, and says how much more it needs when given too little', () => {
    const bytes = build([{}, {}])
    expect(bwavHeaderSize(2)).toBe(0x10 + 2 * 0x4c)
    // The channel count is readable from the file header alone, which is how a caller sizes its read.
    expect(bwavChannelCount(bytes.subarray(0, 0x10))).toBe(2)
    // Exactly the header, with none of the sample data that follows it in a real file.
    expect(bytes).toHaveLength(bwavHeaderSize(2))
    expect(parseBwav(bytes.subarray(0, bwavHeaderSize(2))).channelCount).toBe(2)

    expect(() => parseBwav(bytes.subarray(0, bwavHeaderSize(1)))).toThrow(
      /2 channels need 168 header bytes but only 92 were given/
    )
  })
})

describe('bwav malformed input', () => {
  it('rejects a file that is not a BWAV', () => {
    expect(() => parseBwav(new Uint8Array(0x40))).toThrow(FormatParseError)
    expect(() => bwavChannelCount(new Uint8Array(0x40))).toThrow(FormatParseError)
  })

  it('rejects an unrecognised byte-order mark', () => {
    const bytes = build([{}])
    bytes[4] = 0x12
    bytes[5] = 0x34
    expect(() => parseBwav(bytes)).toThrow(FormatParseError)
  })

  it('rejects a header declaring no channels', () => {
    const bytes = build([{}])
    new DataView(bytes.buffer).setUint16(0x0e, 0, true)
    expect(() => parseBwav(bytes)).toThrow(/zero channels/)
  })

  it('rejects a channel count whose records are not present', () => {
    const bytes = build([{}])
    new DataView(bytes.buffer).setUint16(0x0e, 64, true)
    expect(() => parseBwav(bytes)).toThrow(FormatParseError)
  })

  it('rejects a loop that is not a range', () => {
    // Loop start at or past loop end describes nothing playable, and reporting it as a loop would
    // hand the preview a negative length.
    expect(() => parseBwav(build([{ loopEnd: 1000, loopStart: 1000 }]))).toThrow(/not a range/)
    expect(() => parseBwav(build([{ loopEnd: 1000, loopStart: 5000 }]))).toThrow(FormatParseError)
  })

  it('rejects a sample rate of zero rather than dividing by it', () => {
    expect(() => parseBwav(build([{ sampleRate: 0 }]))).toThrow(/sample rate of zero/)
  })

  it('rejects sample data pointed past the end of a file whose size is known', () => {
    const bytes = build([{ dataOffset: 5_000_000 }])
    // Without a size there is nothing to check against, and inventing a failure would be worse.
    expect(() => parseBwav(bytes)).not.toThrow()
    expect(() => parseBwav(bytes, { fileSize: 4096 })).toThrow(/past the end of a 4096-byte file/)
  })

  it('does not check the offsets of a prefetch stub against its own length', () => {
    /*
     * A stub's channel offsets describe the stream it stands in for, not the bytes it holds — in the
     * dump the gap between a stereo stub's two channel offsets matches the full stream's frame count
     * rather than the 8 KB stored. Checking them against the stub would reject all 946.
     */
    const bytes = build([{ dataOffset: 0xc0 }, { dataOffset: 810_304 }], { prefetch: 1 })
    expect(() => parseBwav(bytes, { fileSize: 16_576 })).not.toThrow()
  })
})

describe('bars index', () => {
  /** A BARS entry table: hashes ascending, then (metadata, audio) offset pairs. */
  function bars(entries: { hash: number; metadata: number; audio: number }[]): Uint8Array {
    const out: number[] = []
    const u16 = (value: number): void => {
      out.push(value & 0xff, (value >> 8) & 0xff)
    }
    const u32 = (value: number): void => {
      u16(value & 0xffff)
      u16((value >>> 16) & 0xffff)
    }

    for (const character of 'BARS') out.push(character.charCodeAt(0))
    const sizeAt = 4
    u32(0) // patched below
    out.push(0xff, 0xfe) // BOM at 0x08 here, not 0x04 — BARS and BWAV disagree about where it sits.
    u16(0x0102)
    u32(entries.length)
    for (const entry of entries) u32(entry.hash)
    for (const entry of entries) {
      u32(entry.metadata)
      u32(entry.audio)
    }

    const bytes = new Uint8Array(out)
    new DataView(bytes.buffer).setUint32(sizeAt, bytes.length, true)
    return bytes
  }

  it('recognises the signature', () => {
    expect(isBars(bars([{ hash: 1, metadata: 0x40, audio: 0x80 }]))).toBe(true)
    expect(isBars(new Uint8Array(0x20))).toBe(false)
    expect(isBars(build([{}]))).toBe(false)
  })

  it('reads the entry table', () => {
    const bytes = bars([
      { hash: 0x01200811, metadata: 3696, audio: 730880 },
      { hash: 0x02f5165c, metadata: 5080, audio: 747456 }
    ])
    const index = parseBarsIndex(bytes)

    expect(index.version).toBe(0x0102)
    expect(index.declaredFileSize).toBe(bytes.length)
    expect(index.entries).toEqual([
      { index: 0, nameHash: 0x01200811, metadataOffset: 3696, audioOffset: 730880 },
      { index: 1, nameHash: 0x02f5165c, metadataOffset: 5080, audioOffset: 747456 }
    ])
  })

  it('rejects an entry count whose table is not present', () => {
    const bytes = bars([{ hash: 1, metadata: 0x40, audio: 0x80 }])
    new DataView(bytes.buffer).setUint32(0x0c, 0xffff, true)
    expect(() => parseBarsIndex(bytes)).toThrow(/entries need/)
  })

  it('rejects a file that is not a BARS', () => {
    expect(() => parseBarsIndex(new Uint8Array(0x20))).toThrow(FormatParseError)
  })
})
