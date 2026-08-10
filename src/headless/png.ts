import { deflateSync } from 'node:zlib'

import { crc32 } from '@main/zip'

/**
 * A minimal PNG encoder.
 *
 * The app encodes PNGs through Electron's `nativeImage`, which is not available
 * outside it — and the whole point of the headless tools is that they run without
 * booting an editor. PNG's container is four length-tagged chunks and a zlib
 * stream, and `node:zlib` supplies the stream, so this is short enough not to be
 * worth a dependency.
 *
 * Filter type 0 on every row: the images this produces are flat UI rectangles
 * where the adaptive filters buy little, and choosing one per row is the only part
 * of PNG encoding with any real complexity to get wrong.
 */

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)

  for (let at = 0; at < 4; at++) out[4 + at] = type.charCodeAt(at)
  out.set(body, 8)

  // The CRC covers the type and the body, not the length.
  view.setUint32(out.length - 4, crc32(out.subarray(4, 8 + body.length)))
  return out
}

/** Encodes straight (non-premultiplied) RGBA8. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: truecolour with alpha
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  // Each row is prefixed with its filter byte, which is what the extra width is.
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const from = y * width * 4
    const to = y * (width * 4 + 1)
    raw[to] = 0
    raw.set(rgba.subarray(from, from + width * 4), to + 1)
  }

  const parts = [
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0))
  ]

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
