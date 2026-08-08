/**
 * Builds BYML files byte by byte, for tests.
 *
 * This is a test helper rather than a writer in `shared`: it lays out the simplest
 * legal file it can (no deduplication, no sorting beyond what the format needs)
 * and is only used to feed the parser known input. The parser's real evidence is
 * the 1812 shipped files that `pnpm validate:byml` reads.
 */
import { BymlNodeType, nodeTypeOf, type BymlNode } from '@shared/formats/byml'

interface Chunk {
  /** Filled in once the chunk is placed. */
  offset: number
  readonly bytes: Uint8Array
  readonly alignment: number
}

class Layout {
  private readonly chunks: Chunk[] = []
  private cursor: number

  constructor(headerSize: number) {
    this.cursor = headerSize
  }

  /** Reserves space for `bytes`, returning the offset it will live at. */
  place(bytes: Uint8Array, alignment = 4): number {
    const offset = Math.ceil(this.cursor / alignment) * alignment
    this.chunks.push({ offset, bytes, alignment })
    this.cursor = offset + bytes.length
    return offset
  }

  get size(): number {
    return this.cursor
  }

  writeInto(out: Uint8Array): void {
    for (const chunk of this.chunks) out.set(chunk.bytes, chunk.offset)
  }
}

function u32(value: number, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value >>> 0, littleEndian)
  return bytes
}

function u16(value: number, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value & 0xffff, littleEndian)
  return bytes
}

/** Header: a type byte then a 24-bit count, in file order. */
function containerHeader(type: number, count: number, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(4)
  if (littleEndian) {
    bytes[0] = type
    bytes[1] = count & 0xff
    bytes[2] = (count >>> 8) & 0xff
    bytes[3] = (count >>> 16) & 0xff
  } else {
    bytes[0] = type
    bytes[1] = (count >>> 16) & 0xff
    bytes[2] = (count >>> 8) & 0xff
    bytes[3] = count & 0xff
  }
  return bytes
}

function encodeUtf8(text: string): Uint8Array {
  const out: number[] = []
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
  }
  return new Uint8Array(out)
}

/** A 0xc2 string table: count, count+1 relative offsets, then the strings. */
function stringTable(strings: readonly string[], littleEndian: boolean): Uint8Array {
  const encoded = strings.map((text) => encodeUtf8(text))
  const headerSize = 4 + (strings.length + 1) * 4
  const offsets: number[] = []
  let cursor = headerSize
  for (const bytes of encoded) {
    offsets.push(cursor)
    cursor += bytes.length + 1
  }
  offsets.push(cursor)

  const total = Math.ceil(cursor / 4) * 4
  const out = new Uint8Array(total)
  out.set(containerHeader(BymlNodeType.StringTable, strings.length, littleEndian), 0)
  offsets.forEach((offset, index) => out.set(u32(offset, littleEndian), 4 + index * 4))
  encoded.forEach((bytes, index) => out.set(bytes, offsets[index]!))
  return out
}

/** Collects every key and string the document needs, in first-seen order. */
function collectTables(root: BymlNode): { keys: string[]; strings: string[] } {
  const keys = new Set<string>()
  const strings = new Set<string>()

  const walk = (node: BymlNode): void => {
    switch (node.kind) {
      case 'string':
        strings.add(node.value)
        break
      case 'array':
        node.items.forEach(walk)
        break
      case 'map':
        for (const entry of node.entries) {
          keys.add(entry.key)
          walk(entry.value)
        }
        break
      case 'hashmap':
        for (const entry of node.entries) walk(entry.value)
        break
      default:
        break
    }
  }
  walk(root)

  // Both tables must be sorted: the format expects binary-searchable keys, and
  // sorting also makes the fixtures deterministic.
  return { keys: [...keys].sort(), strings: [...strings].sort() }
}

export interface BymlFixtureOptions {
  readonly littleEndian?: boolean
  readonly version?: number
}

/**
 * Serialises `root` into a BYML file.
 *
 * Containers are laid out depth-first: a container's children are placed before
 * the container itself so their offsets are known when its slots are written.
 */
export function buildByml(root: BymlNode, options: BymlFixtureOptions = {}): Uint8Array {
  const littleEndian = options.littleEndian ?? true
  const version = options.version ?? 7
  const { keys, strings } = collectTables(root)

  const layout = new Layout(16)
  const keyTableOffset = keys.length > 0 ? layout.place(stringTable(keys, littleEndian)) : 0
  const stringTableOffset =
    strings.length > 0 ? layout.place(stringTable(strings, littleEndian)) : 0

  const keyIndex = new Map(keys.map((key, index) => [key, index]))
  const stringIndex = new Map(strings.map((text, index) => [text, index]))

  /** Writes a node, returning the 4 bytes that go in its parent's value slot. */
  const emit = (node: BymlNode): Uint8Array => {
    switch (node.kind) {
      case 'null':
        return u32(0, littleEndian)
      case 'bool':
        return u32(node.value ? 1 : 0, littleEndian)
      case 'uint':
        return u32(node.value, littleEndian)
      case 'int': {
        const bytes = new Uint8Array(4)
        new DataView(bytes.buffer).setInt32(0, node.value, littleEndian)
        return bytes
      }
      case 'float': {
        const bytes = new Uint8Array(4)
        new DataView(bytes.buffer).setFloat32(0, node.value, littleEndian)
        return bytes
      }
      case 'string':
        return u32(stringIndex.get(node.value)!, littleEndian)

      case 'int64':
      case 'uint64':
      case 'double': {
        const bytes = new Uint8Array(8)
        const view = new DataView(bytes.buffer)
        if (node.kind === 'int64') view.setBigInt64(0, node.value, littleEndian)
        else if (node.kind === 'uint64') view.setBigUint64(0, node.value, littleEndian)
        else view.setFloat64(0, node.value, littleEndian)
        return u32(layout.place(bytes, 8), littleEndian)
      }

      case 'binary': {
        const prefix = node.alignment === undefined ? 4 : 8
        const bytes = new Uint8Array(prefix + node.data.length)
        bytes.set(u32(node.data.length, littleEndian), 0)
        if (node.alignment !== undefined) bytes.set(u32(node.alignment, littleEndian), 4)
        bytes.set(node.data, prefix)
        return u32(layout.place(bytes), littleEndian)
      }

      case 'array': {
        // Children first, so their offsets exist by the time slots are filled.
        const slots = node.items.map((item) => emit(item))
        const typesSize = Math.ceil(node.items.length / 4) * 4
        const bytes = new Uint8Array(4 + typesSize + node.items.length * 4)
        bytes.set(containerHeader(BymlNodeType.Array, node.items.length, littleEndian), 0)
        node.items.forEach((item, index) => {
          bytes[4 + index] = nodeTypeOf(item)
        })
        slots.forEach((slot, index) => bytes.set(slot, 4 + typesSize + index * 4))
        return u32(layout.place(bytes), littleEndian)
      }

      case 'map': {
        const slots = node.entries.map((entry) => emit(entry.value))
        const bytes = new Uint8Array(4 + node.entries.length * 8)
        bytes.set(containerHeader(BymlNodeType.Map, node.entries.length, littleEndian), 0)
        node.entries.forEach((entry, index) => {
          const at = 4 + index * 8
          const index24 = keyIndex.get(entry.key)!
          const type = nodeTypeOf(entry.value)
          if (littleEndian) {
            bytes[at] = index24 & 0xff
            bytes[at + 1] = (index24 >>> 8) & 0xff
            bytes[at + 2] = (index24 >>> 16) & 0xff
            bytes[at + 3] = type
          } else {
            bytes[at] = (index24 >>> 16) & 0xff
            bytes[at + 1] = (index24 >>> 8) & 0xff
            bytes[at + 2] = index24 & 0xff
            bytes[at + 3] = type
          }
          bytes.set(slots[index]!, at + 4)
        })
        return u32(layout.place(bytes), littleEndian)
      }

      case 'hashmap': {
        const slots = node.entries.map((entry) => emit(entry.value))
        const count = node.entries.length
        // Pairs, then the type bytes — the reverse of an array's layout.
        const bytes = new Uint8Array(4 + count * 8 + Math.ceil(count / 4) * 4)
        bytes.set(containerHeader(BymlNodeType.HashMap, count, littleEndian), 0)
        node.entries.forEach((entry, index) => {
          const at = 4 + index * 8
          bytes.set(u32(entry.hash, littleEndian), at)
          bytes.set(slots[index]!, at + 4)
          bytes[4 + count * 8 + index] = nodeTypeOf(entry.value)
        })
        return u32(layout.place(bytes), littleEndian)
      }
    }
  }

  const rootSlot = emit(root)

  const file = new Uint8Array(Math.ceil(layout.size / 4) * 4)
  // "BY" big-endian, "YB" little-endian — the magic doubles as the byte-order mark.
  file[0] = littleEndian ? 0x59 : 0x42
  file[1] = littleEndian ? 0x42 : 0x59
  file.set(u16(version, littleEndian), 2)
  file.set(u32(keyTableOffset, littleEndian), 4)
  file.set(u32(stringTableOffset, littleEndian), 8)
  file.set(rootSlot, 12)
  layout.writeInto(file)
  return file
}
