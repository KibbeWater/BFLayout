/**
 * Tegra X1 block-linear (de)swizzling.
 *
 * Ported from AboodXD's BNTX-Extractor swizzle.py, which is the lineage
 * Switch-Toolbox and tegra_swizzle both descend from; the address math is
 * from the Tegra X1 TRM v1.3 (pages 1217-1218).
 *
 * The GPU stores a surface as a grid of *blocks*. A block is one GOB wide and
 * `blockHeight` GOBs tall. A GOB ("group of bytes") is a fixed 512-byte tile
 * covering 64 bytes by 8 rows, with a fixed interleave inside it. Blocks are
 * laid out left-to-right then top-to-bottom, so an address decomposes into:
 * which row of blocks, which block within that row, which GOB within the
 * block, and finally the byte's slot inside the GOB.
 *
 * Everything here works in units of *blocks* for compressed formats: callers
 * divide the pixel dimensions by the format's block dimensions and pass the
 * bytes-per-block as `bpp`. That is what makes the same code serve BCn.
 */

const GOB_WIDTH_IN_BYTES = 64
const GOB_HEIGHT_IN_ROWS = 8
const GOB_SIZE_IN_BYTES = GOB_WIDTH_IN_BYTES * GOB_HEIGHT_IN_ROWS

/** `nn::gfx::TileMode`. */
export const BntxTileMode = {
  Optimal: 0,
  Linear: 1
} as const

/** Pitch-linear surfaces round their row stride up to this many bytes. */
const LINEAR_PITCH_ALIGNMENT = 32

/** The TRM only defines block heights of 1, 2, 4, 8, 16 and 32 GOBs. */
const MAX_BLOCK_HEIGHT_LOG2 = 5

export function divRoundUp(n: number, d: number): number {
  return Math.floor((n + d - 1) / d)
}

export function roundUp(x: number, y: number): number {
  return divRoundUp(x, y) * y
}

function clampBlockHeightLog2(blockHeightLog2: number): number {
  return Math.max(0, Math.min(Math.floor(blockHeightLog2), MAX_BLOCK_HEIGHT_LOG2))
}

/**
 * Byte offset of (x, y) within a single 512-byte GOB. The interleave is a fixed
 * hardware pattern in 16-byte runs, not a stride, so it is spelled out.
 */
function gobOffset(xBytes: number, y: number): number {
  return (
    Math.floor((xBytes % 64) / 32) * 256 +
    Math.floor((y % 8) / 2) * 64 +
    Math.floor((xBytes % 32) / 16) * 32 +
    (y % 2) * 16 +
    (xBytes % 16)
  )
}

/**
 * Address of element (x, y) in a block-linear surface `widthInGobs` GOBs wide.
 * `x` and `y` are in elements/rows of elements; `bpp` converts x to bytes.
 */
export function blockLinearAddress(
  x: number,
  y: number,
  widthInGobs: number,
  bpp: number,
  blockHeight: number
): number {
  const rowsPerBlock = GOB_HEIGHT_IN_ROWS * blockHeight
  const blockSizeInBytes = GOB_SIZE_IN_BYTES * blockHeight
  const xBytes = x * bpp

  const gobAddress =
    // Skip whole rows of blocks: each row is `widthInGobs` blocks wide.
    Math.floor(y / rowsPerBlock) * blockSizeInBytes * widthInGobs +
    // Skip blocks within this row; blocks are always exactly one GOB wide.
    Math.floor(xBytes / GOB_WIDTH_IN_BYTES) * blockSizeInBytes +
    // Skip GOBs stacked within this block.
    Math.floor((y % rowsPerBlock) / GOB_HEIGHT_IN_ROWS) * GOB_SIZE_IN_BYTES

  return gobAddress + gobOffset(xBytes, y)
}

/**
 * Size of the tiled surface a mip level occupies, in bytes. Block-linear
 * surfaces are padded out to whole blocks in both directions.
 */
export function swizzledSurfaceSize(
  width: number,
  height: number,
  blkWidth: number,
  blkHeight: number,
  bpp: number,
  tileMode: number,
  blockHeightLog2: number
): number {
  const w = divRoundUp(width, blkWidth)
  const h = divRoundUp(height, blkHeight)

  if (tileMode === BntxTileMode.Linear) {
    return roundUp(w * bpp, LINEAR_PITCH_ALIGNMENT) * h
  }

  const blockHeight = 1 << clampBlockHeightLog2(blockHeightLog2)
  return (
    roundUp(w * bpp, GOB_WIDTH_IN_BYTES) * roundUp(h, blockHeight * GOB_HEIGHT_IN_ROWS)
  )
}

/** Size of the untiled surface a mip level occupies, in bytes. */
export function deswizzledSurfaceSize(
  width: number,
  height: number,
  blkWidth: number,
  blkHeight: number,
  bpp: number
): number {
  return divRoundUp(width, blkWidth) * divRoundUp(height, blkHeight) * bpp
}

/**
 * Block height the hardware picks for mip 0 when the file does not say. BNTX
 * carries the value explicitly in `textureLayout`, so this is only a fallback.
 *
 * Ported from Ryujinx via tegra_swizzle: the "+ half" biases the choice so a
 * surface only earns a taller block once it is comfortably past the boundary.
 */
export function blockHeightLog2Mip0(heightInBlocks: number): number {
  const biased = heightInBlocks + Math.floor(heightInBlocks / 2)
  if (biased >= 128) return 4
  if (biased >= 64) return 3
  if (biased >= 32) return 2
  if (biased >= 16) return 1
  return 0
}

/**
 * Block height for a mip level. As a mip shrinks the driver halves the block
 * height rather than waste a mostly-empty block, so every level below mip 0
 * needs its own value.
 */
export function mipBlockHeightLog2(
  mipHeightInBlocks: number,
  blockHeightLog2Mip0Value: number
): number {
  let log2 = clampBlockHeightLog2(blockHeightLog2Mip0Value)
  while (log2 > 0 && mipHeightInBlocks <= (1 << (log2 - 1)) * GOB_HEIGHT_IN_ROWS) {
    log2 -= 1
  }
  return log2
}

/**
 * Tiles a plain row-major surface back into the GPU's block-linear layout.
 *
 * The exact inverse of `deswizzle`, sharing its address math so the two cannot
 * drift apart — which matters more than it sounds: a forward swizzle that
 * disagrees with the reverse one produces a texture that looks right in this app
 * (it round-trips through our own code) and is shredded on the GPU.
 *
 * Padding introduced by rounding the surface up to whole blocks is left zeroed.
 * The hardware never reads it, and matching whatever the original file happened to
 * have there is not possible from the pixels alone.
 */
export function swizzle(
  width: number,
  height: number,
  blkWidth: number,
  blkHeight: number,
  bpp: number,
  tileMode: number,
  blockHeightLog2: number,
  linearData: Uint8Array
): Uint8Array {
  const w = divRoundUp(width, blkWidth)
  const h = divRoundUp(height, blkHeight)
  const linear = tileMode === BntxTileMode.Linear
  const blockHeight = 1 << clampBlockHeightLog2(blockHeightLog2)

  const pitch = linear
    ? roundUp(w * bpp, LINEAR_PITCH_ALIGNMENT)
    : roundUp(w * bpp, GOB_WIDTH_IN_BYTES)
  const surfaceSize = linear
    ? pitch * h
    : pitch * roundUp(h, blockHeight * GOB_HEIGHT_IN_ROWS)
  const widthInGobs = divRoundUp(w * bpp, GOB_WIDTH_IN_BYTES)

  const out = new Uint8Array(surfaceSize)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const source = (y * w + x) * bpp
      if (source + bpp > linearData.length) continue

      const destination = linear
        ? y * pitch + x * bpp
        : blockLinearAddress(x, y, widthInGobs, bpp, blockHeight)
      if (destination + bpp > surfaceSize) continue

      for (let i = 0; i < bpp; i++) out[destination + i] = linearData[source + i]!
    }
  }

  return out
}

/**
 * Untiles one mip level into a plain row-major surface of
 * `divRoundUp(width, blkWidth) * divRoundUp(height, blkHeight) * bpp` bytes.
 *
 * Elements whose tiled address falls outside `data` are left zeroed rather
 * than throwing: the last mip levels of real textures are frequently stored
 * without the padding a full block would need.
 */
export function deswizzle(
  width: number,
  height: number,
  blkWidth: number,
  blkHeight: number,
  bpp: number,
  tileMode: number,
  blockHeightLog2: number,
  data: Uint8Array
): Uint8Array {
  const w = divRoundUp(width, blkWidth)
  const h = divRoundUp(height, blkHeight)
  const linear = tileMode === BntxTileMode.Linear
  const blockHeight = 1 << clampBlockHeightLog2(blockHeightLog2)

  const pitch = linear
    ? roundUp(w * bpp, LINEAR_PITCH_ALIGNMENT)
    : roundUp(w * bpp, GOB_WIDTH_IN_BYTES)
  const surfaceSize = linear
    ? pitch * h
    : pitch * roundUp(h, blockHeight * GOB_HEIGHT_IN_ROWS)
  const widthInGobs = divRoundUp(w * bpp, GOB_WIDTH_IN_BYTES)

  const out = new Uint8Array(w * h * bpp)
  const limit = Math.min(surfaceSize, data.length)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const source = linear
        ? y * pitch + x * bpp
        : blockLinearAddress(x, y, widthInGobs, bpp, blockHeight)
      if (source + bpp > limit) continue

      const destination = (y * w + x) * bpp
      for (let i = 0; i < bpp; i++) out[destination + i] = data[source + i]!
    }
  }

  return out
}
