import { BinaryReadError } from './errors'

/**
 * Cursor over a byte buffer with switchable endianness.
 *
 * Endianness is mutable because the layout formats declare it in a byte-order
 * mark partway through their own header: the first fields are read big-endian,
 * then the reader flips for the rest of the file.
 *
 * String decoding is hand-written rather than using TextDecoder, which is a
 * host global unavailable under this package's platform-neutral constraint.
 */
export class BinaryReader {
  readonly bytes: Uint8Array
  private readonly view: DataView
  private pos = 0

  littleEndian: boolean

  constructor(data: Uint8Array, options?: { littleEndian?: boolean }) {
    this.bytes = data
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.littleEndian = options?.littleEndian ?? true
  }

  get length(): number {
    return this.bytes.byteLength
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos
  }

  tell(): number {
    return this.pos
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.byteLength) {
      throw new BinaryReadError({
        offset,
        length: 0,
        available: this.bytes.byteLength,
        message: `seek to ${offset} is outside the buffer`
      })
    }
    this.pos = offset
  }

  skip(count: number): void {
    this.seek(this.pos + count)
  }

  /** Advances to the next multiple of `alignment`. */
  align(alignment: number): void {
    const rem = this.pos % alignment
    if (rem !== 0) this.skip(alignment - rem)
  }

  private need(count: number): void {
    if (this.pos + count > this.bytes.byteLength) {
      throw new BinaryReadError({
        offset: this.pos,
        length: count,
        available: this.remaining,
        message: `read of ${count} byte(s) runs past the end of the buffer`
      })
    }
  }

  u8(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }

  i8(): number {
    this.need(1)
    return this.view.getInt8(this.pos++)
  }

  u16(): number {
    this.need(2)
    const value = this.view.getUint16(this.pos, this.littleEndian)
    this.pos += 2
    return value
  }

  i16(): number {
    this.need(2)
    const value = this.view.getInt16(this.pos, this.littleEndian)
    this.pos += 2
    return value
  }

  u32(): number {
    this.need(4)
    const value = this.view.getUint32(this.pos, this.littleEndian)
    this.pos += 4
    return value
  }

  i32(): number {
    this.need(4)
    const value = this.view.getInt32(this.pos, this.littleEndian)
    this.pos += 4
    return value
  }

  f32(): number {
    this.need(4)
    const value = this.view.getFloat32(this.pos, this.littleEndian)
    this.pos += 4
    return value
  }

  /**
   * 64-bit integers as `bigint`, because a `number` cannot hold the full range
   * and BYML stores real 64-bit values. Callers that only display them can
   * stringify; callers that round-trip them must not go through `number`.
   */
  u64(): bigint {
    this.need(8)
    const value = this.view.getBigUint64(this.pos, this.littleEndian)
    this.pos += 8
    return value
  }

  i64(): bigint {
    this.need(8)
    const value = this.view.getBigInt64(this.pos, this.littleEndian)
    this.pos += 8
    return value
  }

  f64(): number {
    this.need(8)
    const value = this.view.getFloat64(this.pos, this.littleEndian)
    this.pos += 8
    return value
  }

  /** Reads big-endian regardless of the current setting (for byte-order marks). */
  u16be(): number {
    this.need(2)
    const value = this.view.getUint16(this.pos, false)
    this.pos += 2
    return value
  }

  vec2(): readonly [number, number] {
    return [this.f32(), this.f32()]
  }

  vec3(): readonly [number, number, number] {
    return [this.f32(), this.f32(), this.f32()]
  }

  /** RGBA8 colour as a 4-tuple. */
  rgba8(): readonly [number, number, number, number] {
    return [this.u8(), this.u8(), this.u8(), this.u8()]
  }

  /** Copies `count` bytes out. A copy, so callers may retain it safely. */
  readBytes(count: number): Uint8Array {
    this.need(count)
    const out = this.bytes.slice(this.pos, this.pos + count)
    this.pos += count
    return out
  }

  /** Zero-copy window onto the underlying buffer; do not retain long-term. */
  subarray(count: number): Uint8Array {
    this.need(count)
    const out = this.bytes.subarray(this.pos, this.pos + count)
    this.pos += count
    return out
  }

  /** Copies an absolute byte range without moving the cursor. */
  bytesAt(offset: number, count: number): Uint8Array {
    if (offset < 0 || offset + count > this.bytes.byteLength) {
      throw new BinaryReadError({
        offset,
        length: count,
        available: Math.max(0, this.bytes.byteLength - offset),
        message: `byte range [${offset}, ${offset + count}) is outside the buffer`
      })
    }
    return this.bytes.slice(offset, offset + count)
  }

  /**
   * Fixed-width name field. Trailing NULs (and anything after the first NUL)
   * are dropped, which is how these formats pad names.
   */
  fixedString(size: number): string {
    this.need(size)
    let end = this.pos + size
    for (let i = this.pos; i < this.pos + size; i++) {
      if (this.bytes[i] === 0) {
        end = i
        break
      }
    }
    let out = ''
    for (let i = this.pos; i < end; i++) out += String.fromCharCode(this.bytes[i]!)
    this.pos += size
    return out
  }

  /** NUL-terminated string; the cursor lands after the terminator. */
  cstring(): string {
    let out = ''
    for (;;) {
      const byte = this.u8()
      if (byte === 0) return out
      out += String.fromCharCode(byte)
    }
  }

  /** NUL-terminated string read at an absolute offset, cursor untouched. */
  cstringAt(offset: number): string {
    const saved = this.pos
    try {
      this.seek(offset)
      return this.cstring()
    } finally {
      this.pos = saved
    }
  }

  /**
   * UTF-16 text held in a fixed field of `byteLength` bytes.
   *
   * Reading stops at the first NUL, because the field is a buffer and the string
   * inside it is terminated — real layouts reserve room for a longer string than
   * they currently hold, so the bytes after the terminator are padding, not text.
   * The cursor still advances by the full field width.
   */
  utf16String(byteLength: number): string {
    this.need(byteLength)
    const units = byteLength >> 1
    let out = ''
    for (let i = 0; i < units; i++) {
      const at = this.pos + i * 2
      const lo = this.bytes[at]!
      const hi = this.bytes[at + 1]!
      const code = this.littleEndian ? lo | (hi << 8) : (lo << 8) | hi
      if (code === 0) break
      out += String.fromCharCode(code)
    }
    this.pos += byteLength
    return out
  }

  /** Runs `body` at `offset`, restoring the cursor afterwards. */
  at<T>(offset: number, body: () => T): T {
    const saved = this.pos
    try {
      this.seek(offset)
      return body()
    } finally {
      this.pos = saved
    }
  }
}
