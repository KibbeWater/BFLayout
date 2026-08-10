import { BinaryReader } from '../../binary/reader'
import { BinaryWriter } from '../../binary/writer'
import { FormatParseError, FormatWriteError } from '../../binary/errors'

/**
 * MSBT — the message tables that hold every string a game shows.
 *
 * 3,406 of them in one title, 61 MB of text. Readable and writable: text is the most-edited
 * thing in modding, and a table that could be read but not changed left translations,
 * renames and every joke rewrite outside the tool.
 *
 * Writing is only safe because of `MsbtRun`. A message is not a string — it is text with
 * inline commands threaded through it, each carrying an opaque payload — and a writer working
 * from the `{n:1.4}` placeholders alone would emit eight literal characters where a variable
 * substitution used to be. See `editing.ts` for how an edited string is merged back.
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

/**
 * One piece of a message: literal text, or an inline command.
 *
 * The placeholder rendering in `text` is for reading. This is for *writing*: a
 * command carries a payload — the colour, the variable id, the button glyph — and
 * a writer that only had the placeholder would re-emit `{n:1.4}` as eight literal
 * characters and destroy the string. Editing a message table without this is not
 * editing, it is corruption with a preview.
 */
export type MsbtRun =
  | { readonly kind: 'text'; readonly value: string }
  /** `0x0E`: group, type, and an opaque payload kept byte for byte. */
  | {
      readonly kind: 'command'
      readonly group: number
      readonly type: number
      readonly payload: readonly number[]
    }
  /** `0x0F`: closes a region opened by a command. Carries a group and type, no payload. */
  | { readonly kind: 'end'; readonly group: number; readonly type: number }

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
  /**
   * The same string, losslessly. `text` is derived from this; this is what the
   * writer emits.
   */
  readonly runs: readonly MsbtRun[]
}

/**
 * A section this build does not model, kept verbatim so writing cannot lose it.
 *
 * `ATR1`, `ATO1` and `TSY1` all fall here. They are per-string data whose meaning
 * is game-specific; re-emitting the bytes is exact, and inventing a model for them
 * would be guessing with someone's translation.
 */
export interface MsbtRawSection {
  readonly signature: string
  readonly data: readonly number[]
}

export interface MsbtDocument {
  readonly littleEndian: boolean
  readonly encoding: 'utf-8' | 'utf-16'
  readonly version: number
  readonly messages: MsbtMessage[]
  /** Section signatures in file order, including any this build does not read. */
  readonly sections: string[]
  /**
   * How many hash buckets `LBL1` used. Preserved rather than chosen, because the
   * bucket a label lands in is `hash % groupCount` — pick a different count and
   * every label moves, and an untouched file stops rewriting byte for byte.
   */
  readonly labelGroupCount: number
  /** Everything except LBL1 and TXT2, in file order, byte for byte. */
  readonly rawSections: readonly MsbtRawSection[]
}

const MAGIC = 'MsgStdBn'

/**
 * Buckets used when a file's own count could not be read.
 *
 * Every MSBT in this dump uses 101, which is the value every implementation of
 * this format seems to have settled on. It only matters for a file being written
 * from nothing — a file that was parsed carries its own count forward.
 */
const DEFAULT_LABEL_GROUPS = 101

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
  const rawSections: MsbtRawSection[] = []
  /** Label to string index, from LBL1. */
  const labels = new Map<number, string>()
  let runs: MsbtRun[][] = []
  let labelGroupCount = DEFAULT_LABEL_GROUPS

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
    if (signature === 'LBL1') {
      labelGroupCount = readLabels(reader, body, start + 16 + size, labels)
    } else if (signature === 'TXT2') {
      runs = readTexts(reader, body, start + 16 + size, encoding)
    } else {
      /*
       * Kept whole. These sections carry per-string data whose meaning is
       * game-specific, and a writer that dropped them would silently discard
       * attributes attached to someone's text. Replaying the bytes is exact;
       * modelling them would be guessing.
       */
      rawSections.push({ signature, data: [...reader.bytesAt(body, size)] })
    }

    /*
     * Sections are padded to 16 bytes. Following the declared size and then aligning is what lets
     * a file containing sections this build has never seen still yield its text, rather than
     * failing on the first unknown signature.
     */
    reader.seek(align16(body + size))
  }

  const messages: MsbtMessage[] = runs.map((value, index) => ({
    label: labels.get(index) ?? '',
    index,
    text: renderRuns(value),
    runs: value
  }))

  // A label pointing past the end of TXT2 is a real possibility in a damaged file; it is reported
  // as a message with no text rather than dropped, so the count still matches the label table.
  for (const [index, label] of labels) {
    if (index >= runs.length) messages.push({ label, index, text: '', runs: [] })
  }

  messages.sort((a, b) => a.index - b.index)
  return {
    littleEndian: reader.littleEndian,
    encoding,
    version,
    messages,
    sections,
    labelGroupCount,
    rawSections
  }
}

/** The placeholder view of a message, which is what `text` holds. */
export function renderRuns(runs: readonly MsbtRun[]): string {
  let out = ''
  for (const run of runs) {
    if (run.kind === 'text') out += run.value
    else if (run.kind === 'end') out += '{n:end}'
    else out += `{n:${run.group}.${run.type}}`
  }
  return out
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
): number {
  reader.seek(body)
  const groupCount = reader.u32()
  // A group count that cannot fit its own table means the section is not what it claims.
  if (body + 4 + groupCount * 8 > end) return DEFAULT_LABEL_GROUPS

  const groups: { count: number; offset: number }[] = []
  for (let index = 0; index < groupCount; index++) {
    groups.push({ count: reader.u32(), offset: reader.u32() })
  }

  for (const group of groups) {
    let at = body + group.offset
    for (let index = 0; index < group.count; index++) {
      if (at + 1 > end) return groupCount
      const length = reader.at(at, () => reader.u8())
      if (at + 1 + length + 4 > end) return groupCount
      const name = reader.at(at + 1, () => reader.fixedString(length))
      const target = reader.at(at + 1 + length, () => reader.u32())
      into.set(target, name)
      at += 1 + length + 4
    }
  }
  return groupCount
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
): MsbtRun[][] {
  reader.seek(body)
  const count = reader.u32()
  if (body + 4 + count * 4 > end) return []

  const offsets: number[] = []
  for (let index = 0; index < count; index++) offsets.push(reader.u32())

  const texts: MsbtRun[][] = []
  for (let index = 0; index < count; index++) {
    const from = body + offsets[index]!
    const to = index + 1 < count ? body + offsets[index + 1]! : end
    if (from > end || to > end || to < from) {
      texts.push([])
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
): MsbtRun[] {
  if (encoding === 'utf-8') {
    const decoded = decodeUtf8(bytes)
    return decoded === '' ? [] : [{ kind: 'text', value: decoded }]
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const runs: MsbtRun[] = []
  let units: number[] = []

  const flush = (): void => {
    if (units.length === 0) return
    runs.push({ kind: 'text', value: String.fromCharCode(...units) })
    units = []
  }

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
      const group = view.getUint16(at, littleEndian)
      const type = view.getUint16(at + 2, littleEndian)
      at += 4
      flush()
      runs.push({ kind: 'end', group, type })
      continue
    }

    if (at + 6 > bytes.length) break
    const group = view.getUint16(at, littleEndian)
    const type = view.getUint16(at + 2, littleEndian)
    const payloadSize = view.getUint16(at + 4, littleEndian)
    at += 6
    // The payload is opaque and kept byte for byte: it is the colour, the variable
    // id, the glyph. Re-emitting it exactly is the whole reason writing is safe.
    const payload = [...bytes.subarray(at, Math.min(at + payloadSize, bytes.length))]
    at += payloadSize
    flush()
    runs.push({ kind: 'command', group, type, payload })
  }

  flush()
  return runs
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

/**
 * The label hash MSBT buckets names by.
 *
 * `(hash * 0x492 + byte) mod 2^32`, then modulo the group count. Reproducing it is
 * what lets a rewritten file put every label back in the bucket it came from — get
 * it wrong and the file is still valid, still loads, and every label has moved,
 * which is indistinguishable from a corrupt diff.
 */
export function msbtLabelHash(label: string, groupCount: number): number {
  let hash = 0
  for (let at = 0; at < label.length; at++) {
    hash = (Math.imul(hash, 0x492) + label.charCodeAt(at)) >>> 0
  }
  return hash % groupCount
}

/**
 * Writes a message table back out.
 *
 * Sections are re-emitted in the order the file had them, and everything this
 * build does not model goes back byte for byte. The two it does model — `LBL1` and
 * `TXT2` — are rebuilt, which is unavoidable: changing a string changes every
 * offset after it.
 *
 * Text is the reason this is safe to expose at all. Every inline command keeps its
 * payload (see `MsbtRun`), so a message that was not edited re-encodes to exactly
 * the bytes it came from, and one that was edited keeps its colours, its glyphs and
 * its variable substitutions.
 */
export function writeMsbt(document: MsbtDocument): Uint8Array {
  const writer = new BinaryWriter({ littleEndian: document.littleEndian })

  writer.magic(MAGIC)
  writer.u16be(document.littleEndian ? 0xfffe : 0xfeff)
  writer.u16(0)
  writer.u8(document.encoding === 'utf-8' ? 0 : 1)
  writer.u8(document.version)
  writer.u16(document.sections.length)
  writer.u16(0)
  const fileSize = writer.defer('u32')
  writer.zeros(10)

  if (writer.tell() !== 0x20) {
    throw new FormatWriteError({
      format: 'msbt',
      message: `header ended at 0x${writer.tell().toString(16)} rather than 0x20`
    })
  }

  const raw = new Map(document.rawSections.map((section) => [section.signature, section]))
  const ordered = document.messages.slice().sort((a, b) => a.index - b.index)

  for (const signature of document.sections) {
    if (signature === 'LBL1') writeSection(writer, 'LBL1', () => writeLabels(writer, document))
    else if (signature === 'TXT2') {
      writeSection(writer, 'TXT2', () => writeTexts(writer, ordered, document))
    } else {
      const section = raw.get(signature)
      if (!section) {
        throw new FormatWriteError({
          format: 'msbt',
          section: signature,
          message: `section ${signature} is listed in the file's own order but its bytes were not preserved`
        })
      }
      writeSection(writer, signature, () => writer.bytes(Uint8Array.from(section.data)))
    }
  }

  fileSize.set(writer.length)
  return writer.toBytes()
}

/** Signature, size, eight bytes of padding, body, then padding to 16. */
function writeSection(writer: BinaryWriter, signature: string, body: () => void): void {
  writer.magic(signature)
  const size = writer.defer('u32')
  writer.zeros(8)
  const start = writer.length
  body()
  size.set(writer.length - start)

  // Padding is 0xAB rather than zero, which is what the real files use. It is
  // cosmetic to the game and load-bearing for a byte-exact rewrite.
  while (writer.length % 16 !== 0) writer.u8(0xab)
}

function writeLabels(writer: BinaryWriter, document: MsbtDocument): void {
  const groupCount = document.labelGroupCount > 0 ? document.labelGroupCount : DEFAULT_LABEL_GROUPS
  const buckets: { label: string; index: number }[][] = Array.from(
    { length: groupCount },
    () => []
  )
  for (const message of document.messages) {
    if (message.label === '') continue
    buckets[msbtLabelHash(message.label, groupCount)]!.push({
      label: message.label,
      index: message.index
    })
  }

  writer.u32(groupCount)
  // Offsets are relative to the section body, which starts at the group count.
  let cursor = 4 + groupCount * 8
  const offsets: number[] = []
  for (const bucket of buckets) {
    offsets.push(cursor)
    for (const entry of bucket) cursor += 1 + entry.label.length + 4
  }
  for (let at = 0; at < groupCount; at++) {
    writer.u32(buckets[at]!.length)
    writer.u32(offsets[at]!)
  }
  for (const bucket of buckets) {
    for (const entry of bucket) {
      writer.u8(entry.label.length)
      writer.fixedString(entry.label, entry.label.length)
      writer.u32(entry.index)
    }
  }
}

function writeTexts(
  writer: BinaryWriter,
  messages: readonly MsbtMessage[],
  document: MsbtDocument
): void {
  const encoded = messages.map((message) => encodeRuns(message.runs, document))

  writer.u32(encoded.length)
  let cursor = 4 + encoded.length * 4
  for (const bytes of encoded) {
    writer.u32(cursor)
    cursor += bytes.length
  }
  for (const bytes of encoded) writer.bytes(bytes)
}

/**
 * One message back to bytes, commands and all.
 *
 * Strings are null-terminated in the file, and the terminator is part of the
 * string's extent rather than padding: `TXT2` delimits strings by the *next*
 * offset, so a missing terminator merges two messages into one.
 */
function encodeRuns(runs: readonly MsbtRun[], document: MsbtDocument): Uint8Array {
  const writer = new BinaryWriter({ littleEndian: document.littleEndian })

  if (document.encoding === 'utf-8') {
    for (const run of runs) {
      if (run.kind === 'text') writer.bytes(encodeUtf8(run.value))
      // UTF-8 tables in this dump carry no inline commands; a file that did would
      // have been parsed as a single text run, so there is nothing to re-emit here.
    }
    writer.u8(0)
    return writer.toBytes()
  }

  for (const run of runs) {
    if (run.kind === 'text') {
      for (let at = 0; at < run.value.length; at++) writer.u16(run.value.charCodeAt(at))
      continue
    }
    if (run.kind === 'end') {
      writer.u16(0x0f)
      writer.u16(run.group)
      writer.u16(run.type)
      continue
    }
    writer.u16(0x0e)
    writer.u16(run.group)
    writer.u16(run.type)
    writer.u16(run.payload.length)
    writer.bytes(Uint8Array.from(run.payload))
  }
  writer.u16(0)
  return writer.toBytes()
}

/**
 * UTF-8 by hand, for the same reason the decoder is: `shared` has no DOM, which is
 * what lets these codecs run unchanged in main, the renderer and tests.
 */
function encodeUtf8(value: string): Uint8Array {
  const out: number[] = []
  for (let at = 0; at < value.length; at++) {
    let code = value.charCodeAt(at)
    // Recombine a surrogate pair into the code point it stands for.
    if (code >= 0xd800 && code <= 0xdbff && at + 1 < value.length) {
      const low = value.charCodeAt(at + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        at++
      }
    }

    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return Uint8Array.from(out)
}
