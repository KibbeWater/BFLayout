import { FormatParseError } from '../../binary/errors'

/**
 * BFTTF / BFOTF — a scalable font with its bytes obfuscated.
 *
 * Underneath it is an ordinary sfnt (TrueType or OpenType) file. The wrapper is eight
 * bytes of header followed by the font XORed, one big-endian u32 at a time, with a key
 * chosen by the magic. That is the whole scheme; there is no compression and no
 * per-file variation.
 *
 * This matters here because this game ships no BFFNT bitmap fonts at all — its layouts
 * name `.bfcpx` descriptors, which name these. Decoding them is what lets the canvas draw
 * text in the typeface the game actually uses instead of whatever sans-serif the OS
 * happens to provide.
 *
 * The keys came from the reference implementation Switch-Toolbox ships, but they were
 * *checked* rather than trusted, and the check is the reason to believe them: for every
 * font in the dump, exactly one of the three candidate keys yields both a valid sfnt tag
 * (`OTTO`, `0x00010000`, `true` or `ttcf`) **and** a declared length equal to the file
 * length minus eight. Two independent invariants agreeing on the same key, across files
 * of every size, is not a coincidence — and `decode` re-checks both, so a font this build
 * cannot make sense of is reported rather than handed on as noise.
 */

/**
 * Magic to XOR key.
 *
 * The wrapper is inconsistent about byte order and the files are the authority: the magic
 * resolves under a *little-endian* read of the first four bytes — `d9 9b 87 1a` on disk is
 * the 0x1a879bd9 other tools quote — while the payload words are XORed **big-endian**.
 * Reading the magic big-endian and everything else big-endian looks tidier and finds no
 * key at all.
 *
 * Only the first entry occurs in this dump, and it is verified there. The other two carry
 * over from the reference implementation under the same convention, which is the best
 * evidence available for magics there is nothing here to check against.
 */
const KEYS = new Map<number, number>([
  [0x1a879bd9, 2785117442],
  [0x1e1af836, 1231165446],
  [0xc1de68f3, 2364726489]
])

/** The magic, little-endian; see KEYS for why this one field disagrees with the rest. */
function readMagic(data: Uint8Array): number {
  return (
    (((data[3] ?? 0) << 24) | ((data[2] ?? 0) << 16) | ((data[1] ?? 0) << 8) | (data[0] ?? 0)) >>> 0
  )
}

export type SfntKind = 'otf' | 'ttf' | 'ttc'

export interface DecodedFont {
  /** The plain sfnt bytes, ready to hand to a FontFace or write to disk. */
  readonly sfnt: Uint8Array
  readonly kind: SfntKind
}

/** Recognises the wrapper by magic alone, cheap enough for a sniffing pass. */
export function isBfttf(data: Uint8Array): boolean {
  if (data.length < 8) return false
  return KEYS.has(readMagic(data))
}

/**
 * The sfnt tag every recognised font starts with.
 *
 * `ttcf` is a collection rather than a single face. Nothing in this dump uses one, but
 * accepting it costs nothing and rejecting it would look like corruption.
 */
function sfntKind(tag: number): SfntKind | null {
  switch (tag) {
    case 0x4f54544f: // 'OTTO' — OpenType with CFF outlines
      return 'otf'
    case 0x00010000: // TrueType outlines
    case 0x74727565: // 'true'
      return 'ttf'
    case 0x74746366: // 'ttcf' — a collection
      return 'ttc'
    default:
      return null
  }
}

export function decodeBfttf(data: Uint8Array): DecodedFont {
  if (data.length < 12) {
    throw new FormatParseError({
      format: 'bfttf',
      offset: 0,
      message: `a font wrapper needs at least 12 bytes, and this has ${data.length}`
    })
  }

  const magic = readMagic(data)
  const key = KEYS.get(magic)
  if (key === undefined) {
    throw new FormatParseError({
      format: 'bfttf',
      offset: 0,
      message: `unrecognised font wrapper magic 0x${magic.toString(16).padStart(8, '0')}`
    })
  }

  /*
   * The declared length is checked, not just read. It is the second of the two
   * invariants that identify the key, so a mismatch means the file is damaged or the
   * scheme differs — either way, guessing past it would produce a font that renders as
   * garbage with no indication why.
   */
  const declared = (readU32(data, 4) ^ key) >>> 0
  const payload = data.length - 8
  if (declared !== payload) {
    throw new FormatParseError({
      format: 'bfttf',
      offset: 4,
      message: `the wrapper declares ${declared} bytes of font but carries ${payload}`
    })
  }

  const sfnt = new Uint8Array(payload)
  /*
   * Whole u32 words, big-endian, and the trailing partial word handled by writing only
   * the bytes that exist. Nothing in the dump is unaligned — every declared length is a
   * multiple of four — but a byte-wise tail is one line and removes a way to truncate a
   * font silently.
   */
  for (let at = 8; at < data.length; at += 4) {
    const word = (readU32(data, at) ^ key) >>> 0
    const out = at - 8
    for (let byte = 0; byte < 4 && out + byte < payload; byte++) {
      sfnt[out + byte] = (word >>> (24 - byte * 8)) & 0xff
    }
  }

  const kind = sfntKind(readU32(sfnt, 0))
  if (!kind) {
    throw new FormatParseError({
      format: 'bfttf',
      offset: 8,
      message: 'the decoded bytes do not begin with a TrueType or OpenType signature'
    })
  }

  return { sfnt, kind }
}

/**
 * Big-endian u32, tolerating a short tail by treating missing bytes as zero.
 *
 * A DataView would throw on the last partial word of an unaligned file, which is a worse
 * outcome than decoding the bytes that are there.
 */
function readU32(data: Uint8Array, at: number): number {
  return (
    (((data[at] ?? 0) << 24) |
      ((data[at + 1] ?? 0) << 16) |
      ((data[at + 2] ?? 0) << 8) |
      (data[at + 3] ?? 0)) >>>
    0
  )
}
