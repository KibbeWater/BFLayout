/**
 * BNTX texture containers: parsing, Tegra X1 deswizzling and RGBA8 decoding.
 *
 * BC6H and BC7 are recognised by the parser but have no decoder; decodeTexture
 * throws UnsupportedFormatError for them so callers can fall back to a
 * placeholder rather than display wrong pixels.
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
  swizzledSurfaceSize
} from './swizzle'

export type { DecodedImage } from './decode'
export { applyChannelSources, decodeSurface, decodeTexture, isFormatSupported } from './decode'

export type { AstcDecodeResult } from './astc'
export { decodeAstc, decodeAstcBlock } from './astc'
