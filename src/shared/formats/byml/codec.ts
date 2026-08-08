import { BinaryReader } from '@shared/binary/reader'
import { FormatParseError, UnsupportedFormatError } from '@shared/binary/errors'
import {
  BymlNodeType,
  type BymlDocument,
  type BymlHashEntry,
  type BymlMapEntry,
  type BymlNode
} from './types'

/**
 * BYML reader.
 *
 * The header is 16 bytes: a two-byte magic that doubles as the byte-order mark, a
 * version, then offsets to the hash-key table, the string table and the root
 * node. Either table offset may be zero, meaning the document uses no keys or no
 * strings.
 *
 * Both tables are 0xc2 string tables: a count, `count + 1` offsets relative to the
 * table start, then NUL-terminated strings. The extra offset is the end of the
 * last string, which is what makes the lengths recoverable.
 */

/** "BY" read as a big-endian u16; the same bytes reversed are little-endian. */
const MAGIC = 0x4259

const HEADER_SIZE = 16

/** Versions seen in the wild. 1 predates the Switch; 7 is the current one. */
const MIN_VERSION = 1
const MAX_VERSION = 7

export function isByml(data: Uint8Array): boolean {
  if (data.length < HEADER_SIZE) return false
  const first = (data[0]! << 8) | data[1]!
  const swapped = (data[1]! << 8) | data[0]!
  if (first !== MAGIC && swapped !== MAGIC) return false

  // The version guards against colliding with other formats that open "BY"/"YB":
  // a real BYML version is small, and the field is two bytes.
  const littleEndian = swapped === MAGIC
  const version = littleEndian ? data[2]! | (data[3]! << 8) : (data[2]! << 8) | data[3]!
  return version >= MIN_VERSION && version <= MAX_VERSION
}

interface ParseContext {
  readonly reader: BinaryReader
  readonly hashKeys: readonly string[]
  readonly strings: readonly string[]
  readonly version: number
  /**
   * Guards against a malformed file whose container offsets form a cycle, which
   * would otherwise recurse until the stack gave out.
   */
  readonly visiting: Set<number>
  depth: number
  /**
   * Nodes produced so far, against a hard ceiling.
   *
   * `visiting` only catches cycles — it releases each offset on the way back out, so
   * a *shared* subtree is legitimately re-parsed once per reference. That makes the
   * tree a DAG, and a 400-byte file with 24 levels of two references each expands
   * toward 2^24 nodes. This runs in the main process, so without a budget one
   * malformed document in a browsed dump takes the whole app down with it.
   */
  nodes: number
}

/** Deep enough for any real document; a cycle or corruption hits this instead. */
const MAX_DEPTH = 128

/**
 * Ceiling on total nodes. The largest document this game ships is 19,369, so this
 * is two orders of magnitude of headroom while still bounding a crafted DAG.
 */
const MAX_NODES = 2_000_000

export function parseByml(data: Uint8Array): BymlDocument {
  if (data.length < HEADER_SIZE) {
    throw new FormatParseError({
      format: 'byml',
      offset: 0,
      message: `a BYML file needs at least ${HEADER_SIZE} bytes but this one has ${data.length}`
    })
  }

  const asBigEndian = (data[0]! << 8) | data[1]!
  const asLittleEndian = (data[1]! << 8) | data[0]!
  if (asBigEndian !== MAGIC && asLittleEndian !== MAGIC) {
    throw new UnsupportedFormatError({
      detected: `0x${asBigEndian.toString(16).padStart(4, '0')}`,
      message: 'not a BYML file: the magic is neither "BY" nor "YB"'
    })
  }

  const littleEndian = asLittleEndian === MAGIC
  const reader = new BinaryReader(data, { littleEndian })
  reader.skip(2)

  const version = reader.u16()
  if (version < MIN_VERSION || version > MAX_VERSION) {
    throw new UnsupportedFormatError({
      detected: `byml v${version}`,
      message: `BYML version ${version} is outside the ${MIN_VERSION}-${MAX_VERSION} range this build understands`
    })
  }

  const hashKeyTableOffset = reader.u32()
  const stringTableOffset = reader.u32()
  const rootOffset = reader.u32()

  const hashKeys = readStringTable(reader, hashKeyTableOffset, 'hash key table')
  const strings = readStringTable(reader, stringTableOffset, 'string table')

  // A zero root offset is a legal empty document, not an error.
  if (rootOffset === 0) {
    return { version, littleEndian, root: null }
  }

  const context: ParseContext = {
    reader,
    hashKeys,
    strings,
    version,
    visiting: new Set(),
    depth: 0,
    nodes: 0
  }

  return { version, littleEndian, root: readContainerAt(context, rootOffset) }
}

/**
 * Reads a 0xc2 string table, or returns empty when the offset is zero.
 *
 * Strings are read by span rather than by scanning for a NUL: the trailing offset
 * gives each string's end, and trusting it means a table whose last string is
 * unterminated still reads correctly rather than running off the end.
 */
function readStringTable(reader: BinaryReader, offset: number, label: string): string[] {
  if (offset === 0) return []

  if (offset + 4 > reader.length) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      section: label,
      message: `${label} starts past the end of the file`
    })
  }

  reader.seek(offset)
  const { type, count } = splitContainerHeader(reader.u32(), reader.littleEndian)

  if (type !== BymlNodeType.StringTable) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      section: label,
      message: `${label} should be a 0xc2 string table but starts with 0x${type.toString(16)}`
    })
  }

  const offsetsEnd = offset + 4 + (count + 1) * 4
  if (offsetsEnd > reader.length) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      section: label,
      message: `${label} claims ${count} entries, which do not fit in the file`
    })
  }

  const offsets: number[] = []
  for (let i = 0; i <= count; i++) offsets.push(reader.u32())

  const strings: string[] = []
  for (let i = 0; i < count; i++) {
    const start = offset + offsets[i]!
    const end = offset + offsets[i + 1]!
    if (start > end || end > reader.length) {
      throw new FormatParseError({
        format: 'byml',
        offset: start,
        section: label,
        message: `${label} entry ${i} spans [${start}, ${end}), which is not inside the file`
      })
    }
    strings.push(decodeUtf8(reader.bytesAt(start, end - start)))
  }

  return strings
}

/**
 * UTF-8 decode, hand-rolled because `shared` has neither Node's Buffer nor the
 * DOM's TextDecoder. Strings are trimmed at the first NUL: the table stores each
 * entry NUL-terminated, so the terminator is inside the span.
 */
function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i]!
    if (byte === 0) break

    if (byte < 0x80) {
      out += String.fromCharCode(byte)
      i += 1
      continue
    }

    let codePoint: number
    let width: number
    if (byte >= 0xf0) {
      codePoint = byte & 0x07
      width = 4
    } else if (byte >= 0xe0) {
      codePoint = byte & 0x0f
      width = 3
    } else {
      codePoint = byte & 0x1f
      width = 2
    }

    // A truncated sequence is replaced rather than thrown on: a viewer showing
    // U+FFFD is more use than a whole file failing to open.
    if (i + width > bytes.length) {
      out += '�'
      break
    }

    let valid = true
    for (let k = 1; k < width; k++) {
      const continuation = bytes[i + k]!
      if ((continuation & 0xc0) !== 0x80) {
        valid = false
        break
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f)
    }

    if (!valid) {
      out += '�'
      i += 1
      continue
    }

    // Over-long and out-of-range sequences decode above U+10FFFF, which
    // String.fromCodePoint rejects with a RangeError — an untyped throw escaping the
    // codec's declared error surface. Replace them like any other bad sequence.
    out += codePoint > 0x10ffff ? '\ufffd' : String.fromCodePoint(codePoint)
    i += width
  }
  return out
}

/** Reads the container (array or map) that starts at `offset`. */
function readContainerAt(context: ParseContext, offset: number): BymlNode {
  const { reader } = context

  if (offset + 4 > reader.length) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: `a container offset points past the end of the file`
    })
  }

  if (context.visiting.has(offset)) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: 'container offsets form a cycle'
    })
  }
  if (context.depth >= MAX_DEPTH) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: `the tree is nested more than ${MAX_DEPTH} deep`
    })
  }
  if (context.nodes > MAX_NODES) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: `the document expands to more than ${MAX_NODES.toLocaleString()} nodes, which is not a document this build will load`
    })
  }

  reader.seek(offset)
  const { type, count } = splitContainerHeader(reader.u32(), reader.littleEndian)

  context.visiting.add(offset)
  context.depth++
  try {
    switch (type) {
      case BymlNodeType.Array:
        return readArray(context, offset, count)
      case BymlNodeType.Map:
        return readMap(context, offset, count)
      case BymlNodeType.HashMap:
        return readHashMap(context, offset, count)
      default:
        throw new FormatParseError({
          format: 'byml',
          offset,
          message: `expected an array (0xc0), map (0xc1) or hash map (0x20) but found 0x${type.toString(16)}`
        })
    }
  } finally {
    context.depth--
    context.visiting.delete(offset)
  }
}

/**
 * Array layout: the header, then one type byte per item, padded to a 4-byte
 * boundary, then one 4-byte value slot per item.
 */
function readArray(context: ParseContext, offset: number, count: number): BymlNode {
  const { reader } = context
  const typesStart = offset + 4
  const valuesStart = typesStart + roundUp(count, 4)

  if (valuesStart + count * 4 > reader.length) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: `an array of ${count} items does not fit in the file`
    })
  }

  const types = reader.bytesAt(typesStart, count)
  const items: BymlNode[] = []
  for (let i = 0; i < count; i++) {
    reader.seek(valuesStart + i * 4)
    items.push(readValue(context, types[i]!, valuesStart + i * 4))
  }

  return { kind: 'array', items }
}

/**
 * Map layout: the header, then `count` eight-byte entries of a 24-bit key index,
 * a type byte and a 4-byte value slot. Entries are stored sorted by key index,
 * which is worth preserving so a writer can reproduce the original order.
 */
function readMap(context: ParseContext, offset: number, count: number): BymlNode {
  const { reader } = context
  const entriesStart = offset + 4

  if (entriesStart + count * 8 > reader.length) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: `a map of ${count} entries does not fit in the file`
    })
  }

  const entries: BymlMapEntry[] = []
  for (let i = 0; i < count; i++) {
    const entryOffset = entriesStart + i * 8
    reader.seek(entryOffset)

    // The key index and type share a u32: three bytes of index then the type.
    const packed = reader.u32()
    const keyIndex = context.reader.littleEndian ? packed & 0x00ffffff : packed >>> 8
    const type = context.reader.littleEndian ? packed >>> 24 : packed & 0xff

    const key = context.hashKeys[keyIndex]
    if (key === undefined) {
      throw new FormatParseError({
        format: 'byml',
        offset: entryOffset,
        message: `map entry ${i} names hash key ${keyIndex}, but the table has ${context.hashKeys.length}`
      })
    }

    entries.push({ key, value: readValue(context, type, entryOffset + 4) })
  }

  return { kind: 'map', entries }
}

/**
 * Hash-map layout (node type 0x20): the header, then `count` pairs of a 32-bit key
 * hash and a 4-byte value slot, then `count` type bytes padded to four.
 *
 * Note the ordering is the opposite of an array, which puts its type bytes first.
 * See the comment on `BymlNodeType.HashMap` for how this was determined.
 */
function readHashMap(context: ParseContext, offset: number, count: number): BymlNode {
  const { reader } = context
  const pairsStart = offset + 4
  const typesStart = pairsStart + count * 8

  if (typesStart + count > reader.length) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: `a hash map of ${count} entries does not fit in the file`
    })
  }

  const types = reader.bytesAt(typesStart, count)
  const entries: BymlHashEntry[] = []
  for (let i = 0; i < count; i++) {
    const pairOffset = pairsStart + i * 8
    reader.seek(pairOffset)
    const hash = reader.u32()
    entries.push({ hash, value: readValue(context, types[i]!, pairOffset + 4) })
  }

  return { kind: 'hashmap', entries }
}

/**
 * Reads one value given its type byte and the address of its 4-byte slot.
 *
 * Container and 64-bit types put an offset in the slot; everything else puts the
 * value there directly.
 */
function readValue(context: ParseContext, type: number, slotOffset: number): BymlNode {
  const { reader } = context
  context.nodes++
  reader.seek(slotOffset)

  switch (type) {
    case BymlNodeType.Null:
      return { kind: 'null' }

    case BymlNodeType.Bool:
      return { kind: 'bool', value: reader.u32() !== 0 }

    case BymlNodeType.Int:
      return { kind: 'int', value: reader.i32() }

    case BymlNodeType.UInt:
      return { kind: 'uint', value: reader.u32() }

    case BymlNodeType.Float:
      return { kind: 'float', value: reader.f32() }

    case BymlNodeType.String: {
      const index = reader.u32()
      const value = context.strings[index]
      if (value === undefined) {
        throw new FormatParseError({
          format: 'byml',
          offset: slotOffset,
          message: `a string node names index ${index}, but the table has ${context.strings.length}`
        })
      }
      return { kind: 'string', value }
    }

    case BymlNodeType.Int64: {
      const at = reader.u32()
      requireRange(context, at, 8, 'a 64-bit integer')
      reader.seek(at)
      return { kind: 'int64', value: reader.i64() }
    }

    case BymlNodeType.UInt64: {
      const at = reader.u32()
      requireRange(context, at, 8, 'a 64-bit integer')
      reader.seek(at)
      return { kind: 'uint64', value: reader.u64() }
    }

    case BymlNodeType.Double: {
      const at = reader.u32()
      requireRange(context, at, 8, 'a double')
      reader.seek(at)
      return { kind: 'double', value: reader.f64() }
    }

    case BymlNodeType.Binary: {
      const at = reader.u32()
      requireRange(context, at, 4, 'a binary node')
      reader.seek(at)
      const size = reader.u32()
      requireRange(context, at + 4, size, 'binary data')
      return { kind: 'binary', data: reader.bytesAt(at + 4, size) }
    }

    case BymlNodeType.File: {
      const at = reader.u32()
      requireRange(context, at, 8, 'a file node')
      reader.seek(at)
      const size = reader.u32()
      const alignment = reader.u32()
      requireRange(context, at + 8, size, 'file data')
      return { kind: 'binary', data: reader.bytesAt(at + 8, size), alignment }
    }

    case BymlNodeType.Array:
    case BymlNodeType.Map:
    case BymlNodeType.HashMap:
      return readContainerAt(context, reader.u32())

    default:
      throw new UnsupportedFormatError({
        detected: `byml node type 0x${type.toString(16)}`,
        message: `unknown BYML node type 0x${type.toString(16)} at offset ${slotOffset}`
      })
  }
}

function requireRange(context: ParseContext, offset: number, length: number, what: string): void {
  if (offset < 0 || offset + length > context.reader.length) {
    throw new FormatParseError({
      format: 'byml',
      offset,
      message: `${what} spans [${offset}, ${offset + length}), which is outside the file`
    })
  }
}

function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}

/**
 * Splits a container header into its type and entry count.
 *
 * The header is a type byte followed by a 24-bit count *in file order*, not a u32
 * with the type in the high bits — so which end the type sits at depends on the
 * byte order. Getting this backwards parses every big-endian file correctly and
 * every little-endian one not at all, which is exactly what happened first time.
 */
function splitContainerHeader(
  packed: number,
  littleEndian: boolean
): { type: number; count: number } {
  return littleEndian
    ? { type: packed & 0xff, count: packed >>> 8 }
    : { type: packed >>> 24, count: packed & 0x00ffffff }
}
