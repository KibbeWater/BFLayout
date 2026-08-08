import { BinaryWriter } from '@shared/binary/writer'
import { FormatParseError } from '@shared/binary/errors'

/**
 * Yaz0 — Nintendo's LZ77 variant used to compress archives.
 *
 * Layout: "Yaz0", big-endian u32 decompressed size, u32 alignment hint, u32
 * reserved, then the coded stream. The stream is groups of one flag byte
 * followed by eight items, MSB first: a set bit is a literal byte, a clear bit
 * is a back-reference of 2 or 3 bytes.
 */

const MAGIC = 'Yaz0'
const HEADER_SIZE = 16
const WINDOW = 0x1000
const MIN_MATCH = 3
const MAX_MATCH = 0x111

export function isYaz0(data: Uint8Array): boolean {
  return (
    data.length >= HEADER_SIZE &&
    data[0] === 0x59 &&
    data[1] === 0x61 &&
    data[2] === 0x7a &&
    data[3] === 0x30
  )
}

export function yaz0DecompressedSize(data: Uint8Array): number {
  if (!isYaz0(data)) {
    throw new FormatParseError({ format: 'yaz0', offset: 0, message: 'not a Yaz0 stream' })
  }
  return ((data[4]! << 24) | (data[5]! << 16) | (data[6]! << 8) | data[7]!) >>> 0
}

export function yaz0Decompress(data: Uint8Array): Uint8Array {
  if (!isYaz0(data)) {
    throw new FormatParseError({ format: 'yaz0', offset: 0, message: 'not a Yaz0 stream' })
  }

  const size = yaz0DecompressedSize(data)
  const out = new Uint8Array(size)

  let src = HEADER_SIZE
  let dst = 0
  let code = 0
  let codeBits = 0

  const takeByte = (): number => {
    if (src >= data.length) {
      throw new FormatParseError({
        format: 'yaz0',
        offset: src,
        message: `compressed stream ended early (wrote ${dst} of ${size} bytes)`
      })
    }
    return data[src++]!
  }

  while (dst < size) {
    if (codeBits === 0) {
      code = takeByte()
      codeBits = 8
    }

    if ((code & 0x80) !== 0) {
      out[dst++] = takeByte()
    } else {
      const b1 = takeByte()
      const b2 = takeByte()
      const distance = (((b1 & 0x0f) << 8) | b2) + 1
      let count = b1 >> 4
      count = count === 0 ? takeByte() + 0x12 : count + 2

      let from = dst - distance
      if (from < 0) {
        throw new FormatParseError({
          format: 'yaz0',
          offset: src,
          message: `back-reference reaches ${from} bytes before the start of output`
        })
      }
      for (let i = 0; i < count && dst < size; i++) out[dst++] = out[from++]!
    }

    code = (code << 1) & 0xff
    codeBits--
  }

  return out
}

/**
 * Hash-chain match finder. Positions are indexed by a 3-byte hash so a match
 * search walks only plausible candidates instead of the whole 4 KiB window,
 * which keeps compressing a multi-megabyte archive practical.
 */
class MatchFinder {
  private readonly head: Int32Array
  private readonly prev: Int32Array
  private inserted = 0

  constructor(
    private readonly data: Uint8Array,
    private readonly maxProbes = 128
  ) {
    this.head = new Int32Array(0x10000).fill(-1)
    this.prev = new Int32Array(data.length).fill(-1)
  }

  private hash(at: number): number {
    return (
      ((this.data[at]! << 8) ^ (this.data[at + 1]! << 4) ^ this.data[at + 2]!) & 0xffff
    )
  }

  /** Indexes every position below `limit`, so searches never see the future. */
  indexUpTo(limit: number): void {
    const last = Math.min(limit, this.data.length - MIN_MATCH + 1)
    while (this.inserted < last) {
      const h = this.hash(this.inserted)
      this.prev[this.inserted] = this.head[h]!
      this.head[h] = this.inserted
      this.inserted++
    }
  }

  find(at: number): { len: number; dist: number } {
    const maxLen = Math.min(MAX_MATCH, this.data.length - at)
    if (maxLen < MIN_MATCH) return { len: 0, dist: 0 }

    const floor = Math.max(0, at - WINDOW)
    let bestLen = 0
    let bestDist = 0
    let probes = this.maxProbes

    for (let candidate = this.head[this.hash(at)]!; candidate >= floor && probes > 0; ) {
      if (candidate >= at) {
        candidate = this.prev[candidate]!
        continue
      }
      let len = 0
      while (len < maxLen && this.data[candidate + len] === this.data[at + len]) len++
      if (len > bestLen) {
        bestLen = len
        bestDist = at - candidate
        if (len === maxLen) break
      }
      candidate = this.prev[candidate]!
      probes--
    }

    return bestLen >= MIN_MATCH ? { len: bestLen, dist: bestDist } : { len: 0, dist: 0 }
  }
}

export function yaz0Compress(data: Uint8Array, options?: { alignment?: number }): Uint8Array {
  const writer = new BinaryWriter({ littleEndian: false, capacity: data.length + 0x100 })
  writer.magic(MAGIC)
  writer.u32(data.length)
  writer.u32(options?.alignment ?? 0)
  writer.u32(0)

  const finder = new MatchFinder(data)
  let pos = 0

  let group: number[] = []
  let code = 0
  let bits = 0

  const flush = (): void => {
    writer.u8(code)
    for (const byte of group) writer.u8(byte)
    group = []
    code = 0
    bits = 0
  }

  while (pos < data.length) {
    finder.indexUpTo(pos)
    let match = finder.find(pos)

    // One byte of lookahead: if starting the match a byte later pays off more,
    // emit this byte as a literal instead. Cheap, and noticeably tighter.
    if (match.len >= MIN_MATCH && pos + 1 < data.length) {
      finder.indexUpTo(pos + 1)
      if (finder.find(pos + 1).len > match.len) match = { len: 0, dist: 0 }
    }

    if (match.len >= MIN_MATCH) {
      const delta = match.dist - 1
      if (match.len >= 0x12) {
        group.push(delta >> 8, delta & 0xff, match.len - 0x12)
      } else {
        group.push(((match.len - 2) << 4) | (delta >> 8), delta & 0xff)
      }
      pos += match.len
    } else {
      code |= 0x80 >> bits
      group.push(data[pos]!)
      pos++
    }

    bits++
    if (bits === 8) flush()
  }

  if (bits > 0) flush()
  return writer.toBytes()
}
