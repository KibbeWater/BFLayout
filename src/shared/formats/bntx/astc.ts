/**
 * ASTC LDR decoder, 2D block sizes from 4x4 to 12x12.
 *
 * This is a port of the decoder in Switch-Toolbox
 * (`Switch_Toolbox_Library/FileFormats/ASTC/`), which is itself Ryujinx's port of
 * FasTC's `Decompressor.cpp`. Working from a decoder that demonstrably renders
 * these textures in an emulator is much safer than working from the spec: the
 * bounded-integer sequence decode (C.2.12) and the partition hash (C.2.21) are
 * both easy to get subtly wrong in ways that produce plausible-looking garbage
 * rather than an obvious failure.
 *
 * Deviations from that reference, all deliberate:
 *
 *   - A malformed or unsupported block returns a reason string instead of
 *     throwing, so one HDR block cannot cost the whole texture. The caller gets a
 *     count and the first reason.
 *   - Assertions that a corrupt block could violate are real checks. The C#
 *     `Debug.Assert` calls compile away in release, so the reference would index
 *     past the end of `MaxWeights` on a block claiming R < 2.
 *   - The colour-value array is oversized. Trit sequences decode five values at a
 *     time, so a block wanting 32 values decodes 35 and the reference writes past
 *     its 32-element array.
 *   - Working buffers are allocated once per surface, not once per block. A 1024²
 *     4x4 texture is 65,536 blocks, and this runs over tens of thousands of
 *     textures.
 *
 * HDR is not implemented — endpoint modes 2, 3, 7, 11, 14 and 15 and HDR void
 * extents are reported as unsupported. Nintendo's UI textures are LDR.
 */

/** Integer-sequence encodings, in the reference's enum order. */
const JUST_BITS = 0
const QUINT = 1
const TRIT = 2

/** A 12x12 block is the largest, so 144 texels and 144 weights per plane. */
const MAX_TEXELS = 144

/**
 * Room for 2 * 144 weights plus the overshoot of a final trit block, which
 * always yields five values whether or not all five are wanted.
 */
const MAX_SEQUENCE = 2 * MAX_TEXELS + 8

/** Eight values per partition, four partitions, plus the same trit overshoot. */
const MAX_COLOR_VALUES = 8 * 4 + 8

/**
 * Blocks are copied into a buffer with four bytes of zero padding so that a bit
 * cursor running slightly past the end of the block reads zeroes instead of
 * `undefined`. Sequence decoding overshoots by design, so this happens normally.
 */
const BLOCK_BUFFER_SIZE = 20

export interface AstcDecodeResult {
  /** RGBA8, top-left origin, `width * height * 4` bytes. */
  readonly rgba: Uint8Array
  /** Blocks that could not be decoded. Their pixels are left transparent. */
  readonly failedBlocks: number
  /** Total blocks in the surface, so a caller can judge how bad it was. */
  readonly totalBlocks: number
  /** Why the first failure happened, or null if there were none. */
  readonly firstError: string | null
}

/* --------------------------------------------------------------- bit plumbing */

/**
 * A cursor over a byte buffer that reads and writes least-significant-bit first,
 * matching the `BitArray` the reference wraps its blocks in.
 */
class BitCursor {
  private bytes: Uint8Array = new Uint8Array(0)
  pos = 0

  reset(bytes: Uint8Array): void {
    this.bytes = bytes
    this.pos = 0
  }

  /**
   * Reads up to 16 bits. Three bytes always cover a 16-bit field at any bit
   * offset, and the buffers are padded past their real length, so this can read
   * a fixed window instead of looping over bits — which matters at roughly a
   * hundred calls per block over millions of blocks.
   */
  read(count: number): number {
    const at = this.pos
    this.pos = at + count
    const index = at >> 3
    const window =
      this.bytes[index] | (this.bytes[index + 1] << 8) | (this.bytes[index + 2] << 16)
    return (window >>> (at & 7)) & ((1 << count) - 1)
  }

  write(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const at = this.pos + i
      const index = at >> 3
      const mask = 1 << (at & 7)
      if (((value >> i) & 1) !== 0) this.bytes[index] |= mask
      else this.bytes[index] &= ~mask
    }
    this.pos += count
  }
}

/** Bits `start` through `end` inclusive of a small integer. */
function bitsOf(value: number, start: number, end: number): number {
  return (value >> start) & ((1 << (end - start + 1)) - 1)
}

function bitOf(value: number, index: number): number {
  return (value >> index) & 1
}

/**
 * Widens a `numberBits`-wide value to `toBit` bits by repeating its own bit
 * pattern, so an all-ones input stays all-ones. ASTC uses this instead of a
 * shift so that quantised endpoints reach full scale.
 */
function replicate(value: number, numberBits: number, toBit: number): number {
  if (numberBits === 0 || toBit === 0) return 0

  const source = value & ((1 << numberBits) - 1)
  let result = source
  let length = numberBits
  let bits = numberBits

  while (length < toBit) {
    let shift = 0
    if (bits > toBit - length) {
      const remaining = toBit - length
      shift = bits - remaining
      bits = remaining
    }
    result = (result << bits) | (source >> shift)
    length += bits
  }

  return result
}

function popCount(value: number): number {
  let n = value
  let count = 0
  while (n !== 0) {
    n &= n - 1
    count++
  }
  return count
}

/* ------------------------------------------------------- integer sequence (C.2.12) */

/**
 * An encoding is a `(kind, bitsPerValue)` pair, packed into one number so that
 * the range search in `decodeColorValues` — up to 512 encodings per block — does
 * not allocate. Equality of the packed value is the reference's
 * `MatchesEncoding`.
 */
type Encoding = number

function encodingOf(kind: number, numberBits: number): Encoding {
  return (kind << 8) | numberBits
}

function encodingKind(encoding: Encoding): number {
  return encoding >> 8
}

function encodingBits(encoding: Encoding): number {
  return encoding & 0xff
}

/**
 * The narrowest encoding that can represent 0..maxValue.
 *
 * Ranges are either a power of two (plain bits), 3*2^n (a trit plus bits) or
 * 5*2^n (a quint plus bits). Anything else steps down until it finds one.
 */
function computeEncoding(maxValue: number): Encoding {
  let max = maxValue
  while (max > 0) {
    const count = max + 1

    if ((count & (count - 1)) === 0) return encodingOf(JUST_BITS, popCount(max))

    if (count % 3 === 0) {
      const third = count / 3
      if ((third & (third - 1)) === 0) return encodingOf(TRIT, popCount(third - 1))
    }

    if (count % 5 === 0) {
      const fifth = count / 5
      if ((fifth & (fifth - 1)) === 0) return encodingOf(QUINT, popCount(fifth - 1))
    }

    max--
  }

  return encodingOf(JUST_BITS, 0)
}

/**
 * Every range a block can use, resolved once.
 *
 * Colour ranges reach 255 and weight ranges 31, so 256 entries cover both. This
 * is a table rather than a call because recovering the colour range means
 * testing candidate ranges from 255 downwards for every block, and doing that
 * arithmetic afresh dominated the decode.
 */
const ENCODINGS: Uint16Array = (() => {
  const table = new Uint16Array(256)
  for (let i = 0; i < 256; i++) table[i] = computeEncoding(i)
  return table
})()

function createEncoding(maxValue: number): Encoding {
  return maxValue >= 0 && maxValue < 256 ? ENCODINGS[maxValue] : computeEncoding(maxValue)
}

/** Bits an encoded sequence of `count` values occupies. */
function sequenceBitLength(encoding: Encoding, count: number): number {
  const total = encodingBits(encoding) * count
  switch (encodingKind(encoding)) {
    case TRIT:
      // Five trits share an 8-bit block.
      return total + Math.floor((count * 8 + 4) / 5)
    case QUINT:
      // Three quints share a 7-bit block.
      return total + Math.floor((count * 7 + 2) / 3)
    default:
      return total
  }
}

/**
 * A decoded sequence, held as parallel flat arrays rather than a list of objects
 * because this is the hottest allocation site in the decoder.
 */
interface Sequence {
  readonly kind: Uint8Array
  readonly numberBits: Uint8Array
  readonly bitValue: Uint8Array
  /** The trit (0-2) or quint (0-4) that accompanies `bitValue`. */
  readonly extra: Uint8Array
  count: number
}

function makeSequence(): Sequence {
  return {
    kind: new Uint8Array(MAX_SEQUENCE),
    numberBits: new Uint8Array(MAX_SEQUENCE),
    bitValue: new Uint8Array(MAX_SEQUENCE),
    extra: new Uint8Array(MAX_SEQUENCE),
    count: 0
  }
}

/** Five trit-encoded values, unpacked per table C.2.14. */
function decodeTritBlock(cursor: BitCursor, sequence: Sequence, bitsPerValue: number): void {
  const m = [0, 0, 0, 0, 0]
  const t = [0, 0, 0, 0, 0]

  m[0] = cursor.read(bitsPerValue)
  let packed = cursor.read(2)
  m[1] = cursor.read(bitsPerValue)
  packed |= cursor.read(2) << 2
  m[2] = cursor.read(bitsPerValue)
  packed |= cursor.read(1) << 4
  m[3] = cursor.read(bitsPerValue)
  packed |= cursor.read(2) << 5
  m[4] = cursor.read(bitsPerValue)
  packed |= cursor.read(1) << 7

  let c: number
  if (bitsOf(packed, 2, 4) === 7) {
    c = (bitsOf(packed, 5, 7) << 2) | bitsOf(packed, 0, 1)
    t[4] = 2
    t[3] = 2
  } else {
    c = bitsOf(packed, 0, 4)
    if (bitsOf(packed, 5, 6) === 3) {
      t[4] = 2
      t[3] = bitOf(packed, 7)
    } else {
      t[4] = bitOf(packed, 7)
      t[3] = bitsOf(packed, 5, 6)
    }
  }

  if (bitsOf(c, 0, 1) === 3) {
    t[2] = 2
    t[1] = bitOf(c, 4)
    t[0] = (bitOf(c, 3) << 1) | (bitOf(c, 2) & ~bitOf(c, 3))
  } else if (bitsOf(c, 2, 3) === 3) {
    t[2] = 2
    t[1] = 2
    t[0] = bitsOf(c, 0, 1)
  } else {
    t[2] = bitOf(c, 4)
    t[1] = bitsOf(c, 2, 3)
    t[0] = (bitOf(c, 1) << 1) | (bitOf(c, 0) & ~bitOf(c, 1))
  }

  for (let i = 0; i < 5; i++) {
    const at = sequence.count++
    sequence.kind[at] = TRIT
    sequence.numberBits[at] = bitsPerValue
    sequence.bitValue[at] = m[i]
    sequence.extra[at] = t[i]
  }
}

/** Three quint-encoded values, unpacked per table C.2.15. */
function decodeQuintBlock(cursor: BitCursor, sequence: Sequence, bitsPerValue: number): void {
  const m = [0, 0, 0]
  const q = [0, 0, 0]

  m[0] = cursor.read(bitsPerValue)
  let packed = cursor.read(3)
  m[1] = cursor.read(bitsPerValue)
  packed |= cursor.read(2) << 3
  m[2] = cursor.read(bitsPerValue)
  packed |= cursor.read(2) << 5

  if (bitsOf(packed, 1, 2) === 3 && bitsOf(packed, 5, 6) === 0) {
    q[0] = 4
    q[1] = 4
    q[2] =
      (bitOf(packed, 0) << 2) |
      ((bitOf(packed, 4) & ~bitOf(packed, 0)) << 1) |
      (bitOf(packed, 3) & ~bitOf(packed, 0))
  } else {
    let c: number
    if (bitsOf(packed, 1, 2) === 3) {
      q[2] = 4
      c = (bitsOf(packed, 3, 4) << 3) | ((~bitsOf(packed, 5, 6) & 3) << 1) | bitOf(packed, 0)
    } else {
      q[2] = bitsOf(packed, 5, 6)
      c = bitsOf(packed, 0, 4)
    }

    if (bitsOf(c, 0, 2) === 5) {
      q[1] = 4
      q[0] = bitsOf(c, 3, 4)
    } else {
      q[1] = bitsOf(c, 3, 4)
      q[0] = bitsOf(c, 0, 2)
    }
  }

  for (let i = 0; i < 3; i++) {
    const at = sequence.count++
    sequence.kind[at] = QUINT
    sequence.numberBits[at] = bitsPerValue
    sequence.bitValue[at] = m[i]
    sequence.extra[at] = q[i]
  }
}

/**
 * Decodes at least `count` values. Trit and quint blocks are indivisible, so the
 * sequence can hold up to four more values than asked for; the extras are
 * ignored by every caller.
 */
function decodeIntegerSequence(
  cursor: BitCursor,
  sequence: Sequence,
  maxRange: number,
  count: number
): void {
  const encoding = createEncoding(maxRange)
  const bits = encodingBits(encoding)
  sequence.count = 0

  while (sequence.count < count) {
    switch (encodingKind(encoding)) {
      case QUINT:
        decodeQuintBlock(cursor, sequence, bits)
        break
      case TRIT:
        decodeTritBlock(cursor, sequence, bits)
        break
      default: {
        const at = sequence.count++
        sequence.kind[at] = JUST_BITS
        sequence.numberBits[at] = bits
        sequence.bitValue[at] = cursor.read(bits)
        sequence.extra[at] = 0
        break
      }
    }
  }
}

/* -------------------------------------------------------------- block mode (C.2.8) */

interface TexelParams {
  /** Weight grid dimensions, which need not match the block's. */
  width: number
  height: number
  dualPlane: boolean
  maxWeight: number
  error: boolean
  voidExtentLdr: boolean
  voidExtentHdr: boolean
}

function packedWeightBits(params: TexelParams): number {
  const count = params.width * params.height * (params.dualPlane ? 2 : 1)
  return sequenceBitLength(createEncoding(params.maxWeight), count)
}

function weightValueCount(params: TexelParams): number {
  return params.width * params.height * (params.dualPlane ? 2 : 1)
}

/** Weight ranges for the low- and high-precision rows of table C.2.7. */
const LOW_PRECISION_WEIGHTS = [1, 2, 3, 4, 5, 7]
const HIGH_PRECISION_WEIGHTS = [9, 11, 15, 19, 23, 31]

function decodeBlockMode(cursor: BitCursor, params: TexelParams): void {
  params.width = 0
  params.height = 0
  params.dualPlane = false
  params.maxWeight = 0
  params.error = false
  params.voidExtentLdr = false
  params.voidExtentHdr = false

  const mode = cursor.read(11)

  // Void extent: bits 0-8 are 111111100, bit 9 picks the dynamic range, and
  // bits 10-11 are reserved and must both be set.
  if ((mode & 0x01ff) === 0x1fc) {
    if ((mode & 0x200) !== 0) params.voidExtentHdr = true
    else params.voidExtentLdr = true

    if ((mode & 0x400) === 0 || cursor.read(1) === 0) params.error = true
    return
  }

  if ((mode & 0xf) === 0) {
    params.error = true
    return
  }

  if ((mode & 0x3) === 0 && (mode & 0x1c0) === 0x1c0) {
    params.error = true
    return
  }

  // Layout 0-9, indexing table C.2.8.
  let layout: number
  if ((mode & 0x3) !== 0) {
    if ((mode & 0x8) !== 0) {
      if ((mode & 0x4) !== 0) layout = (mode & 0x100) !== 0 ? 4 : 3
      else layout = 2
    } else {
      layout = (mode & 0x4) !== 0 ? 1 : 0
    }
  } else {
    if ((mode & 0x100) !== 0) {
      if ((mode & 0x80) !== 0) layout = (mode & 0x20) !== 0 ? 8 : 7
      else layout = 9
    } else {
      layout = (mode & 0x80) !== 0 ? 6 : 5
    }
  }

  let range = (mode >> 4) & 1
  if (layout < 5) range |= (mode & 0x3) << 1
  else range |= (mode & 0xc) >> 1

  // The reference only asserts this. A block claiming range < 2 would index
  // before the start of the weight tables.
  if (range < 2 || range > 7) {
    params.error = true
    return
  }

  const a = (mode >> 5) & 0x3
  switch (layout) {
    case 0:
      params.width = ((mode >> 7) & 0x3) + 4
      params.height = a + 2
      break
    case 1:
      params.width = ((mode >> 7) & 0x3) + 8
      params.height = a + 2
      break
    case 2:
      params.width = a + 2
      params.height = ((mode >> 7) & 0x3) + 8
      break
    case 3:
      params.width = a + 2
      params.height = ((mode >> 7) & 0x1) + 6
      break
    case 4:
      params.width = ((mode >> 7) & 0x1) + 2
      params.height = a + 2
      break
    case 5:
      params.width = 12
      params.height = a + 2
      break
    case 6:
      params.width = a + 2
      params.height = 12
      break
    case 7:
      params.width = 6
      params.height = 10
      break
    case 8:
      params.width = 10
      params.height = 6
      break
    default:
      params.width = a + 6
      params.height = ((mode >> 9) & 0x3) + 6
      break
  }

  // Layout 9 spends the bits that would carry these on its grid size.
  params.dualPlane = layout !== 9 && (mode & 0x400) !== 0
  const highPrecision = layout !== 9 && (mode & 0x200) !== 0
  params.maxWeight = (highPrecision ? HIGH_PRECISION_WEIGHTS : LOW_PRECISION_WEIGHTS)[range - 2]
}

/* ------------------------------------------------------------- colours (C.2.13) */

/**
 * Dequantises the endpoint colour sequence to 0-255.
 *
 * The range is not stored; it is recovered by finding the widest range whose
 * encoded sequence still fits in the bits left over after the weights.
 */
function decodeColorValues(
  cursor: BitCursor,
  sequence: Sequence,
  bytes: Uint8Array,
  out: Int32Array,
  modes: Int32Array,
  partitionCount: number,
  colorDataBits: number
): void {
  let valueCount = 0
  for (let i = 0; i < partitionCount; i++) {
    valueCount += ((modes[i] >> 2) + 1) << 1
  }

  let range = 256
  while (--range > 0) {
    const encoding = createEncoding(range)
    if (sequenceBitLength(encoding, valueCount) <= colorDataBits) {
      // Step down to the smallest range that still uses this same encoding, so
      // the dequantisation constants below match what the encoder used.
      while (--range > 0) {
        if (createEncoding(range) !== encoding) break
      }
      range++
      break
    }
  }

  cursor.reset(bytes)
  decodeIntegerSequence(cursor, sequence, range, valueCount)

  let written = 0
  for (let i = 0; i < sequence.count && written < MAX_COLOR_VALUES; i++) {
    const bitLength = sequence.numberBits[i]
    const bitValue = sequence.bitValue[i]
    const kind = sequence.kind[i]

    if (kind === JUST_BITS) {
      out[written++] = replicate(bitValue, bitLength, 8)
      continue
    }

    // A is the low bit repeated nine times; B and C come from table C.2.16.
    const a = replicate(bitValue & 1, 1, 9)
    let b = 0
    let c = 0
    const d = sequence.extra[i]

    if (kind === TRIT) {
      switch (bitLength) {
        case 1:
          c = 204
          break
        case 2: {
          c = 93
          const x = (bitValue >> 1) & 1
          b = (x << 8) | (x << 4) | (x << 2) | (x << 1)
          break
        }
        case 3: {
          c = 44
          const x = (bitValue >> 1) & 3
          b = (x << 7) | (x << 2) | x
          break
        }
        case 4: {
          c = 22
          const x = (bitValue >> 1) & 7
          b = (x << 6) | x
          break
        }
        case 5: {
          c = 11
          const x = (bitValue >> 1) & 0xf
          b = (x << 5) | (x >> 2)
          break
        }
        case 6: {
          c = 5
          const x = (bitValue >> 1) & 0x1f
          b = (x << 4) | (x >> 4)
          break
        }
        default:
          // Ranges wider than this cannot be trit-encoded, so the range search
          // went wrong rather than the file being bad.
          out[written++] = 0
          continue
      }
    } else {
      switch (bitLength) {
        case 1:
          c = 113
          break
        case 2: {
          c = 54
          const x = (bitValue >> 1) & 1
          b = (x << 8) | (x << 3) | (x << 2)
          break
        }
        case 3: {
          c = 26
          const x = (bitValue >> 1) & 3
          b = (x << 7) | (x << 1) | (x >> 1)
          break
        }
        case 4: {
          c = 13
          const x = (bitValue >> 1) & 7
          b = (x << 6) | (x >> 1)
          break
        }
        case 5: {
          c = 6
          const x = (bitValue >> 1) & 0xf
          b = (x << 5) | (x >> 3)
          break
        }
        default:
          out[written++] = 0
          continue
      }
    }

    let value = d * c + b
    value ^= a
    out[written++] = (a & 0x80) | (value >> 2)
  }

  for (let i = written; i < MAX_COLOR_VALUES; i++) out[i] = 0
}

/** Moves the low bit of `a` into `b`'s sign, per C.2.14. Returns [a, b]. */
function bitTransferSigned(a: number, b: number): [number, number] {
  let low = b >> 1
  low |= a & 0x80
  let high = a >> 1
  high &= 0x3f
  if ((high & 0x20) !== 0) high -= 0x40
  return [high, low]
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/**
 * Endpoints are stored as (A, R, G, B) quadruples to match the component
 * ordering the reference's `GetComponent` uses, which the dual-plane channel
 * selector depends on.
 */
const ENDPOINT_STRIDE = 4

function setEndpoint(
  endpoints: Int32Array,
  slot: number,
  a: number,
  r: number,
  g: number,
  b: number
): void {
  const at = slot * ENDPOINT_STRIDE
  endpoints[at] = a
  endpoints[at + 1] = r
  endpoints[at + 2] = g
  endpoints[at + 3] = b
}

function clampEndpoint(endpoints: Int32Array, slot: number): void {
  const at = slot * ENDPOINT_STRIDE
  for (let i = 0; i < 4; i++) endpoints[at + i] = clampByte(endpoints[at + i])
}

/** Trades a little blue precision for more red and green, per C.2.14. */
function setBlueContracted(
  endpoints: Int32Array,
  slot: number,
  a: number,
  r: number,
  g: number,
  b: number
): void {
  setEndpoint(endpoints, slot, a, (r + b) >> 1, (g + b) >> 1, b)
}

/**
 * Turns dequantised colour values into a pair of endpoints for one partition.
 * Returns a reason string for endpoint modes this decoder does not implement.
 */
function computeEndpoints(
  endpoints: Int32Array,
  slot: number,
  values: Int32Array,
  mode: number,
  read: { at: number }
): string | null {
  const take = (count: number): Int32Array => {
    const out = values.subarray(read.at, read.at + count)
    read.at += count
    return out
  }

  switch (mode) {
    case 0: {
      const v = take(2)
      setEndpoint(endpoints, slot, 0xff, v[0], v[0], v[0])
      setEndpoint(endpoints, slot + 1, 0xff, v[1], v[1], v[1])
      return null
    }

    case 1: {
      const v = take(2)
      const l0 = (v[0] >> 2) | (v[1] & 0xc0)
      const l1 = Math.min(l0 + (v[1] & 0x3f), 0xff)
      setEndpoint(endpoints, slot, 0xff, l0, l0, l0)
      setEndpoint(endpoints, slot + 1, 0xff, l1, l1, l1)
      return null
    }

    case 4: {
      const v = take(4)
      setEndpoint(endpoints, slot, v[2], v[0], v[0], v[0])
      setEndpoint(endpoints, slot + 1, v[3], v[1], v[1], v[1])
      return null
    }

    case 5: {
      const v = take(4)
      const [lumaDelta, luma] = bitTransferSigned(v[1], v[0])
      const [alphaDelta, alpha] = bitTransferSigned(v[3], v[2])
      const luma1 = luma + lumaDelta
      setEndpoint(endpoints, slot, alpha, luma, luma, luma)
      setEndpoint(endpoints, slot + 1, alpha + alphaDelta, luma1, luma1, luma1)
      clampEndpoint(endpoints, slot)
      clampEndpoint(endpoints, slot + 1)
      return null
    }

    case 6: {
      const v = take(4)
      setEndpoint(
        endpoints,
        slot,
        0xff,
        (v[0] * v[3]) >> 8,
        (v[1] * v[3]) >> 8,
        (v[2] * v[3]) >> 8
      )
      setEndpoint(endpoints, slot + 1, 0xff, v[0], v[1], v[2])
      return null
    }

    case 8: {
      const v = take(6)
      if (v[1] + v[3] + v[5] >= v[0] + v[2] + v[4]) {
        setEndpoint(endpoints, slot, 0xff, v[0], v[2], v[4])
        setEndpoint(endpoints, slot + 1, 0xff, v[1], v[3], v[5])
      } else {
        setBlueContracted(endpoints, slot, 0xff, v[1], v[3], v[5])
        setBlueContracted(endpoints, slot + 1, 0xff, v[0], v[2], v[4])
      }
      return null
    }

    case 9: {
      const v = take(6)
      const [r1, r0] = bitTransferSigned(v[1], v[0])
      const [g1, g0] = bitTransferSigned(v[3], v[2])
      const [b1, b0] = bitTransferSigned(v[5], v[4])
      if (r1 + g1 + b1 >= 0) {
        setEndpoint(endpoints, slot, 0xff, r0, g0, b0)
        setEndpoint(endpoints, slot + 1, 0xff, r0 + r1, g0 + g1, b0 + b1)
      } else {
        setBlueContracted(endpoints, slot, 0xff, r0 + r1, g0 + g1, b0 + b1)
        setBlueContracted(endpoints, slot + 1, 0xff, r0, g0, b0)
      }
      clampEndpoint(endpoints, slot)
      clampEndpoint(endpoints, slot + 1)
      return null
    }

    case 10: {
      const v = take(6)
      setEndpoint(
        endpoints,
        slot,
        v[4],
        (v[0] * v[3]) >> 8,
        (v[1] * v[3]) >> 8,
        (v[2] * v[3]) >> 8
      )
      setEndpoint(endpoints, slot + 1, v[5], v[0], v[1], v[2])
      return null
    }

    case 12: {
      const v = take(8)
      if (v[1] + v[3] + v[5] >= v[0] + v[2] + v[4]) {
        setEndpoint(endpoints, slot, v[6], v[0], v[2], v[4])
        setEndpoint(endpoints, slot + 1, v[7], v[1], v[3], v[5])
      } else {
        setBlueContracted(endpoints, slot, v[7], v[1], v[3], v[5])
        setBlueContracted(endpoints, slot + 1, v[6], v[0], v[2], v[4])
      }
      return null
    }

    case 13: {
      const v = take(8)
      const [r1, r0] = bitTransferSigned(v[1], v[0])
      const [g1, g0] = bitTransferSigned(v[3], v[2])
      const [b1, b0] = bitTransferSigned(v[5], v[4])
      const [a1, a0] = bitTransferSigned(v[7], v[6])
      if (r1 + g1 + b1 >= 0) {
        setEndpoint(endpoints, slot, a0, r0, g0, b0)
        setEndpoint(endpoints, slot + 1, a0 + a1, r0 + r1, g0 + g1, b0 + b1)
      } else {
        setBlueContracted(endpoints, slot, a0 + a1, r0 + r1, g0 + g1, b0 + b1)
        setBlueContracted(endpoints, slot + 1, a0, r0, g0, b0)
      }
      clampEndpoint(endpoints, slot)
      clampEndpoint(endpoints, slot + 1)
      return null
    }

    default:
      return `colour endpoint mode ${mode} is HDR, which this decoder does not implement`
  }
}

/* -------------------------------------------------------------- weights (C.2.17) */

/** Dequantises one weight to 0-64. */
function unquantizeWeight(kind: number, bitValue: number, bitLength: number, extra: number): number {
  if (kind === JUST_BITS) {
    const plain = replicate(bitValue, bitLength, 6)
    return plain > 32 ? plain + 1 : plain
  }

  const a = replicate(bitValue & 1, 1, 7)
  let b = 0
  let c = 0
  const d = extra
  let result = 0

  if (kind === TRIT) {
    switch (bitLength) {
      case 0:
        result = [0, 32, 63][d] ?? 0
        break
      case 1:
        c = 50
        break
      case 2: {
        c = 23
        const x = (bitValue >> 1) & 1
        b = (x << 6) | (x << 2) | x
        break
      }
      case 3: {
        c = 11
        const x = (bitValue >> 1) & 3
        b = (x << 5) | x
        break
      }
      default:
        return 0
    }
  } else {
    switch (bitLength) {
      case 0:
        result = [0, 16, 32, 47, 63][d] ?? 0
        break
      case 1:
        c = 28
        break
      case 2: {
        c = 13
        const x = (bitValue >> 1) & 1
        b = (x << 6) | (x << 1)
        break
      }
      default:
        return 0
    }
  }

  if (bitLength > 0) {
    result = d * c + b
    result ^= a
    result = (a & 0x20) | (result >> 2)
  }

  // The stored range is 0-63; interpolation wants 0-64.
  return result > 32 ? result + 1 : result
}

/**
 * Expands the stored weight grid to one weight per texel, bilinearly (C.2.18).
 *
 * The grid is usually coarser than the block — a 6x6 block commonly stores a 4x4
 * grid — so most texels interpolate between four stored weights.
 */
function unquantizeTexelWeights(
  sequence: Sequence,
  params: TexelParams,
  blockWidth: number,
  blockHeight: number,
  unquantized0: Int32Array,
  unquantized1: Int32Array,
  weights0: Int32Array,
  weights1: Int32Array
): void {
  const gridSize = params.width * params.height
  unquantized0.fill(0)
  unquantized1.fill(0)

  let index = 0
  for (let i = 0; i < sequence.count && index < gridSize; i++) {
    unquantized0[index] = unquantizeWeight(
      sequence.kind[i],
      sequence.bitValue[i],
      sequence.numberBits[i],
      sequence.extra[i]
    )

    if (params.dualPlane) {
      i++
      if (i >= sequence.count) break
      unquantized1[index] = unquantizeWeight(
        sequence.kind[i],
        sequence.bitValue[i],
        sequence.numberBits[i],
        sequence.extra[i]
      )
    }

    index++
  }

  const ds = Math.floor((1024 + Math.floor(blockWidth / 2)) / (blockWidth - 1))
  const dt = Math.floor((1024 + Math.floor(blockHeight / 2)) / (blockHeight - 1))
  const planes = params.dualPlane ? 2 : 1

  for (let plane = 0; plane < planes; plane++) {
    const source = plane === 0 ? unquantized0 : unquantized1
    const target = plane === 0 ? weights0 : weights1

    for (let t = 0; t < blockHeight; t++) {
      for (let s = 0; s < blockWidth; s++) {
        const gs = (ds * s * (params.width - 1) + 32) >> 6
        const gt = (dt * t * (params.height - 1) + 32) >> 6

        const js = gs >> 4
        const fs = gs & 0xf
        const jt = gt >> 4
        const ft = gt & 0xf

        const w11 = (fs * ft + 8) >> 4
        const w10 = ft - w11
        const w01 = fs - w11
        const w00 = 16 - fs - ft + w11

        const v0 = js + jt * params.width
        const p00 = v0 < gridSize ? source[v0] : 0
        const p01 = v0 + 1 < gridSize ? source[v0 + 1] : 0
        const p10 = v0 + params.width < gridSize ? source[v0 + params.width] : 0
        const p11 = v0 + params.width + 1 < gridSize ? source[v0 + params.width + 1] : 0

        target[t * blockWidth + s] = (p00 * w00 + p01 * w01 + p10 * w10 + p11 * w11 + 8) >> 4
      }
    }
  }
}

/* ------------------------------------------------------------ partitions (C.2.21) */

function hash52(value: number): number {
  let v = value >>> 0
  v = (v ^ (v >>> 15)) >>> 0
  v = (v - ((v << 17) >>> 0)) >>> 0
  v = (v + ((v << 7) >>> 0)) >>> 0
  v = (v + ((v << 4) >>> 0)) >>> 0
  v = (v ^ (v >>> 5)) >>> 0
  v = (v + ((v << 16) >>> 0)) >>> 0
  v = (v ^ (v >>> 7)) >>> 0
  v = (v ^ (v >>> 3)) >>> 0
  v = (v ^ ((v << 6) >>> 0)) >>> 0
  v = (v ^ (v >>> 17)) >>> 0
  return v >>> 0
}

/**
 * The part of the partition hash that depends only on the block.
 *
 * ASTC does not store a partition map; it stores a 10-bit seed and both encoder
 * and decoder run this hash to agree on the shape. Only the final weighted sum
 * varies per texel, so everything above it is computed once per block — it used
 * to run the whole hash for all 144 texels.
 */
interface PartitionSeeds {
  /** Eight squared-and-shifted seeds, as (x, y) coefficient pairs. */
  readonly coefficients: Int32Array
  /** The four per-texel offsets, already shifted out of the hash. */
  readonly offsets: Int32Array
}

function makePartitionSeeds(): PartitionSeeds {
  return { coefficients: new Int32Array(8), offsets: new Int32Array(4) }
}

function preparePartitionSeeds(
  seed: number,
  partitionCount: number,
  into: PartitionSeeds
): void {
  const s = seed + (partitionCount - 1) * 1024

  // Deliberately signed: the reference shifts this arithmetically.
  const random = hash52(s) | 0

  let shift1: number
  let shift2: number
  if ((s & 1) !== 0) {
    shift1 = (s & 2) !== 0 ? 4 : 5
    shift2 = partitionCount === 3 ? 6 : 5
  } else {
    shift1 = partitionCount === 3 ? 6 : 5
    shift2 = (s & 2) !== 0 ? 4 : 5
  }

  // Nibbles 0-7 pair up as the x and y coefficients of the four candidates, x
  // taking shift1 and y shift2. The reference's four further seeds only ever
  // multiply z, which is 0 for 2D blocks, so they are not computed at all.
  for (let i = 0; i < 8; i++) {
    const nibble = (random >> (i * 4)) & 0xf
    into.coefficients[i] = (nibble * nibble) >> (i % 2 === 0 ? shift1 : shift2)
  }

  into.offsets[0] = random >> 14
  into.offsets[1] = random >> 10
  into.offsets[2] = random >> 6
  into.offsets[3] = random >> 2
}

/**
 * Which partition a texel belongs to. `smallBlock` doubles the coordinates for
 * blocks under 31 texels so the same hash yields useful shapes at small sizes.
 */
function selectPartition(
  seeds: PartitionSeeds,
  x: number,
  y: number,
  partitionCount: number,
  smallBlock: boolean
): number {
  const px = smallBlock ? x << 1 : x
  const py = smallBlock ? y << 1 : y
  const k = seeds.coefficients
  const o = seeds.offsets

  const a = (k[0]! * px + k[1]! * py + o[0]!) & 0x3f
  const b = (k[2]! * px + k[3]! * py + o[1]!) & 0x3f
  let c = (k[4]! * px + k[5]! * py + o[2]!) & 0x3f
  let d = (k[6]! * px + k[7]! * py + o[3]!) & 0x3f

  if (partitionCount < 4) d = 0
  if (partitionCount < 3) c = 0

  if (a >= b && a >= c && a >= d) return 0
  if (b >= c && b >= d) return 1
  if (c >= d) return 2
  return 3
}

/* ----------------------------------------------------------------- void extent */

/**
 * A constant-colour block. The extent coordinates say over what area the colour
 * is valid, which only matters to an encoder, so they are read and dropped.
 */
function fillVoidExtentLdr(
  cursor: BitCursor,
  tile: Uint8Array,
  blockWidth: number,
  blockHeight: number
): void {
  for (let i = 0; i < 4; i++) cursor.read(13)

  // Stored as UNORM16; the top byte is the 8-bit value.
  const r = cursor.read(16) >> 8
  const g = cursor.read(16) >> 8
  const b = cursor.read(16) >> 8
  const a = cursor.read(16) >> 8

  for (let i = 0; i < blockWidth * blockHeight; i++) {
    const at = i * 4
    tile[at] = r
    tile[at + 1] = g
    tile[at + 2] = b
    tile[at + 3] = a
  }
}

/* ------------------------------------------------------------------ block decode */

/** Buffers reused across every block of a surface. */
interface AstcScratch {
  readonly block: Uint8Array
  readonly weightBytes: Uint8Array
  readonly colorBytes: Uint8Array
  readonly blockCursor: BitCursor
  readonly weightCursor: BitCursor
  readonly colorCursor: BitCursor
  readonly sequence: Sequence
  readonly colorValues: Int32Array
  readonly endpointModes: Int32Array
  readonly endpoints: Int32Array
  /** The same endpoints widened to 16 bits, ready for interpolation. */
  readonly expandedEndpoints: Int32Array
  readonly partitionSeeds: PartitionSeeds
  readonly unquantized0: Int32Array
  readonly unquantized1: Int32Array
  readonly weights0: Int32Array
  readonly weights1: Int32Array
  readonly tile: Uint8Array
  readonly params: TexelParams
}

function makeScratch(): AstcScratch {
  return {
    block: new Uint8Array(BLOCK_BUFFER_SIZE),
    weightBytes: new Uint8Array(BLOCK_BUFFER_SIZE),
    colorBytes: new Uint8Array(BLOCK_BUFFER_SIZE),
    blockCursor: new BitCursor(),
    weightCursor: new BitCursor(),
    colorCursor: new BitCursor(),
    sequence: makeSequence(),
    colorValues: new Int32Array(MAX_COLOR_VALUES),
    endpointModes: new Int32Array(4),
    // Four partitions, two endpoints each, four components each.
    endpoints: new Int32Array(4 * 2 * ENDPOINT_STRIDE),
    expandedEndpoints: new Int32Array(4 * 2 * ENDPOINT_STRIDE),
    partitionSeeds: makePartitionSeeds(),
    unquantized0: new Int32Array(MAX_TEXELS),
    unquantized1: new Int32Array(MAX_TEXELS),
    weights0: new Int32Array(MAX_TEXELS),
    weights1: new Int32Array(MAX_TEXELS),
    tile: new Uint8Array(MAX_TEXELS * 4),
    params: {
      width: 0,
      height: 0,
      dualPlane: false,
      maxWeight: 0,
      error: false,
      voidExtentLdr: false,
      voidExtentHdr: false
    }
  }
}

/** Reverses a byte's bit order. */
function reverseByte(value: number): number {
  let b = value
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4)
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2)
  b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1)
  return b & 0xff
}

/**
 * Decodes one 16-byte block into `scratch.tile` as RGBA8, row-major, one row per
 * `blockWidth`. Returns null on success or a reason the block could not be
 * decoded.
 */
function decodeBlock(
  scratch: AstcScratch,
  data: Uint8Array,
  offset: number,
  blockWidth: number,
  blockHeight: number
): string | null {
  const { block, params, tile } = scratch

  // Copy into a padded buffer so overshooting reads see zeroes.
  block.set(data.subarray(offset, offset + 16))
  block.fill(0, 16)

  const cursor = scratch.blockCursor
  cursor.reset(block)
  decodeBlockMode(cursor, params)

  if (params.error) return 'invalid block mode'
  if (params.voidExtentHdr) return 'HDR void extent blocks are not supported'

  if (params.voidExtentLdr) {
    fillVoidExtentLdr(cursor, tile, blockWidth, blockHeight)
    return null
  }

  if (params.width > blockWidth || params.height > blockHeight) {
    return `weight grid ${params.width}x${params.height} exceeds the ${blockWidth}x${blockHeight} block`
  }

  const partitionCount = cursor.read(2) + 1
  if (partitionCount === 4 && params.dualPlane) {
    return 'dual plane mode cannot be combined with four partitions'
  }

  const modes = scratch.endpointModes
  modes.fill(0)

  let partitionIndex = 0
  let baseEndpointMode = 0
  if (partitionCount === 1) {
    modes[0] = cursor.read(4)
  } else {
    partitionIndex = cursor.read(10)
    baseEndpointMode = cursor.read(6)
  }
  const baseMode = baseEndpointMode & 3

  const weightBits = packedWeightBits(params)
  if (weightBits > 128) return `weight data needs ${weightBits} bits, more than the block holds`

  let remaining = 128 - weightBits - cursor.pos

  // With several partitions and a non-degenerate base mode, the endpoint modes
  // need extra bits that sit after the colour data.
  let extraModeBits = 0
  if (baseMode !== 0) {
    extraModeBits = partitionCount === 2 ? 2 : partitionCount === 3 ? 5 : 8
  }
  remaining -= extraModeBits

  const planeSelectorBits = params.dualPlane ? 2 : 0
  remaining -= planeSelectorBits

  const colorDataBits = remaining
  if (colorDataBits <= 0) return 'no bits left for colour endpoint data'

  // Colour data is relocated to its own bit stream because the endpoint-mode
  // tail bits sit between it and the weights.
  scratch.colorBytes.fill(0)
  const colorWriter = scratch.colorCursor
  colorWriter.reset(scratch.colorBytes)
  while (remaining > 0) {
    colorWriter.write(cursor.read(Math.min(remaining, 8)), Math.min(remaining, 8))
    remaining -= 8
  }

  const planeSelector = cursor.read(planeSelectorBits)

  if (baseMode !== 0) {
    const extra = cursor.read(extraModeBits)
    let combined = ((extra << 6) | baseEndpointMode) >>> 2

    const classBit: boolean[] = [false, false, false, false]
    for (let i = 0; i < partitionCount; i++) {
      classBit[i] = (combined & 1) !== 0
      combined >>>= 1
    }

    for (let i = 0; i < partitionCount; i++) {
      const low = combined & 3
      combined >>>= 2
      let mode = baseMode
      if (!classBit[i]) mode -= 1
      mode <<= 2
      modes[i] = mode | low
    }
  } else if (partitionCount > 1) {
    const shared = baseEndpointMode >> 2
    for (let i = 0; i < partitionCount; i++) modes[i] = shared
  }

  for (let i = 0; i < partitionCount; i++) {
    if (modes[i] < 0 || modes[i] > 15) return `colour endpoint mode ${modes[i]} is out of range`
  }

  // A well-formed block spends exactly its 128 bits. A mismatch means the mode
  // was decoded wrongly and everything downstream would be noise.
  if (cursor.pos + weightBits !== 128) {
    return `block layout does not add up to 128 bits (${cursor.pos} + ${weightBits})`
  }

  decodeColorValues(
    scratch.colorCursor,
    scratch.sequence,
    scratch.colorBytes,
    scratch.colorValues,
    modes,
    partitionCount,
    colorDataBits
  )

  const read = { at: 0 }
  for (let i = 0; i < partitionCount; i++) {
    const failure = computeEndpoints(
      scratch.endpoints,
      i * 2,
      scratch.colorValues,
      modes[i],
      read
    )
    if (failure) return failure
  }

  /*
   * Weights are stored from the *end* of the block backwards, so the whole block
   * is bit-reversed and read forwards instead. Bits above the weight data belong
   * to the colour endpoints and must be cleared or they would decode as weights.
   */
  const weightBytes = scratch.weightBytes
  for (let i = 0; i < 16; i++) weightBytes[i] = reverseByte(block[15 - i])
  weightBytes.fill(0, 16)

  const lastWeightByte = weightBits >> 3
  weightBytes[lastWeightByte] &= (1 << (weightBits % 8)) - 1
  weightBytes.fill(0, lastWeightByte + 1)

  scratch.weightCursor.reset(weightBytes)
  decodeIntegerSequence(
    scratch.weightCursor,
    scratch.sequence,
    params.maxWeight,
    weightValueCount(params)
  )

  unquantizeTexelWeights(
    scratch.sequence,
    params,
    blockWidth,
    blockHeight,
    scratch.unquantized0,
    scratch.unquantized1,
    scratch.weights0,
    scratch.weights1
  )

  const smallBlock = blockWidth * blockHeight < 31
  // Component indices here are 0=A, 1=R, 2=G, 3=B; the plane-2 selector names
  // channels as 0=R..3=A, hence the rotation.
  const dualPlaneComponent = params.dualPlane ? (planeSelector + 1) & 3 : -1

  // Endpoints are per-partition, so widen them to 16 bits once rather than once
  // per texel. For an 8-bit value this replication is just (v << 8) | v.
  const expanded = scratch.expandedEndpoints
  for (let i = 0; i < partitionCount * 2 * ENDPOINT_STRIDE; i++) {
    const value = scratch.endpoints[i]!
    expanded[i] = (value << 8) | value
  }

  if (partitionCount > 1) {
    preparePartitionSeeds(partitionIndex, partitionCount, scratch.partitionSeeds)
  }

  for (let y = 0; y < blockHeight; y++) {
    for (let x = 0; x < blockWidth; x++) {
      const partition =
        partitionCount === 1
          ? 0
          : selectPartition(scratch.partitionSeeds, x, y, partitionCount, smallBlock)
      const low = partition * 2 * ENDPOINT_STRIDE
      const high = low + ENDPOINT_STRIDE
      const texel = y * blockWidth + x
      const at = texel * 4

      for (let component = 0; component < 4; component++) {
        const c0 = expanded[low + component]!
        const c1 = expanded[high + component]!
        const weight =
          component === dualPlaneComponent ? scratch.weights1[texel] : scratch.weights0[texel]

        const value = Math.floor((c0 * (64 - weight) + c1 * weight + 32) / 64)

        /*
         * The interpolated value is UNORM16 and the output is 8-bit, and the
         * conversion is a truncation to the top byte rather than a rescale.
         *
         * This was measured, not assumed. Rounding — `round(value / 257)`, the
         * arithmetically faithful UNORM16 to UNORM8 conversion — disagrees with
         * astcenc on 6.5% of bytes by one, in both directions; so does the
         * Ryujinx reference's `255 * value / 65536 + 0.5`. Taking the top eight
         * bits reproduces astcenc exactly across every test vector. It is also
         * what the spec prescribes for the sRGB path, which is the variant these
         * files actually use.
         */
        const byte = value >> 8

        // Component 0 is alpha, then R, G, B.
        tile[at + (component === 0 ? 3 : component - 1)] = clampByte(byte)
      }
    }
  }

  return null
}

/* ---------------------------------------------------------------- surface decode */

/**
 * Decodes an untiled ASTC surface to RGBA8.
 *
 * `data` must hold whole blocks in row-major order:
 * `ceil(width / blockWidth) * ceil(height / blockHeight) * 16` bytes. Blocks that
 * cannot be decoded leave their pixels transparent and are counted rather than
 * aborting the surface, so one bad block does not lose the image.
 */
export function decodeAstc(
  width: number,
  height: number,
  blockWidth: number,
  blockHeight: number,
  data: Uint8Array
): AstcDecodeResult {
  if (blockWidth < 4 || blockWidth > 12 || blockHeight < 4 || blockHeight > 12) {
    return {
      rgba: new Uint8Array(Math.max(0, width * height * 4)),
      failedBlocks: 0,
      totalBlocks: 0,
      firstError: `${blockWidth}x${blockHeight} is not a 2D ASTC block size`
    }
  }

  const rgba = new Uint8Array(width * height * 4)
  const blocksX = Math.ceil(width / blockWidth)
  const blocksY = Math.ceil(height / blockHeight)
  const scratch = makeScratch()

  let failedBlocks = 0
  let firstError: string | null = null

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const offset = (by * blocksX + bx) * 16
      const failure = decodeBlock(scratch, data, offset, blockWidth, blockHeight)

      if (failure !== null) {
        failedBlocks++
        if (firstError === null) firstError = failure
        continue
      }

      const rows = Math.min(blockHeight, height - by * blockHeight)
      const columns = Math.min(blockWidth, width - bx * blockWidth)
      for (let ty = 0; ty < rows; ty++) {
        const to = ((by * blockHeight + ty) * width + bx * blockWidth) * 4
        const from = ty * blockWidth * 4
        rgba.set(scratch.tile.subarray(from, from + columns * 4), to)
      }
    }
  }

  return { rgba, failedBlocks, totalBlocks: blocksX * blocksY, firstError }
}

/**
 * Decodes a single block to a `blockWidth * blockHeight * 4` RGBA8 tile.
 * Exposed for tests, which need to reason about one block at a time.
 */
export function decodeAstcBlock(
  data: Uint8Array,
  blockWidth: number,
  blockHeight: number
): { tile: Uint8Array; error: string | null } {
  const scratch = makeScratch()
  const error = decodeBlock(scratch, data, 0, blockWidth, blockHeight)
  return { tile: scratch.tile.slice(0, blockWidth * blockHeight * 4), error }
}
