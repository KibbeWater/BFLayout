import { BinaryReader } from '../../binary/reader'
import { FormatParseError } from '../../binary/errors'

/**
 * AAMP — the parameter archives that configure this engine's graphics stack.
 *
 * 26 of them in one title (`.baglcube`, `.baglenv`, `.bagldof`, `.baglsky`, `.baglmf`, `.bgenv`,
 * `.bgmsconf`, …) and they were unreadable here. Read-only: these are authored by Nintendo's own
 * tooling and writing them back is a different project, but *seeing* what a filter chain or an
 * environment set actually declares is most of what anyone wants from one.
 *
 * The header, verified byte for byte against all 26 files in a Tomodachi Life v1.0.4 dump:
 *
 *   0x00  char[4]  "AAMP"
 *   0x04  u32      version — 2 in every file measured
 *   0x08  u32      flag word — 3 in every file measured
 *   0x0c  u32      file size
 *   0x10  u32      parameter-IO version (0, 1, 2 and 410 all occur)
 *   0x14  u32      length of the type string, which is also the offset from 0x30 to the root list
 *   0x18  u32      list count, whole file
 *   0x1c  u32      object count, whole file
 *   0x20  u32      parameter count, whole file
 *   0x24  u32      data section size
 *   0x28  u32      string section size
 *   0x2c  u32      unknown — 0 in every file measured
 *   0x30  char[]   the type string, `u32 at 0x14` bytes long (e.g. "aglcube\0")
 *   then           the root parameter list
 *
 * Lists, objects and parameters form a tree. **Names are not stored** — each node carries a CRC32
 * of its name and nothing else, which is why every node here exposes `hash` alongside a `name`
 * that is `null` when the hash could not be resolved. See `resolveAampName`.
 *
 * The node layouts, all three measured rather than assumed:
 *
 *   list       u32 hash, u16 listsOffset, u16 listCount, u16 objectsOffset, u16 objectCount  (12)
 *   object     u32 hash, u16 parametersOffset, u16 parameterCount                            (8)
 *   parameter  u32 hash, u24 dataOffset, u8 type                                             (8)
 *
 * Every offset is in **4-byte units relative to the start of the node holding it**.
 *
 * Two findings worth recording, because the brief and the reference both say otherwise:
 *
 * - **Only parameters use a 24-bit offset.** Lists and objects use a u16 offset and a u16 count.
 *   This is decidable from the files: `gsys.bgmsconf` has an object whose parameter count exceeds
 *   255, so the count cannot be one byte; and `default.baglenv` nests 16 lists, which a u24 offset
 *   plus u8 count would read as zero sublists everywhere — the walk would find 1 list where the
 *   header declares 16. Under the layout above all 26 files walk to exactly the counts their own
 *   headers declare.
 * - The parameter offset's **third byte is 0 in every file measured**, because these files are at
 *   most 5,880 bytes and 16 bits of 4-byte units already reaches 256 KB. So the width is taken
 *   from the reference rather than measured; a 16-bit reading would agree on every file here.
 *
 * Values are **deduplicated and may overlap**: a vec2 whose two floats match the first two floats
 * of a vec4 points into the middle of that vec4, and in `default.baglccr` four separate Curve4
 * parameters share one 512-byte value. So nothing here may infer a value's size from the distance
 * to the next one — each type has a fixed width, listed in `AAMP_TYPES`.
 */

/** One curve: two leading integers then 30 floats. 128 bytes, measured — see `AAMP_TYPES`. */
export interface AampCurve {
  readonly ints: readonly number[]
  readonly floats: readonly number[]
}

/**
 * A parameter's decoded value.
 *
 * `unknown` is not a failure path to be avoided — it is the honest answer for a type byte this
 * build does not model, and for a value whose bytes fall outside the file. Guessing would produce
 * plausible numbers for a field nobody can check, which is worse here than saying nothing.
 */
export type AampValue =
  | { readonly kind: 'bool'; readonly value: boolean; readonly raw: number }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'u32'; readonly value: number }
  | { readonly kind: 'f32'; readonly value: number }
  /** vec2, vec3, vec4, color and quat all decode to a fixed-length float tuple. */
  | { readonly kind: 'floats'; readonly value: readonly number[] }
  | { readonly kind: 'string'; readonly value: string; readonly truncated: boolean }
  | { readonly kind: 'curves'; readonly value: readonly AampCurve[] }
  | {
      readonly kind: 'buffer'
      readonly element: 'int' | 'u32' | 'f32' | 'binary'
      readonly length: number
      readonly value: readonly number[]
    }
  | { readonly kind: 'unknown'; readonly typeByte: number; readonly reason: string }

export interface AampParameter {
  readonly hash: number
  /** Resolved name, or `null` when no candidate hashes to this value. Never a stand-in. */
  readonly name: string | null
  /** `name`, or `0x…` when unresolved — safe to print anywhere a name is expected. */
  readonly label: string
  readonly typeByte: number
  /** `AAMP_TYPES[typeByte].name`, or `unknown(<byte>)`. */
  readonly typeName: string
  /**
   * `false` when this type byte does not occur anywhere in the corpus this parser was measured
   * against, so its width and meaning come from the reference implementation rather than from
   * bytes. The value may still be present and correct; it has simply never been checked.
   */
  readonly verified: boolean
  /** Absolute file offset of the value, for reporting a suspect field precisely. */
  readonly offset: number
  readonly value: AampValue
}

export interface AampObject {
  readonly hash: number
  readonly name: string | null
  readonly label: string
  readonly offset: number
  readonly parameters: readonly AampParameter[]
}

export interface AampList {
  readonly hash: number
  readonly name: string | null
  readonly label: string
  readonly offset: number
  readonly lists: readonly AampList[]
  readonly objects: readonly AampObject[]
}

export interface AampDocument {
  readonly version: number
  /** The raw flag word at 0x08. 3 in every file measured; see `parseAamp` for what bit 0 means. */
  readonly flags: number
  readonly littleEndian: boolean
  /** Bit 1 of the flag word, which the reference reads as "strings are UTF-8". Set in all files. */
  readonly utf8: boolean
  readonly pioVersion: number
  /** The type string at 0x30, e.g. `aglcube`. Stored as text, unlike every node name. */
  readonly typeName: string
  readonly fileSize: number
  readonly root: AampList
  /** What the header claims, so a caller can show it beside what the walk found. */
  readonly declared: {
    readonly lists: number
    readonly objects: number
    readonly parameters: number
    readonly dataSize: number
    readonly stringSize: number
    readonly unknown: number
  }
  /** What the walk actually found. Equal to `declared` for all 26 files in the dump. */
  readonly counts: {
    readonly lists: number
    readonly objects: number
    readonly parameters: number
  }
  /** Nodes whose hash no candidate name matched, so the UI can say how much is unnamed. */
  readonly unresolvedNames: number
  /**
   * Everything the parse noticed but could recover from: a count short of the header's claim, a
   * truncated string, a value outside the declared sections. Surfacing these is the difference
   * between a file that parsed and a file that parsed *correctly*.
   */
  readonly warnings: readonly string[]
}

/** Fixed layout for each parameter type byte. `size` is the value's width in bytes. */
export const AAMP_TYPES: readonly (
  | { readonly name: string; readonly size: number }
  | undefined
)[] = [
  { name: 'bool', size: 4 }, // 0 — stored as a u32, not a byte
  { name: 'f32', size: 4 }, // 1
  { name: 'int', size: 4 }, // 2
  { name: 'vec2', size: 8 }, // 3
  { name: 'vec3', size: 12 }, // 4
  { name: 'vec4', size: 16 }, // 5
  { name: 'color', size: 16 }, // 6 — four floats, not RGBA8
  { name: 'string32', size: 0 }, // 7 — NUL-terminated in the string section
  { name: 'string64', size: 0 }, // 8
  { name: 'curve1', size: 128 }, // 9
  { name: 'curve2', size: 256 }, // 10
  { name: 'curve3', size: 384 }, // 11
  { name: 'curve4', size: 512 }, // 12
  { name: 'bufferInt', size: 0 }, // 13 — length-prefixed, see readBuffer
  { name: 'bufferF32', size: 0 }, // 14
  { name: 'string256', size: 0 }, // 15
  { name: 'quat', size: 16 }, // 16
  { name: 'u32', size: 4 }, // 17
  { name: 'bufferU32', size: 0 }, // 18
  { name: 'bufferBinary', size: 0 }, // 19
  { name: 'stringRef', size: 0 } // 20
]

/**
 * Type bytes that occur in the dump this parser was measured against.
 *
 * 0, 1, 2, 3, 4, 5, 6, 7, 8, 12 and 17 appear; the widths above were each read off real data.
 * Curve4 is the one that pinned the curve struct: in `default.baglccr` four Curve4 parameters
 * share a value at 0x370 and the next distinct value sits at 0x570, with the 128-byte pattern
 * `9, 7, 0, 0, 0.5, …` repeating at 0x370, 0x3f0, 0x470 and 0x4f0 — four curves of 128 bytes.
 * Curve1 to Curve3 therefore reuse a *measured* struct at an *inferred* count.
 *
 * Everything else — the three buffer types, string256, stringRef, quat — never occurs here, so its
 * entry above comes from the reference implementation and parameters carrying it are flagged
 * `verified: false`.
 */
export const AAMP_VERIFIED_TYPES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 17]

const VERIFIED = new Set(AAMP_VERIFIED_TYPES)

const MAGIC = 'AAMP'
const HEADER_SIZE = 0x30
const LIST_SIZE = 12
const OBJECT_SIZE = 8
const PARAMETER_SIZE = 8

/**
 * A tree deeper than this is taken to be corrupt rather than parsed.
 *
 * Offsets are relative and unsigned, so a damaged file can point a list at itself; the declared
 * counts bound the walk eventually, but only after recursing as many times as the header claims
 * nodes. The deepest tree in the dump is 5 lists, so 64 costs nothing real.
 */
const MAX_DEPTH = 64

/** Longest string decoded from the string section before giving up and saying so. */
const MAX_STRING = 1024

export function isAamp(data: Uint8Array): boolean {
  if (data.length < HEADER_SIZE) return false
  for (let at = 0; at < MAGIC.length; at++) {
    if (data[at] !== MAGIC.charCodeAt(at)) return false
  }
  return true
}

export function parseAamp(data: Uint8Array): AampDocument {
  if (!isAamp(data)) {
    throw new FormatParseError({ format: 'aamp', offset: 0, message: 'missing AAMP signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: true })
  reader.seek(4)
  const version = reader.u32()
  const flags = reader.u32()

  /*
   * Every file measured has version 2 and flags 3. Version 1 is a different container entirely
   * (its header is shorter and its nodes are laid out differently), so it is refused by name
   * rather than read as if it were a v2.
   */
  if (version !== 2) {
    throw new FormatParseError({
      format: 'aamp',
      offset: 4,
      message: `version ${version} is not supported; only version 2 has been measured against real files`
    })
  }

  /*
   * The reference reads bit 0 of the flag word as "little-endian" and bit 1 as "UTF-8". Both are
   * set in all 26 files, so a big-endian AAMP has never been seen here and there is nothing to
   * check a byte-flipped reading against. Refusing it names the field; parsing it anyway would
   * turn every offset in the file into a plausible-looking wrong number.
   */
  if ((flags & 1) === 0) {
    throw new FormatParseError({
      format: 'aamp',
      offset: 8,
      message: `flag word 0x${flags.toString(16)} has bit 0 clear, which the reference reads as big-endian; no such file exists in the corpus this parser was measured against, so it is refused rather than guessed at`
    })
  }

  const fileSize = reader.u32()
  const pioVersion = reader.u32()
  const typeLength = reader.u32()
  const declaredLists = reader.u32()
  const declaredObjects = reader.u32()
  const declaredParameters = reader.u32()
  const dataSize = reader.u32()
  const stringSize = reader.u32()
  const unknown = reader.u32()

  if (fileSize > data.length) {
    throw new FormatParseError({
      format: 'aamp',
      offset: 0xc,
      message: `header claims ${fileSize} bytes but only ${data.length} are present`
    })
  }
  if (HEADER_SIZE + typeLength + LIST_SIZE > fileSize) {
    throw new FormatParseError({
      format: 'aamp',
      offset: 0x14,
      message: `type string of ${typeLength} bytes leaves no room for the root list in ${fileSize} bytes`
    })
  }

  const typeName = reader.at(HEADER_SIZE, () => reader.fixedString(typeLength))

  const warnings: string[] = []
  const counts = { lists: 0, objects: 0, parameters: 0 }
  let unresolvedNames = 0

  /*
   * The data and string sections sit at the end of the file, string section last. Their bounds are
   * derived rather than stored, and are used only to *warn*: a value pointing outside them is
   * suspicious but still readable, whereas one pointing outside the file is not readable at all.
   * `unknown` is 0 in every file measured, so whether it is a fourth section's size is undecided
   * and it is deliberately left out of this arithmetic.
   */
  const stringStart = fileSize - stringSize
  const dataStart = stringStart - dataSize
  if (dataStart < HEADER_SIZE + typeLength) {
    warnings.push(
      `declared data (${dataSize}) and string (${stringSize}) sections overlap the node tree`
    )
  }

  const label = (hash: number, name: string | null): string =>
    name ?? `0x${hash.toString(16).padStart(8, '0')}`

  const resolve = (hash: number): string | null => {
    const name = resolveAampName(hash)
    if (name === null) unresolvedNames++
    return name
  }

  const readParameter = (at: number): AampParameter => {
    counts.parameters++
    if (counts.parameters > declaredParameters) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: `walk found more than the ${declaredParameters} parameters the header declares, so the tree does not match its own header`
      })
    }
    if (at + PARAMETER_SIZE > fileSize) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: 'parameter runs past the end of the file'
      })
    }

    const hash = reader.at(at, () => reader.u32())
    // u24 little-endian offset, then the type in the top byte of the same word.
    const relative =
      data[at + 4]! | (data[at + 5]! << 8) | (data[at + 6]! << 16)
    const typeByte = data[at + 7]!
    const offset = at + relative * 4
    const entry = AAMP_TYPES[typeByte]
    const name = resolve(hash)

    return {
      hash,
      name,
      label: label(hash, name),
      typeByte,
      typeName: entry?.name ?? `unknown(${typeByte})`,
      verified: VERIFIED.has(typeByte),
      offset,
      value: readValue(typeByte, offset)
    }
  }

  const readObject = (at: number): AampObject => {
    counts.objects++
    if (counts.objects > declaredObjects) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: `walk found more than the ${declaredObjects} objects the header declares, so the tree does not match its own header`
      })
    }
    if (at + OBJECT_SIZE > fileSize) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: 'object header runs past the end of the file'
      })
    }

    const hash = reader.at(at, () => reader.u32())
    const parametersAt = at + reader.at(at + 4, () => reader.u16()) * 4
    const parameterCount = reader.at(at + 6, () => reader.u16())
    if (parametersAt + parameterCount * PARAMETER_SIZE > fileSize) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: `object declares ${parameterCount} parameters at 0x${parametersAt.toString(16)}, which runs past the end of the file`
      })
    }

    const parameters: AampParameter[] = []
    for (let index = 0; index < parameterCount; index++) {
      parameters.push(readParameter(parametersAt + index * PARAMETER_SIZE))
    }

    const name = resolve(hash)
    return { hash, name, label: label(hash, name), offset: at, parameters }
  }

  const readList = (at: number, depth: number): AampList => {
    counts.lists++
    if (counts.lists > declaredLists) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: `walk found more than the ${declaredLists} lists the header declares, so the tree does not match its own header`
      })
    }
    if (depth > MAX_DEPTH) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: `list nesting deeper than ${MAX_DEPTH}, which a relative offset pointing back at its own node would produce`
      })
    }
    if (at + LIST_SIZE > fileSize) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: 'list header runs past the end of the file'
      })
    }

    const hash = reader.at(at, () => reader.u32())
    const listsAt = at + reader.at(at + 4, () => reader.u16()) * 4
    const listCount = reader.at(at + 6, () => reader.u16())
    const objectsAt = at + reader.at(at + 8, () => reader.u16()) * 4
    const objectCount = reader.at(at + 10, () => reader.u16())

    if (listsAt + listCount * LIST_SIZE > fileSize) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: `list declares ${listCount} sublists at 0x${listsAt.toString(16)}, which runs past the end of the file`
      })
    }
    if (objectsAt + objectCount * OBJECT_SIZE > fileSize) {
      throw new FormatParseError({
        format: 'aamp',
        offset: at,
        message: `list declares ${objectCount} objects at 0x${objectsAt.toString(16)}, which runs past the end of the file`
      })
    }

    const lists: AampList[] = []
    for (let index = 0; index < listCount; index++) {
      lists.push(readList(listsAt + index * LIST_SIZE, depth + 1))
    }
    const objects: AampObject[] = []
    for (let index = 0; index < objectCount; index++) {
      objects.push(readObject(objectsAt + index * OBJECT_SIZE))
    }

    const name = resolve(hash)
    return { hash, name, label: label(hash, name), offset: at, lists, objects }
  }

  /** Reads one value, degrading to `unknown` rather than inventing anything. */
  function readValue(typeByte: number, at: number): AampValue {
    const entry = AAMP_TYPES[typeByte]
    if (entry === undefined) {
      return {
        kind: 'unknown',
        typeByte,
        reason: `type byte ${typeByte} is outside the 0..${AAMP_TYPES.length - 1} range this build models`
      }
    }
    if (at < HEADER_SIZE || at >= fileSize) {
      return {
        kind: 'unknown',
        typeByte,
        reason: `value offset 0x${at.toString(16)} is outside the file`
      }
    }
    if (entry.size > 0 && at + entry.size > fileSize) {
      return {
        kind: 'unknown',
        typeByte,
        reason: `${entry.name} needs ${entry.size} bytes at 0x${at.toString(16)}, which runs past the end of the file`
      }
    }
    if (at < dataStart) {
      warnings.push(
        `${entry.name} at 0x${at.toString(16)} points before the declared data section (0x${dataStart.toString(16)})`
      )
    }

    switch (typeByte) {
      case 0: {
        const raw = reader.at(at, () => reader.u32())
        return { kind: 'bool', value: raw !== 0, raw }
      }
      case 1:
        return { kind: 'f32', value: reader.at(at, () => reader.f32()) }
      case 2:
        return { kind: 'int', value: reader.at(at, () => reader.i32()) }
      case 17:
        return { kind: 'u32', value: reader.at(at, () => reader.u32()) }
      case 3:
      case 4:
      case 5:
      case 6:
      case 16:
        return { kind: 'floats', value: readFloats(at, entry.size / 4) }
      case 7:
      case 8:
      case 15:
      case 20:
        return readString(at)
      case 9:
      case 10:
      case 11:
      case 12:
        return { kind: 'curves', value: readCurves(at, entry.size / 128) }
      case 13:
        return readBuffer(typeByte, at, 'int')
      case 14:
        return readBuffer(typeByte, at, 'f32')
      case 18:
        return readBuffer(typeByte, at, 'u32')
      case 19:
        return readBuffer(typeByte, at, 'binary')
      default:
        return {
          kind: 'unknown',
          typeByte,
          reason: `${entry.name} is named by the reference but this build has no decoder for it`
        }
    }
  }

  function readFloats(at: number, count: number): number[] {
    return reader.at(at, () => {
      const out: number[] = []
      for (let index = 0; index < count; index++) out.push(reader.f32())
      return out
    })
  }

  /**
   * Strings live NUL-terminated in the string section, padded to a 4-byte boundary.
   *
   * The type byte (string32 / string64 / string256 / stringRef) names the C++ field width, not the
   * stored length, so it is deliberately not used as a limit: BFLYT taught this codebase that a
   * shipped file can hold a string longer than the capacity it declares, and truncating to the
   * nominal width would silently shorten text nobody had edited.
   */
  function readString(at: number): AampValue {
    let value = ''
    let cursor = at
    while (cursor < fileSize && data[cursor] !== 0) {
      if (value.length >= MAX_STRING) {
        warnings.push(`string at 0x${at.toString(16)} exceeded ${MAX_STRING} bytes and was cut`)
        return { kind: 'string', value, truncated: true }
      }
      value += String.fromCharCode(data[cursor]!)
      cursor++
    }
    if (cursor >= fileSize) {
      // No terminator before the end of the file: what was read is real, but it is not the string.
      warnings.push(`string at 0x${at.toString(16)} has no terminator before the end of the file`)
      return { kind: 'string', value, truncated: true }
    }
    return { kind: 'string', value, truncated: false }
  }

  function readCurves(at: number, count: number): AampCurve[] {
    return reader.at(at, () => {
      const out: AampCurve[] = []
      for (let index = 0; index < count; index++) {
        const ints = [reader.u32(), reader.u32()]
        const floats: number[] = []
        for (let step = 0; step < 30; step++) floats.push(reader.f32())
        out.push({ ints, floats })
      }
      return out
    })
  }

  /**
   * Buffers: the reference stores the element count in the u32 *immediately before* the data, so
   * the parameter's own offset points at element zero.
   *
   * No buffer of any kind occurs in the dump, so this is the least-checked path in the file. It is
   * bounds-checked hard and degrades to `unknown` on anything implausible, which is the only
   * honest way to ship a decoder nothing has been able to verify.
   */
  function readBuffer(
    typeByte: number,
    at: number,
    element: 'int' | 'u32' | 'f32' | 'binary'
  ): AampValue {
    if (at < HEADER_SIZE + 4) {
      return {
        kind: 'unknown',
        typeByte,
        reason: `buffer at 0x${at.toString(16)} leaves no room for the length word before it`
      }
    }
    const length = reader.at(at - 4, () => reader.u32())
    const stride = element === 'binary' ? 1 : 4
    if (length > (fileSize - at) / stride) {
      return {
        kind: 'unknown',
        typeByte,
        reason: `buffer at 0x${at.toString(16)} declares ${length} elements, which runs past the end of the file`
      }
    }
    const value = reader.at(at, () => {
      const out: number[] = []
      for (let index = 0; index < length; index++) {
        if (element === 'binary') out.push(reader.u8())
        else if (element === 'f32') out.push(reader.f32())
        else if (element === 'u32') out.push(reader.u32())
        else out.push(reader.i32())
      }
      return out
    })
    return { kind: 'buffer', element, length, value }
  }

  const root = readList(HEADER_SIZE + typeLength, 0)

  /*
   * Falling short of the header's counts is a warning rather than a failure: the tree that was
   * read is still real, and a caller showing "112 of 136 parameters" is better served than one
   * shown an exception. Exceeding them is fatal, and is checked above as the walk runs, because
   * that is the shape a cyclic or misaligned offset takes.
   */
  if (counts.lists !== declaredLists) {
    warnings.push(`header declares ${declaredLists} lists; the walk found ${counts.lists}`)
  }
  if (counts.objects !== declaredObjects) {
    warnings.push(`header declares ${declaredObjects} objects; the walk found ${counts.objects}`)
  }
  if (counts.parameters !== declaredParameters) {
    warnings.push(
      `header declares ${declaredParameters} parameters; the walk found ${counts.parameters}`
    )
  }

  return {
    version,
    flags,
    littleEndian: true,
    utf8: (flags & 2) !== 0,
    pioVersion,
    typeName,
    fileSize,
    root,
    declared: {
      lists: declaredLists,
      objects: declaredObjects,
      parameters: declaredParameters,
      dataSize,
      stringSize,
      unknown
    },
    counts,
    unresolvedNames,
    warnings
  }
}

/** Depth-first walk in file order: a list, then its sublists, then its objects and parameters. */
export function walkAamp(
  root: AampList,
  visit: (node: AampList | AampObject | AampParameter, kind: 'list' | 'object' | 'parameter', depth: number) => void
): void {
  const walkList = (list: AampList, depth: number): void => {
    visit(list, 'list', depth)
    for (const child of list.lists) walkList(child, depth + 1)
    for (const object of list.objects) {
      visit(object, 'object', depth + 1)
      for (const parameter of object.parameters) visit(parameter, 'parameter', depth + 2)
    }
  }
  walkList(root, 0)
}

/**
 * CRC32 (the zlib polynomial, reflected) over the UTF-8 bytes of `text`.
 *
 * This is the hash AAMP stores in place of every node name, confirmed by `crc32('param_root')`
 * coming out as `0xa4f6cb6c` — the root list's hash in all 26 files.
 */
export function crc32(text: string): number {
  let crc = 0xffffffff
  // `for..of` walks code points, so a surrogate pair arrives as one character rather than two.
  for (const character of text) {
    for (const byte of utf8Bytes(character.codePointAt(0)!)) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * UTF-8 by hand, because `shared` has no `TextEncoder`.
 *
 * Every name measured is ASCII, so the multi-byte branches exist for a caller-supplied name rather
 * than for the built-in table — but a hash function that silently mangles non-ASCII input would
 * quietly fail to resolve names it should.
 */
function utf8Bytes(point: number): number[] {
  if (point < 0x80) return [point]
  if (point < 0x800) return [0xc0 | (point >> 6), 0x80 | (point & 0x3f)]
  if (point < 0x10000) {
    return [0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)]
  }
  return [
    0xf0 | (point >> 18),
    0x80 | ((point >> 12) & 0x3f),
    0x80 | ((point >> 6) & 0x3f),
    0x80 | (point & 0x3f)
  ]
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/**
 * Hash to name, or `null`.
 *
 * `null` matters: a hash is not a name, and a UI that prints one where the other belongs is
 * claiming to know something it does not. Callers should use `node.label`, which is the name when
 * there is one and `0x…` when there is not.
 */
export function resolveAampName(hash: number): string | null {
  if (NAME_TABLE === null) {
    NAME_TABLE = new Map()
    for (const name of AAMP_NAMES) NAME_TABLE.set(crc32(name), name)
  }
  return NAME_TABLE.get(hash >>> 0) ?? null
}

/**
 * Adds names to the lookup for subsequent parses, returning how many hashes became resolvable.
 *
 * This exists because the built-in table only covers the names this dump uses (see `AAMP_NAMES`).
 * A caller holding names from elsewhere — another title's table, a `.yml` dump, a user's own list
 * — can widen coverage without this module carrying a megabyte of strings it mostly cannot use.
 */
export function addAampNames(names: readonly string[]): number {
  resolveAampName(0)
  let added = 0
  for (const name of names) {
    const hash = crc32(name)
    if (!NAME_TABLE!.has(hash)) {
      NAME_TABLE!.set(hash, name)
      added++
    }
  }
  return added
}

let NAME_TABLE: Map<number, string> | null = null

/**
 * The names behind the hashes, and how they were arrived at.
 *
 * AAMP stores no names at all, so every one of these is a candidate string whose CRC32 was checked
 * against a hash that really occurs in the dump. Two sources:
 *
 * - **496** come from Switch Toolbox's own `aamp_hashed_names.txt` (58,465 candidates). That list
 *   is mostly Breath of the Wild gameplay names and only its `agl*` graphics entries are relevant
 *   here, so embedding the whole megabyte would ship ~99% dead weight into the renderer bundle;
 *   the entries that matched are kept and the rest are not. `addAampNames` is the way back in for
 *   anyone who needs the others.
 * - **164** were recovered by generating indexed variants (`param0`, `cubemap_unit_7`, `data11`,
 *   `config_31`, …) of every candidate and of every string appearing inside the files themselves.
 *
 * That second source needs a guard, and it is the reason this list is 660 names rather than 668.
 * Testing ~19 million candidates against 935 wanted 32-bit hashes yields about four collisions by
 * chance, so a lone match is not evidence. Only names belonging to a **family** — another name
 * with the same stem and a different index also matching — were kept, which threw out
 * `DirectionalLight0`, `Projector0` and `projection_shadow_0` and every one-off from a wider
 * variant sweep (`mAperture`, `enable_depth_gain`, …). The bare digits `0`–`14` survive that test
 * and are corroborated structurally: in `default.baglenvset` their hashes appear as eight
 * consecutive sibling objects, which is what an indexed array looks like.
 *
 * Coverage is therefore **660 of the 935 distinct hashes** in the dump, or 70.6%. The remaining
 * 275 have no candidate that hashes to them; they show up as `0x…` labels, never as invented text.
 */
export const AAMP_NAMES: readonly string[] = [
  '0', '1', '10', '11', '12', '13', '14', '2', '3', '4', '5', '6', '7', '8', '9', 'AmbientLight',
  'AutoExposure', 'BacksideColor', 'BlendRateDown', 'BlendRateUp', 'BloomObj', 'Cloud',
  'CloudParam0', 'CloudParam1', 'CloudParam2', 'DepthOfFieldObj', 'DiffuseColor', 'Direction',
  'DirectionalLight', 'ExposureMid', 'Fog', 'HemisphereLight', 'Intensity', 'IsEnable',
  'LightMapAmbientLight', 'LightMapCube', 'LightMapDirectionalLight', 'LightMapHemiSphereLight',
  'LightMapSizeSphere', 'Main', 'MaskedProjLight', 'MaskedSpotLight', 'MaskedSpotLightRig',
  'MaskedSpotLightRig::Obj', 'ParticleConfig', 'PointLightRig', 'PointLightRig::Obj', 'Projector',
  'RangeMax', 'RangeMin', 'ShadowPrePass', 'SpecularColor', 'SpotLightRig', 'SpotLightRig::Obj',
  'VertexOffsetX', 'VertexOffsetY', 'VertexScaleX', 'VertexScaleY', 'ViewCoordinate', 'active',
  'adhoc_fog_atten_grd', 'adhoc_fog_atten_minscale_sky', 'adhoc_fog_atten_sky', 'adhoc_fog_color',
  'adhoc_fog_far', 'adhoc_fog_near', 'agl_sharc_num', 'alchemy_bias', 'alchemy_density',
  'alchemy_detection_intensity', 'alchemy_max_radius', 'alchemy_radius', 'alchemy_sample_pair_num',
  'align', 'ambient_light_num', 'anim_rot_speed', 'anim_swing_amp', 'anim_swing_cyc_x',
  'anim_swing_cyc_y', 'anim_trans_vel', 'antialias_type', 'ao_far', 'arg', 'aspect',
  'base_reso_height', 'base_reso_width', 'bfres_num', 'bias_rotate', 'bias_scale', 'bias_trans',
  'blend_type', 'bloom', 'bloom_correct_depth', 'blur', 'blur_0', 'blur_1', 'blur_2', 'blur_3',
  'blur_num', 'blur_type', 'change_format', 'change_format_0', 'change_format_1',
  'change_format_2', 'change_format_3', 'clamped_luminance', 'color', 'color1', 'color2', 'color3',
  'color4', 'color_correction', 'color_correction_0', 'color_correction_1', 'color_correction_2',
  'color_correction_3', 'color_ctrl_depth', 'color_drift', 'color_drift_0', 'color_drift_1',
  'color_drift_2', 'color_drift_3', 'comp_sel_a', 'comp_sel_b', 'comp_sel_g', 'comp_sel_r',
  'config', 'config_10', 'config_11', 'config_12', 'config_13', 'config_14', 'config_15',
  'config_16', 'config_17', 'config_18', 'config_19', 'config_20', 'config_21', 'config_22',
  'config_23', 'config_24', 'config_25', 'config_26', 'config_27', 'config_28', 'config_29',
  'config_30', 'config_31', 'convert_parts_array', 'cube_map_max_tex_num',
  'cube_map_max_tex_width', 'cubemap_array', 'cubemap_disable_encode', 'cubemap_dynamic_range',
  'cubemap_hdr_compose_power', 'cubemap_max_model_unit_num', 'cubemap_max_shape_num',
  'cubemap_mgr', 'cubemap_unit', 'cubemap_unit_0', 'cubemap_unit_1', 'cubemap_unit_10',
  'cubemap_unit_11', 'cubemap_unit_2', 'cubemap_unit_3', 'cubemap_unit_4', 'cubemap_unit_5',
  'cubemap_unit_6', 'cubemap_unit_7', 'cubemap_unit_8', 'cubemap_unit_9', 'curve0', 'curve1',
  'curve2', 'curve3', 'data0', 'data1', 'data10', 'data11', 'data2', 'data3', 'data4', 'data5',
  'data6', 'data7', 'data8', 'data9', 'decal_ao_object_max', 'decal_ao_texture_cannel_num',
  'decal_ao_texture_height', 'decal_ao_texture_max', 'decal_ao_texture_width',
  'deferred_shading_model', 'deferred_shading_model1', 'deferred_shading_model2',
  'deferred_shading_model3', 'deferred_shading_model4', 'deferred_shading_model5',
  'deferred_shading_model6', 'deferred_shading_model7', 'density', 'density_drc', 'depth_blur',
  'depth_blur_add', 'depth_mask_func', 'depth_mask_reference', 'depth_offset', 'depth_reduce',
  'depth_shadow_check_only', 'depth_shadow_clip_plane_enable', 'depth_shadow_enable_bb_clip',
  'depth_shadow_ex_clip_plane_num', 'depth_shadow_force_array',
  'depth_shadow_matrix_view_coordinate', 'depth_shadow_near_0_0', 'depth_shadow_near_0_1',
  'depth_shadow_near_0_2', 'depth_shadow_near_0_3', 'depth_shadow_near_far_margin',
  'depth_shadow_pcf_offset', 'depth_shadow_polygon_offset', 'depth_shadow_polygon_scale',
  'depth_shadow_release_gbuffer', 'depth_shadow_tex_height', 'depth_shadow_tex_width',
  'directional_light_num', 'dist_attn', 'distance', 'dof', 'dof_far_max', 'drift_b', 'drift_g',
  'drift_r', 'dynamicShadowFarFadeEnd', 'dynamicShadowFarFadeStart', 'dynamic_color',
  'dynamic_mie_amplifier', 'dynamic_mie_symmetrical_prop', 'dynamic_rayleigh_amplifier',
  'edit_type', 'effect_model_heap_size', 'enable', 'enable_batck_process_streamout',
  'enable_clamped_luminance', 'enable_color_control', 'enable_color_reverse', 'enable_depth_clamp',
  'enable_dof_far_max', 'enable_indirect_from_full', 'enable_luminance_offset',
  'enable_particle_lineardepth', 'enable_reduce_draw', 'enable_vignetting_2_shape',
  'enable_vignetting_blur', 'enable_vignetting_color', 'end', 'env_obj_masked_proj_light_num',
  'env_obj_masked_spot_light_num', 'env_obj_masked_spot_light_rig_num', 'env_obj_point_light_num',
  'env_obj_point_light_rig_num', 'env_obj_ref_array', 'env_obj_set_template',
  'env_obj_spot_light_num', 'env_obj_spot_light_rig_num', 'ex_iteration', 'ex_type', 'expand',
  'expand_0', 'expand_1', 'expand_2', 'expand_3', 'ext', 'faceNormalBias', 'far', 'far_enable',
  'far_end', 'far_mul_color', 'far_start', 'file', 'filter_aa', 'finalblend', 'flg', 'fog_num',
  'format', 'fovy', 'fxaa_detect_edge_qa', 'fxaa_fetcht_qa', 'fxaa_reprojection',
  'fxaa_reprojection_move_limit', 'g3d_shader_binary', 'g3d_shader_text', 'g_buffer',
  'g_buffer_albedo_reduce_nearest', 'g_buffer_albedo_srgb', 'g_buffer_depth',
  'g_buffer_material_id_format', 'g_buffer_normal_8bit', 'g_buffer_normal_disable_reduce',
  'g_buffer_normal_reduce_nearest', 'g_buffer_normal_z_sign_w', 'gaussian_kernel',
  'gaussian_repetition_num', 'gpu_particle_heap_size', 'gpu_stress_analyzer_enable',
  'gpu_stress_analyzer_reduce_bufferenable', 'ground_color', 'group', 'gsys_app_package_info',
  'hdr_compose', 'hdr_compose_0', 'hdr_compose_1', 'hdr_compose_2', 'hdr_compose_3', 'height',
  'hemisphere_light_num', 'hiz_expand_enable', 'indirect_buffer_LDR',
  'indirect_depth_cancelenable', 'indirect_enable', 'indirect_scale', 'indirect_tex_rotate',
  'indirect_tex_scale', 'indirect_tex_trans', 'init_filter_aa_smaa_res_textures', 'intensity',
  'is_PcfSampleNum', 'is_PcfShaderType', 'is_enable', 'is_farDepthTestDist', 'is_useDecalAo',
  'is_useDepth2Normal', 'is_useDepth2NormalBlur', 'is_useFarDepthTest', 'is_useFarFade',
  'is_useMipLevelBlur', 'is_useMipLevelBlurReduce', 'is_usePreCombSsao', 'is_useStaticDepthShadow',
  'level', 'light_map_name_0', 'light_map_name_1', 'light_map_name_2', 'light_map_name_3',
  'light_map_name_4', 'light_map_name_5', 'light_map_name_6', 'light_map_name_7', 'light_name',
  'light_pre_pass_diffuse_intensity', 'light_pre_pass_specular_intensity',
  'light_prepass_texture_half', 'light_type', 'linear_lighting_enable', 'lm_max_cube_map',
  'lm_max_front_and_back', 'lm_max_front_only', 'luminance_intensity', 'mAlphaMul',
  'mAlphaThreshold', 'mAttenuationForSky', 'mBacklightColor', 'mBacklightParam0',
  'mBacklightParam1', 'mBacklightPower', 'mBacklightRange', 'mBaseColor', 'mBaseColorIntensity',
  'mBaseTexScale', 'mBaseTexScrollSpdX', 'mBaseTexScrollSpdY', 'mBaseTextureNo',
  'mBaseTextureNo_Blend', 'mCloudColorScale', 'mCloudTexBlendRate', 'mDarkSideNoiseParam',
  'mDebugParam0', 'mDebugParam1', 'mDebugParam2', 'mDebugParam3', 'mDensity', 'mDistotion',
  'mDrawOrder', 'mEmbossDensity', 'mEmbossWidth', 'mFarAlphaChgEnd', 'mFarAlphaChgPower',
  'mFarAlphaChgStart', 'mFarDensityChgEnd', 'mFarDensityChgPower', 'mFarDensityChgStart',
  'mFarDistotionChgEnd', 'mFarDistotionChgPower', 'mFarDistotionChgStart', 'mFarUVMul',
  'mFarUVPow', 'mFogColor', 'mFogFar', 'mFogNear', 'mHighlightAmbient', 'mHighlightRange',
  'mHilightColor', 'mHilightColorIntensity', 'mHilightPower', 'mIsDisableDepthTest',
  'mIsDisableFarClip', 'mIsDrawReduceBuffer', 'mIsEnable', 'mLightSideNoiseParam',
  'mNoiseDensity1', 'mNoiseDensity2', 'mNoiseScale1', 'mNoiseScale2', 'mNoiseSpeed1X',
  'mNoiseSpeed1Y', 'mNoiseSpeed2X', 'mNoiseSpeed2Y', 'mNoiseSpeedMaster', 'mNoiseTextureNo',
  'mNoiseTextureNo_Blend', 'mScatterAmb', 'mScatterHeight', 'mScreenSpaceBlurRepNum',
  'mShadowColor', 'mShadowColorIntensity', 'mShadowPower', 'mSkyHeight', 'mSkyScale',
  'mSunOccBufSize', 'mSunOccChkSize', 'mSunPosX', 'mSunPosY', 'mUseDebugDispSun',
  'mUseProcedualTexture', 'mUseScatter', 'masked_light_shadow_only', 'max_span', 'mbCloudTexBlend',
  'mf_root_param', 'mie_amplifier_rendering', 'mie_base_height', 'mie_scattering_coeff',
  'mie_symmetrical_prop', 'mie_symmetrical_prop_rendering', 'mii_hair_light_name',
  'mii_hair_light_ss_name', 'mipBlurRepNum', 'mipBlurWidth', 'mip_blur_num', 'model_num',
  'model_scene_env_data_set_num', 'model_scene_light', 'model_unit_num', 'name', 'name_array',
  'near', 'near_enable', 'nld_32bit', 'nld_enable', 'nld_half_32bit', 'normal2ShadowMul',
  'normal2ShadowRatio', 'normal_parts_array', 'num', 'occlusion_query_num', 'offset_adjust',
  'ofx_num_large_lens_flare_rig', 'ofx_num_large_lens_flare_rig_obj',
  'ofx_num_large_lens_flare_rig_preset', 'ofx_num_lens_flare', 'ofx_num_lens_flare_dynamic',
  'ofx_num_lens_flare_dynamic_preset', 'ofx_num_lens_flare_preset', 'ofx_num_lens_flare_rig',
  'ofx_num_lens_flare_rig_obj', 'ofx_num_lens_flare_rig_preset', 'opa_polygon_offset',
  'opa_polygon_scale', 'package_name', 'param', 'param0', 'param1', 'param10', 'param11',
  'param12', 'param13', 'param14', 'param15', 'param16', 'param17', 'param18', 'param19', 'param2',
  'param20', 'param21', 'param22', 'param23', 'param24', 'param25', 'param26', 'param27',
  'param28', 'param29', 'param3', 'param30', 'param31', 'param32', 'param33', 'param34', 'param35',
  'param36', 'param37', 'param38', 'param39', 'param4', 'param5', 'param6', 'param7', 'param8',
  'param9', 'param_array', 'param_root', 'parts', 'pcfWidth', 'position', 'proj_name',
  'proj_shadow_matrix_view_coordinate', 'proj_type', 'projection_shadow_num',
  'ptcl_emit_callback_heap_size', 'quality', 'radius', 'rayleigh_amplifier_rendering',
  'rayleigh_base_height', 'reduce', 'reduce_0', 'reduce_1', 'reduce_2', 'reduce_3', 'reduce_scale',
  'reduced_buffer_16bit', 'reduced_buffer_blur_adjust_bake', 'reduced_buffer_edge_adjust',
  'reduced_buffer_edge_adjust_bake', 'reduced_buffer_edge_adjust_coeff', 'refer', 'refer_entity',
  'refer_tex', 'render_sun_intensity', 'render_sun_lerp', 'render_sun_size',
  'rendering_repetition_num', 'repeat', 'resolutionMode', 'result_sampler_linear',
  'rev_polygon_offset', 'rev_polygon_scale', 'sample_pair_num', 'saturate_min', 'save_index',
  'scale', 'scatter_fog_atten', 'scatter_fog_density', 'scatter_fog_far', 'scatter_fog_horz',
  'scatter_fog_near', 'scene_material_model', 'screenSpaceBlurType', 'screenSpaceBlurWidth',
  'set_array', 'setting', 'shader_num', 'shape_num', 'signature', 'sky', 'smaa_detect_edge_qa',
  'smaa_line_detect_local_adopt', 'smaa_line_detect_qa', 'smaa_line_detect_th', 'smaa_variation',
  'smaa_velocity_penalty_scale', 'smaa_weight_calc_qa', 'span_minimum', 'span_multiply',
  'ssao_is_depth_full', 'ssao_parameter', 'ssao_type', 'start', 'staticShadowFarFadeEnd',
  'staticShadowFarFadeStart', 'static_depth_shadow_parameter', 'static_mie_base_height',
  'static_mie_scattering_coeff', 'static_mie_symmetrical_prop', 'static_rayleigh_base_height',
  'static_sdw_depth_format_name', 'static_sdw_shadow_map_format_name', 'static_sdw_width',
  'subpix_param', 'sun_color', 'template_name', 'threshhold_balance', 'tool', 'trim_center',
  'trim_scale', 'trimming', 'trimming_0', 'trimming_1', 'trimming_2', 'trimming_3', 'type',
  'use_decal_ao', 'use_decal_buffer', 'use_decal_trail', 'use_density_drc',
  'user_visualize_clr_name_0', 'user_visualize_clr_name_1', 'user_visualize_clr_name_10',
  'user_visualize_clr_name_11', 'user_visualize_clr_name_12', 'user_visualize_clr_name_13',
  'user_visualize_clr_name_14', 'user_visualize_clr_name_15', 'user_visualize_clr_name_2',
  'user_visualize_clr_name_3', 'user_visualize_clr_name_4', 'user_visualize_clr_name_5',
  'user_visualize_clr_name_6', 'user_visualize_clr_name_7', 'user_visualize_clr_name_8',
  'user_visualize_clr_name_9', 'user_visualize_tex_name_0', 'user_visualize_tex_name_1',
  'user_visualize_tex_name_10', 'user_visualize_tex_name_11', 'user_visualize_tex_name_12',
  'user_visualize_tex_name_13', 'user_visualize_tex_name_14', 'user_visualize_tex_name_15',
  'user_visualize_tex_name_2', 'user_visualize_tex_name_3', 'user_visualize_tex_name_4',
  'user_visualize_tex_name_5', 'user_visualize_tex_name_6', 'user_visualize_tex_name_7',
  'user_visualize_tex_name_8', 'user_visualize_tex_name_9', 'variable_dist_min', 'version',
  'view_at', 'view_pos', 'view_up', 'vignetting_blend', 'vignetting_blur', 'vignetting_color',
  'xlu_polygon_offset', 'xlu_polygon_scale', 'z_pre_pass', 'z_pre_pass_selectable'
]
