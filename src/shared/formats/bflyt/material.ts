import type { BinaryReader } from '@shared/binary/reader'
import type { BinaryWriter } from '@shared/binary/writer'

import type {
  AlphaCompare,
  BlendMode,
  FontShadowParameter,
  IndirectParameter,
  Material,
  ProjectionTexGenParam,
  Rgba,
  TevStage,
  TexCoordGen,
  TextureRef,
  TextureTransform
} from './types'

/**
 * Material flags pack the counts of every variable-length array plus a
 * presence bit for each optional block, which is why the arrays that follow can
 * only be read after decoding this word.
 */
const FLAG = {
  texCountShift: 0,
  texCountMask: 0x3,
  matrixCountShift: 2,
  matrixCountMask: 0x3,
  texCoordGenCountShift: 4,
  texCoordGenCountMask: 0x3,
  tevStageCountShift: 6,
  tevStageCountMask: 0x7,
  alphaCompare: 9,
  blend: 10,
  useTextureOnly: 11,
  blendLogic: 12,
  indParams: 14,
  projTexGenCountShift: 15,
  projTexGenCountMask: 0x3,
  fontShadow: 17,
  alphaInterpolation: 18
} as const

const bit = (flags: number, index: number): boolean => ((flags >>> index) & 1) === 1
const field = (flags: number, shift: number, mask: number): number => (flags >>> shift) & mask

function readTextureRef(reader: BinaryReader): TextureRef {
  return { textureIndex: reader.i16(), flag1: reader.u8(), flag2: reader.u8() }
}

function writeTextureRef(writer: BinaryWriter, ref: TextureRef): void {
  writer.i16(ref.textureIndex)
  writer.u8(ref.flag1)
  writer.u8(ref.flag2)
}

function readTextureTransform(reader: BinaryReader): TextureTransform {
  return {
    translate: [reader.f32(), reader.f32()],
    rotate: reader.f32(),
    scale: [reader.f32(), reader.f32()]
  }
}

function writeTextureTransform(writer: BinaryWriter, value: TextureTransform): void {
  writer.f32(value.translate[0])
  writer.f32(value.translate[1])
  writer.f32(value.rotate)
  writer.f32(value.scale[0])
  writer.f32(value.scale[1])
}

/** The trailing blob grew from 6 to 14 bytes in version 8. */
const texCoordGenExtra = (major: number): number => (major >= 8 ? 0x0e : 6)

function readTexCoordGen(reader: BinaryReader, major: number): TexCoordGen {
  const matrix = reader.u8()
  const source = reader.u8()
  const unknown = [...reader.readBytes(texCoordGenExtra(major))]
  return { matrix, source, unknown }
}

function writeTexCoordGen(writer: BinaryWriter, value: TexCoordGen, major: number): void {
  writer.u8(value.matrix)
  writer.u8(value.source)
  const size = texCoordGenExtra(major)
  for (let i = 0; i < size; i++) writer.u8(value.unknown[i] ?? 0)
}

function readTevStage(reader: BinaryReader): TevStage {
  const colorFlags = reader.u8()
  const alphaFlags = reader.u8()
  const padding: [number, number] = [reader.u8(), reader.u8()]
  return { colorFlags, alphaFlags, padding }
}

function writeTevStage(writer: BinaryWriter, value: TevStage): void {
  writer.u8(value.colorFlags)
  writer.u8(value.alphaFlags)
  for (const byte of value.padding) writer.u8(byte)
}

function readAlphaCompare(reader: BinaryReader): AlphaCompare {
  const compareMode = reader.u8()
  const padding: [number, number, number] = [reader.u8(), reader.u8(), reader.u8()]
  return { compareMode, padding, value: reader.f32() }
}

function writeAlphaCompare(writer: BinaryWriter, value: AlphaCompare): void {
  writer.u8(value.compareMode)
  for (const byte of value.padding) writer.u8(byte)
  writer.f32(value.value)
}

function readBlendMode(reader: BinaryReader): BlendMode {
  return {
    blendOp: reader.u8(),
    sourceFactor: reader.u8(),
    destFactor: reader.u8(),
    logicOp: reader.u8()
  }
}

function writeBlendMode(writer: BinaryWriter, value: BlendMode): void {
  writer.u8(value.blendOp)
  writer.u8(value.sourceFactor)
  writer.u8(value.destFactor)
  writer.u8(value.logicOp)
}

function readIndirectParameter(reader: BinaryReader): IndirectParameter {
  return { rotation: reader.f32(), scaleX: reader.f32(), scaleY: reader.f32() }
}

function writeIndirectParameter(writer: BinaryWriter, value: IndirectParameter): void {
  writer.f32(value.rotation)
  writer.f32(value.scaleX)
  writer.f32(value.scaleY)
}

function readProjectionTexGenParam(reader: BinaryReader): ProjectionTexGenParam {
  const posX = reader.f32()
  const posY = reader.f32()
  const scaleX = reader.f32()
  const scaleY = reader.f32()
  const flags = reader.u8()
  const padding: [number, number, number] = [reader.u8(), reader.u8(), reader.u8()]
  return { posX, posY, scaleX, scaleY, flags, padding }
}

function writeProjectionTexGenParam(writer: BinaryWriter, value: ProjectionTexGenParam): void {
  writer.f32(value.posX)
  writer.f32(value.posY)
  writer.f32(value.scaleX)
  writer.f32(value.scaleY)
  writer.u8(value.flags)
  for (const byte of value.padding) writer.u8(byte)
}

function readFontShadowParameter(reader: BinaryReader): FontShadowParameter {
  return { blackColor: [...reader.rgba8()] as Rgba, whiteColor: [...reader.rgba8()] as Rgba }
}

function writeFontShadowParameter(writer: BinaryWriter, value: FontShadowParameter): void {
  writer.rgba8(value.blackColor)
  writer.rgba8(value.whiteColor)
}

export function readMaterial(reader: BinaryReader, major: number, end?: number): Material {
  const name = reader.fixedString(0x1c)

  let flags: number
  let unknown = 0
  let blackColor: Rgba
  let whiteColor: Rgba

  // Version 8 moved the flags word ahead of the two colours.
  if (major >= 8) {
    flags = reader.u32()
    unknown = reader.i32()
    blackColor = [...reader.rgba8()] as Rgba
    whiteColor = [...reader.rgba8()] as Rgba
  } else {
    blackColor = [...reader.rgba8()] as Rgba
    whiteColor = [...reader.rgba8()] as Rgba
    flags = reader.u32()
  }

  const texCount = field(flags, FLAG.texCountShift, FLAG.texCountMask)
  const matrixCount = field(flags, FLAG.matrixCountShift, FLAG.matrixCountMask)
  const texCoordGenCount = field(flags, FLAG.texCoordGenCountShift, FLAG.texCoordGenCountMask)
  const tevStageCount = field(flags, FLAG.tevStageCountShift, FLAG.tevStageCountMask)
  const projTexGenCount = field(flags, FLAG.projTexGenCountShift, FLAG.projTexGenCountMask)

  const textureMaps: TextureRef[] = []
  for (let i = 0; i < texCount; i++) textureMaps.push(readTextureRef(reader))

  const textureTransforms: TextureTransform[] = []
  for (let i = 0; i < matrixCount; i++) textureTransforms.push(readTextureTransform(reader))

  const texCoordGens: TexCoordGen[] = []
  for (let i = 0; i < texCoordGenCount; i++) texCoordGens.push(readTexCoordGen(reader, major))

  const tevStages: TevStage[] = []
  for (let i = 0; i < tevStageCount; i++) tevStages.push(readTevStage(reader))

  const alphaCompare = bit(flags, FLAG.alphaCompare) ? readAlphaCompare(reader) : null
  const blendMode = bit(flags, FLAG.blend) ? readBlendMode(reader) : null
  const blendModeLogic = bit(flags, FLAG.blendLogic) ? readBlendMode(reader) : null
  const indirectParameter = bit(flags, FLAG.indParams) ? readIndirectParameter(reader) : null

  const projectionTexGenParams: ProjectionTexGenParam[] = []
  for (let i = 0; i < projTexGenCount; i++) {
    projectionTexGenParams.push(readProjectionTexGenParam(reader))
  }

  const fontShadowParameter = bit(flags, FLAG.fontShadow) ? readFontShadowParameter(reader) : null

  return {
    name,
    blackColor,
    whiteColor,
    unknown,
    textureMaps,
    textureTransforms,
    texCoordGens,
    tevStages,
    alphaCompare,
    blendMode,
    blendModeLogic,
    indirectParameter,
    projectionTexGenParams,
    fontShadowParameter,
    useTextureOnly: bit(flags, FLAG.useTextureOnly),
    alphaInterpolation: bit(flags, FLAG.alphaInterpolation),
    // Whatever the flags word gates that this build does not model; see Material.
    trailing:
      end !== undefined && end > reader.tell()
        ? [...reader.readBytes(end - reader.tell())]
        : [],
    originalFlags: flags,
    dirty: false
  }
}

/**
 * Rebuilds the flags word from the material's actual contents. Only used for
 * edited materials — a clean material is written from its original bytes, so
 * untouched files round-trip exactly.
 */
export function computeMaterialFlags(material: Material): number {
  let flags = 0
  flags |= (material.textureMaps.length & FLAG.texCountMask) << FLAG.texCountShift
  flags |= (material.textureTransforms.length & FLAG.matrixCountMask) << FLAG.matrixCountShift
  flags |=
    (material.texCoordGens.length & FLAG.texCoordGenCountMask) << FLAG.texCoordGenCountShift
  flags |= (material.tevStages.length & FLAG.tevStageCountMask) << FLAG.tevStageCountShift
  if (material.alphaCompare) flags |= 1 << FLAG.alphaCompare
  if (material.blendMode) flags |= 1 << FLAG.blend
  if (material.useTextureOnly) flags |= 1 << FLAG.useTextureOnly
  if (material.blendModeLogic) flags |= 1 << FLAG.blendLogic
  if (material.indirectParameter) flags |= 1 << FLAG.indParams
  flags |=
    (material.projectionTexGenParams.length & FLAG.projTexGenCountMask) <<
    FLAG.projTexGenCountShift
  if (material.fontShadowParameter) flags |= 1 << FLAG.fontShadow
  if (material.alphaInterpolation) flags |= 1 << FLAG.alphaInterpolation
  return flags >>> 0
}

export function writeMaterial(
  writer: BinaryWriter,
  material: Material,
  major: number
): void {
  const flags = material.dirty ? computeMaterialFlags(material) : material.originalFlags

  writer.fixedString(material.name, 0x1c)

  if (major >= 8) {
    writer.u32(flags)
    writer.i32(material.unknown)
    writer.rgba8(material.blackColor)
    writer.rgba8(material.whiteColor)
  } else {
    writer.rgba8(material.blackColor)
    writer.rgba8(material.whiteColor)
    writer.u32(flags)
  }

  // Written from the flags actually emitted, so a preserved flags word and the
  // emitted arrays can never disagree.
  const texCount = field(flags, FLAG.texCountShift, FLAG.texCountMask)
  const matrixCount = field(flags, FLAG.matrixCountShift, FLAG.matrixCountMask)
  const texCoordGenCount = field(flags, FLAG.texCoordGenCountShift, FLAG.texCoordGenCountMask)
  const tevStageCount = field(flags, FLAG.tevStageCountShift, FLAG.tevStageCountMask)
  const projTexGenCount = field(flags, FLAG.projTexGenCountShift, FLAG.projTexGenCountMask)

  for (let i = 0; i < texCount; i++) {
    writeTextureRef(writer, material.textureMaps[i] ?? { textureIndex: -1, flag1: 0, flag2: 0 })
  }
  for (let i = 0; i < matrixCount; i++) {
    writeTextureTransform(
      writer,
      material.textureTransforms[i] ?? { translate: [0, 0], rotate: 0, scale: [1, 1] }
    )
  }
  for (let i = 0; i < texCoordGenCount; i++) {
    writeTexCoordGen(writer, material.texCoordGens[i] ?? { matrix: 0, source: 0, unknown: [] }, major)
  }
  for (let i = 0; i < tevStageCount; i++) {
    writeTevStage(writer, material.tevStages[i] ?? { colorFlags: 0, alphaFlags: 0, padding: [0, 0] })
  }

  if (bit(flags, FLAG.alphaCompare)) {
    writeAlphaCompare(
      writer,
      material.alphaCompare ?? { compareMode: 6, padding: [0, 0, 0], value: 0 }
    )
  }
  if (bit(flags, FLAG.blend)) {
    writeBlendMode(
      writer,
      material.blendMode ?? { blendOp: 1, sourceFactor: 4, destFactor: 5, logicOp: 0 }
    )
  }
  if (bit(flags, FLAG.blendLogic)) {
    writeBlendMode(
      writer,
      material.blendModeLogic ?? { blendOp: 1, sourceFactor: 4, destFactor: 5, logicOp: 0 }
    )
  }
  if (bit(flags, FLAG.indParams)) {
    writeIndirectParameter(
      writer,
      material.indirectParameter ?? { rotation: 0, scaleX: 1, scaleY: 1 }
    )
  }
  for (let i = 0; i < projTexGenCount; i++) {
    writeProjectionTexGenParam(
      writer,
      material.projectionTexGenParams[i] ?? {
        posX: 0,
        posY: 0,
        scaleX: 1,
        scaleY: 1,
        flags: 0
      }
    )
  }
  if (bit(flags, FLAG.fontShadow)) {
    writeFontShadowParameter(
      writer,
      material.fontShadowParameter ?? {
        blackColor: [0, 0, 0, 255],
        whiteColor: [255, 255, 255, 255]
      }
    )
  }

  // Unmodelled per-material bytes, replayed as read; see Material.trailing.
  if (material.trailing.length > 0) writer.bytes(new Uint8Array(material.trailing))
}
