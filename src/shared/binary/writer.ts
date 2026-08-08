/**
 * A deferred numeric field.
 *
 * These formats are full of values that are only knowable after the thing they
 * describe has been written — section sizes, file sizes, pointers to sub-blocks.
 * Reserve the field with `defer`, keep the handle, and fill it once the position
 * is known.
 */
export interface Patch {
  /** Absolute position of the reserved field. */
  readonly at: number
  set(value: number): void
  /** Sets the field to (current write position - base), the usual pointer form. */
  fillFrom(base: number): void
}

/** Growable little/big-endian byte writer. */
export class BinaryWriter {
  private buffer: Uint8Array
  private view: DataView
  private pos = 0
  private end = 0

  littleEndian: boolean

  constructor(options?: { littleEndian?: boolean; capacity?: number }) {
    this.buffer = new Uint8Array(options?.capacity ?? 4096)
    this.view = new DataView(this.buffer.buffer)
    this.littleEndian = options?.littleEndian ?? true
  }

  tell(): number {
    return this.pos
  }

  get length(): number {
    return this.end
  }

  seek(offset: number): void {
    this.ensure(offset - this.pos)
    this.pos = offset
    if (this.pos > this.end) this.end = this.pos
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra
    if (needed <= this.buffer.byteLength) return
    let capacity = this.buffer.byteLength * 2
    while (capacity < needed) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.buffer.subarray(0, this.end))
    this.buffer = grown
    this.view = new DataView(grown.buffer)
  }

  private advance(count: number): void {
    this.pos += count
    if (this.pos > this.end) this.end = this.pos
  }

  u8(value: number): void {
    this.ensure(1)
    this.view.setUint8(this.pos, value & 0xff)
    this.advance(1)
  }

  i8(value: number): void {
    this.ensure(1)
    this.view.setInt8(this.pos, value)
    this.advance(1)
  }

  u16(value: number): void {
    this.ensure(2)
    this.view.setUint16(this.pos, value & 0xffff, this.littleEndian)
    this.advance(2)
  }

  i16(value: number): void {
    this.ensure(2)
    this.view.setInt16(this.pos, value, this.littleEndian)
    this.advance(2)
  }

  u32(value: number): void {
    this.ensure(4)
    this.view.setUint32(this.pos, value >>> 0, this.littleEndian)
    this.advance(4)
  }

  i32(value: number): void {
    this.ensure(4)
    this.view.setInt32(this.pos, value, this.littleEndian)
    this.advance(4)
  }

  f32(value: number): void {
    this.ensure(4)
    this.view.setFloat32(this.pos, value, this.littleEndian)
    this.advance(4)
  }

  /** Writes big-endian regardless of the current setting (for byte-order marks). */
  u16be(value: number): void {
    this.ensure(2)
    this.view.setUint16(this.pos, value & 0xffff, false)
    this.advance(2)
  }

  vec2(value: readonly [number, number]): void {
    this.f32(value[0])
    this.f32(value[1])
  }

  vec3(value: readonly [number, number, number]): void {
    this.f32(value[0])
    this.f32(value[1])
    this.f32(value[2])
  }

  rgba8(value: readonly [number, number, number, number]): void {
    this.u8(value[0])
    this.u8(value[1])
    this.u8(value[2])
    this.u8(value[3])
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.byteLength)
    this.buffer.set(data, this.pos)
    this.advance(data.byteLength)
  }

  zeros(count: number): void {
    if (count <= 0) return
    this.ensure(count)
    this.buffer.fill(0, this.pos, this.pos + count)
    this.advance(count)
  }

  /** ASCII magic/signature. Throws on non-ASCII so bad tags fail loudly. */
  magic(signature: string): void {
    for (let i = 0; i < signature.length; i++) {
      const code = signature.charCodeAt(i)
      if (code > 0x7f) throw new Error(`non-ASCII byte in signature "${signature}"`)
      this.u8(code)
    }
  }

  /** Writes `value` into `size` bytes, NUL-padded and NUL-truncated. */
  fixedString(value: string, size: number): void {
    this.ensure(size)
    const limit = Math.min(value.length, size)
    for (let i = 0; i < limit; i++) {
      this.buffer[this.pos + i] = value.charCodeAt(i) & 0xff
    }
    for (let i = limit; i < size; i++) this.buffer[this.pos + i] = 0
    this.advance(size)
  }

  cstring(value: string): void {
    for (let i = 0; i < value.length; i++) this.u8(value.charCodeAt(i))
    this.u8(0)
  }

  /** UTF-16 text in the writer's endianness, with a NUL terminator. */
  utf16String(value: string, options?: { terminate?: boolean }): void {
    for (let i = 0; i < value.length; i++) this.u16(value.charCodeAt(i))
    if (options?.terminate !== false) this.u16(0)
  }

  /** Zero-pads up to the next multiple of `alignment`. */
  align(alignment: number): void {
    const rem = this.pos % alignment
    if (rem !== 0) this.zeros(alignment - rem)
  }

  defer(kind: 'u16' | 'u32'): Patch {
    const at = this.pos
    const writer = this
    // Placeholder is all-ones so an unresolved patch is obvious in a hex dump.
    if (kind === 'u16') this.u16(0xffff)
    else this.u32(0xffffffff)

    return {
      at,
      set(value: number): void {
        if (kind === 'u16') writer.view.setUint16(at, value & 0xffff, writer.littleEndian)
        else writer.view.setUint32(at, value >>> 0, writer.littleEndian)
      },
      fillFrom(base: number): void {
        this.set(writer.pos - base)
      }
    }
  }

  /**
   * Writes a `signature` + size-prefixed section. The recorded size covers the
   * 8-byte header itself, which is how these formats count it.
   */
  section(signature: string, body: () => void, options?: { align?: number }): void {
    const start = this.pos
    this.magic(signature)
    const size = this.defer('u32')
    body()
    this.align(options?.align ?? 4)
    size.set(this.pos - start)
  }

  /** Copy of everything written so far. */
  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.end)
  }
}
