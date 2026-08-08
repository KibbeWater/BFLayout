import type { BinaryReader } from '@shared/binary/reader'
import type { BinaryWriter } from '@shared/binary/writer'
import { FormatParseError } from '@shared/binary/errors'

import type {
  Pane,
  PaneBase,
  PaneKind,
  PaneOrigin,
  PartProperty,
  Rgba,
  TexCoordSet,
  Vec2,
  Vec3,
  WindowContent,
  WindowFrame
} from './types'

let paneCounter = 0
export function nextPaneId(prefix = 'pane'): string {
  return `${prefix}_${(++paneCounter).toString(36)}`
}

/** Both origins live in one byte: low nibble self, high nibble parent. */
function decodeOrigin(byte: number): PaneOrigin {
  const self = byte & 0x0f
  const parent = (byte >> 4) & 0x0f
  return {
    x: self % 4,
    y: Math.floor(self / 4),
    parentX: parent % 4,
    parentY: Math.floor(parent / 4)
  }
}

function encodeOrigin(origin: PaneOrigin): number {
  const self = (origin.y * 4 + origin.x) & 0x0f
  const parent = (origin.parentY * 4 + origin.parentX) & 0x0f
  return ((parent << 4) | self) & 0xff
}

function readTexCoordSet(reader: BinaryReader): TexCoordSet {
  return {
    topLeft: [reader.f32(), reader.f32()],
    topRight: [reader.f32(), reader.f32()],
    bottomLeft: [reader.f32(), reader.f32()],
    bottomRight: [reader.f32(), reader.f32()]
  }
}

function writeTexCoordSet(writer: BinaryWriter, set: TexCoordSet): void {
  for (const uv of [set.topLeft, set.topRight, set.bottomLeft, set.bottomRight]) {
    writer.f32(uv[0])
    writer.f32(uv[1])
  }
}

/** Rounds up to the next multiple of four, the padding these sections use. */
function align4(value: number): number {
  return (value + 3) & ~3
}

function readBase(reader: BinaryReader): Omit<PaneBase, 'id' | 'children' | 'userData' | 'dirty' | 'trailing'> {
  const flags1 = reader.u8()
  const originByte = reader.u8()
  const alpha = reader.u8()
  const paneMagFlags = reader.u8()
  const name = reader.fixedString(0x18)
  const userDataInfo = reader.fixedString(0x08)
  const translate = [reader.f32(), reader.f32(), reader.f32()] as Vec3
  const rotate = [reader.f32(), reader.f32(), reader.f32()] as Vec3
  const scale = [reader.f32(), reader.f32()] as Vec2
  const width = reader.f32()
  const height = reader.f32()

  return {
    name,
    userDataInfo,
    visible: (flags1 & 0x01) !== 0,
    influenceAlpha: (flags1 & 0x02) !== 0,
    baseFlags: flags1,
    alpha,
    origin: decodeOrigin(originByte),
    paneMagFlags,
    translate,
    rotate,
    scale,
    width,
    height
  }
}

function writeBase(writer: BinaryWriter, pane: PaneBase): void {
  // Keep every bit that is not modelled, and set the two that are.
  let flags1 = pane.baseFlags & ~0x03
  if (pane.visible) flags1 |= 0x01
  if (pane.influenceAlpha) flags1 |= 0x02

  writer.u8(flags1)
  writer.u8(encodeOrigin(pane.origin))
  writer.u8(pane.alpha)
  writer.u8(pane.paneMagFlags)
  writer.fixedString(pane.name, 0x18)
  writer.fixedString(pane.userDataInfo, 0x08)
  writer.f32(pane.translate[0])
  writer.f32(pane.translate[1])
  writer.f32(pane.translate[2])
  writer.f32(pane.rotate[0])
  writer.f32(pane.rotate[1])
  writer.f32(pane.rotate[2])
  writer.f32(pane.scale[0])
  writer.f32(pane.scale[1])
  writer.f32(pane.width)
  writer.f32(pane.height)
}

function readWindowContent(reader: BinaryReader): WindowContent {
  const colorTopLeft = [...reader.rgba8()] as Rgba
  const colorTopRight = [...reader.rgba8()] as Rgba
  const colorBottomLeft = [...reader.rgba8()] as Rgba
  const colorBottomRight = [...reader.rgba8()] as Rgba
  const materialIndex = reader.u16()
  const uvCount = reader.u8()
  reader.skip(1)
  const texCoords: TexCoordSet[] = []
  for (let i = 0; i < uvCount; i++) texCoords.push(readTexCoordSet(reader))
  return {
    colorTopLeft,
    colorTopRight,
    colorBottomLeft,
    colorBottomRight,
    materialIndex,
    texCoords
  }
}

function writeWindowContent(writer: BinaryWriter, content: WindowContent): void {
  writer.rgba8(content.colorTopLeft)
  writer.rgba8(content.colorTopRight)
  writer.rgba8(content.colorBottomLeft)
  writer.rgba8(content.colorBottomRight)
  writer.u16(content.materialIndex)
  writer.u8(content.texCoords.length)
  writer.zeros(1)
  for (const set of content.texCoords) writeTexCoordSet(writer, set)
}

/**
 * Reads one pane section body. `sectionStart` is the offset of the section
 * signature, which every internal pointer in these sections is relative to.
 */
export function readPane(
  reader: BinaryReader,
  kind: PaneKind,
  sectionStart: number,
  sectionEnd: number,
  major: number
): Pane {
  const base = readBase(reader)
  const common = {
    ...base,
    id: nextPaneId(kind),
    children: [],
    userData: null,
    trailing: [] as number[],
    dirty: false
  }

  switch (kind) {
    // Kinds with no modelled body of their own: whatever follows the common
    // header is kept verbatim so version-specific extras are not lost.
    case 'pan1':
    case 'bnd1':
    case 'scr1':
    case 'ali1':
      return {
        kind,
        ...common,
        trailing: [...reader.readBytes(Math.max(0, sectionEnd - reader.tell()))]
      }

    case 'pic1': {
      const colorTopLeft = [...reader.rgba8()] as Rgba
      const colorTopRight = [...reader.rgba8()] as Rgba
      const colorBottomLeft = [...reader.rgba8()] as Rgba
      const colorBottomRight = [...reader.rgba8()] as Rgba
      const materialIndex = reader.u16()
      const uvCount = reader.u8()
      reader.skip(1)
      const texCoords: TexCoordSet[] = []
      for (let i = 0; i < uvCount; i++) texCoords.push(readTexCoordSet(reader))
      return {
        kind,
        ...common,
        colorTopLeft,
        colorTopRight,
        colorBottomLeft,
        colorBottomRight,
        materialIndex,
        texCoords
      }
    }

    case 'txt1': {
      // Field one is the runtime capacity, field two the bytes actually stored.
      // Reading the string at the capacity overruns the section; see TextPane.
      const textCapacityBytes = reader.u16()
      const maxTextLength = reader.u16()
      const materialIndex = reader.u16()
      const fontIndex = reader.u16()
      const textAlignment = reader.u8()
      const lineAlignment = reader.u8()
      const flags = reader.u8()
      const unknown = reader.u8()
      const italicTilt = reader.f32()
      const textOffset = reader.u32()
      const fontTopColor = [...reader.rgba8()] as Rgba
      const fontBottomColor = [...reader.rgba8()] as Rgba
      const fontSize = [reader.f32(), reader.f32()] as Vec2
      const charSpace = reader.f32()
      const lineSpace = reader.f32()
      const nameOffset = reader.u32()
      const shadowPosition = [reader.f32(), reader.f32()] as Vec2
      const shadowSize = [reader.f32(), reader.f32()] as Vec2
      const shadowForeColor = [...reader.rgba8()] as Rgba
      const shadowBackColor = [...reader.rgba8()] as Rgba
      const shadowItalic = reader.f32()

      // The per-character transform pointer only exists past version 2.
      const perCharOffset = major > 2 ? reader.u32() : 0
      const extra = major >= 8 ? reader.f32() : null

      const textStart = sectionStart + textOffset
      // Clamped to the section: a malformed length must not read into the next one.
      const storedTextBytes = Math.max(
        0,
        Math.min(maxTextLength, Math.max(0, sectionEnd - textStart))
      )
      const text =
        textOffset > 0 && storedTextBytes > 0
          ? reader.at(textStart, () => reader.utf16String(storedTextBytes))
          : ''

      const textBoxName =
        nameOffset > 0 ? reader.at(sectionStart + nameOffset, () => reader.cstring()) : ''

      // Extent is unknown, so keep everything from the pointer to the section
      // end rather than guessing a size and truncating it.
      /**
       * Everything this build addresses inside a txt1 lives at one of three
       * offsets. The furthest of them marks where the modelled data ends; anything
       * past that is an unmodelled block kept verbatim.
       */
      const textEnd = textOffset > 0 ? textStart + storedTextBytes : sectionStart
      const nameEnd =
        nameOffset > 0
          ? sectionStart + nameOffset + textBoxName.length + 1
          : sectionStart
      const modelledEnd = align4(Math.max(textEnd, nameEnd))

      const perCharStart = sectionStart + perCharOffset
      const perCharTransform =
        perCharOffset > 0 && perCharStart < sectionEnd
          ? [...reader.bytesAt(perCharStart, sectionEnd - perCharStart)]
          : null

      const trailingData =
        perCharOffset > 0 || modelledEnd >= sectionEnd
          ? []
          : [...reader.bytesAt(modelledEnd, sectionEnd - modelledEnd)]

      return {
        kind,
        ...common,
        text,
        textCapacityBytes,
        maxTextLength,
        materialIndex,
        fontIndex,
        textAlignment,
        lineAlignment,
        flags,
        unknown,
        italicTilt,
        fontTopColor,
        fontBottomColor,
        fontSize,
        charSpace,
        lineSpace,
        shadowPosition,
        shadowSize,
        shadowForeColor,
        shadowBackColor,
        shadowItalic,
        textBoxName,
        perCharTransform,
        extra,
        trailingData
      }
    }

    case 'wnd1': {
      const stretchLeft = reader.u16()
      const stretchRight = reader.u16()
      const stretchTop = reader.u16()
      const stretchBottom = reader.u16()
      const frameElemLeft = reader.u16()
      const frameElemRight = reader.u16()
      const frameElemTop = reader.u16()
      const frameElemBottom = reader.u16()
      const frameCount = reader.u8()
      const flag = reader.u8()
      reader.skip(2)
      const contentOffset = reader.u32()
      const frameTableOffset = reader.u32()

      const content =
        contentOffset > 0
          ? reader.at(sectionStart + contentOffset, () => readWindowContent(reader))
          : {
              colorTopLeft: [255, 255, 255, 255] as Rgba,
              colorTopRight: [255, 255, 255, 255] as Rgba,
              colorBottomLeft: [255, 255, 255, 255] as Rgba,
              colorBottomRight: [255, 255, 255, 255] as Rgba,
              materialIndex: 0,
              texCoords: []
            }

      const frames: WindowFrame[] = []
      if (frameTableOffset > 0 && frameCount > 0) {
        reader.at(sectionStart + frameTableOffset, () => {
          const pointers: number[] = []
          for (let i = 0; i < frameCount; i++) pointers.push(reader.u32())
          for (const pointer of pointers) {
            reader.at(sectionStart + pointer, () => {
              const materialIndex = reader.u16()
              const textureFlip = reader.u8()
              reader.skip(1)
              frames.push({ materialIndex, textureFlip })
            })
          }
        })
      }

      return {
        kind,
        ...common,
        stretchLeft,
        stretchRight,
        stretchTop,
        stretchBottom,
        frameElemLeft,
        frameElemRight,
        frameElemTop,
        frameElemBottom,
        flag,
        content,
        frames
      }
    }

    case 'prt1': {
      const propertyCount = reader.u32()
      const magnify = [reader.f32(), reader.f32()] as Vec2

      interface RawProperty {
        name: string
        usageFlag: number
        basicUsageFlag: number
        materialUsageFlag: number
        propertyOffset: number
        secondOffset: number
        panelInfoOffset: number
      }

      const raw: RawProperty[] = []
      for (let i = 0; i < propertyCount; i++) {
        const name = reader.fixedString(0x18)
        const usageFlag = reader.u8()
        const basicUsageFlag = reader.u8()
        const materialUsageFlag = reader.u8()
        reader.skip(1)
        raw.push({
          name,
          usageFlag,
          basicUsageFlag,
          materialUsageFlag,
          propertyOffset: reader.u32(),
          secondOffset: reader.u32(),
          panelInfoOffset: reader.u32()
        })
      }

      const externalLayoutName = reader.cstring()

      const properties: PartProperty[] = raw.map((entry) => {
        // The override is a whole embedded section: read its size from its own
        // header rather than inferring the extent.
        let overrideSection: number[] | null = null
        if (entry.propertyOffset > 0) {
          const at = sectionStart + entry.propertyOffset
          const size = reader.at(at + 4, () => reader.u32())
          if (size >= 8 && at + size <= sectionEnd) {
            overrideSection = [...reader.bytesAt(at, size)]
          }
        }

        const panelInfo =
          entry.panelInfoOffset > 0 && sectionStart + entry.panelInfoOffset + 52 <= sectionEnd
            ? [...reader.bytesAt(sectionStart + entry.panelInfoOffset, 52)]
            : null

        return {
          name: entry.name,
          usageFlag: entry.usageFlag,
          basicUsageFlag: entry.basicUsageFlag,
          materialUsageFlag: entry.materialUsageFlag,
          overrideSection,
          panelInfo,
          userDataBytes: null,
          unknown: entry.secondOffset
        }
      })

      /**
       * No tail capture here, deliberately.
       *
       * A part's data is reached entirely through offsets, so the reader's cursor
       * after the headers sits *before* those blocks, not after them — treating the
       * remainder as a tail duplicated every property block and inflated 220 files.
       * The four parts that do not round-trip are left as known mismatches rather
       * than papered over with bytes written twice.
       */
      return { kind, ...common, magnify, properties, externalLayoutName, trailingData: [] }
    }

    default: {
      const exhaustive: never = kind
      throw new FormatParseError({
        format: 'bflyt',
        offset: sectionStart,
        message: `unhandled pane kind ${String(exhaustive)}`
      })
    }
  }
}

/**
 * Writes a pane section, including its 8-byte header. Internal pointers are
 * reserved then backfilled once the blocks they point at have been placed.
 */
export function writePane(writer: BinaryWriter, pane: Pane, major: number): void {
  const start = writer.tell()
  writer.magic(pane.kind)
  const sizePatch = writer.defer('u32')

  writeBase(writer, pane)

  switch (pane.kind) {
    case 'pan1':
    case 'bnd1':
    case 'scr1':
    case 'ali1':
      if (pane.trailing.length > 0) writer.bytes(new Uint8Array(pane.trailing))
      break

    case 'pic1': {
      writer.rgba8(pane.colorTopLeft)
      writer.rgba8(pane.colorTopRight)
      writer.rgba8(pane.colorBottomLeft)
      writer.rgba8(pane.colorBottomRight)
      writer.u16(pane.materialIndex)
      writer.u8(pane.texCoords.length)
      writer.zeros(1)
      for (const set of pane.texCoords) writeTexCoordSet(writer, set)
      break
    }

    case 'txt1': {
      // Bytes the string occupies in the file, including its NUL terminator.
      const textBytes = pane.text.length * 2 + 2
      // Runtime capacity is kept as authored, and only grown if the string no
      // longer fits — so an untouched pane writes back byte for byte.
      writer.u16(Math.max(pane.textCapacityBytes, textBytes))
      writer.u16(textBytes)
      writer.u16(pane.materialIndex)
      writer.u16(pane.fontIndex)
      writer.u8(pane.textAlignment)
      writer.u8(pane.lineAlignment)
      writer.u8(pane.flags)
      writer.u8(pane.unknown)
      writer.f32(pane.italicTilt)
      const textPatch = writer.defer('u32')
      writer.rgba8(pane.fontTopColor)
      writer.rgba8(pane.fontBottomColor)
      writer.f32(pane.fontSize[0])
      writer.f32(pane.fontSize[1])
      writer.f32(pane.charSpace)
      writer.f32(pane.lineSpace)
      const namePatch = writer.defer('u32')
      writer.f32(pane.shadowPosition[0])
      writer.f32(pane.shadowPosition[1])
      writer.f32(pane.shadowSize[0])
      writer.f32(pane.shadowSize[1])
      writer.rgba8(pane.shadowForeColor)
      writer.rgba8(pane.shadowBackColor)
      writer.f32(pane.shadowItalic)
      const perCharPatch = major > 2 ? writer.defer('u32') : null
      if (major >= 8) writer.f32(pane.extra ?? 0)

      textPatch.fillFrom(start)
      writer.utf16String(pane.text)
      writer.align(4)

      if (pane.textBoxName) {
        namePatch.fillFrom(start)
        writer.cstring(pane.textBoxName)
        writer.align(4)
      } else {
        namePatch.set(0)
      }

      if (perCharPatch) {
        if (pane.perCharTransform && pane.perCharTransform.length > 0) {
          perCharPatch.fillFrom(start)
          writer.bytes(new Uint8Array(pane.perCharTransform))
          writer.align(4)
        } else {
          perCharPatch.set(0)
        }
      }

      // Unmodelled block past everything above; see TextPane.trailingData.
      if (pane.trailingData.length > 0) writer.bytes(new Uint8Array(pane.trailingData))
      break
    }

    case 'wnd1': {
      writer.u16(pane.stretchLeft)
      writer.u16(pane.stretchRight)
      writer.u16(pane.stretchTop)
      writer.u16(pane.stretchBottom)
      writer.u16(pane.frameElemLeft)
      writer.u16(pane.frameElemRight)
      writer.u16(pane.frameElemTop)
      writer.u16(pane.frameElemBottom)
      writer.u8(pane.frames.length)
      writer.u8(pane.flag)
      writer.zeros(2)
      const contentPatch = writer.defer('u32')
      const framePatch = writer.defer('u32')

      contentPatch.fillFrom(start)
      writeWindowContent(writer, pane.content)
      writer.align(4)

      if (pane.frames.length > 0) {
        framePatch.fillFrom(start)
        const pointers = pane.frames.map(() => writer.defer('u32'))
        for (const [index, frame] of pane.frames.entries()) {
          pointers[index]!.fillFrom(start)
          writer.u16(frame.materialIndex)
          writer.u8(frame.textureFlip)
          writer.zeros(1)
        }
      } else {
        framePatch.set(0)
      }
      break
    }

    case 'prt1': {
      writer.u32(pane.properties.length)
      writer.f32(pane.magnify[0])
      writer.f32(pane.magnify[1])

      const patches = pane.properties.map((property) => {
        writer.fixedString(property.name, 0x18)
        writer.u8(property.usageFlag)
        writer.u8(property.basicUsageFlag)
        writer.u8(property.materialUsageFlag)
        writer.zeros(1)
        const propertyPatch = writer.defer('u32')
        // From version 8 this slot is an opaque value, not a pointer.
        if (major >= 8) writer.u32(property.unknown)
        const userDataPatch = major >= 8 ? null : writer.defer('u32')
        const panelInfoPatch = writer.defer('u32')
        return { property, propertyPatch, userDataPatch, panelInfoPatch }
      })

      writer.cstring(pane.externalLayoutName)
      writer.align(4)

      for (const entry of patches) {
        if (entry.property.overrideSection && entry.property.overrideSection.length > 0) {
          entry.propertyPatch.fillFrom(start)
          writer.bytes(new Uint8Array(entry.property.overrideSection))
          writer.align(4)
        } else {
          entry.propertyPatch.set(0)
        }

        if (entry.userDataPatch) {
          if (entry.property.userDataBytes && entry.property.userDataBytes.length > 0) {
            entry.userDataPatch.fillFrom(start)
            writer.bytes(new Uint8Array(entry.property.userDataBytes))
            writer.align(4)
          } else {
            entry.userDataPatch.set(0)
          }
        }

        if (entry.property.panelInfo && entry.property.panelInfo.length > 0) {
          entry.panelInfoPatch.fillFrom(start)
          writer.bytes(new Uint8Array(entry.property.panelInfo))
          writer.align(4)
        } else {
          entry.panelInfoPatch.set(0)
        }
      }

      // Unmodelled remainder; see PartPane.trailingData.
      if (pane.trailingData.length > 0) writer.bytes(new Uint8Array(pane.trailingData))
      break
    }
  }

  writer.align(4)
  sizePatch.set(writer.tell() - start)
}
