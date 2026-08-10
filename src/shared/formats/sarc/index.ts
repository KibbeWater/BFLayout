import { BinaryReader } from '@shared/binary/reader'
import { BinaryWriter } from '@shared/binary/writer'
import { FormatParseError, FormatWriteError } from '@shared/binary/errors'

/**
 * SARC — the archive Nintendo ships layouts inside. Conventional folders are
 * blyt/ (layouts), anim/ (animations), timg/ (textures) and font/.
 *
 * Structure: SARC header, SFAT node table sorted by name hash, SFNT name table,
 * then the file data. Some archives omit names entirely and are addressed only
 * by hash — see recoverSarcNames.
 */

const SARC_HEADER_SIZE = 0x14
const SFAT_HEADER_SIZE = 0x0c
const SFAT_NODE_SIZE = 0x10
const SFNT_HEADER_SIZE = 0x08
const HAS_NAME_FLAG = 0x0100_0000
const DEFAULT_HASH_KEY = 0x65
const MAX_ALIGNMENT = 0x2000

export interface SarcEntry {
  readonly nameHash: number
  /** null when the archive carries no name table for this node. */
  readonly name: string | null
  readonly data: Uint8Array
  /** Offset relative to the archive's data section, as originally stored. */
  readonly originalOffset: number
  /** Size as originally stored; a mismatch with data.length forces a repack. */
  readonly originalLength: number
  /** Largest power-of-two boundary the original absolute offset sat on. */
  readonly alignment: number
}

export interface SarcArchive {
  readonly littleEndian: boolean
  readonly version: number
  readonly hashKey: number
  readonly hasNames: boolean
  readonly originalDataOffset: number
  readonly entries: readonly SarcEntry[]
}

/** SARC name hash: `hash = hash * key + byte`, wrapping at 32 bits. */
export function sarcHash(name: string, key: number = DEFAULT_HASH_KEY): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (Math.imul(hash, key) + name.charCodeAt(i)) >>> 0
  }
  return hash
}

/**
 * GPU resources the driver maps rather than reads.
 *
 * A shader or texture container that does not start on a page boundary is not a
 * file the reader rejects — it is a null dereference somewhere inside it, with
 * nothing connecting the crash to how the archive was packed. Every stock archive
 * puts these on 0x1000, and so must anything this writes.
 */
const PAGE_ALIGNED = new Set(['.bntx', '.bnsh'])

/** Bytes an entry of this name must start on when the archive is rebuilt. */
export const GPU_ALIGNMENT = 0x1000

/**
 * The alignment a *new* entry should be given, from its name.
 *
 * Existing entries carry an alignment inferred from where they already sat, which
 * preserves a stock archive exactly. A new one has no such history, and guessing
 * from whichever sibling happens to share its extension gets it wrong precisely
 * when it matters: the first `.bntx` added to an archive that has none.
 */
export function sarcAlignmentFor(name: string): number {
  const lower = name.toLowerCase()
  for (const extension of PAGE_ALIGNED) {
    if (lower.endsWith(extension)) return GPU_ALIGNMENT
  }
  return DEFAULT_ENTRY_ALIGNMENT
}

/** True when this entry has to start on a page boundary. */
export function needsPageAlignment(name: string): boolean {
  const lower = name.toLowerCase()
  return [...PAGE_ALIGNED].some((extension) => lower.endsWith(extension))
}

/**
 * What everything else gets. Stock archives leave non-GPU entries wherever they
 * fall, so this only has to be a sane floor rather than a reproduction.
 */
const DEFAULT_ENTRY_ALIGNMENT = 0x80

function detectAlignment(absoluteOffset: number): number {
  if (absoluteOffset === 0) return MAX_ALIGNMENT
  let alignment = 1
  while (alignment < MAX_ALIGNMENT && absoluteOffset % (alignment * 2) === 0) {
    alignment *= 2
  }
  return alignment
}

export function isSarc(data: Uint8Array): boolean {
  return (
    data.length >= SARC_HEADER_SIZE &&
    data[0] === 0x53 &&
    data[1] === 0x41 &&
    data[2] === 0x52 &&
    data[3] === 0x43
  )
}

export function parseSarc(data: Uint8Array): SarcArchive {
  if (!isSarc(data)) {
    throw new FormatParseError({ format: 'sarc', offset: 0, message: 'missing SARC signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: false })

  // The byte-order mark sits after headerSize, so it has to be read first.
  const bom = reader.at(0x06, () => reader.u16be())
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'sarc',
      offset: 0x06,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  reader.littleEndian = bom === 0xfffe

  reader.seek(4)
  const headerSize = reader.u16()
  reader.skip(2) // byte-order mark
  const fileSize = reader.u32()
  const dataOffset = reader.u32()
  const version = reader.u16()
  reader.skip(2)

  if (headerSize !== SARC_HEADER_SIZE) {
    throw new FormatParseError({
      format: 'sarc',
      offset: 4,
      message: `unexpected SARC header size ${headerSize}`
    })
  }
  if (fileSize > data.length) {
    throw new FormatParseError({
      format: 'sarc',
      offset: 8,
      message: `header claims ${fileSize} bytes but only ${data.length} are present`
    })
  }

  reader.seek(headerSize)
  if (reader.fixedString(4) !== 'SFAT') {
    throw new FormatParseError({
      format: 'sarc',
      offset: headerSize,
      section: 'SFAT',
      message: 'missing SFAT signature'
    })
  }
  const sfatHeaderSize = reader.u16()
  const nodeCount = reader.u16()
  const hashKey = reader.u32()

  const nodes: Array<{ hash: number; attrs: number; begin: number; end: number }> = []
  reader.seek(headerSize + sfatHeaderSize)
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      hash: reader.u32(),
      attrs: reader.u32(),
      begin: reader.u32(),
      end: reader.u32()
    })
  }

  // SFNT immediately follows the node table.
  let nameTableStart = -1
  if (reader.remaining >= SFNT_HEADER_SIZE) {
    const sfntPos = reader.tell()
    if (reader.fixedString(4) === 'SFNT') {
      reader.u16() // header size
      reader.u16() // reserved
      nameTableStart = sfntPos + SFNT_HEADER_SIZE
    }
  }

  let hasNames = false
  const entries: SarcEntry[] = nodes.map((node) => {
    let name: string | null = null
    if (nameTableStart >= 0 && (node.attrs & HAS_NAME_FLAG) !== 0) {
      name = reader.cstringAt(nameTableStart + (node.attrs & 0x00ff_ffff) * 4)
      hasNames = true
    }

    const start = dataOffset + node.begin
    const end = dataOffset + node.end
    if (end > data.length || node.end < node.begin) {
      throw new FormatParseError({
        format: 'sarc',
        offset: start,
        section: name ?? `hash 0x${node.hash.toString(16)}`,
        message: `entry data range [${start}, ${end}) is outside the archive`
      })
    }

    return {
      nameHash: node.hash,
      name,
      data: data.slice(start, end),
      originalOffset: node.begin,
      originalLength: end - start,
      alignment: detectAlignment(start)
    }
  })

  return {
    littleEndian: reader.littleEndian,
    version,
    hashKey,
    hasNames,
    originalDataOffset: dataOffset,
    entries
  }
}

/**
 * Fills in names for a hash-only archive by hashing candidates and matching.
 * Layout files name their textures in txl1, which is where candidates come from.
 */
export function recoverSarcNames(
  archive: SarcArchive,
  candidates: Iterable<string>
): SarcArchive {
  const byHash = new Map<number, string>()
  for (const candidate of candidates) {
    byHash.set(sarcHash(candidate, archive.hashKey), candidate)
  }

  let recovered = false
  const entries = archive.entries.map((entry) => {
    if (entry.name !== null) return entry
    const found = byHash.get(entry.nameHash)
    if (found === undefined) return entry
    recovered = true
    return { ...entry, name: found }
  })

  if (!recovered) return archive
  return { ...archive, entries, hasNames: true }
}

export function findSarcEntry(archive: SarcArchive, name: string): SarcEntry | undefined {
  const hash = sarcHash(name, archive.hashKey)
  return (
    archive.entries.find((entry) => entry.name === name) ??
    archive.entries.find((entry) => entry.nameHash === hash)
  )
}

/** Replaces one entry's bytes, leaving every other entry untouched. */
export function replaceSarcEntry(
  archive: SarcArchive,
  name: string,
  data: Uint8Array
): SarcArchive {
  const target = findSarcEntry(archive, name)
  if (!target) {
    throw new FormatWriteError({
      format: 'sarc',
      section: name,
      message: `no entry named "${name}" in archive`
    })
  }
  return {
    ...archive,
    entries: archive.entries.map((entry) => (entry === target ? { ...entry, data } : entry))
  }
}

export function writeSarc(archive: SarcArchive): Uint8Array {
  if (archive.entries.some((entry) => entry.name === null)) {
    // Writing without names would need the original attrs preserved per node;
    // refuse rather than silently producing an archive with broken lookups.
    throw new FormatWriteError({
      format: 'sarc',
      message: 'cannot write an archive with unnamed entries; recover names first'
    })
  }

  // Nodes are ordered by hash. The sort is stable, so colliding hashes keep
  // their original relative order.
  const sorted = [...archive.entries].sort((a, b) => a.nameHash - b.nameHash)

  const nameTable = new BinaryWriter({ littleEndian: archive.littleEndian })
  const nameOffsets: number[] = []
  for (const entry of sorted) {
    nameOffsets.push(nameTable.length)
    nameTable.cstring(entry.name!)
    nameTable.align(4)
  }
  const nameBytes = nameTable.toBytes()

  const headerEnd =
    SARC_HEADER_SIZE +
    SFAT_HEADER_SIZE +
    SFAT_NODE_SIZE * sorted.length +
    SFNT_HEADER_SIZE +
    nameBytes.length

  const maxAlignment = sorted.reduce((max, entry) => Math.max(max, entry.alignment), 4)

  /**
   * Byte-exact path: when nothing changed size and the header still fits, every
   * file goes back to the offset it came from, reproducing the original padding
   * exactly. Otherwise offsets are recomputed from each file's alignment.
   */
  const canPreserve =
    archive.originalDataOffset >= headerEnd &&
    sorted.every((entry) => entry.data.length === entry.originalLength)

  let dataOffset: number
  const offsets: number[] = []

  if (canPreserve) {
    dataOffset = archive.originalDataOffset
    for (const entry of sorted) offsets.push(entry.originalOffset)
  } else {
    dataOffset = align(headerEnd, maxAlignment)
    let cursor = 0
    for (const entry of sorted) {
      cursor = align(dataOffset + cursor, entry.alignment) - dataOffset
      offsets.push(cursor)
      cursor += entry.data.length
    }
  }

  const totalSize = sorted.reduce(
    (max, entry, index) => Math.max(max, dataOffset + offsets[index]! + entry.data.length),
    dataOffset
  )

  const writer = new BinaryWriter({
    littleEndian: archive.littleEndian,
    capacity: totalSize + 0x100
  })

  writer.magic('SARC')
  writer.u16(SARC_HEADER_SIZE)
  writer.u16be(archive.littleEndian ? 0xfffe : 0xfeff)
  writer.u32(totalSize)
  writer.u32(dataOffset)
  writer.u16(archive.version)
  writer.u16(0)

  writer.magic('SFAT')
  writer.u16(SFAT_HEADER_SIZE)
  writer.u16(sorted.length)
  writer.u32(archive.hashKey)

  sorted.forEach((entry, index) => {
    writer.u32(entry.nameHash)
    writer.u32(HAS_NAME_FLAG | ((nameOffsets[index]! / 4) & 0x00ff_ffff))
    writer.u32(offsets[index]!)
    writer.u32(offsets[index]! + entry.data.length)
  })

  writer.magic('SFNT')
  writer.u16(SFNT_HEADER_SIZE)
  writer.u16(0)
  writer.bytes(nameBytes)

  // Gaps stay zero-filled, which is what the originals contain.
  writer.seek(totalSize)
  sorted.forEach((entry, index) => {
    writer.seek(dataOffset + offsets[index]!)
    writer.bytes(entry.data)
  })
  writer.seek(totalSize)

  return writer.toBytes()
}

function align(value: number, alignment: number): number {
  const rem = value % alignment
  return rem === 0 ? value : value + (alignment - rem)
}
