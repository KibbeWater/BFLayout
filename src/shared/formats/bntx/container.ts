import { BinaryReader } from '@shared/binary/reader'
import { FormatParseError } from '@shared/binary/errors'
import type { BntxFormat, BntxFormatVariant } from './format'

/**
 * BNTX — the texture container Nintendo ships alongside layouts (timg/ inside
 * a SARC). It is an nn::gfx resource file: a generic binary header, then an
 * "NX  " platform header pointing at an array of BRTI texture-info blocks,
 * then one BRTD blob holding every texture's tiled pixel data.
 *
 * Header offsets (little-endian in every shipped file):
 *
 *   BNTX header
 *   0x00 magic "BNTX", 0x04 four zero bytes
 *   0x08 versionMicro u8, 0x09 versionMinor u8, 0x0a versionMajor u16
 *   0x0c byte-order mark u16 (0xfffe little, 0xfeff big)
 *   0x0e alignment exponent u8, 0x0f target address size u8
 *   0x10 name offset u32, 0x14 flags u16, 0x16 first block offset u16
 *   0x18 relocation table offset u32, 0x1c file size u32
 *
 *   NX header (immediately after, at 0x20)
 *   0x20 magic ("NX  ", "Ounc" or "PC  "), 0x24 texture count u32
 *   0x28 texture info pointer array u64, 0x30 texture data pointer u64
 *   0x38 texture dictionary pointer u64, 0x40 memory pool pointer u64
 *   0x48, 0x50 reserved u64
 *
 *   BRTI block (offsets relative to the block start)
 *   0x00 magic "BRTI", 0x04 block size u32, 0x08 next block pointer u64
 *   0x10 flags u8, 0x11 storage dimension u8, 0x12 tile mode u16
 *   0x14 swizzle u16, 0x16 mip count u16, 0x18 sample count u32
 *   0x1c image format u32, 0x20 gpu access flags u32
 *   0x24 width u32, 0x28 height u32, 0x2c depth u32, 0x30 array count u32
 *   0x34 texture layout u32, 0x38 texture layout 2 u32, 0x3c reserved[20]
 *   0x50 image size u32, 0x54 alignment u32
 *   0x58 channel source R/G/B/A u8 each, 0x5c image dimension u32
 *   0x60 name pointer u64, 0x68 container pointer u64
 *   0x70 mip pointer array u64, 0x78 user data pointer u64
 *   0x80 texture pointer u64, 0x88 texture view pointer u64
 *   0x90 descriptor slot pointer u64, 0x98 user data dictionary pointer u64
 */

const BNTX_HEADER_SIZE = 0x20
const NX_HEADER_OFFSET = 0x20
const BRTI_SIZE = 0xa0
const BLOCK_HEIGHT_LOG2_MASK = 7

export interface BntxTexture {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly depth: number
  readonly mipCount: number
  readonly arrayCount: number
  /** Channel layout — the high 8 bits of the BRTI format word. */
  readonly format: BntxFormat
  /** Data interpretation — the low 8 bits of the BRTI format word. */
  readonly formatVariant: BntxFormatVariant
  /** `nn::gfx::TileMode`; see BntxTileMode in ./swizzle. */
  readonly tileMode: number
  readonly swizzle: number
  /** Block height of mip 0, as log2 GOBs — the low 3 bits of textureLayout. */
  readonly blockHeightLog2: number
  readonly textureLayout: number
  readonly textureLayout2: number
  readonly sampleCount: number
  readonly alignment: number
  readonly flags: number
  readonly storageDimension: number
  readonly imageDimension: number
  readonly gpuAccessFlags: number
  /** Output channel sources in R, G, B, A order; see BntxChannelSource. */
  readonly channelSources: readonly [number, number, number, number]
  /** Byte offset of each mip level within imageData; entry 0 is always 0. */
  readonly mipOffsets: readonly number[]
  /** Tiled pixel data for every mip level and array layer. */
  readonly imageData: Uint8Array
}

export interface BntxContainer {
  readonly name: string
  readonly littleEndian: boolean
  readonly version: { readonly major: number; readonly minor: number; readonly micro: number }
  /** Platform tag from the NX header: "NX  ", "Ounc" or "PC  ". */
  readonly target: string
  readonly alignment: number
  readonly textures: readonly BntxTexture[]
}

export function isBntx(data: Uint8Array): boolean {
  return (
    data.length >= BNTX_HEADER_SIZE &&
    data[0] === 0x42 &&
    data[1] === 0x4e &&
    data[2] === 0x54 &&
    data[3] === 0x58
  )
}

/**
 * Reads a 64-bit file pointer. Every offset in a shipped BNTX fits in 32 bits;
 * a set high word means the file is not what we think it is.
 */
function pointer(reader: BinaryReader, section: string): number {
  const offset = reader.tell()
  const first = reader.u32()
  const second = reader.u32()
  const low = reader.littleEndian ? first : second
  const high = reader.littleEndian ? second : first
  if (high !== 0) {
    throw new FormatParseError({
      format: 'bntx',
      offset,
      section,
      message: `64-bit offset 0x${high.toString(16)}${low.toString(16)} is out of range`
    })
  }
  return low
}

/** BNTX strings are a u16 byte length followed by NUL-terminated UTF-8. */
function nameAt(reader: BinaryReader, offset: number, section: string): string {
  if (offset < 0 || offset + 2 > reader.length) {
    throw new FormatParseError({
      format: 'bntx',
      offset,
      section,
      message: 'name offset is outside the file'
    })
  }
  return reader.at(offset, () => {
    const length = reader.u16()
    return reader.fixedString(length)
  })
}

export function parseBntx(data: Uint8Array): BntxContainer {
  if (!isBntx(data)) {
    throw new FormatParseError({ format: 'bntx', offset: 0, message: 'missing BNTX signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: false })

  const bom = reader.at(0x0c, () => reader.u16be())
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'bntx',
      offset: 0x0c,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  reader.littleEndian = bom === 0xfffe

  reader.seek(0x08)
  const versionMicro = reader.u8()
  const versionMinor = reader.u8()
  const versionMajor = reader.u16()
  reader.skip(2) // byte-order mark
  const alignmentExponent = reader.u8()
  reader.skip(1) // target address size
  const containerNameOffset = reader.u32()
  reader.skip(2) // flags
  reader.skip(2) // first block offset
  reader.skip(4) // relocation table offset
  const fileSize = reader.u32()

  if (fileSize > data.length) {
    throw new FormatParseError({
      format: 'bntx',
      offset: 0x1c,
      message: `header claims ${fileSize} bytes but only ${data.length} are present`
    })
  }

  reader.seek(NX_HEADER_OFFSET)
  const target = reader.fixedString(4)
  if (target !== 'NX  ' && target !== 'Ounc' && target !== 'PC  ') {
    throw new FormatParseError({
      format: 'bntx',
      offset: NX_HEADER_OFFSET,
      section: 'NX',
      message: `unrecognised platform header "${target}"`
    })
  }
  const textureCount = reader.u32()
  const textureInfoArray = pointer(reader, 'NX')

  // The container name offset points at the characters; the u16 length that
  // every other BNTX string carries inline sits two bytes before it.
  const name = nameAt(reader, containerNameOffset - 2, 'name')

  const textures: BntxTexture[] = []
  for (let i = 0; i < textureCount; i++) {
    const infoOffset = reader.at(textureInfoArray + i * 8, () => pointer(reader, 'BRTI pointer'))
    textures.push(parseTextureInfo(reader, infoOffset, i))
  }

  return {
    name,
    littleEndian: reader.littleEndian,
    version: { major: versionMajor, minor: versionMinor, micro: versionMicro },
    target,
    alignment: 1 << alignmentExponent,
    textures
  }
}

function parseTextureInfo(reader: BinaryReader, offset: number, index: number): BntxTexture {
  const section = `BRTI[${index}]`

  if (offset + BRTI_SIZE > reader.length) {
    throw new FormatParseError({
      format: 'bntx',
      offset,
      section,
      message: 'texture info block runs past the end of the file'
    })
  }

  reader.seek(offset)
  if (reader.fixedString(4) !== 'BRTI') {
    throw new FormatParseError({
      format: 'bntx',
      offset,
      section,
      message: 'missing BRTI signature'
    })
  }

  reader.seek(offset + 0x10)
  const flags = reader.u8()
  const storageDimension = reader.u8()
  const tileMode = reader.u16()
  const swizzle = reader.u16()
  const mipCount = reader.u16()
  const sampleCount = reader.u32()
  const formatWord = reader.u32()
  const gpuAccessFlags = reader.u32()
  const width = reader.u32()
  const height = reader.u32()
  const depth = reader.u32()
  const arrayCount = reader.u32()
  const textureLayout = reader.u32()
  const textureLayout2 = reader.u32()

  reader.seek(offset + 0x50)
  const imageSize = reader.u32()
  const alignment = reader.u32()
  const channelSources: readonly [number, number, number, number] = [
    reader.u8(),
    reader.u8(),
    reader.u8(),
    reader.u8()
  ]
  const imageDimension = reader.u32()
  const nameOffset = pointer(reader, section)
  reader.skip(8) // container pointer
  const mipPointerArray = pointer(reader, section)

  if (width === 0 || height === 0) {
    throw new FormatParseError({
      format: 'bntx',
      offset: offset + 0x24,
      section,
      message: `degenerate texture dimensions ${width}x${height}`
    })
  }

  const name = nameAt(reader, nameOffset, section)
  const levels = Math.max(1, mipCount)

  // Mip pointers are absolute file offsets into the BRTD blob. The first one is
  // where this texture's data starts; the rest become relative offsets.
  let imageData: Uint8Array = new Uint8Array(0)
  const mipOffsets: number[] = [0]
  if (mipPointerArray !== 0) {
    const absolute = reader.at(mipPointerArray, () => {
      const out: number[] = []
      for (let level = 0; level < levels; level++) out.push(pointer(reader, section))
      return out
    })
    const base = absolute[0]!
    if (base + imageSize > reader.length) {
      throw new FormatParseError({
        format: 'bntx',
        offset: base,
        section,
        message: `image data range [${base}, ${base + imageSize}) is outside the file`
      })
    }
    imageData = reader.bytesAt(base, imageSize)
    for (let level = 1; level < levels; level++) mipOffsets.push(absolute[level]! - base)
  }

  return {
    name,
    width,
    height,
    depth: Math.max(1, depth),
    mipCount: levels,
    arrayCount: Math.max(1, arrayCount),
    format: (formatWord >>> 8) & 0xff,
    formatVariant: formatWord & 0xff,
    tileMode,
    swizzle,
    blockHeightLog2: textureLayout & BLOCK_HEIGHT_LOG2_MASK,
    textureLayout,
    textureLayout2,
    sampleCount,
    alignment,
    flags,
    storageDimension,
    imageDimension,
    gpuAccessFlags,
    channelSources,
    mipOffsets,
    imageData
  }
}
