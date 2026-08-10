import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * ZIP, written and read by hand.
 *
 * A mod is distributed as a zip — that is what every loader's install
 * instructions and every mod site expect — and pulling in an archive library for
 * one well-specified container is a poor trade when `node:zlib` already supplies
 * the only hard part. What is left is a handful of fixed-layout records.
 *
 * Deliberately the boring subset: no encryption, no ZIP64, no data descriptors,
 * store and deflate only. A mod that needed any of those would be a mod nobody
 * should install.
 */

export interface ZipEntry {
  /** Forward slashes, no leading slash — the same relative form the mod layer uses. */
  readonly name: string
  readonly data: Uint8Array
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50

/** Store when deflating gains nothing, which is the case for already-compressed assets. */
const STORED = 0
const DEFLATED = 8

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let at = 0; at < 256; at++) {
    let value = at
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[at] = value >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let at = 0; at < data.length; at++) {
    crc = CRC_TABLE[(crc ^ data[at]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

class Buffer_ {
  private parts: Uint8Array[] = []
  private size = 0

  push(bytes: Uint8Array): void {
    this.parts.push(bytes)
    this.size += bytes.length
  }

  u16(value: number): void {
    this.push(Uint8Array.from([value & 0xff, (value >> 8) & 0xff]))
  }

  u32(value: number): void {
    this.push(
      Uint8Array.from([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff
      ])
    )
  }

  get length(): number {
    return this.size
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size)
    let at = 0
    for (const part of this.parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  }
}

/**
 * Builds a zip.
 *
 * Timestamps are fixed rather than taken from the clock, which makes a package
 * byte-reproducible: building the same mod twice produces the same file, so a
 * checksum means something and a re-release with no changes is visibly a
 * re-release with no changes.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const out = new Buffer_()
  const central: { record: Uint8Array; offset: number }[] = []

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const checksum = crc32(entry.data)

    const deflated = deflateRawSync(entry.data, { level: 9 })
    // Storing is better whenever deflate did not help; game assets are usually
    // already compressed, and a "compressed" copy that is bigger is just slower.
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? new Uint8Array(deflated) : entry.data
    const method = useDeflate ? DEFLATED : STORED

    const offset = out.length
    out.u32(LOCAL_SIGNATURE)
    out.u16(20) // version needed
    out.u16(0) // flags
    out.u16(method)
    out.u16(0) // time
    out.u16(0x21) // date: 1980-01-01, fixed for reproducibility
    out.u32(checksum)
    out.u32(payload.length)
    out.u32(entry.data.length)
    out.u16(name.length)
    out.u16(0) // extra length
    out.push(name)
    out.push(payload)

    const record = new Buffer_()
    record.u32(CENTRAL_SIGNATURE)
    record.u16(20) // version made by
    record.u16(20) // version needed
    record.u16(0)
    record.u16(method)
    record.u16(0)
    record.u16(0x21)
    record.u32(checksum)
    record.u32(payload.length)
    record.u32(entry.data.length)
    record.u16(name.length)
    record.u16(0) // extra
    record.u16(0) // comment
    record.u16(0) // disk
    record.u16(0) // internal attrs
    record.u32(0) // external attrs
    record.u32(offset)
    record.push(name)
    central.push({ record: record.toBytes(), offset })
  }

  const centralStart = out.length
  for (const entry of central) out.push(entry.record)
  const centralSize = out.length - centralStart

  out.u32(END_SIGNATURE)
  out.u16(0)
  out.u16(0)
  out.u16(central.length)
  out.u16(central.length)
  out.u32(centralSize)
  out.u32(centralStart)
  out.u16(0)

  return out.toBytes()
}

/**
 * Reads a zip, checking every entry's CRC.
 *
 * The checksum check is not optional here. This reads mods other people built,
 * and a truncated download that installs cleanly and then corrupts a game file is
 * the worst outcome available — far worse than refusing to import.
 */
export function readZip(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // The end record is at the end, after a comment of unknown length; scan back.
  let end = -1
  for (let at = data.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === END_SIGNATURE) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('not a zip file (no end-of-central-directory record)')

  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)

  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (at + 46 > data.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`zip central directory is damaged at entry ${index + 1}`)
    }

    const method = view.getUint16(at + 10, true)
    const checksum = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const uncompressedSize = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength

    if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`${name}: local header is missing or damaged`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const payload = data.subarray(start, start + compressedSize)

    // A directory entry, which carries no data.
    if (name.endsWith('/')) continue

    const bytes =
      method === STORED
        ? new Uint8Array(payload)
        : method === DEFLATED
          ? new Uint8Array(inflateRawSync(payload))
          : (() => {
              throw new Error(`${name}: compression method ${method} is not supported`)
            })()

    if (bytes.length !== uncompressedSize || crc32(bytes) !== checksum) {
      throw new Error(
        `${name} failed its checksum — the archive is damaged or was truncated in transfer. Download it again rather than installing it.`
      )
    }

    entries.push({ name, data: bytes })
  }

  return entries
}
