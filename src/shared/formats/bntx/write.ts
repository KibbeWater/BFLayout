import { FormatWriteError } from '@shared/binary/errors'
import { BinaryWriter } from '@shared/binary/writer'
import type { BntxContainer, BntxTexture } from './container'
import { buildDict } from './dict'

/**
 * Writing a BNTX container back out.
 *
 * The reason this exists is merging. A layout finds its textures in one
 * `timg/__Combined.bntx`, looked up by that exact path, so two containers cannot
 * sit side by side in one archive — and copying panes between archives therefore
 * needs the *union* of two containers, which needs a serializer. Without one,
 * cross-archive copies could only refuse.
 *
 * Nothing here re-encodes pixels. Each texture's tiled data is carried over
 * exactly as it was read, so a merge is a repack: same bytes, new offsets. That
 * matters because there is no BCn or ASTC compressor (see `encode.ts`), and there
 * does not need to be one for this.
 *
 * The layout, which is not inferable and was read off shipped files:
 *
 *   0x000  BNTX header
 *   0x020  NX header, pointing at everything below
 *   0x058  memory pool, 0x140 bytes the runtime scribbles on — zero on disk
 *   0x198  texture info pointer array, one u64 per texture
 *          `_STR` block: string count, then length-prefixed names
 *          `_DIC` block: the radix tree, inside the `_STR` block's extent
 *          `BRTI` blocks, one per texture, each carrying two runtime structs
 *          `BRTD` block, whose payload starts on a container-alignment boundary
 *          `_RLT` relocation table
 *
 * Verified the only way worth trusting: every one of the 470 containers in a
 * shipped romfs is parsed and rewritten **byte for byte**, which is what pins the
 * relocation table and the dictionary rather than merely making them plausible.
 */

const NX_HEADER = 0x20
const MEMORY_POOL_SIZE = 0x140
/** BRTI header, then the texture and texture-view structs, then the mip array. */
const BRTI_HEADER = 0xa0
const BRTI_STRUCTS = 0x200
const BRTI_MIPS = BRTI_HEADER + BRTI_STRUCTS

/** A name as the pool stores it: u16 length, characters, NUL, padded to 2. */
const pooledSize = (name: string): number => {
  const raw = 2 + name.length + 1
  return raw + (raw % 2)
}

const brtiSize = (texture: BntxTexture): number => BRTI_MIPS + texture.mipCount * 8

/**
 * The order names sit in the pool.
 *
 * A parsed container remembers where each name was, and putting them back in that
 * order is what makes an untouched rewrite byte-identical. The container's own
 * name takes part: it is not reliably first, and assuming it was left a quarter of
 * shipped files rewriting to a different — still valid — layout.
 *
 * Names from anywhere else, a merge or a container built from scratch, have no
 * such offset and simply follow in the order they were given.
 */
function poolOrder(container: BntxContainer): { name: string; texture: BntxTexture | null }[] {
  const pooled = [
    { name: container.name, texture: null as BntxTexture | null, at: container.nameOffset },
    ...container.textures.map((texture) => ({ name: texture.name, texture, at: texture.nameOffset }))
  ]
  if (pooled.some((entry) => entry.at <= 0)) return pooled
  return [...pooled].sort((a, b) => a.at - b.at)
}

export function writeBntx(container: BntxContainer): Uint8Array {
  const textures = container.textures
  if (textures.length === 0) {
    throw new FormatWriteError({
      format: 'bntx',
      message: 'a container needs at least one texture; the runtime cannot open an empty one'
    })
  }
  if (textures.length > 0xffff) {
    throw new FormatWriteError({
      format: 'bntx',
      message: `${textures.length} textures is more than the dictionary can index`
    })
  }

  const names = new Set<string>()
  for (const texture of textures) {
    if (names.has(texture.name)) {
      throw new FormatWriteError({
        format: 'bntx',
        message: `two textures are both called ${texture.name}; names are how the game finds them, so one would be unreachable`
      })
    }
    names.add(texture.name)
  }

  // ---------------------------------------------------------------- layout

  const infoArray = NX_HEADER + 0x38 + MEMORY_POOL_SIZE
  const strBlock = infoArray + textures.length * 8

  // The root's name is the empty string, and it reads out of the high half of the
  // string count — which is always zero. The original writer aims at it rather
  // than storing an actual empty string, and matching that is free.
  const rootName = strBlock + 0x14

  const nameOffsets = new Map<string, number>()
  const ordered = poolOrder(container)
  let at = strBlock + 0x18
  let containerNameAt = at
  for (const entry of ordered) {
    if (entry.texture === null) containerNameAt = at
    else nameOffsets.set(entry.name, at)
    at += pooledSize(entry.name)
  }

  const dictBlock = at + ((8 - (at % 8)) % 8)
  const dictSize = 8 + (textures.length + 1) * 16
  const strSize = dictBlock + dictSize - strBlock

  const brtiOffsets: number[] = []
  at = dictBlock + dictSize
  for (const texture of textures) {
    brtiOffsets.push(at)
    at += brtiSize(texture)
  }
  const brtiEnd = at

  // The payload has to land on a container-alignment boundary, so the BRTD header
  // is placed to end exactly there and the last BRTI absorbs the gap.
  const alignment = Math.max(container.alignment, 1)
  const dataStart = Math.ceil((brtiEnd + 0x10) / alignment) * alignment
  const brtdBlock = dataStart - 0x10

  const dataOffsets: number[] = []
  at = dataStart
  for (const texture of textures) {
    const step = Math.max(texture.alignment, 1)
    at = Math.ceil(at / step) * step
    dataOffsets.push(at)
    at += texture.imageData.length
  }
  const dataEnd = at
  const rltBlock = Math.ceil(dataEnd / alignment) * alignment

  // ------------------------------------------------------------ relocations

  /**
   * A place the runtime adds a section's base address to: a position, and how many
   * consecutive u64s starting there.
   */
  interface Group {
    readonly position: number
    readonly offsetCount: number
  }

  /**
   * An encoded run: `structCount` repeats of `offsetCount` pointers, each repeat
   * separated by `paddingCount` u64s that are left alone.
   */
  interface Run {
    readonly position: number
    readonly structCount: number
    readonly offsetCount: number
    readonly paddingCount: number
  }

  /**
   * Packs relocation groups into runs the way the original writer does.
   *
   * Greedy, and greedier than it looks. It takes the lowest group not yet spoken
   * for, pairs it with the next unused group of the *same* width — skipping over
   * any of a different width in between — and then extends that arithmetic
   * progression as far as groups exist at its stride, consuming them out of order.
   *
   * That last part is not a detail. In a six-texture container the BRTD pointer
   * pairs with texture 0's mip array at a stride of two BRTI blocks, so the run
   * goes on to swallow textures 2 and 4 and leaves 1, 3 and 5 to a second run. No
   * tidier rule reproduces that, and the tidier rules all produce a valid-looking
   * table that is not the one the file has.
   */
  const coalesce = (groups: readonly Group[]): Run[] => {
    const sorted = [...groups].sort((a, b) => a.position - b.position)
    const used = new Array<boolean>(sorted.length).fill(false)
    const runs: Run[] = []

    for (let index = 0; index < sorted.length; index++) {
      if (used[index]) continue
      const start = sorted[index]!
      used[index] = true

      const next = sorted.findIndex(
        (group, at) => at > index && !used[at] && group.offsetCount === start.offsetCount
      )
      const stride = next < 0 ? 0 : sorted[next]!.position - start.position
      const padding = stride / 8 - start.offsetCount

      // A gap too wide for the byte that encodes it simply ends the run, which is
      // how a container with many textures ends up with a lone leading entry.
      if (next < 0 || padding < 0 || padding > 0xff || !Number.isInteger(padding)) {
        runs.push({ position: start.position, structCount: 1, offsetCount: start.offsetCount, paddingCount: 0 })
        continue
      }

      used[next] = true
      let structCount = 2
      let want = sorted[next]!.position + stride
      for (;;) {
        const at = sorted.findIndex(
          (group, candidate) =>
            !used[candidate] && group.position === want && group.offsetCount === start.offsetCount
        )
        if (at < 0 || structCount >= 0xffff) break
        used[at] = true
        structCount++
        want += stride
      }

      runs.push({ position: start.position, structCount, offsetCount: start.offsetCount, paddingCount: padding })
    }
    return runs
  }

  const fileGroups: Group[] = [
    { position: NX_HEADER + 0x08, offsetCount: 1 }, // texture info array
    { position: NX_HEADER + 0x18, offsetCount: 2 }, // dictionary, memory pool
    { position: infoArray, offsetCount: textures.length },
    { position: dictBlock + 0x10, offsetCount: 1 } // the root's name
  ]
  textures.forEach((_, index) => {
    fileGroups.push({ position: dictBlock + 0x20 + index * 16, offsetCount: 1 })
  })
  for (const offset of brtiOffsets) {
    // name, container, mip array — then the two runtime struct pointers.
    fileGroups.push({ position: offset + 0x60, offsetCount: 3 })
    fileGroups.push({ position: offset + 0x80, offsetCount: 2 })
  }

  const dataGroups: Group[] = [{ position: NX_HEADER + 0x10, offsetCount: 1 }]
  textures.forEach((texture, index) => {
    dataGroups.push({ position: brtiOffsets[index]! + BRTI_MIPS, offsetCount: texture.mipCount })
  })

  const fileRuns = coalesce(fileGroups)
  const dataRuns = coalesce(dataGroups)

  const fileSize = rltBlock + 0x10 + 2 * 0x18 + (fileRuns.length + dataRuns.length) * 8

  // ------------------------------------------------------------------ emit

  const writer = new BinaryWriter({
    littleEndian: container.littleEndian,
    capacity: fileSize
  })
  const u64 = (value: number): void => {
    writer.u32(value)
    writer.u32(0)
  }

  writer.magic('BNTX')
  writer.u32(0)
  writer.u8(container.version.micro)
  writer.u8(container.version.minor)
  writer.u16(container.version.major)
  writer.u16be(container.littleEndian ? 0xfffe : 0xfeff)
  writer.u8(Math.log2(alignment))
  // Target pointer size in bits. Every shipped container is 64-bit, and every
  // offset in one still fits in 32 — which is why the reader rejects a set high
  // word rather than trying to honour it.
  writer.u8(0x40)
  writer.u32(containerNameAt + 2)
  writer.u16(0) // flags
  writer.u16(strBlock)
  writer.u32(rltBlock)
  writer.u32(fileSize)

  writer.fixedString(container.target, 4)
  writer.u32(textures.length)
  u64(infoArray)
  u64(brtdBlock)
  u64(dictBlock)
  u64(NX_HEADER + 0x38)
  u64(0)
  u64(0)
  writer.zeros(MEMORY_POOL_SIZE)

  for (const offset of brtiOffsets) u64(offset)

  writer.magic('_STR')
  writer.u32(strSize)
  u64(strSize)
  u64(textures.length + 1)
  const pooled = (name: string): void => {
    writer.u16(name.length)
    writer.cstring(name)
    writer.align(2)
  }
  for (const entry of ordered) pooled(entry.name)
  writer.seek(dictBlock)

  writer.magic('_DIC')
  writer.u32(textures.length)
  for (const node of buildDict(textures.map((texture) => texture.name))) {
    writer.i32(node.reference)
    writer.u16(node.left)
    writer.u16(node.right)
    u64(node.name === '' ? rootName : nameOffsets.get(node.name)!)
  }

  textures.forEach((texture, index) => {
    const start = brtiOffsets[index]!
    const last = index === textures.length - 1
    const size = last ? brtdBlock - start : brtiSize(texture)

    writer.seek(start)
    writer.magic('BRTI')
    writer.u32(size)
    u64(size)

    writer.u8(texture.flags)
    writer.u8(texture.storageDimension)
    writer.u16(texture.tileMode)
    writer.u16(texture.swizzle)
    writer.u16(texture.mipCount)
    writer.u32(texture.sampleCount)
    writer.u32(((texture.format & 0xff) << 8) | (texture.formatVariant & 0xff))
    writer.u32(texture.gpuAccessFlags)
    writer.u32(texture.width)
    writer.u32(texture.height)
    writer.u32(texture.depth)
    writer.u32(texture.arrayCount)
    writer.u32(texture.textureLayout)
    writer.u32(texture.textureLayout2)
    writer.zeros(20)
    writer.u32(texture.imageData.length)
    writer.u32(texture.alignment)
    for (const source of texture.channelSources) writer.u8(source)
    writer.u32(texture.imageDimension)
    u64(nameOffsets.get(texture.name)!)
    u64(NX_HEADER)
    u64(start + BRTI_MIPS)
    u64(0) // user data
    u64(start + BRTI_HEADER)
    u64(start + BRTI_HEADER + 0x100)
    u64(0) // descriptor slot
    u64(0) // user data dictionary

    // The texture and texture-view structs are runtime scratch and ship as zeros.
    writer.seek(start + BRTI_MIPS)
    for (let level = 0; level < texture.mipCount; level++) {
      u64(dataOffsets[index]! + (texture.mipOffsets[level] ?? 0))
    }
  })

  writer.seek(brtdBlock)
  writer.magic('BRTD')
  writer.u32(0)
  u64(rltBlock - brtdBlock)

  textures.forEach((texture, index) => {
    writer.seek(dataOffsets[index]!)
    writer.bytes(texture.imageData)
  })

  writer.seek(rltBlock)
  writer.magic('_RLT')
  writer.u32(rltBlock)
  writer.u32(2)
  writer.u32(0)

  const section = (position: number, size: number, index: number, count: number): void => {
    u64(0) // filled in at load time
    writer.u32(position)
    writer.u32(size)
    writer.u32(index)
    writer.u32(count)
  }
  section(0, brtiEnd, 0, fileRuns.length)
  section(brtdBlock, rltBlock - brtdBlock, fileRuns.length, dataRuns.length)

  for (const run of [...fileRuns, ...dataRuns]) {
    writer.u32(run.position)
    writer.u16(run.structCount)
    writer.u8(run.offsetCount)
    writer.u8(run.paddingCount)
  }

  writer.seek(fileSize)
  return writer.toBytes()
}

/**
 * A container holding the union of two.
 *
 * The whole point of having a writer. A layout archive can hold exactly one
 * texture container — nn::ui2d opens `timg/__Combined.bntx` by that exact path and
 * never enumerates an archive — so copying panes between archives means the
 * destination's container has to *grow*, not gain a sibling. Adding a second one
 * produces an archive that previews perfectly and dies in the texture resolver.
 *
 * Textures are carried verbatim, still tiled, still in their original format. A
 * name already present is left alone rather than replaced: the destination's own
 * art is what its other layouts are drawing with, and silently swapping it for a
 * same-named texture from elsewhere would break panes nobody was editing.
 */
export function mergeBntx(
  into: BntxContainer,
  from: BntxContainer,
  wanted?: readonly string[]
): { container: BntxContainer; added: string[]; skipped: string[] } {
  const present = new Set(into.textures.map((texture) => texture.name))
  const take = wanted === undefined ? null : new Set(wanted)

  const added: string[] = []
  const skipped: string[] = []
  const extra: BntxTexture[] = []

  for (const texture of from.textures) {
    if (take !== null && !take.has(texture.name)) continue
    if (present.has(texture.name)) {
      skipped.push(texture.name)
      continue
    }
    // The source offset is dropped: it described a position in a pool this
    // texture is leaving, and keeping it would order the merged pool by two
    // unrelated coordinate systems.
    extra.push({ ...texture, nameOffset: 0 })
    added.push(texture.name)
    present.add(texture.name)
  }

  if (take !== null) {
    for (const name of take) {
      if (!present.has(name)) {
        throw new FormatWriteError({
          format: 'bntx',
          message: `${from.name} has no texture called ${name}; it holds ${from.textures.map((texture) => texture.name).join(', ')}`
        })
      }
    }
  }

  return {
    container: { ...into, nameOffset: 0, textures: [...into.textures, ...extra] },
    added,
    skipped
  }
}
