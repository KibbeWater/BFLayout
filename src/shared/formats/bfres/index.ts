import { BinaryReader } from '../../binary/reader'
import { FormatParseError } from '../../binary/errors'

/**
 * BFRES — Nintendo's model and resource container: models with shapes, materials, skeletons and
 * vertex buffers, plus animation subfiles and a table of embedded external files.
 *
 * This is a **structural summary, not a model loader**. Nothing here decodes a vertex buffer, an
 * index buffer or an animation curve; the point is that opening a `.bfres` tells you what is inside
 * it — how many models, what they are called, which materials and textures they reference — instead
 * of "this build does not read BFRES". Geometry is deliberately out of scope, and every field this
 * parser does *not* read is called out below rather than guessed at.
 *
 * ## The layout, verified against 2,284 real files
 *
 * Every offset in a Switch BFRES is an absolute file offset stored as a u64 (the runtime relocates
 * them in place through the `_RLT` table at the end, which this parser ignores). Nothing here is
 * section-relative, which is the opposite of BFLYT and worth stating because it is the mistake that
 * would produce plausible garbage.
 *
 *   0x00  char[4]  "FRES"
 *   0x04  char[4]  four spaces — 0x20202020 in all 2,284 files. On Wii U this is the version
 *                  instead, which is how a big-endian BFRES is told apart from a Switch one.
 *   0x08  u32      version: 0x000A0202 in 2,283 files, 0x000A0000 in one (BodySkeleton.BodySkeleton)
 *   0x0c  u16      byte-order mark, read big-endian — 0xFFFE for little-endian, as in BFLYT
 *   0x0e  u8       data alignment as a power of two: 12 (4 KiB) for files with vertex data,
 *                  3 (8 bytes) for the 241 animation-only files
 *   0x0f  u8       target address size — 0 everywhere
 *   0x10  u32      offset of the file name *characters* (the name offset at 0x20 plus 2)
 *   0x14  u16      flag — 0 everywhere
 *   0x16  u16      block offset; see the note on `declaredBlockOffset` below
 *   0x18  u32      relocation table offset — lands on `_RLT` in all 2,284 files
 *   0x1c  u32      file size — equals the real byte length in all 2,284 files
 *   0x20  u64      resource name
 *   0x28  u64[16]  eight (array, dictionary) offset pairs, one per subfile group
 *   0xa8  u64      memory pool, 0xb0 u64 buffer info — both unread here, they describe GPU memory
 *   0xb8  u64      external file array, 0xc0 u64 its dictionary
 *   0xc8  u64      0 in every file; unread
 *   0xd0  u64      string pool — always exactly 20 bytes past the `_STR` block signature
 *   0xd8  u32      string pool size
 *   0xdc  u16[8]   one count per group slot, in the same order as the pairs at 0x28
 *   0xec  u16      external file count
 *
 * ## The group slots
 *
 * The eight pairs are fixed slots, not a list, and this dump only ever populates five of them. The
 * mapping was read off the files rather than assumed — for each slot the magic at the array offset
 * is always the same four characters:
 *
 *   slot 0  FMDL  models                    2,049 files
 *   slot 1  —     never used in this dump
 *   slot 2  —     never used in this dump
 *   slot 3  FSKA  skeletal animation          293 files
 *   slot 4  FMAA  material animation          539 files
 *   slot 5  FBVS  bone visibility animation    19 files
 *   slot 6  —     never used in this dump
 *   slot 7  FSCN  scene animation              15 files
 *
 * Because the *kind* of a group is read from the bytes at its array offset rather than from a table
 * keyed on slot number, a file using slot 1, 2 or 6 still reports its subfiles correctly — it just
 * reports them under whatever magic they carry. Only the per-entry strides below are kind-specific,
 * and an unrecognised kind is reported with its name from the dictionary and nothing more.
 *
 * The v8 reference implementation (Switch-Toolbox's `Syroot.NintenTools.NSW.Bfres`) has six slots
 * here — models, skeletal, material, bone-visibility, shape, scene — with skeletal animation
 * immediately after models. **The files disagree**: skeletal animation is at slot 3, so v10 inserted
 * two slots after models. What they hold is unknown, because nothing in this dump uses them, and
 * naming them from the older layout would have put material animation two slots early.
 *
 * ## The dictionary
 *
 * Every group and every named array carries a `ResDict`, which is the fiddly part of the format:
 *
 *   u32 zero, u32 entryCount, then (entryCount + 1) nodes of 16 bytes:
 *     i32 refBit, u16 leftIndex, u16 rightIndex, u64 keyOffset
 *
 * It is a radix tree, and this parser does not walk it — it does not need to. Node 0 is the root and
 * its key is the empty string (checked: all 2,915 dictionaries in the dump), and node `i + 1` names
 * array entry `i`. That was verified directly rather than assumed: for all 2,915 groups the key
 * offset in node `i + 1` is byte-identical to the name offset stored inside entry `i` itself. So the
 * dictionary is used for two things only — its `entryCount`, as a cross-check on the u16 counts in
 * the header, and its keys, as the names of entries whose own layout is not modelled.
 *
 * ## Strings
 *
 * The string pool is a run of `u16 length, characters, NUL`, padded to 2 bytes, and the first entry
 * is the empty string sitting exactly at the pool base. A string offset points at the length field,
 * which is why the header carries both a name offset (0x20) and a name *character* offset (0x10)
 * two bytes apart.
 *
 * ## What is read, and what is left alone
 *
 * Read: the header, the group dictionaries, and inside a model the skeleton's bone count, each
 * vertex buffer's vertex count, each shape's name, and each material's name and texture references.
 *
 * Left alone, deliberately: vertex and index buffer contents, attribute formats, sub-mesh and LOD
 * structures, bounding volumes, shader assignment, render info, shader parameters, sampler
 * configuration, user data, the memory pool and buffer info, the `_RLT` relocation table, and the
 * internals of every animation subfile (an FSKA reports its name and nothing else). None of these
 * are needed to say what a file contains, and several cannot be checked without a renderer.
 */

/** Four-character magic of a BFRES subfile group, e.g. `FSKA`. Read from the bytes, not assumed. */
export type BfresSubfileKind = string

export interface BfresSubfile {
  /** Name from the group's dictionary. */
  readonly name: string
  /** Magic of the array this entry lives in — `FMDL`, `FSKA`, `FMAA`, `FBVS`, `FSCN` in this dump. */
  readonly kind: BfresSubfileKind
}

export interface BfresMaterial {
  readonly name: string
  /**
   * Texture names this material references, capped at {@link MAX_TEXTURES_PER_MATERIAL}.
   * `textureCount` is the true total.
   *
   * These are the names in the material's texture array; whether a matching texture exists anywhere
   * is a separate question this parser does not ask.
   */
  readonly textures: readonly string[]
  readonly textureCount: number
  /**
   * Number of samplers, taken from the byte beside the texture count and cross-checked against the
   * sampler dictionary's own count on every material in the dump. Sampler *names* are not read.
   */
  readonly samplerCount: number
}

export interface BfresModel {
  readonly name: string
  readonly vertexBufferCount: number
  readonly shapeCount: number
  readonly materialCount: number
  /** Bones in the model's skeleton. Bone names are not read. */
  readonly boneCount: number
  /**
   * Vertices, summed over the model's vertex buffers.
   *
   * This is **not** a field in the file. The v8 reference has a `TotalVertexCount` on the model and
   * no u32 anywhere in v10's 120-byte model header holds it — checked against the summed value on
   * every model in the dump, which matched only by coincidence on offset fields. Each vertex
   * buffer does declare its own count, and that count is trustworthy for an independent reason:
   * every buffer's declared byte size equals its declared stride times it, on all 4,455 vertex
   * buffers in the dump. So the sum is measured, not inferred.
   */
  readonly vertexCount: number
  /** Shape names, capped at {@link MAX_SHAPES_PER_MODEL}; `shapeCount` is the true total. */
  readonly shapes: readonly string[]
  /** Materials, capped at {@link MAX_MATERIALS_PER_MODEL}; `materialCount` is the true total. */
  readonly materials: readonly BfresMaterial[]
}

export interface BfresExternalFile {
  readonly name: string
  readonly size: number
  /**
   * Printable four-character magic of the payload, or `` when the entry is empty or the bytes are
   * not printable. This is how an embedded BNTX would announce itself — the payload is reported,
   * never parsed, because BNTX has its own parser.
   *
   * No file in this dump exercises it: 178 files carry exactly one external file, every one of them
   * a zero-length entry whose name ends in `.flag` (`LoadAnimEventSet.flag`), i.e. a named marker
   * rather than a payload. The 16-byte stride between entries is therefore **unverified** — no file
   * in the dump has two.
   */
  readonly magic: string
}

export interface BfresDocument {
  readonly littleEndian: boolean
  /** Version as the reference formats it, e.g. `0.10.2.2`. */
  readonly version: string
  /** The raw version word, so an unfamiliar version can be reported exactly. */
  readonly versionRaw: number
  /** The resource's own name, from the string pool. */
  readonly name: string
  /** Data alignment in bytes: 4096 for files with vertex data, 8 for animation-only files. */
  readonly alignment: number
  /** File size as the header declares it. */
  readonly declaredFileSize: number
  /**
   * The header's u16 block offset, kept because it is measurably unreliable rather than because it
   * is useful. It is the string pool offset minus 20 truncated to 16 bits — exactly that, in all
   * 2,284 files — so for the 192 files whose pool sits past 64 KiB it names the wrong place. The
   * string pool is located from the u64 at 0xd0 instead.
   */
  readonly declaredBlockOffset: number
  /** Models, capped at {@link MAX_MODELS}; `modelCount` is the true total. */
  readonly models: readonly BfresModel[]
  readonly modelCount: number
  /**
   * Every non-model subfile, in group then array order, capped at {@link MAX_SUBFILES}.
   * `subfileCount` is the true total.
   */
  readonly subfiles: readonly BfresSubfile[]
  readonly subfileCount: number
  /** Embedded files, capped at {@link MAX_EXTERNAL_FILES}; `externalFileCount` is the true total. */
  readonly externalFiles: readonly BfresExternalFile[]
  readonly externalFileCount: number
}

/*
 * Caps. A list that can be long is truncated and the true total reported beside it, so a cap can
 * never be mistaken for the whole picture. The largest counts measured in the dump are 30 shapes,
 * 73 bones and 16 models, so these are headroom rather than limits anyone will meet here.
 */
export const MAX_MODELS = 64
export const MAX_SHAPES_PER_MODEL = 128
export const MAX_MATERIALS_PER_MODEL = 128
export const MAX_TEXTURES_PER_MATERIAL = 32
export const MAX_SUBFILES = 512
export const MAX_EXTERNAL_FILES = 64

const MAGIC = 'FRES'

/** Group slots in the header, at 0x28 + slot * 16 with the count at 0xdc + slot * 2. */
const GROUP_SLOTS = 8

/**
 * Per-entry strides, established by finding the offset at which a group's magic repeats and then
 * checking every entry in every group in the dump lands on it. A kind absent from this table is
 * still listed by name — only its interior is unreachable.
 */
const SUBFILE_STRIDES: Record<string, number> = {
  FMDL: 0x78,
  FSKA: 0x50,
  FMAA: 0x70,
  FBVS: 0x60,
  FSCN: 0x60
}

const FMDL_STRIDE = 0x78
const FVTX_STRIDE = 0x58
const FSHP_STRIDE = 0x60
const FMAT_STRIDE = 0xb0
const EXTERNAL_FILE_STRIDE = 0x10

export function isBfres(data: Uint8Array): boolean {
  if (data.length < 0xf0) return false
  for (let at = 0; at < MAGIC.length; at++) {
    if (data[at] !== MAGIC.charCodeAt(at)) return false
  }
  return true
}

export function parseBfres(data: Uint8Array): BfresDocument {
  if (!isBfres(data)) {
    throw new FormatParseError({ format: 'bfres', offset: 0, message: 'missing FRES signature' })
  }

  const reader = new BinaryReader(data, { littleEndian: true })

  /*
   * Bytes 4-7 are four spaces on Switch and the version on Wii U, and the byte-order mark moves with
   * them. Checking here means a big-endian Wii U BFRES is named as one rather than read with every
   * field four bytes out of place.
   */
  reader.seek(4)
  const filler = reader.fixedString(4)
  if (filler !== '    ') {
    throw new FormatParseError({
      format: 'bfres',
      offset: 4,
      message:
        'bytes 4-7 are not the four-space filler a Switch BFRES has; this looks like a Wii U ' +
        'BFRES, which this build does not read'
    })
  }

  const versionRaw = reader.u32()
  const bom = reader.u16be()
  if (bom !== 0xfeff && bom !== 0xfffe) {
    throw new FormatParseError({
      format: 'bfres',
      offset: 0x0c,
      message: `unrecognised byte-order mark 0x${bom.toString(16)}`
    })
  }
  // Every file in the dump is little-endian. The big-endian path is symmetric but untested.
  reader.littleEndian = bom === 0xfffe

  const alignmentExponent = reader.u8()
  reader.skip(1) // target address size: 0 in every file
  reader.skip(4) // name character offset: the name offset at 0x20 plus 2, so redundant here
  reader.skip(2) // flag: 0 in every file
  const declaredBlockOffset = reader.u16()
  reader.skip(4) // relocation table offset
  const declaredFileSize = reader.u32()

  if (declaredFileSize > data.length) {
    throw new FormatParseError({
      format: 'bfres',
      offset: 0x1c,
      message: `header claims ${declaredFileSize} bytes but only ${data.length} are present`
    })
  }

  const stringPool = offsetAt(reader, 0xd0, data.length, 'string pool')
  const stringPoolSize = reader.at(0xd8, () => reader.u32())
  if (stringPool + stringPoolSize > data.length) {
    throw new FormatParseError({
      format: 'bfres',
      offset: 0xd0,
      message: `string pool at ${stringPool} plus ${stringPoolSize} bytes runs past the end of the file`
    })
  }
  const strings = new StringPool(reader, stringPool, stringPoolSize)

  const name = strings.read(offsetAt(reader, 0x20, data.length, 'resource name'), 0x20)

  const models: BfresModel[] = []
  const subfiles: BfresSubfile[] = []
  let modelCount = 0
  let subfileCount = 0

  for (let slot = 0; slot < GROUP_SLOTS; slot++) {
    const countAt = 0xdc + slot * 2
    const count = reader.at(countAt, () => reader.u16())
    if (count === 0) continue

    const arrayAt = 0x28 + slot * 16
    const array = offsetAt(reader, arrayAt, data.length, `group ${slot} array`)
    const dictionary = offsetAt(reader, arrayAt + 8, data.length, `group ${slot} dictionary`)
    const kind = readMagic(reader, array, arrayAt)

    /*
     * The dictionary's own entry count is an independent statement of the group's size, and it
     * agrees with the header's u16 on all 2,915 groups in the dump. Disagreement means one of the
     * two is not what this parser thinks it is, so it is reported rather than resolved by picking
     * a winner.
     */
    const declared = readDictionaryCount(reader, dictionary, data.length, kind)
    if (declared !== count) {
      throw new FormatParseError({
        format: 'bfres',
        offset: countAt,
        section: kind,
        message: `header declares ${count} ${kind} entries but its dictionary declares ${declared}`
      })
    }

    const names = readDictionaryKeys(reader, dictionary, count, strings)

    if (kind === 'FMDL') {
      modelCount = count
      for (let index = 0; index < Math.min(count, MAX_MODELS); index++) {
        models.push(readModel(reader, array + index * FMDL_STRIDE, data.length, strings))
      }
      continue
    }

    subfileCount += count
    const stride = SUBFILE_STRIDES[kind]
    for (let index = 0; index < count; index++) {
      if (subfiles.length >= MAX_SUBFILES) break
      /*
       * The magic is checked per entry when the stride is known, because that is the cheapest way to
       * notice a stride that is wrong for a version this parser has not seen. Without a stride the
       * name still comes from the dictionary — a subfile kind this build does not model is listed,
       * not dropped.
       */
      if (stride !== undefined) {
        const entry = array + index * stride
        const entryMagic = readMagic(reader, entry, arrayAt)
        if (entryMagic !== kind) {
          throw new FormatParseError({
            format: 'bfres',
            offset: entry,
            section: kind,
            message: `${kind} entry ${index} has magic ${JSON.stringify(entryMagic)} instead`
          })
        }
      }
      subfiles.push({ name: names[index] ?? '', kind })
    }
  }

  const externalFileCount = reader.at(0xec, () => reader.u16())
  const externalFiles: BfresExternalFile[] = []
  if (externalFileCount > 0) {
    const array = offsetAt(reader, 0xb8, data.length, 'external file array')
    const dictionary = offsetAt(reader, 0xc0, data.length, 'external file dictionary')
    const declared = readDictionaryCount(reader, dictionary, data.length, 'external files')
    if (declared !== externalFileCount) {
      throw new FormatParseError({
        format: 'bfres',
        offset: 0xec,
        message: `header declares ${externalFileCount} external files but its dictionary declares ${declared}`
      })
    }
    const names = readDictionaryKeys(reader, dictionary, externalFileCount, strings)
    for (let index = 0; index < Math.min(externalFileCount, MAX_EXTERNAL_FILES); index++) {
      const entry = array + index * EXTERNAL_FILE_STRIDE
      if (entry + EXTERNAL_FILE_STRIDE > data.length) {
        throw new FormatParseError({
          format: 'bfres',
          offset: entry,
          message: `external file ${index} runs past the end of the file`
        })
      }
      const dataOffset = Number(reader.at(entry, () => reader.u64()))
      const size = reader.at(entry + 8, () => reader.u32())
      externalFiles.push({
        name: names[index] ?? '',
        size,
        magic: printableMagic(reader, dataOffset, size, data.length)
      })
    }
  }

  return {
    littleEndian: reader.littleEndian,
    version: formatVersion(versionRaw),
    versionRaw,
    name,
    alignment: 1 << alignmentExponent,
    declaredFileSize,
    declaredBlockOffset,
    models,
    modelCount,
    subfiles,
    subfileCount,
    externalFiles,
    externalFileCount
  }
}

/**
 * One model. Everything here is a count or a name; nothing walks into geometry.
 *
 *   +0x08 name, +0x10 path, +0x18 skeleton, +0x20 vertex buffers, +0x28/+0x30 shapes and their
 *   dictionary, +0x38/+0x40 materials and theirs, +0x68 u16 vertex buffer count, +0x6a u16 shape
 *   count, +0x6c u16 material count.
 *
 * The three counts were pinned rather than assumed: the shape and material counts each equal their
 * dictionary's own count on every model in the dump, and for all three the array ends where the
 * count says it does — the bytes one stride past the last entry are never that entry's magic.
 * A model with no shapes leaves both the array and the dictionary offset null, which is why count
 * zero is handled before either is touched.
 *
 * Unread: +0x10 path (the empty string in every file), +0x48 and +0x6e (set together, one per model
 * with materials — shader assignment in the reference's later layout), +0x50 to +0x67, and +0x70,
 * which holds 0, 2 or 3 and is emphatically not a vertex total.
 */
function readModel(
  reader: BinaryReader,
  at: number,
  length: number,
  strings: StringPool
): BfresModel {
  requireRange(at, FMDL_STRIDE, length, 'FMDL')
  const magic = readMagic(reader, at, at)
  if (magic !== 'FMDL') {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      message: `expected FMDL, found ${JSON.stringify(magic)}`
    })
  }

  const name = strings.read(offsetAt(reader, at + 0x08, length, 'model name'), at + 0x08)
  const vertexBufferCount = reader.at(at + 0x68, () => reader.u16())
  const shapeCount = reader.at(at + 0x6a, () => reader.u16())
  const materialCount = reader.at(at + 0x6c, () => reader.u16())

  let vertexCount = 0
  if (vertexBufferCount > 0) {
    const array = offsetAt(reader, at + 0x20, length, 'vertex buffer array')
    for (let index = 0; index < vertexBufferCount; index++) {
      vertexCount += readVertexCount(reader, array + index * FVTX_STRIDE, length)
    }
  }

  const shapes: string[] = []
  if (shapeCount > 0) {
    const array = offsetAt(reader, at + 0x28, length, 'shape array')
    for (let index = 0; index < Math.min(shapeCount, MAX_SHAPES_PER_MODEL); index++) {
      const entry = array + index * FSHP_STRIDE
      requireRange(entry, FSHP_STRIDE, length, 'FSHP')
      const shapeMagic = readMagic(reader, entry, entry)
      if (shapeMagic !== 'FSHP') {
        throw new FormatParseError({
          format: 'bfres',
          offset: entry,
          section: 'FSHP',
          message: `shape ${index} has magic ${JSON.stringify(shapeMagic)} instead`
        })
      }
      shapes.push(strings.read(offsetAt(reader, entry + 0x08, length, 'shape name'), entry + 0x08))
    }
  }

  const materials: BfresMaterial[] = []
  if (materialCount > 0) {
    const array = offsetAt(reader, at + 0x38, length, 'material array')
    for (let index = 0; index < Math.min(materialCount, MAX_MATERIALS_PER_MODEL); index++) {
      materials.push(readMaterial(reader, array + index * FMAT_STRIDE, length, strings))
    }
  }

  return {
    name,
    vertexBufferCount,
    shapeCount,
    materialCount,
    boneCount: readBoneCount(reader, offsetAt(reader, at + 0x18, length, 'skeleton'), length),
    vertexCount,
    shapes,
    materials
  }
}

/**
 * `FSKL` exists only to be counted here.
 *
 * +0x08 bone dictionary, +0x10 bone array, +0x38 u16 bone count. The count agrees with the bone
 * dictionary's own count on all 3,019 models in the dump, which is what makes it safe to report
 * without reading a single bone. The bone array itself — 88 bytes per bone of parent index, matrix
 * indices, flags and an SRT triple — is not touched.
 */
function readBoneCount(reader: BinaryReader, at: number, length: number): number {
  requireRange(at, 0x40, length, 'FSKL')
  const magic = readMagic(reader, at, at)
  if (magic !== 'FSKL') {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      message: `expected FSKL, found ${JSON.stringify(magic)}`
    })
  }
  return reader.at(at + 0x38, () => reader.u16())
}

/**
 * A vertex buffer's declared vertex count, and nothing else about it.
 *
 * +0x4c u8 attribute count, +0x4d u8 buffer count, +0x50 u32 vertex count. The vertex count is
 * checkable without decoding anything: +0x30 points at one u32 byte size per buffer and +0x38 at one
 * u32 stride, both on a 16-byte pitch, and `size == stride * vertexCount` holds for every buffer of
 * every model in the dump. That is the whole reason this number is reported and the buffer contents
 * are not.
 */
function readVertexCount(reader: BinaryReader, at: number, length: number): number {
  requireRange(at, FVTX_STRIDE, length, 'FVTX')
  const magic = readMagic(reader, at, at)
  if (magic !== 'FVTX') {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      message: `expected FVTX, found ${JSON.stringify(magic)}`
    })
  }
  return reader.at(at + 0x50, () => reader.u32())
}

/**
 * One material: its name, its texture references, and how many samplers it has.
 *
 * +0x08 name, +0x20 an array of u64 string offsets — one per texture — +0x38 the sampler dictionary,
 * +0xa2 u8 texture count, +0xa3 u8 sampler count.
 *
 * The two counts sit in adjacent bytes and are equal on every one of the 4,242 materials in the
 * dump, so they cannot be told apart that way. They were separated by their consumers instead: the
 * byte at +0xa3 equals the sampler dictionary's own entry count everywhere, and the byte at +0xa2
 * bounds the texture array exactly — all `count` entries are string-pool offsets and the entry just
 * past the end never is.
 *
 * Unread: render info, shader parameters, sampler configuration, user data, the material flags at
 * +0xa0, and the several offset fields between +0x10 and +0x98 that lead to them. Sampler *names*
 * are reachable through the dictionary at +0x38 but are not reported — they are shader-side channel
 * names (`_a0`, `_n0`, `_o0`), not information about the file's contents.
 */
function readMaterial(
  reader: BinaryReader,
  at: number,
  length: number,
  strings: StringPool
): BfresMaterial {
  requireRange(at, FMAT_STRIDE, length, 'FMAT')
  const magic = readMagic(reader, at, at)
  if (magic !== 'FMAT') {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      message: `expected FMAT, found ${JSON.stringify(magic)}`
    })
  }

  const name = strings.read(offsetAt(reader, at + 0x08, length, 'material name'), at + 0x08)
  const textureCount = reader.at(at + 0xa2, () => reader.u8())
  const samplerCount = reader.at(at + 0xa3, () => reader.u8())

  const textures: string[] = []
  if (textureCount > 0) {
    const array = offsetAt(reader, at + 0x20, length, 'texture name array')
    for (let index = 0; index < Math.min(textureCount, MAX_TEXTURES_PER_MATERIAL); index++) {
      const entry = array + index * 8
      textures.push(strings.read(offsetAt(reader, entry, length, 'texture name'), entry))
    }
  }

  return { name, textures, textureCount, samplerCount }
}

/**
 * The string pool.
 *
 * A string is `u16 length, characters, NUL`, and an offset names the length field. The pool bounds
 * are enforced because they are the one cheap way to tell a real name offset from a stray pointer:
 * an offset outside the pool is reported as a parse failure naming the field, rather than decoding
 * whatever bytes happen to be there.
 *
 * Characters are taken one byte at a time. BFRES stores them as UTF-8, and every name in the dump is
 * ASCII, where the two agree; a name with a multi-byte sequence would come out as mojibake, which is
 * visible rather than silently wrong.
 */
class StringPool {
  constructor(
    private readonly reader: BinaryReader,
    private readonly base: number,
    private readonly size: number
  ) {}

  read(offset: number, fieldOffset: number): string {
    if (offset < this.base || offset + 2 > this.base + this.size) {
      throw new FormatParseError({
        format: 'bfres',
        offset: fieldOffset,
        message: `string offset ${offset} is outside the string pool [${this.base}, ${this.base + this.size})`
      })
    }
    const length = this.reader.at(offset, () => this.reader.u16())
    if (offset + 2 + length > this.base + this.size) {
      throw new FormatParseError({
        format: 'bfres',
        offset,
        message: `string declares ${length} bytes, which runs past the end of the string pool`
      })
    }
    return this.reader.at(offset + 2, () => this.reader.fixedString(length))
  }
}

/** A dictionary's own entry count, with the shape checks that make it worth trusting. */
function readDictionaryCount(
  reader: BinaryReader,
  at: number,
  length: number,
  section: string
): number {
  if (at + 8 > length) {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      section,
      message: 'dictionary header runs past the end of the file'
    })
  }
  const count = reader.at(at + 4, () => reader.u32())
  if (at + 8 + (count + 1) * 16 > length) {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      section,
      message: `dictionary declares ${count} entries, whose nodes run past the end of the file`
    })
  }
  return count
}

/** Keys for entries 0..count-1, which live in nodes 1..count; node 0 is the root. */
function readDictionaryKeys(
  reader: BinaryReader,
  at: number,
  count: number,
  strings: StringPool
): string[] {
  const keys: string[] = []
  for (let index = 0; index < count; index++) {
    const keyField = at + 8 + (index + 1) * 16 + 8
    keys.push(strings.read(Number(reader.at(keyField, () => reader.u64())), keyField))
  }
  return keys
}

/** Reads a u64 offset and rejects one that cannot be an offset into this file. */
function offsetAt(reader: BinaryReader, at: number, length: number, what: string): number {
  const offset = Number(reader.at(at, () => reader.u64()))
  if (offset <= 0 || offset >= length) {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      message: `${what} offset ${offset} is outside the file`
    })
  }
  return offset
}

function readMagic(reader: BinaryReader, at: number, fieldOffset: number): string {
  if (at + 4 > reader.length) {
    throw new FormatParseError({
      format: 'bfres',
      offset: fieldOffset,
      message: `signature at ${at} runs past the end of the file`
    })
  }
  let out = ''
  for (let index = 0; index < 4; index++) {
    const byte = reader.bytes[at + index]!
    out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '?'
  }
  return out
}

/**
 * The payload's magic, when there is a payload and it is printable. An embedded BNTX would surface
 * here; a zero-length marker entry surfaces as ``.
 */
function printableMagic(
  reader: BinaryReader,
  offset: number,
  size: number,
  length: number
): string {
  if (offset <= 0 || size < 4 || offset + 4 > length) return ''
  let out = ''
  for (let index = 0; index < 4; index++) {
    const byte = reader.bytes[offset + index]!
    if (byte < 0x20 || byte >= 0x7f) return ''
    out += String.fromCharCode(byte)
  }
  return out
}

function requireRange(at: number, size: number, length: number, section: string): void {
  if (at < 0 || at + size > length) {
    throw new FormatParseError({
      format: 'bfres',
      offset: at,
      section,
      message: `${section} at ${at} needs ${size} bytes, which run past the end of the file`
    })
  }
}

/**
 * The reference prints the version word as four bytes most-significant first, so 0x000A0202 is
 * `0.10.2.2` — the second component is the one that matters and the one this dump varies.
 */
function formatVersion(raw: number): string {
  return [(raw >>> 24) & 0xff, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff].join('.')
}
