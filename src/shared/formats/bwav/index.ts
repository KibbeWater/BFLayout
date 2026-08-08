import { BinaryReader } from '../../binary/reader'
import { FormatParseError } from '../../binary/errors'

/**
 * BWAV — the audio containers this title streams every sound from.
 *
 * 946 loose files in one dump, 1.15 GB, plus 2,003 more inside six `.bars` archives. This is
 * metadata only: it reads the header and reports what the file *is*, and it decodes no audio
 * whatsoever. Nintendo DSP ADPCM and Opus are each their own project, and a preview that tells the
 * truth about sample rate, channel count, duration and loop points is most of what anyone wants
 * from an audio file they cannot play.
 *
 * There is no reference implementation for this format. Switch-Toolbox knows the string `BWAV` in
 * exactly one place — a BARS entry it labels and then hands to `BCFstmReader`, which cannot read it
 * — so every field below was derived from the real files and cross-checked against the population
 * of 2,949 headers. Where a claim rests on measurement, the measurement is named.
 *
 * The census quoted below is 2,949 files and 4,338 channels: the 946 loose files and the 2,003
 * entries of the six `.bars` archives in a Tomodachi Life romfs dump (Switch, v1.0.4).
 *
 * File header, 0x10 bytes:
 *
 *   0x00  char[4]  "BWAV"
 *   0x04  u16      byte-order mark — 0xFFFE little-endian in all 2,949, as with BFLYT
 *   0x06  u16      version; 1 everywhere
 *   0x08  u32      a checksum over the sample data — see `checksum`, it is not verified here
 *   0x0c  u16      1 when this is a prefetch stub, 0 when the file holds the whole stream
 *   0x0e  u16      channel count
 *   0x10           channel info, 0x4c bytes each, then padding to the first channel's data
 *
 * Channel info, 0x4c bytes:
 *
 *   +0x00  u16      codec
 *   +0x02  u16      channel layout / pan
 *   +0x04  u32      sample rate
 *   +0x08  u32      samples in the whole stream
 *   +0x0c  u32      samples stored in *this* file
 *   +0x10  s16[16]  DSP ADPCM coefficients (zero when the codec is not ADPCM)
 *   +0x30  u32      sample data offset
 *   +0x34  u32      the same offset again — identical in every channel of every complete file
 *   +0x38  u32      unidentified; 1 in all 4,338 channels
 *   +0x3c  u32      loop end sample, or 0xFFFFFFFF when the sample does not loop
 *   +0x40  u32      loop start sample
 *   +0x44  u16      ADPCM predictor/scale at the loop point
 *   +0x46  s16      ADPCM history sample 1 at the loop point
 *   +0x48  s16      ADPCM history sample 2 at the loop point
 *   +0x4a  u16      zero in all 1,625 channels of the loose files (not measured inside a `.bars`)
 *
 * Two of those are worth their own paragraph because they are the reverse of what a reading of a
 * sibling format would suggest, and the files are what settled them.
 *
 * **Loop end comes before loop start.** The field at +0x3c is only ever the whole-stream sample
 * count or 0xFFFFFFFF, and +0x40 is only ever 0 or a value below the stream count — there is no
 * third case in the census. Read the other way round a looping file would claim to start its loop
 * at the last sample and end it in the middle, so the assignment is forced. `validate-bwav`
 * re-checks the consequence on all 4,338 channels — start below end, end no greater than the stream
 * — and reports zero violations. The 0xFFFFFFFF sentinel meaning "no loop" is supported
 * independently: of the 62 loose files with `loop` in their name, 62 have a real loop end and none
 * carry the sentinel.
 *
 * **The two sample counts are not duplicates.** They are equal in every one of the 946 loose files,
 * which is exactly why a parser built from loose files alone would never learn the difference. In a
 * `.bars` the 946 entries flagged prefetch — the same count as the loose files, and their CRC-32
 * name hashes match those filenames one for one — carry +0x08 equal to the loose file's own +0x08
 * and +0x0c fixed at 14,336 samples, an 8 KB stub per channel. So +0x08 is the stream and +0x0c is
 * what is present, duration comes from +0x08, and a prefetch stub must not be described as if it
 * held the whole sound.
 */

export const BWAV_MAGIC = 'BWAV'

/** Bytes before the first channel record. */
export const BWAV_FILE_HEADER_SIZE = 0x10

/** Bytes per channel record. Constant across the population; the format carries no stride field. */
export const BWAV_CHANNEL_INFO_SIZE = 0x4c

/**
 * Codecs this build can name. The raw byte is always reported alongside, because naming a codec is
 * a claim and an unrecognised value must stay a number rather than become a guess.
 *
 * `dsp-adpcm` (1) covers 4,333 of the 4,338 channels and is confirmed by arithmetic rather than by
 * lineage: 14 samples per 8-byte frame, with a partial final frame of one header byte plus one
 * nibble per remaining sample, accounts for every byte of all 946 loose files. `pcm16` (0) accounts
 * for the other 5 channels — two of them the stereo pair of the only loose file that uses it,
 * `SE_UI_LevelUpJingle.bwav`, where two bytes per sample per channel likewise accounts for the file
 * exactly and the coefficient region is all zero.
 */
export type BwavCodecName = 'pcm16' | 'dsp-adpcm'

export function bwavCodecName(codec: number): BwavCodecName | null {
  if (codec === 0) return 'pcm16'
  if (codec === 1) return 'dsp-adpcm'
  return null
}

/** Human-readable codec, falling back to the raw value so an unknown codec is never dressed up. */
export function describeBwavCodec(codec: number): string {
  const name = bwavCodecName(codec)
  if (name === 'pcm16') return '16-bit PCM'
  if (name === 'dsp-adpcm') return 'Nintendo DSP ADPCM'
  return `unknown codec ${codec}`
}

/**
 * Whether this build could turn a channel's bytes into samples. It cannot, for any codec — the same
 * plain answer `isFormatSupported` gives for BC6H, and for the same reason: a preview that reports
 * "unsupported" is useful, and one that produces plausible-but-wrong output is not.
 *
 * Nothing here decodes audio. DSP ADPCM would need the coefficient and history handling this file
 * only records, and Opus needs a decoder outright. The parameter is taken so callers read as if
 * asking about a specific codec, which is how this will read once one of them is answered yes.
 */
export function isBwavCodecDecodable(_codec: number): boolean {
  return false
}

export interface BwavLoop {
  /** First sample of the loop, in whole-stream samples. */
  readonly startSample: number
  /** Sample the loop runs to, in whole-stream samples. Equal to the stream length in every file measured. */
  readonly endSample: number
}

/**
 * The ADPCM decoder state at the loop point.
 *
 * Verified where it can be: in all 813 ADPCM channels of the loose files whose loop start is 0,
 * `predictorScale` equals the header byte of the frame at the channel's own data offset and both
 * history samples are zero — which is what a decoder starting from the beginning would need, and
 * 813 of 813 with no misses. Where the loop start is
 * non-zero the same three fields are taken to describe that point instead; nothing here consumes
 * them, so that reading is recorded rather than relied on.
 */
export interface BwavAdpcmContext {
  readonly predictorScale: number
  readonly history1: number
  readonly history2: number
}

export interface BwavChannel {
  readonly index: number
  /** Raw codec field, always present even when this build cannot name it. */
  readonly codec: number
  /** `null` when the codec value is not one this build recognises. */
  readonly codecName: BwavCodecName | null
  /**
   * Raw layout/pan field at +0x02. Reported as a number on purpose: all 1,389 stereo files use 0 for
   * the first channel and 1 for the second while all 1,560 mono files use 2, which is consistent with
   * left/right/centre but is a mapping the files cannot confirm, so it is not asserted.
   */
  readonly channelLayout: number
  readonly sampleRate: number
  /** Samples in the whole stream, which is what duration is derived from. */
  readonly streamSampleCount: number
  /** Samples actually stored in this file. Lower than the stream count in a prefetch stub. */
  readonly storedSampleCount: number
  /** `null` when the sample rate is zero, rather than a division by it. */
  readonly durationSeconds: number | null
  readonly loop: BwavLoop | null
  /**
   * Offset of this channel's sample data.
   *
   * Relative to the start of the BWAV, so it works the same for a loose file and for one embedded
   * in a `.bars`. In a prefetch stub it describes the *whole stream's* layout rather than the bytes
   * present — measured on the stereo prefetch entries, where the gap between the two channels'
   * offsets matches the full stream's frame count and not the 8 KB actually stored — so it cannot
   * be used to locate the stub's own second channel.
   */
  readonly dataOffset: number
  /** The 16 DSP coefficients, for `dsp-adpcm` only; the region is all zero for `pcm16`. */
  readonly adpcmCoefficients: readonly number[] | null
  /** Loop-point decoder state, for `dsp-adpcm` only. */
  readonly adpcmContext: BwavAdpcmContext | null
  /** The unidentified u32 at +0x38, reported raw. 1 in every channel measured. */
  readonly unknown38: number
}

export interface BwavHeader {
  readonly littleEndian: boolean
  readonly version: number
  /**
   * The u32 at 0x08, reported and not checked.
   *
   * It is a CRC-32 over sample data — running the standard CRC-32 over each channel's exact frame
   * bytes reproduces it for 618 of the 941 loose files small enough to test, which is far too many
   * to be coincidence and far too few to be the rule. The byte range for the remaining 323 was not
   * pinned down, so this build reports the stored value and verifies nothing. It is *not* the
   * CRC-32 of the file's own name: that matched 0 of 946, while the same hash of the same names
   * matches the BARS index for 946 of 946 (see `parseBarsIndex`).
   */
  readonly checksum: number
  /** True when this file holds a short prefetch stub and the full stream lives elsewhere. */
  readonly prefetch: boolean
  readonly channelCount: number
  readonly channels: readonly BwavChannel[]
  /** Sample rate when every channel agrees, `null` when they disagree. */
  readonly sampleRate: number | null
  /** Codec when every channel agrees, `null` when they disagree. */
  readonly codec: number | null
  /** Duration when every channel agrees on rate and stream length, `null` otherwise. */
  readonly durationSeconds: number | null
  /** Loop of the first channel when every channel agrees, `null` when they disagree or none loops. */
  readonly loop: BwavLoop | null
  readonly looping: boolean
  /** False for every file: this build models the metadata and decodes none of the audio. */
  readonly decodable: boolean
  /** Why not, in words a preview can show. `null` only if `decodable` ever becomes true. */
  readonly undecodableReason: string | null
}

export function isBwav(data: Uint8Array): boolean {
  if (data.length < BWAV_FILE_HEADER_SIZE) return false
  for (let at = 0; at < BWAV_MAGIC.length; at++) {
    if (data[at] !== BWAV_MAGIC.charCodeAt(at)) return false
  }
  return true
}

/** Bytes of header a file with this many channels carries, which is all `parseBwav` needs. */
export function bwavHeaderSize(channelCount: number): number {
  return BWAV_FILE_HEADER_SIZE + channelCount * BWAV_CHANNEL_INFO_SIZE
}

/**
 * Reads just the channel count, so a caller can size its prefix before reading the rest.
 *
 * These files run to tens of megabytes and there are hundreds of them, so nothing here should
 * require the whole file: read 0x10 bytes, ask this, read `bwavHeaderSize(count)`, parse. A prefix
 * of 0x400 covers everything up to eight channels and every file in this dump has one or two.
 */
export function bwavChannelCount(data: Uint8Array): number {
  if (!isBwav(data)) {
    throw new FormatParseError({ format: 'bwav', offset: 0, message: 'missing BWAV signature' })
  }
  const reader = new BinaryReader(data, { littleEndian: readEndianness(data) })
  reader.seek(0x0e)
  return reader.u16()
}

export interface BwavParseOptions {
  /**
   * Total length of the file when `data` is only its leading bytes.
   *
   * Supplied, the channel data extents are checked against it. Omitted, they are not — a prefix
   * cannot tell a truncated file from a correctly-read header, and inventing a failure from a
   * missing input would be worse than declining to check.
   */
  readonly fileSize?: number
}

/**
 * Parses a BWAV header. `data` may be a prefix of the file; only `bwavHeaderSize(channels)` bytes
 * are ever touched.
 */
export function parseBwav(data: Uint8Array, options?: BwavParseOptions): BwavHeader {
  if (!isBwav(data)) {
    throw new FormatParseError({ format: 'bwav', offset: 0, message: 'missing BWAV signature' })
  }

  const littleEndian = readEndianness(data)
  const reader = new BinaryReader(data, { littleEndian })
  reader.skip(4)
  const bom = reader.u16be()
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'bwav',
      offset: 4,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }

  const version = reader.u16()
  const checksum = reader.u32()
  const prefetchFlag = reader.u16()
  const channelCount = reader.u16()

  if (channelCount === 0) {
    throw new FormatParseError({
      format: 'bwav',
      offset: 0x0e,
      message: 'header declares zero channels'
    })
  }

  /*
   * The header is fixed-width per channel, so how much is needed is knowable before reading it.
   * Saying how many bytes are missing is what lets a caller widen its prefix and retry rather than
   * fall back to reading the whole file.
   */
  const needed = bwavHeaderSize(channelCount)
  if (data.length < needed) {
    throw new FormatParseError({
      format: 'bwav',
      offset: BWAV_FILE_HEADER_SIZE,
      message: `${channelCount} channels need ${needed} header bytes but only ${data.length} were given`
    })
  }

  const channels: BwavChannel[] = []
  for (let index = 0; index < channelCount; index++) {
    const at = BWAV_FILE_HEADER_SIZE + index * BWAV_CHANNEL_INFO_SIZE
    reader.seek(at)

    const codec = reader.u16()
    const channelLayout = reader.u16()
    const sampleRate = reader.u32()
    const streamSampleCount = reader.u32()
    const storedSampleCount = reader.u32()

    const coefficients: number[] = []
    for (let coefficient = 0; coefficient < 16; coefficient++) coefficients.push(reader.i16())

    const dataOffset = reader.u32()
    reader.skip(4) // +0x34, the same offset again in every channel of every file measured.
    const unknown38 = reader.u32()
    const loopEnd = reader.u32()
    const loopStart = reader.u32()
    const predictorScale = reader.u16()
    const history1 = reader.i16()
    const history2 = reader.i16()

    /*
     * 0xFFFFFFFF at +0x3c is the "does not loop" sentinel; see the file comment for why that is
     * the reading and why start and end sit in this order. A loop whose start is not below its end
     * would describe nothing playable, so it is rejected rather than reported as a loop.
     */
    const loops = loopEnd !== 0xffffffff
    if (loops && loopStart >= loopEnd) {
      throw new FormatParseError({
        format: 'bwav',
        offset: at + 0x40,
        message: `channel ${index} loops from sample ${loopStart} to ${loopEnd}, which is not a range`
      })
    }

    if (sampleRate === 0) {
      throw new FormatParseError({
        format: 'bwav',
        offset: at + 4,
        message: `channel ${index} declares a sample rate of zero`
      })
    }

    /*
     * Only checked when the caller knows the file's real length, and only for a complete file: a
     * prefetch stub's offsets describe the stream it stands in for, so measuring them against the
     * stub would reject every one of the 946 in this dump.
     */
    const fileSize = options?.fileSize
    if (fileSize !== undefined && prefetchFlag === 0 && dataOffset >= fileSize) {
      throw new FormatParseError({
        format: 'bwav',
        offset: at + 0x30,
        message: `channel ${index} points its sample data at ${dataOffset}, past the end of a ${fileSize}-byte file`
      })
    }

    const isAdpcm = bwavCodecName(codec) === 'dsp-adpcm'
    channels.push({
      index,
      codec,
      codecName: bwavCodecName(codec),
      channelLayout,
      sampleRate,
      streamSampleCount,
      storedSampleCount,
      durationSeconds: streamSampleCount / sampleRate,
      loop: loops ? { startSample: loopStart, endSample: loopEnd } : null,
      dataOffset,
      adpcmCoefficients: isAdpcm ? coefficients : null,
      adpcmContext: isAdpcm ? { predictorScale, history1, history2 } : null,
      unknown38
    })
  }

  /*
   * The document-level summary reports a value only when every channel agrees on it. Every file in
   * the dump agrees, so this never actually degrades — but a preview showing "48000 Hz" for a file
   * whose two channels disagree would be stating something false about one of them, and `null` is
   * the honest answer to a question the file answers twice.
   */
  const first = channels[0]!
  const agrees = <T>(pick: (channel: BwavChannel) => T): boolean =>
    channels.every((channel) => pick(channel) === pick(first))

  const sameRate = agrees((channel) => channel.sampleRate)
  const sameLength = agrees((channel) => channel.streamSampleCount)
  const sameLoop =
    agrees((channel) => channel.loop?.startSample ?? -1) &&
    agrees((channel) => channel.loop?.endSample ?? -1)

  const decodable = channels.every((channel) => isBwavCodecDecodable(channel.codec))
  const codecs = [...new Set(channels.map((channel) => channel.codec))]

  return {
    littleEndian,
    version,
    checksum,
    prefetch: prefetchFlag !== 0,
    channelCount,
    channels,
    sampleRate: sameRate ? first.sampleRate : null,
    codec: codecs.length === 1 ? codecs[0]! : null,
    durationSeconds: sameRate && sameLength ? first.durationSeconds : null,
    loop: sameLoop ? first.loop : null,
    looping: channels.some((channel) => channel.loop !== null),
    decodable,
    undecodableReason: decodable
      ? null
      : `this build reads BWAV metadata only and cannot decode ${codecs
          .map((codec) => describeBwavCodec(codec))
          .join(' or ')}`
  }
}

/**
 * The byte-order mark sits at 0x04, before anything read with it — the same arrangement BFLYT uses,
 * so the first fields are read big-endian and the reader flips afterwards.
 */
function readEndianness(data: Uint8Array): boolean {
  return !(data[4] === 0xfe && data[5] === 0xff)
}

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * BARS — the archive BWAVs ship inside.
 *
 * Six of them in this dump, 33 MB compressed, 2,003 entries between them and every single entry an
 * (AMTA, BWAV) pair. Enough of the container is modelled here to hand a caller the offset of each
 * BWAV; it is deliberately an index and not a document, so a caller can slice one header out of a
 * decompressed archive without a second copy of 12 MB.
 *
 * This lives beside the BWAV parser because BWAV is the only thing a BARS was observed to hold. If
 * a second payload kind ever turns up it belongs in its own module.
 *
 *   0x00  char[4]  "BARS"
 *   0x04  u32      file size — equal to the decompressed length in all six
 *   0x08  u16      byte-order mark, 0xFFFE
 *   0x0a  u16      version, 0x0102 in all six
 *   0x0c  u32      entry count
 *   0x10  u32[n]   name hashes, ascending
 *   ...   (u32, u32)[n]  metadata offset, audio offset — both absolute in the archive
 *
 * The AMTA blocks are not parsed. They hold the entry *names*, and the offset at AMTA+0x24 lands a
 * few bytes short of one — three bytes in one sample, five in another — so it points at a string
 * table whose own header was not worked out. Worse, the tables carry two different names apiece
 * (one entry holds both `BGM_Demo_GirlsParty_01.x` and `BGM_Demo_Ukiuki_02`), so which one names
 * the entry is not decidable from what was measured. Guessing would put a wrong name under a
 * playable file, so entries are returned unnamed and carry their hash instead.
 */

export const BARS_MAGIC = 'BARS'

export interface BarsEntry {
  readonly index: number
  /**
   * CRC-32 (the standard reflected polynomial) of the entry's own file name, without extension.
   *
   * Verified rather than assumed: every one of the 946 prefetch entries across the six archives
   * hashes to the name of one of the 946 loose `.bwav` files, with no misses and no leftovers. That
   * makes names recoverable from a candidate list the same way `archive.recoverNames` does for a
   * SARC, which is not implemented here.
   */
  readonly nameHash: number
  /** Offset of this entry's AMTA metadata block, which this build does not parse. */
  readonly metadataOffset: number
  /** Offset of this entry's audio payload — a BWAV in all 2,003 entries measured. */
  readonly audioOffset: number
}

export interface BarsIndex {
  readonly littleEndian: boolean
  readonly version: number
  /** The size the header claims, equal to the real decompressed length in all six archives. */
  readonly declaredFileSize: number
  readonly entries: readonly BarsEntry[]
}

export function isBars(data: Uint8Array): boolean {
  if (data.length < 0x10) return false
  for (let at = 0; at < BARS_MAGIC.length; at++) {
    if (data[at] !== BARS_MAGIC.charCodeAt(at)) return false
  }
  return true
}

/**
 * Reads the entry table. Needs only `0x10 + count * 12` bytes, not the whole archive — though a
 * caller wanting the payloads will already hold all of it, since the offsets are absolute.
 */
export function parseBarsIndex(data: Uint8Array): BarsIndex {
  if (!isBars(data)) {
    throw new FormatParseError({ format: 'bars', offset: 0, message: 'missing BARS signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: true })
  reader.seek(8)
  const bom = reader.u16be()
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'bars',
      offset: 8,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  reader.littleEndian = bom === 0xfffe

  reader.seek(4)
  const declaredFileSize = reader.u32()
  reader.seek(0x0a)
  const version = reader.u16()
  const count = reader.u32()

  // Hashes then offset pairs: 4 bytes and 8 bytes per entry, both fixed-width and both required.
  const tableEnd = 0x10 + count * 12
  if (tableEnd > data.length) {
    throw new FormatParseError({
      format: 'bars',
      offset: 0x0c,
      message: `${count} entries need ${tableEnd} bytes of table but only ${data.length} were given`
    })
  }

  const entries: BarsEntry[] = []
  const pairsAt = 0x10 + count * 4
  for (let index = 0; index < count; index++) {
    reader.seek(0x10 + index * 4)
    const nameHash = reader.u32()
    reader.seek(pairsAt + index * 8)
    const metadataOffset = reader.u32()
    const audioOffset = reader.u32()
    entries.push({ index, nameHash, metadataOffset, audioOffset })
  }
  return { littleEndian: reader.littleEndian, version, declaredFileSize, entries }
}
