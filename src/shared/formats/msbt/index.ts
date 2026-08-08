import { BinaryReader } from '../../binary/reader'
import { FormatParseError } from '../../binary/errors'

/**
 * MSBT — the message tables that hold every string a game shows.
 *
 * 3,406 of them in one title, 61 MB of text, and until now they were unreadable here. Read-only:
 * these are the most-translated files in a game and editing them is a different project, but
 * *seeing* them is most of what anyone wants from a message table.
 *
 * The layout, verified against real files rather than taken from documentation:
 *
 *   0x00  char[8]  "MsgStdBn"
 *   0x08  u16      byte-order mark — 0xFFFE little-endian, as with BFLYT
 *   0x0c  u8       encoding: 0 = UTF-8, 1 = UTF-16
 *   0x0d  u8       version
 *   0x0e  u16      section count
 *   0x12  u32      file size
 *   0x20           sections, each: char[4] signature, u32 size, 8 bytes padding, then body
 *
 * Three sections matter. `LBL1` maps names to string indices through a hash table, `TXT2` holds
 * the strings themselves, and `ATR1` carries per-string attributes this build does not interpret.
 * Anything else is skipped by its declared size, which is what lets a file with sections this
 * build has never seen still yield its text.
 */

export interface MsbtMessage {
  /** Label from `LBL1`, or `` when this string has none. */
  readonly label: string
  /** Index into `TXT2`, which is what a label actually points at. */
  readonly index: number
  /**
   * The string, with control sequences rendered as `{n:...}` placeholders.
   *
   * Game text is full of inline commands — colour changes, button glyphs, variable
   * substitutions — encoded as escape sequences rather than characters. Dropping them would
   * misrepresent the string's length and hide that a variable is being interpolated; rendering
   * them as visible placeholders keeps the text honest without pretending to know what each one
   * means.
   */
  readonly text: string
}

export interface MsbtDocument {
  readonly littleEndian: boolean
  readonly encoding: 'utf-8' | 'utf-16'
  readonly version: number
  readonly messages: MsbtMessage[]
  /** Section signatures in file order, including any this build does not read. */
  readonly sections: string[]
}

const MAGIC = 'MsgStdBn'

export function isMsbt(data: Uint8Array): boolean {
  if (data.length < 0x20) return false
  for (let at = 0; at < MAGIC.length; at++) {
    if (data[at] !== MAGIC.charCodeAt(at)) return false
  }
  return true
}

export function parseMsbt(data: Uint8Array): MsbtDocument {
  if (!isMsbt(data)) {
    throw new FormatParseError({ format: 'msbt', offset: 0, message: 'missing MsgStdBn signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: false })
  reader.skip(8)
  const bom = reader.u16be()
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'msbt',
      offset: 8,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  reader.littleEndian = bom === 0xfffe

  reader.skip(2)
  const encodingByte = reader.u8()
  const version = reader.u8()
  const sectionCount = reader.u16()
  reader.skip(2)
  const fileSize = reader.u32()

  if (fileSize > data.length) {
    throw new FormatParseError({
      format: 'msbt',
      offset: 0x12,
      message: `header claims ${fileSize} bytes but only ${data.length} are present`
    })
  }

  const encoding = encodingByte === 0 ? 'utf-8' : 'utf-16'
  const sections: string[] = []
  /** Label to string index, from LBL1. */
  const labels = new Map<number, string>()
  let texts: string[] = []

  reader.seek(0x20)
  for (let index = 0; index < sectionCount; index++) {
    if (reader.tell() + 8 > data.length) break
    const start = reader.tell()
    const signature = reader.fixedString(4)
    const size = reader.u32()
    if (size > data.length - start) {
      throw new FormatParseError({
        format: 'msbt',
        offset: start,
        section: signature,
        message: `section ${signature} declares ${size} bytes, which runs past the end of the file`
      })
    }
    sections.push(signature)

    // 8 bytes of padding sit between every section header and its body.
    const body = start + 16
    if (signature === 'LBL1') readLabels(reader, body, start + 16 + size, labels)
    else if (signature === 'TXT2') texts = readTexts(reader, body, start + 16 + size, encoding)

    /*
     * Sections are padded to 16 bytes. Following the declared size and then aligning is what lets
     * a file containing sections this build has never seen still yield its text, rather than
     * failing on the first unknown signature.
     */
    reader.seek(align16(body + size))
  }

  const messages: MsbtMessage[] = texts.map((text, index) => ({
    label: labels.get(index) ?? '',
    index,
    text
  }))

  // A label pointing past the end of TXT2 is a real possibility in a damaged file; it is reported
  // as a message with no text rather than dropped, so the count still matches the label table.
  for (const [index, label] of labels) {
    if (index >= texts.length) messages.push({ label, index, text: '' })
  }

  messages.sort((a, b) => a.index - b.index)
  return { littleEndian: reader.littleEndian, encoding, version, messages, sections }
}

/**
 * `LBL1`: a hash table of names, each carrying the `TXT2` index it refers to.
 *
 * u32 group count, then that many (count, offset) pairs, then the entries each group points at:
 * a length-prefixed name followed by its index. Offsets are relative to the section body.
 */
function readLabels(
  reader: BinaryReader,
  body: number,
  end: number,
  into: Map<number, string>
): void {
  reader.seek(body)
  const groupCount = reader.u32()
  // A group count that cannot fit its own table means the section is not what it claims.
  if (body + 4 + groupCount * 8 > end) return

  const groups: { count: number; offset: number }[] = []
  for (let index = 0; index < groupCount; index++) {
    groups.push({ count: reader.u32(), offset: reader.u32() })
  }

  for (const group of groups) {
    let at = body + group.offset
    for (let index = 0; index < group.count; index++) {
      if (at + 1 > end) return
      const length = reader.at(at, () => reader.u8())
      if (at + 1 + length + 4 > end) return
      const name = reader.at(at + 1, () => reader.fixedString(length))
      const target = reader.at(at + 1 + length, () => reader.u32())
      into.set(target, name)
      at += 1 + length + 4
    }
  }
}

/**
 * `TXT2`: u32 count, then that many offsets relative to the section body, then the strings.
 *
 * Each string runs to the next offset, or to the end of the section for the last one — there is
 * no length, so the offsets are the only delimiter.
 */
function readTexts(
  reader: BinaryReader,
  body: number,
  end: number,
  encoding: 'utf-8' | 'utf-16'
): string[] {
  reader.seek(body)
  const count = reader.u32()
  if (body + 4 + count * 4 > end) return []

  const offsets: number[] = []
  for (let index = 0; index < count; index++) offsets.push(reader.u32())

  const texts: string[] = []
  for (let index = 0; index < count; index++) {
    const from = body + offsets[index]!
    const to = index + 1 < count ? body + offsets[index + 1]! : end
    if (from > end || to > end || to < from) {
      texts.push('')
      continue
    }
    texts.push(decodeText(reader.bytesAt(from, to - from), encoding, reader.littleEndian))
  }
  return texts
}

/**
 * Decodes one string, turning control sequences into visible placeholders.
 *
 * Game text is full of inline commands — colour, button glyphs, variable substitution — encoded
 * as `0x0E` followed by group, type and a length-prefixed payload (`0x0F` closes a region). They
 * are not characters, so decoding them as text produces garbage, and dropping them silently
 * misrepresents the string. `{n:group.type}` says one is there without pretending to know what it
 * does.
 */
function decodeText(
  bytes: Uint8Array,
  encoding: 'utf-8' | 'utf-16',
  littleEndian: boolean
): string {
  if (encoding === 'utf-8') return decodeUtf8(bytes)

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const units: number[] = []
  let at = 0
  while (at + 2 <= bytes.length) {
    const unit = view.getUint16(at, littleEndian)
    at += 2

    if (unit === 0) break
    if (unit !== 0x0e && unit !== 0x0f) {
      units.push(unit)
      continue
    }

    if (unit === 0x0f) {
      // A region close carries a group and a type and no payload.
      if (at + 4 > bytes.length) break
      at += 4
      pushPlaceholder(units, 'end')
      continue
    }

    if (at + 6 > bytes.length) break
    const group = view.getUint16(at, littleEndian)
    const type = view.getUint16(at + 2, littleEndian)
    const payload = view.getUint16(at + 4, littleEndian)
    at += 6 + payload
    pushPlaceholder(units, `${group}.${type}`)
  }

  return String.fromCharCode(...units)
}

function pushPlaceholder(units: number[], label: string): void {
  for (const character of `{n:${label}}`) units.push(character.charCodeAt(0))
}

function align16(value: number): number {
  return (value + 15) & ~15
}

/**
 * UTF-8 by hand, because `shared` has no DOM.
 *
 * The purity gate (`tsconfig.shared.json`, `types: []`) is what lets these codecs run unchanged in
 * the renderer, in main and in tests, so `TextDecoder` is not available here. Every MSBT in the
 * dump is UTF-16, so this is the rare path — but a rare path that throws is worse than one that is
 * fifteen lines long.
 *
 * Malformed sequences become U+FFFD rather than throwing: a message table is worth reading even
 * when one string in it is damaged.
 */
function decodeUtf8(bytes: Uint8Array): string {
  const units: number[] = []
  let at = 0
  while (at < bytes.length) {
    const first = bytes[at]!
    if (first === 0) break

    let codePoint: number
    let length: number
    if (first < 0x80) {
      codePoint = first
      length = 1
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f
      length = 2
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f
      length = 3
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07
      length = 4
    } else {
      units.push(0xfffd)
      at++
      continue
    }

    if (at + length > bytes.length) {
      units.push(0xfffd)
      break
    }

    let valid = true
    for (let index = 1; index < length; index++) {
      const next = bytes[at + index]!
      if ((next & 0xc0) !== 0x80) {
        valid = false
        break
      }
      codePoint = (codePoint << 6) | (next & 0x3f)
    }
    at += length
    if (!valid || codePoint > 0x10ffff) {
      units.push(0xfffd)
      continue
    }

    // Surrogate pair for anything outside the basic plane.
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000
      units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
    } else {
      units.push(codePoint)
    }
  }
  return String.fromCharCode(...units)
}
