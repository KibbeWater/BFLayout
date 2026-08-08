import { FormatParseError } from '../../binary/errors'

/**
 * BFCPX — a "font complex": the ordered set of typefaces one named font is made of.
 *
 * A layout's `fnl1` list does not name typefaces. It names these, and each one names
 * several `.bfttf`/`.bfotf` faces: the specialised ones first (extended glyphs, gaiji,
 * digits) and the main typeface last. That ordering is a per-glyph fallback chain, and it
 * happens to be exactly the order CSS `font-family` resolves in — so the chain can be
 * handed to a canvas verbatim and the browser does the glyph-by-glyph fallback itself.
 *
 * **Only the name table is modelled**, deliberately. The records ahead of it carry sizes
 * and scale factors laid out at a stride that one game's seven descriptors are not enough
 * to pin down — the values are readable but their meaning is not, and seeking through a
 * structure inferred from seven samples risks reading the wrong field on some other game's
 * file. The names are unambiguous: a contiguous run of NUL-terminated ASCII at the end of
 * the file, in chain order. Taking those and nothing else cannot mis-seek, and the worst a
 * future variation can cost is a fallback face the canvas then does without.
 *
 * Verified against every descriptor in the dump: all seven declare a length equal to their
 * own, all are little-endian version 0x09030000 with a 20-byte header, and each yields a
 * chain that ends in a plausible main typeface (`SeuratCapie`, `RODINNTLG`, `TsukuMin`,
 * `UDKAKUGO`).
 */

export interface FontComplex {
  /**
   * Typeface filenames in fallback order: specialised faces first, main typeface last.
   * Names are as stored — bare filenames with their `.bfttf`/`.bfotf` extension.
   */
  readonly faces: string[]
}

export function isBfcpx(data: Uint8Array): boolean {
  return (
    data.length >= 0x14 &&
    data[0] === 0x46 &&
    data[1] === 0x43 &&
    data[2] === 0x50 &&
    data[3] === 0x58
  )
}

export function parseBfcpx(data: Uint8Array): FontComplex {
  if (!isBfcpx(data)) {
    throw new FormatParseError({ format: 'bfcpx', offset: 0, message: 'missing FCPX signature' })
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const bom = view.getUint16(4, false)
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'bfcpx',
      offset: 4,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  const littleEndian = bom === 0xfffe

  const fileSize = view.getUint32(12, littleEndian)
  if (fileSize > data.length) {
    throw new FormatParseError({
      format: 'bfcpx',
      offset: 12,
      message: `header claims ${fileSize} bytes but only ${data.length} are present`
    })
  }

  return { faces: readFaceNames(data.subarray(0, fileSize || data.length)) }
}

/**
 * Pulls the NUL-terminated face names out, in file order.
 *
 * Scoped to names ending in a font extension so the scan cannot mistake a run of
 * printable bytes elsewhere in the file for a typeface. Duplicates are dropped: a
 * repeated family in a CSS fallback list is harmless but says something is being read
 * twice.
 */
function readFaceNames(data: Uint8Array): string[] {
  const faces: string[] = []
  const seen = new Set<string>()
  let start = -1

  for (let at = 0; at <= data.length; at++) {
    const byte = at < data.length ? data[at]! : 0
    const printable = byte >= 0x20 && byte < 0x7f
    if (printable) {
      if (start < 0) start = at
      continue
    }
    if (start >= 0) {
      const text = String.fromCharCode(...data.subarray(start, at))
      if (/\.bf[ot]tf$/i.test(text) && !seen.has(text)) {
        seen.add(text)
        faces.push(text)
      }
      start = -1
    }
  }

  return faces
}
