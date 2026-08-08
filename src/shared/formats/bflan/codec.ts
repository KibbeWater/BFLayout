import { BinaryReader } from '../../binary/reader'
import { BinaryWriter } from '../../binary/writer'
import { FormatParseError, FormatWriteError } from '../../binary/errors'
import { DEFAULT_VERSION, decodeVersion, encodeVersion } from '../bflyt/layout'
import type {
  AnimationComponent,
  AnimationDocument,
  AnimationEntry,
  AnimationInfo,
  AnimationTag,
  AnimationTagInfo,
  CurveKind,
  Keyframe,
  ParsedAnimation
} from './types'

/**
 * BFLAN reader and writer.
 *
 * The header is laid out exactly like BFLYT's — magic, byte-order mark at 0x04,
 * header size, version, file size, section count — so the same "read big-endian
 * until the BOM tells you otherwise" trick applies.
 *
 * Offsets inside pai1 are relative to different bases depending on where they
 * appear, which is the main thing to get right:
 *
 *   entry offset table      relative to the start of the pai1 *section header*
 *   texture name offsets    relative to the start of the offset table itself
 *   tag offsets in an entry relative to the start of that entry
 *   keyframe offset         relative to the start of that component
 */

const MAGIC = 'FLAN'
const ENTRY_NAME_LENGTH = 28

/**
 * Width of a group-name slot in pat1.
 *
 * Verified against real version-9 files: the stride is 36, not the 28 the
 * Switch-Toolbox reference uses. Files with 2, 6 and 7 groups all measure exactly
 * 36 bytes per entry, so this is a stride rather than 28 plus padding. BFLYT
 * widened its own group names at major 5, so that is where this switches too —
 * 28 is kept for older files because that is what the reference reads and there
 * were none in the dump to check against.
 */
function groupNameLength(major: number): number {
  return major >= 5 ? 36 : 28
}

export function isBflan(data: Uint8Array): boolean {
  return (
    data.length >= 0x14 &&
    data[0] === 0x46 &&
    data[1] === 0x4c &&
    data[2] === 0x41 &&
    data[3] === 0x4e
  )
}

function decodeCurve(value: number): CurveKind {
  switch (value) {
    case 1:
      return 'step'
    case 2:
      return 'hermite'
    default:
      return 'constant'
  }
}

function encodeCurve(curve: CurveKind): number {
  switch (curve) {
    case 'step':
      return 1
    case 'hermite':
      return 2
    default:
      return 0
  }
}

export function parseBflan(data: Uint8Array): ParsedAnimation {
  if (!isBflan(data)) {
    throw new FormatParseError({ format: 'bflan', offset: 0, message: 'missing FLAN signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: false })
  reader.skip(4)
  const bom = reader.u16be()
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'bflan',
      offset: 4,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  reader.littleEndian = bom === 0xfffe

  const headerSize = reader.u16()
  const version = decodeVersion(reader.u32())
  const fileSize = reader.u32()
  const sectionCount = reader.u16()
  reader.skip(2)

  if (fileSize > data.length) {
    throw new FormatParseError({
      format: 'bflan',
      offset: 0x0c,
      message: `header claims ${fileSize} bytes but only ${data.length} are present`
    })
  }

  const document: AnimationDocument = {
    version,
    littleEndian: reader.littleEndian,
    tag: null,
    info: null,
    unknownSections: []
  }

  reader.seek(headerSize)
  for (let index = 0; index < sectionCount; index++) {
    if (reader.tell() + 8 > data.length) break
    const start = reader.tell()
    const signature = reader.fixedString(4)
    const size = reader.u32()

    if (size < 8 || start + size > data.length) {
      throw new FormatParseError({
        format: 'bflan',
        offset: start,
        section: signature,
        message: `section ${signature} declares a size of ${size} bytes, which runs past the end of the file`
      })
    }

    switch (signature) {
      case 'pat1':
        document.tag = readTagInfo(reader, start, start + size, version.major)
        break
      case 'pai1':
        document.info = readInfo(reader, start)
        break
      default:
        document.unknownSections.push({
          signature,
          index,
          data: [...reader.bytesAt(start + 8, size - 8)]
        })
        break
    }

    reader.seek(start + size)
  }

  return { document, original: data.slice(0) }
}

function readTagInfo(
  reader: BinaryReader,
  start: number,
  end: number,
  major: number
): AnimationTagInfo {
  const groupNameSize = groupNameLength(major)
  const order = reader.u16()
  const groupCount = reader.u16()
  const nameOffset = reader.u32()
  const groupsOffset = reader.u32()
  /*
   * Version 8 added an offset to a `usd1` block nested inside this section, after
   * the group names. It was read as padding and written back as zero, which
   * silently dropped the block.
   */
  const userDataOffset = major >= 8 ? reader.u32() : 0

  const startFrame = reader.i16()
  const endFrame = reader.i16()
  const childBinding = reader.u8() !== 0

  // Everything between here and the name is version-dependent padding this build
  // does not model; keeping the bytes is what lets an untouched file round-trip.
  const trailingLength = Math.max(0, start + nameOffset - reader.tell())
  const trailing = [...reader.readBytes(trailingLength)]

  const name = reader.cstringAt(start + nameOffset)

  const groups: string[] = []
  reader.seek(start + groupsOffset)
  for (let i = 0; i < groupCount; i++) groups.push(reader.fixedString(groupNameSize))

  // Everything from the offset to the end of the section, which is the whole nested
  // section including its own signature and size.
  const userData =
    userDataOffset > 0 && start + userDataOffset < end
      ? [...reader.bytesAt(start + userDataOffset, end - (start + userDataOffset))]
      : []

  return { name, order, startFrame, endFrame, childBinding, groups, trailing, userData }
}

function readInfo(reader: BinaryReader, start: number): AnimationInfo {
  const frameSize = reader.u16()
  const loop = reader.u8() !== 0
  reader.skip(1)
  const textureCount = reader.u16()
  const entryCount = reader.u16()
  const entryTableOffset = reader.u32()

  const textures: string[] = []
  if (textureCount > 0) {
    const tableStart = reader.tell()
    const offsets: number[] = []
    for (let i = 0; i < textureCount; i++) offsets.push(reader.u32())
    // Texture name offsets are relative to the offset table, not the section.
    for (const offset of offsets) textures.push(reader.cstringAt(tableStart + offset))
  }

  const entries: AnimationEntry[] = []
  if (entryCount > 0 && entryTableOffset !== 0) {
    reader.seek(start + entryTableOffset)
    const offsets: number[] = []
    for (let i = 0; i < entryCount; i++) offsets.push(reader.u32())
    for (const offset of offsets) {
      reader.seek(start + offset)
      entries.push(readEntry(reader))
    }
  }

  return { frameSize, loop, textures, entries }
}

function readEntry(reader: BinaryReader): AnimationEntry {
  const start = reader.tell()
  const name = reader.fixedString(ENTRY_NAME_LENGTH)
  const tagCount = reader.u8()
  const targetByte = reader.u8()
  reader.skip(2)

  const offsets: number[] = []
  for (let i = 0; i < tagCount; i++) offsets.push(reader.u32())

  const target = targetByte === 1 ? 'material' : 'pane'
  const tags: AnimationTag[] = []
  for (const offset of offsets) {
    reader.seek(start + offset)
    tags.push(readTag(reader, targetByte))
  }

  return { name, target, tags }
}

function readTag(reader: BinaryReader, targetByte: number): AnimationTag {
  // Target byte 2 puts an extra word ahead of the tag that the offset table does
  // not account for. Nothing here interprets it, but it has to survive a save.
  const leading = targetByte === 2 ? reader.u32() : null

  const start = reader.tell()
  const signature = reader.fixedString(4)
  const count = reader.u8()
  reader.skip(3)

  const offsets: number[] = []
  for (let i = 0; i < count; i++) offsets.push(reader.u32())

  const components: AnimationComponent[] = []
  for (const offset of offsets) {
    reader.seek(start + offset)
    components.push(readComponent(reader))
  }

  return { signature, leading, components }
}

function readComponent(reader: BinaryReader): AnimationComponent {
  const start = reader.tell()
  const index = reader.u8()
  const target = reader.u8()
  const curve = decodeCurve(reader.u8())
  reader.skip(1)
  const keyCount = reader.u16()
  reader.skip(2)
  const keyOffset = reader.u32()

  const keyframes: Keyframe[] = []
  if (keyCount > 0 && keyOffset !== 0) {
    reader.seek(start + keyOffset)
    for (let i = 0; i < keyCount; i++) keyframes.push(readKeyframe(reader, curve))
  }

  return { index, target, curve, keyframes }
}

function readKeyframe(reader: BinaryReader, curve: CurveKind): Keyframe {
  if (curve === 'hermite') {
    return { frame: reader.f32(), value: reader.f32(), slope: reader.f32() }
  }
  // Step and constant keys store the value as a signed 16-bit integer.
  const frame = reader.f32()
  const value = reader.i16()
  reader.skip(2)
  return { frame, value, slope: 0 }
}

// ------------------------------------------------------------------- writing

/**
 * Serializes an animation. `original` short-circuits to a byte-for-byte copy —
 * BFLAN has no per-node dirty tracking, so an unmodified document is passed
 * through whole rather than re-encoded.
 */
export function writeBflan(document: AnimationDocument, original?: Uint8Array): Uint8Array {
  if (original) return original.slice(0)

  const writer = new BinaryWriter({ littleEndian: document.littleEndian })

  writer.magic(MAGIC)
  writer.u16be(document.littleEndian ? 0xfffe : 0xfeff)
  writer.u16(0x14)
  writer.u32(encodeVersion(document.version))
  const fileSize = writer.defer('u32')
  const sectionCount = writer.defer('u16')
  writer.u16(0)

  /**
   * Sections are emitted in their original stream order.
   *
   * Unknown sections record the index they were found at, so they are written when
   * the counter reaches it rather than appended — a section's position in the
   * stream is part of the format, and `cnt1` in a layout taught us that the hard
   * way by sitting near the front rather than the end.
   */
  const pending = [...document.unknownSections].sort((a, b) => a.index - b.index)
  let sections = 0

  const emitPendingUnknown = (): void => {
    while (pending.length > 0 && pending[0]!.index === sections) {
      const unknown = pending.shift()!
      writer.section(unknown.signature, () => writer.bytes(new Uint8Array(unknown.data)))
      sections++
    }
  }

  emitPendingUnknown()
  if (document.tag) {
    writer.section('pat1', () => writeTagInfo(writer, document.tag!, document.version.major))
    sections++
    emitPendingUnknown()
  }
  if (document.info) {
    writer.section('pai1', () => writeInfo(writer, document.info!))
    sections++
    emitPendingUnknown()
  }

  // Anything whose recorded index sits past the sections we model.
  while (pending.length > 0) {
    const unknown = pending.shift()!
    writer.section(unknown.signature, () => writer.bytes(new Uint8Array(unknown.data)))
    sections++
  }

  if (sections === 0) {
    throw new FormatWriteError({
      format: 'bflan',
      message: 'an animation needs at least a pat1 or pai1 section'
    })
  }

  sectionCount.set(sections)
  fileSize.set(writer.length)
  return writer.toBytes()
}

function writeTagInfo(writer: BinaryWriter, tag: AnimationTagInfo, major: number): void {
  // Offsets in pat1 are relative to the section start, which is 8 bytes back.
  const base = writer.length - 8

  writer.u16(tag.order)
  writer.u16(tag.groups.length)
  const nameOffset = writer.defer('u32')
  const groupsOffset = writer.defer('u32')
  const userDataOffset = major >= 8 ? writer.defer('u32') : null

  writer.i16(tag.startFrame)
  writer.i16(tag.endFrame)
  writer.u8(tag.childBinding ? 1 : 0)
  for (const byte of tag.trailing) writer.u8(byte)

  nameOffset.set(writer.length - base)
  writer.cstring(tag.name)
  writer.align(4)

  groupsOffset.set(writer.length - base)
  for (const group of tag.groups) writer.fixedString(group, groupNameLength(major))

  // A nested usd1 block, replayed verbatim after the groups.
  if (userDataOffset) {
    if (tag.userData.length > 0) {
      userDataOffset.set(writer.length - base)
      writer.bytes(new Uint8Array(tag.userData))
    } else {
      userDataOffset.set(0)
    }
  }
}

function writeInfo(writer: BinaryWriter, info: AnimationInfo): void {
  const base = writer.length - 8

  writer.u16(info.frameSize)
  writer.u8(info.loop ? 1 : 0)
  writer.u8(0)
  writer.u16(info.textures.length)
  writer.u16(info.entries.length)
  const entryTableOffset = writer.defer('u32')

  if (info.textures.length > 0) {
    const tableStart = writer.length
    const offsets = info.textures.map(() => writer.defer('u32'))
    for (const [index, name] of info.textures.entries()) {
      offsets[index]!.set(writer.length - tableStart)
      writer.cstring(name)
    }
    writer.align(4)
  }

  if (info.entries.length === 0) {
    entryTableOffset.set(0)
    return
  }

  entryTableOffset.set(writer.length - base)
  const entryOffsets = info.entries.map(() => writer.defer('u32'))
  for (const [index, entry] of info.entries.entries()) {
    entryOffsets[index]!.set(writer.length - base)
    writeEntry(writer, entry)
  }
}

function writeEntry(writer: BinaryWriter, entry: AnimationEntry): void {
  const start = writer.length

  writer.fixedString(entry.name, ENTRY_NAME_LENGTH)
  writer.u8(entry.tags.length)
  // A tag with a leading word round-trips as target byte 2, which is what
  // produced it; otherwise the pane/material distinction decides.
  const targetByte = entry.tags.some((tag) => tag.leading !== null)
    ? 2
    : entry.target === 'material'
      ? 1
      : 0
  writer.u8(targetByte)
  writer.u16(0)

  if (entry.tags.length === 0) return

  const offsets = entry.tags.map(() => writer.defer('u32'))
  for (const [index, tag] of entry.tags.entries()) {
    // The offset points at the tag signature, which sits after the leading word.
    const at = writer.length + (tag.leading !== null ? 4 : 0)
    offsets[index]!.set(at - start)
    writeTag(writer, tag)
  }
}

function writeTag(writer: BinaryWriter, tag: AnimationTag): void {
  if (tag.leading !== null) writer.u32(tag.leading)

  const start = writer.length
  writer.magic(tag.signature)
  writer.u8(tag.components.length)
  writer.u8(0)
  writer.u16(0)

  if (tag.components.length === 0) return

  const offsets = tag.components.map(() => writer.defer('u32'))
  for (const [index, component] of tag.components.entries()) {
    offsets[index]!.set(writer.length - start)
    writeComponent(writer, component)
  }
}

function writeComponent(writer: BinaryWriter, component: AnimationComponent): void {
  const start = writer.length

  writer.u8(component.index)
  writer.u8(component.target)
  writer.u8(encodeCurve(component.curve))
  writer.u8(0)
  writer.u16(component.keyframes.length)
  writer.u16(0)
  const keyOffset = writer.defer('u32')

  if (component.keyframes.length === 0) {
    keyOffset.set(0)
    return
  }

  keyOffset.set(writer.length - start)
  for (const key of component.keyframes) {
    writer.f32(key.frame)
    if (component.curve === 'hermite') {
      writer.f32(key.value)
      writer.f32(key.slope)
    } else {
      writer.i16(Math.round(key.value))
      writer.u16(0)
    }
  }
}

/** An empty animation, for creating one from scratch. */
export function createAnimation(name: string, frameSize = 60): AnimationDocument {
  return {
    version: DEFAULT_VERSION,
    littleEndian: true,
    tag: {
      name,
      order: 2,
      startFrame: 0,
      endFrame: frameSize,
      childBinding: false,
      groups: [],
      trailing: [],
      userData: []
    },
    info: { frameSize, loop: false, textures: [], entries: [] },
    unknownSections: []
  }
}
