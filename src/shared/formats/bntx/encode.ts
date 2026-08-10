import { FormatWriteError } from '@shared/binary/errors'
import { BntxFormat, formatInfo, formatName, type BntxFormatVariant } from './format'

/**
 * Turning straight RGBA8 pixels back into a surface a BNTX can hold.
 *
 * Deliberately only the uncompressed formats. BCn and ASTC need a real
 * *compressor* — a rate-distortion search, not a format conversion — and shipping
 * a bad one would be worse than shipping none: the textures would load, look
 * subtly wrong, and the tool would have been the one that made them wrong. The
 * decoder handles every one of those formats; the encoder is honest about
 * handling none of them.
 */

/** Formats a surface can be written back into, with the channels each one keeps. */
const ENCODERS: Record<number, (rgba: Uint8Array, out: Uint8Array) => void> = {
  [BntxFormat.R8G8B8A8]: (rgba, out) => {
    out.set(rgba)
  },
  [BntxFormat.B8G8R8A8]: (rgba, out) => {
    for (let at = 0; at < rgba.length; at += 4) {
      out[at] = rgba[at + 2]!
      out[at + 1] = rgba[at + 1]!
      out[at + 2] = rgba[at]!
      out[at + 3] = rgba[at + 3]!
    }
  },
  [BntxFormat.R8]: (rgba, out) => {
    for (let at = 0, to = 0; at < rgba.length; at += 4, to += 1) out[to] = rgba[at]!
  },
  [BntxFormat.R8G8]: (rgba, out) => {
    for (let at = 0, to = 0; at < rgba.length; at += 4, to += 2) {
      out[to] = rgba[at]!
      out[to + 1] = rgba[at + 1]!
    }
  },
  [BntxFormat.R5G6B5]: (rgba, out) => {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    for (let at = 0, to = 0; at < rgba.length; at += 4, to += 2) {
      const packed =
        ((rgba[at]! >> 3) << 11) | ((rgba[at + 1]! >> 2) << 5) | (rgba[at + 2]! >> 3)
      view.setUint16(to, packed, true)
    }
  },
  [BntxFormat.R4G4B4A4]: (rgba, out) => {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    for (let at = 0, to = 0; at < rgba.length; at += 4, to += 2) {
      const packed =
        ((rgba[at]! >> 4) << 12) |
        ((rgba[at + 1]! >> 4) << 8) |
        ((rgba[at + 2]! >> 4) << 4) |
        (rgba[at + 3]! >> 4)
      view.setUint16(to, packed, true)
    }
  }
}

/** True when a surface in this format can be written back from pixels. */
export function canEncodeFormat(format: BntxFormat): boolean {
  return format in ENCODERS
}

/**
 * Why a format cannot be written, phrased as what to do instead.
 *
 * Returned rather than thrown so a UI can disable a button with a reason rather
 * than offering an action that always fails.
 */
export function whyNotEncodable(
  format: BntxFormat,
  variant: BntxFormatVariant
): string | null {
  if (canEncodeFormat(format)) return null
  return (
    `${formatName(format, variant)} is a compressed format, and BFLayout has no encoder for it — ` +
    'compressing to BCn or ASTC well is a rate-distortion search, not a format conversion. ' +
    'Build the .bntx in a tool that has one and use Replace on the archive entry instead.'
  )
}

/**
 * Encodes straight (non-premultiplied) RGBA8 into one uncompressed surface.
 *
 * Row-major and untiled — the caller swizzles. Keeping the two steps separate is
 * what lets the swizzle be tested against the reverse direction that a real dump
 * has already validated.
 */
export function encodeSurface(
  rgba: Uint8Array,
  width: number,
  height: number,
  format: BntxFormat,
  variant: BntxFormatVariant
): Uint8Array {
  const encoder = ENCODERS[format]
  const info = formatInfo(format)
  if (!encoder || !info) {
    throw new FormatWriteError({
      format: 'bntx',
      message: whyNotEncodable(format, variant) ?? `no encoder for ${formatName(format, variant)}`
    })
  }

  const expected = width * height * 4
  if (rgba.length < expected) {
    throw new FormatWriteError({
      format: 'bntx',
      message: `expected ${expected} bytes of RGBA for ${width}x${height} but got ${rgba.length}`
    })
  }

  const out = new Uint8Array(width * height * info.bytesPerBlock)
  encoder(rgba.subarray(0, expected), out)
  return out
}

/**
 * Halves an RGBA8 image with a box filter, for regenerating a mip chain.
 *
 * Replacing mip 0 alone leaves the smaller levels showing the *old* texture, which
 * appears as the image changing back as it gets further away or smaller on screen
 * — a bug that looks like a rendering fault rather than a stale mip.
 *
 * A box filter is the right amount of cleverness here: these are UI textures being
 * shrunk by powers of two, where anything fancier is imperceptible.
 */
export function halveRgba(
  rgba: Uint8Array,
  width: number,
  height: number
): { data: Uint8Array; width: number; height: number } {
  const nextWidth = Math.max(1, width >> 1)
  const nextHeight = Math.max(1, height >> 1)
  const out = new Uint8Array(nextWidth * nextHeight * 4)

  for (let y = 0; y < nextHeight; y++) {
    for (let x = 0; x < nextWidth; x++) {
      // Clamped, so an odd dimension samples the same column or row twice rather
      // than reading past the edge.
      const x0 = Math.min(x * 2, width - 1)
      const x1 = Math.min(x * 2 + 1, width - 1)
      const y0 = Math.min(y * 2, height - 1)
      const y1 = Math.min(y * 2 + 1, height - 1)

      for (let channel = 0; channel < 4; channel++) {
        const sum =
          rgba[(y0 * width + x0) * 4 + channel]! +
          rgba[(y0 * width + x1) * 4 + channel]! +
          rgba[(y1 * width + x0) * 4 + channel]! +
          rgba[(y1 * width + x1) * 4 + channel]!
        out[(y * nextWidth + x) * 4 + channel] = (sum + 2) >> 2
      }
    }
  }

  return { data: out, width: nextWidth, height: nextHeight }
}
