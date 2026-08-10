/**
 * BNTX texture containers: parsing, Tegra X1 deswizzling and RGBA8 decoding.
 *
 * BC6H is recognised by the parser but decodeTexture throws UnsupportedFormatError for it,
 * so callers fall back to a placeholder rather than display wrong pixels.
 *
 * `decodeBc7Block` is exported for the GPU cross-validation in the self-test, which is how
 * it was verified: the same blocks decoded on the CPU and by the hardware, compared byte
 * for byte.
 */

export type { BntxContainer, BntxTexture } from './container'
export { isBntx, parseBntx } from './container'

export type { BntxFormatInfo } from './format'
export {
  BntxChannelSource,
  BntxFormat,
  BntxFormatVariant,
  formatInfo,
  formatName,
  isAstc,
  isBlockCompressed
} from './format'

export {
  BntxTileMode,
  blockHeightLog2Mip0,
  blockLinearAddress,
  deswizzle,
  deswizzledSurfaceSize,
  divRoundUp,
  mipBlockHeightLog2,
  roundUp,
  swizzle,
  swizzledSurfaceSize
} from './swizzle'

export type { DecodedImage } from './decode'
export { applyChannelSources, decodeSurface, decodeTexture, isFormatSupported } from './decode'

export { canEncodeFormat, encodeSurface, halveRgba, whyNotEncodable } from './encode'

export { buildDict, differingBit, keyBit, lookupDict, type DictNode } from './dict'
export { mergeBntx, writeBntx } from './write'

export { decodeBc7Block } from './bc7'

export type { AstcDecodeResult } from './astc'
export { decodeAstc, decodeAstcBlock } from './astc'
