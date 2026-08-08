import { BinaryReader } from '@shared/binary/reader'
import { BinaryWriter } from '@shared/binary/writer'
import { FormatParseError } from '@shared/binary/errors'

import { readMaterial, writeMaterial } from './material'
import { readPane, writePane } from './panes'
import {
  isPaneKind,
  walkPanes,
  type GroupPane,
  type LayoutDocument,
  type LayoutInfo,
  type LayoutPlatform,
  type LayoutVersion,
  type Material,
  type Pane,
  type ParsedLayout,
  type PreservedSources,
  type UnknownSection,
  type UserData,
  type UserDataEntry,
  type UserDataValueKind
} from './types'

const MAGIC = 'FLYT'
const HEADER_SIZE = 0x14

/** Sections with no payload that only push and pop tree depth. */
const PUSH_POP = new Set(['pas1', 'pae1', 'grs1', 'gre1'])

let groupCounter = 0
const nextGroupId = (): string => `group_${(++groupCounter).toString(36)}`

export function decodeVersion(raw: number): LayoutVersion {
  return {
    major: (raw >>> 24) & 0xff,
    minor: (raw >>> 16) & 0xff,
    micro: (raw >>> 8) & 0xff,
    micro2: raw & 0xff
  }
}

export function encodeVersion(version: LayoutVersion): number {
  return (
    ((version.major & 0xff) << 24) |
    ((version.minor & 0xff) << 16) |
    ((version.micro & 0xff) << 8) |
    (version.micro2 & 0xff)
  ) >>> 0
}

/** Newly created layouts target the revision current Switch titles use. */
export const DEFAULT_VERSION: LayoutVersion = { major: 8, minor: 0, micro: 0, micro2: 0 }

export function isBflyt(data: Uint8Array): boolean {
  return (
    data.length >= HEADER_SIZE &&
    data[0] === 0x46 &&
    data[1] === 0x4c &&
    data[2] === 0x59 &&
    data[3] === 0x54
  )
}

const USER_DATA_KINDS: readonly UserDataValueKind[] = ['string', 'int', 'float', 'struct']

/**
 * Reads a usd1 section.
 *
 * The per-entry count field is a count of *items*, not bytes. That matters for
 * struct entries, where real files store 1 no matter how large the payload is —
 * so a struct's extent has to be derived from the layout instead: it runs to the
 * nearest thing that follows it, which is either another entry's data, a name, or
 * the end of the section.
 */
function readUserData(
  reader: BinaryReader,
  sectionStart: number,
  sectionEnd: number
): UserData {
  const count = reader.u16()
  reader.skip(2)

  interface Header {
    entryStart: number
    nameOffset: number
    dataOffset: number
    itemCount: number
    typeCode: number
    unknown: number
  }

  const headers: Header[] = []
  for (let i = 0; i < count; i++) {
    const entryStart = reader.tell()
    headers.push({
      entryStart,
      nameOffset: reader.u32(),
      dataOffset: reader.u32(),
      itemCount: reader.u16(),
      typeCode: reader.u8(),
      unknown: reader.u8()
    })
  }

  // Every absolute position a payload is not allowed to run into.
  const stops: number[] = [sectionEnd]
  for (const header of headers) {
    if (header.nameOffset > 0) stops.push(header.entryStart + header.nameOffset)
    if (header.dataOffset > 0) stops.push(header.entryStart + header.dataOffset)
  }

  const entries: UserDataEntry[] = []
  for (const header of headers) {
    const kind = USER_DATA_KINDS[header.typeCode] ?? 'struct'
    const name =
      header.nameOffset > 0 ? reader.cstringAt(header.entryStart + header.nameOffset) : ''

    let stringValue: string | null = null
    const numberValues: number[] = []
    let structValue: number[] | null = null

    if (header.dataOffset > 0) {
      const at = header.entryStart + header.dataOffset
      const limit = Math.min(...stops.filter((stop) => stop > at))
      reader.at(at, () => {
        switch (kind) {
          case 'string':
            stringValue = reader.fixedString(header.itemCount)
            break
          case 'int':
            for (let n = 0; n < header.itemCount; n++) numberValues.push(reader.i32())
            break
          case 'float':
            for (let n = 0; n < header.itemCount; n++) numberValues.push(reader.f32())
            break
          default:
            // Struct contents are undocumented; keep them verbatim.
            structValue = [...reader.readBytes(Math.max(0, limit - at))]
            break
        }
      })
    }

    entries.push({
      name,
      kind,
      stringValue,
      numberValues,
      structValue,
      itemCount: header.itemCount,
      unknown: header.unknown
    })
  }

  void sectionStart
  return {
    entries,
    raw: [...reader.bytesAt(sectionStart + 8, Math.max(0, sectionEnd - sectionStart - 8))],
    dirty: false
  }
}

function readStringList(reader: BinaryReader): string[] {
  const count = reader.u16()
  reader.skip(2)
  // Offsets are relative to the start of the offset table itself.
  const base = reader.tell()
  const offsets: number[] = []
  for (let i = 0; i < count; i++) offsets.push(reader.u32())
  return offsets.map((offset) => reader.cstringAt(base + offset))
}

function writeStringList(writer: BinaryWriter, values: readonly string[]): void {
  writer.u16(values.length)
  writer.u16(0)
  const base = writer.tell()
  const patches = values.map(() => writer.defer('u32'))
  values.forEach((value, index) => {
    patches[index]!.set(writer.tell() - base)
    writer.cstring(value)
  })
  writer.align(4)
}

function readGroup(reader: BinaryReader, major: number): GroupPane {
  // Version 5 widened the name field and dropped the padding after the count.
  const name = major >= 5 ? reader.fixedString(34) : reader.fixedString(24)
  const count = reader.u16()
  if (major < 5) reader.skip(2)

  const paneNames: string[] = []
  for (let i = 0; i < count; i++) paneNames.push(reader.fixedString(24))

  return { id: nextGroupId(), name, paneNames, children: [], dirty: false }
}

function writeGroup(writer: BinaryWriter, group: GroupPane, major: number): void {
  writer.section('grp1', () => {
    if (major >= 5) {
      writer.fixedString(group.name, 34)
      writer.u16(group.paneNames.length)
    } else {
      writer.fixedString(group.name, 24)
      writer.u16(group.paneNames.length)
      writer.zeros(2)
    }
    for (const name of group.paneNames) writer.fixedString(name, 24)
  })
}

function readLayoutInfo(reader: BinaryReader): LayoutInfo {
  const drawFromCenter = reader.u8() !== 0
  reader.skip(3)
  return {
    drawFromCenter,
    width: reader.f32(),
    height: reader.f32(),
    maxPartsWidth: reader.f32(),
    maxPartsHeight: reader.f32(),
    name: reader.cstring()
  }
}

function writeLayoutInfo(writer: BinaryWriter, info: LayoutInfo): void {
  writer.section('lyt1', () => {
    writer.u8(info.drawFromCenter ? 1 : 0)
    writer.zeros(3)
    writer.f32(info.width)
    writer.f32(info.height)
    writer.f32(info.maxPartsWidth)
    writer.f32(info.maxPartsHeight)
    writer.cstring(info.name)
  })
}

function detectPlatform(littleEndian: boolean, major: number): LayoutPlatform {
  if (!littleEndian) return 'wiiu'
  return major === 3 ? 'ctr' : 'switch'
}

export function parseBflyt(data: Uint8Array): ParsedLayout {
  if (!isBflyt(data)) {
    throw new FormatParseError({ format: 'bflyt', offset: 0, message: 'missing FLYT signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: false })
  const bom = reader.at(0x04, () => reader.u16be())
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'bflyt',
      offset: 0x04,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  reader.littleEndian = bom === 0xfffe

  reader.seek(0x06)
  const headerSize = reader.u16()
  const rawVersion = reader.u32()
  const fileSize = reader.u32()
  const sectionCount = reader.u16()

  const version = decodeVersion(rawVersion)
  const major = version.major

  if (fileSize > data.length) {
    throw new FormatParseError({
      format: 'bflyt',
      offset: 0x0c,
      message: `header claims ${fileSize} bytes but only ${data.length} are present`
    })
  }

  const sources: PreservedSources = new Map()
  const unknownSections: UnknownSection[] = []
  /**
   * False once the group tree starts, which is what ends the pane tree.
   *
   * A usd1 before that point belongs to the pane just read; one after it belongs to
   * whatever follows the trees (cnt1, in practice) and is preserved as an opaque
   * trailing section instead.
   */
  let inPaneTree = true

  let info: LayoutInfo = {
    drawFromCenter: false,
    width: 1280,
    height: 720,
    maxPartsWidth: 0,
    maxPartsHeight: 0,
    name: ''
  }
  let textures: string[] = []
  let fonts: string[] = []
  const materials: Material[] = []
  let rootPane: Pane | null = null
  let rootGroup: GroupPane | null = null
  let layoutUserData: UserData | null = null

  // Two independent trees, each driven by its own push/pop markers.
  const paneStack: Pane[] = []
  const groupStack: GroupPane[] = []
  let lastPane: Pane | null = null
  let lastGroup: GroupPane | null = null

  reader.seek(headerSize)

  for (let index = 0; index < sectionCount; index++) {
    if (reader.remaining < 8) break

    const sectionStart = reader.tell()
    const signature = reader.fixedString(4)
    const sectionSize = reader.u32()

    if (sectionSize < 8 || sectionStart + sectionSize > data.length) {
      throw new FormatParseError({
        format: 'bflyt',
        offset: sectionStart,
        section: signature,
        message: `section ${signature} declares a size of ${sectionSize} bytes, which runs past the end of the file`
      })
    }
    const sectionEnd = sectionStart + sectionSize

    if (PUSH_POP.has(signature)) {
      if (signature === 'pas1') {
        if (lastPane) paneStack.push(lastPane)
      } else if (signature === 'pae1') {
        paneStack.pop()
      } else if (signature === 'grs1') {
        if (lastGroup) groupStack.push(lastGroup)
      } else {
        groupStack.pop()
      }
      reader.seek(sectionEnd)
      continue
    }

    if (isPaneKind(signature)) {
      const pane = readPane(reader, signature, sectionStart, sectionEnd, major)
      sources.set(pane.id, data.slice(sectionStart, sectionEnd))

      const parent = paneStack[paneStack.length - 1]
      if (parent) parent.children.push(pane)
      else if (!rootPane) rootPane = pane

      lastPane = pane
      reader.seek(sectionEnd)
      continue
    }

    switch (signature) {
      case 'lyt1':
        info = readLayoutInfo(reader)
        break

      case 'txl1':
        textures = readStringList(reader)
        break

      case 'fnl1':
        fonts = readStringList(reader)
        break

      case 'mat1': {
        const count = reader.u16()
        reader.skip(2)
        const offsets: number[] = []
        for (let i = 0; i < count; i++) offsets.push(reader.u32())

        for (let i = 0; i < count; i++) {
          const start = sectionStart + offsets[i]!
          const end = i + 1 < count ? sectionStart + offsets[i + 1]! : sectionEnd
          reader.seek(start)
          materials.push(readMaterial(reader, major, end))
          sources.set(`mat:${i}`, data.slice(start, end))
        }
        break
      }

      case 'usd1': {
        /**
         * User data attaches to the pane just read — but only while the pane tree
         * is still being read. Real files also carry a usd1 at the very end, after
         * the group tree and after cnt1, which belongs to whatever cnt1 describes
         * rather than to the last pane. Attaching it to that pane writes it back in
         * the wrong place, so once the pane tree is closed it is preserved as an
         * opaque trailing section instead.
         */
        if (!inPaneTree) {
          unknownSections.push({
            signature,
            index,
            data: [...data.slice(sectionStart + 8, sectionEnd)]
          })
          sources.set(`unknown:${index}`, data.slice(sectionStart, sectionEnd))
          break
        }

        const parsed = readUserData(reader, sectionStart, sectionEnd)
        const raw = data.slice(sectionStart, sectionEnd)
        // Attaches to the pane just read; before any pane it belongs to the layout.
        if (lastPane) {
          lastPane.userData = parsed
          sources.set(`usd1:${lastPane.id}`, raw)
        } else {
          layoutUserData = parsed
          sources.set('layoutUserData', raw)
        }
        break
      }

      case 'grp1': {
        inPaneTree = false
        const group = readGroup(reader, major)
        sources.set(`grp:${group.id}`, data.slice(sectionStart, sectionEnd))

        const parent = groupStack[groupStack.length - 1]
        if (parent) parent.children.push(group)
        else if (!rootGroup) rootGroup = group

        lastGroup = group
        break
      }

      default:
        // Unrecognised: replayed verbatim so saving never drops data. The payload
        // lives in the document as well as the sources table, so a re-encode from
        // the model alone is still lossless.
        //
        // Deliberately does NOT close the pane tree: ctl1 sits before the panes in
        // real files, and treating it as the boundary sent every pane's user data
        // to the trailing bucket instead of to its pane.
        unknownSections.push({
          signature,
          index,
          data: [...data.slice(sectionStart + 8, sectionEnd)]
        })
        sources.set(`unknown:${index}`, data.slice(sectionStart, sectionEnd))
        break
    }

    reader.seek(sectionEnd)
  }

  const document: LayoutDocument = {
    version,
    littleEndian: reader.littleEndian,
    platform: detectPlatform(reader.littleEndian, major),
    info,
    textures,
    fonts,
    materials,
    rootPane,
    rootGroup,
    layoutUserData,
    unknownSections
  }

  sources.set('__original__', data.slice(0))
  return { document, sources }
}

/** True when any part of the document has been edited since parsing. */
export function isDocumentDirty(document: LayoutDocument): boolean {
  if (document.materials.some((material) => material.dirty)) return true
  if (document.layoutUserData?.dirty) return true

  let dirty = false
  walkPanes(document.rootPane, (pane) => {
    if (pane.dirty || pane.userData?.dirty) dirty = true
  })
  if (dirty) return true

  const groupDirty = (group: GroupPane | null): boolean => {
    if (!group) return false
    if (group.dirty) return true
    return group.children.some(groupDirty)
  }
  return groupDirty(document.rootGroup)
}

interface WriteContext {
  writer: BinaryWriter
  sources: PreservedSources | undefined
  major: number
  count: number
  /** Unmodelled sections still to place, ordered by their original index. */
  pendingUnknown: UnknownSection[]
}

/**
 * Writes any unmodelled sections whose turn has come.
 *
 * These are not all trailing: `ctl1` appears near the front of the stream in real
 * files, so emitting them at the end reproduces the right bytes in the wrong order.
 * Each carries the index it had when parsed, and is written once the section
 * counter reaches it.
 */
function emitPendingUnknown(ctx: WriteContext): void {
  while (ctx.pendingUnknown.length > 0 && ctx.pendingUnknown[0]!.index <= ctx.count) {
    const section = ctx.pendingUnknown.shift()!
    const preserved = ctx.sources?.get(`unknown:${section.index}`)
    if (preserved) ctx.writer.bytes(preserved)
    // section() re-adds the 8-byte header the stored payload excludes.
    else ctx.writer.section(section.signature, () => ctx.writer.bytes(new Uint8Array(section.data)))
    ctx.count++
  }
}

/** Emits a pane's original bytes when it is clean, re-encoding only if edited. */
function emitPane(ctx: WriteContext, pane: Pane): void {
  emitPendingUnknown(ctx)
  const preserved = pane.dirty ? undefined : ctx.sources?.get(pane.id)
  if (preserved) ctx.writer.bytes(preserved)
  else writePane(ctx.writer, pane, ctx.major)
  ctx.count++

  if (pane.userData) {
    const userSource = pane.userData.dirty ? undefined : ctx.sources?.get(`usd1:${pane.id}`)
    if (userSource) {
      ctx.writer.bytes(userSource)
      ctx.count++
    } else {
      writeUserData(ctx, pane.userData)
    }
  }

  if (pane.children.length > 0) {
    ctx.writer.section('pas1', () => undefined)
    ctx.count++
    for (const child of pane.children) emitPane(ctx, child)
    ctx.writer.section('pae1', () => undefined)
    ctx.count++
  }
}

function writeUserData(ctx: WriteContext, userData: UserData): void {
  const { writer } = ctx

  // Untouched user data is replayed byte for byte; see UserData.raw.
  if (!userData.dirty && userData.raw.length > 0) {
    writer.section('usd1', () => writer.bytes(new Uint8Array(userData.raw)))
    ctx.count++
    return
  }

  writer.section('usd1', () => {
    writer.u16(userData.entries.length)
    writer.u16(0)

    const starts: number[] = []
    const namePatches: ReturnType<BinaryWriter['defer']>[] = []
    const dataPatches: ReturnType<BinaryWriter['defer']>[] = []

    for (const entry of userData.entries) {
      starts.push(writer.tell())
      namePatches.push(writer.defer('u32'))
      dataPatches.push(writer.defer('u32'))
      // Structs keep the count they came with; see readUserData. The others are
      // derived so an edited value stays consistent with its own length.
      const length =
        entry.kind === 'string'
          ? (entry.stringValue?.length ?? 0) + 1
          : entry.kind === 'struct'
            ? entry.itemCount
            : entry.numberValues.length
      writer.u16(length)
      writer.u8(Math.max(0, USER_DATA_KINDS.indexOf(entry.kind)))
      writer.u8(entry.unknown)
    }

    userData.entries.forEach((entry, index) => {
      dataPatches[index]!.set(writer.tell() - starts[index]!)
      switch (entry.kind) {
        case 'string':
          writer.cstring(entry.stringValue ?? '')
          break
        case 'int':
          for (const value of entry.numberValues) writer.i32(value)
          break
        case 'float':
          for (const value of entry.numberValues) writer.f32(value)
          break
        default:
          if (entry.structValue) writer.bytes(new Uint8Array(entry.structValue))
          break
      }
    })

    userData.entries.forEach((entry, index) => {
      namePatches[index]!.set(writer.tell() - starts[index]!)
      writer.cstring(entry.name)
    })
  })
  ctx.count++
}

function emitGroup(ctx: WriteContext, group: GroupPane): void {
  emitPendingUnknown(ctx)
  const preserved = group.dirty ? undefined : ctx.sources?.get(`grp:${group.id}`)
  if (preserved) ctx.writer.bytes(preserved)
  else writeGroup(ctx.writer, group, ctx.major)
  ctx.count++

  if (group.children.length > 0) {
    ctx.writer.section('grs1', () => undefined)
    ctx.count++
    for (const child of group.children) emitGroup(ctx, child)
    ctx.writer.section('gre1', () => undefined)
    ctx.count++
  }
}

export function writeBflyt(document: LayoutDocument, sources?: PreservedSources): Uint8Array {
  // Fast path: an untouched document is written back byte-for-byte.
  const original = sources?.get('__original__')
  if (original && !isDocumentDirty(document)) return original.slice(0)

  const writer = new BinaryWriter({ littleEndian: document.littleEndian })
  const major = document.version.major

  writer.magic(MAGIC)
  writer.u16be(document.littleEndian ? 0xfffe : 0xfeff)
  writer.u16(HEADER_SIZE)
  writer.u32(encodeVersion(document.version))
  const fileSizePatch = writer.defer('u32')
  const sectionCountPatch = writer.defer('u16')
  writer.u16(0)

  const ctx: WriteContext = {
    writer,
    sources,
    major,
    count: 0,
    // Sorted so the counter can consume them in stream order.
    pendingUnknown: [...document.unknownSections].sort((a, b) => a.index - b.index)
  }

  writeLayoutInfo(writer, document.info)
  ctx.count++
  emitPendingUnknown(ctx)

  if (document.layoutUserData) {
    const preserved = document.layoutUserData.dirty ? undefined : sources?.get('layoutUserData')
    if (preserved) {
      writer.bytes(preserved)
      ctx.count++
    } else {
      writeUserData(ctx, document.layoutUserData)
    }
  }

  emitPendingUnknown(ctx)
  if (document.textures.length > 0) {
    writer.section('txl1', () => writeStringList(writer, document.textures))
    ctx.count++
  }

  if (document.fonts.length > 0) {
    writer.section('fnl1', () => writeStringList(writer, document.fonts))
    ctx.count++
  }

  if (document.materials.length > 0) {
    writer.section('mat1', () => {
      const sectionStart = writer.tell() - 8
      writer.u16(document.materials.length)
      writer.u16(0)
      const patches = document.materials.map(() => writer.defer('u32'))
      document.materials.forEach((material, index) => {
        patches[index]!.set(writer.tell() - sectionStart)
        const preserved = material.dirty ? undefined : sources?.get(`mat:${index}`)
        if (preserved) writer.bytes(preserved)
        else writeMaterial(writer, material, major)
      })
    })
    ctx.count++
  }

  if (document.rootPane) emitPane(ctx, document.rootPane)
  if (document.rootGroup) emitGroup(ctx, document.rootGroup)

  // Anything left belongs after the trees; ctl1-style sections were already
  // placed as the counter passed their index.
  for (const section of ctx.pendingUnknown) {
    const preserved = sources?.get(`unknown:${section.index}`)
    if (preserved) writer.bytes(preserved)
    else writer.section(section.signature, () => writer.bytes(new Uint8Array(section.data)))
    ctx.count++
  }
  ctx.pendingUnknown = []

  fileSizePatch.set(writer.length)
  sectionCountPatch.set(ctx.count)

  return writer.toBytes()
}
