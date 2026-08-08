import { BinaryReader } from '../../binary/reader'
import { FormatParseError } from '../../binary/errors'

/**
 * AINB — the node graphs that hold a character's logic.
 *
 * 2,574 of them in one title, 21 MB, and until now they were unreadable here. Read-only, and
 * deliberately a *structural summary* rather than a graph: the node list with its names and types,
 * the entry-point commands, the parameter counts and the string pool. Editing a behaviour graph is a
 * different project; seeing what a graph contains is most of what anyone wants from one.
 *
 * There is no reference implementation to lean on — Switch Toolbox predates the format entirely, so
 * every offset below was worked out from the files and each one is annotated with what proves it.
 * Where a region defeated measurement it is reported in `sections` with `read: false` and skipped by
 * its declared extent rather than guessed at.
 *
 * The layout, verified against all 2,574 files in a Tomodachi Life romfs dump:
 *
 *   0x00  char[4]  "AIB " — note the trailing space
 *   0x04  u32      version; 0x408 in this title, and the only value this build accepts
 *   0x08  u32      file name offset into the string pool (0 in every file here)
 *   0x0c  u32      command count
 *   0x10  u32      node count
 *   0x14  u32      unread count (0..0x79 here)
 *   0x18  u32      unread count (0 in every file here)
 *   0x1c  u32      unread count (0..4 here)
 *   0x20  u32      global parameters, and the per-node parameter bodies after them
 *   0x24  u32      string pool, which runs to the end of the file
 *   0x28  u32      a 4-byte section that is always `stringPool - 4` and always zero here
 *   0x2c  u32      immediate parameters: 6 offsets, one per value type
 *   0x34  u32      input/output parameters: 12 offsets, input and output per value type
 *   0x30, 0x38..0x70   further sections, listed in `sections` and not interpreted
 *   0x74           commands, 0x18 bytes each; then nodes, 0x3c bytes each
 *
 * Two things the header does *not* contain are worth knowing, because they are the reason the
 * sizing below works at all: there is no per-section signature and no per-section size. Every
 * section's extent has to be derived from where the next one starts, so `sections` is built by
 * sorting the declared offsets — which is also what makes an unrecognised region safe to step over.
 */

/** Value types shared by the immediate and input/output parameter tables, in the order stored. */
export type AinbValueType = 'int' | 'bool' | 'float' | 'string' | 'vec3f' | 'pointer'

/**
 * Global parameter types, in the order the global table stores them.
 *
 * This is *not* the same order as {@link AinbValueType}, which caught out the first draft: globals
 * lead with `string` and carry a seventh slot that no file in this dump uses. Both orders were
 * derived the same way (see `readImmediateCounts`), and they genuinely differ.
 */
export type AinbGlobalType = AinbValueType | 'unknown'

export interface AinbCommand {
  readonly name: string
  /**
   * A node index, verified in range for every command in the dump.
   *
   * That it is the graph's *entry* node is inferred from the field's position and from the name of
   * the command ("Run") rather than proved, so the field is named for what it is — an index.
   */
  readonly entryNodeIndex: number
  /** The 16 GUID bytes in file order. Not rendered as a UUID: the field order is unverified. */
  readonly guid: string
}

export interface AinbNode {
  /** Position in the node array. The stored index field matches it in every file in the dump. */
  readonly index: number
  /**
   * Raw type word.
   *
   * 0 means user-defined, and only those nodes carry a name. The other 24 values seen in this dump
   * (1..9, 100..105, 200..205, 300, 400, 500) all store an empty name, so this build reports the
   * number and does not label them: nothing in these files names them, and a plausible label taken
   * from elsewhere is exactly the kind of output this codebase treats as worse than none.
   */
  readonly type: number
  /** `true` when `type` is 0, which is the only case that carries a name. */
  readonly userDefined: boolean
  /**
   * Class name for a user-defined node, `` for every other type.
   *
   * Cross-checked against the game's own `AI/NodeDefinition/Node.Product.100.aidefn.byml`: of the
   * 44,368 user-defined nodes, 30,189 name a class declared there and the other 14,589 end in
   * `.module`, which is a reference to another AINB file. Nothing else appears, which is why this
   * field can be trusted to be a name rather than an offset landing somewhere plausible.
   */
  readonly name: string
  /** Hash of `name` as stored. Not recomputed, so a mismatch cannot be detected here. */
  readonly nameHash: number
  /** Byte at +6. Takes values 0..4 and 6 across the dump; the meaning is not known. */
  readonly flags: number
  /** The 16 GUID bytes in file order, as with {@link AinbCommand}. */
  readonly guid: string
}

export interface AinbGlobalParameter {
  readonly name: string
  readonly type: AinbGlobalType
  /**
   * The second string on each entry. Japanese authoring notes where present, otherwise ``.
   *
   * Read as a plain string offset because that is what it decodes to; whether the field means
   * "notes" to the runtime is not something these files can settle.
   */
  readonly notes: string
  /** Position in the flat global entry array. */
  readonly index: number
}

/** Counts of one parameter table, by value type. */
export interface AinbValueCounts {
  readonly int: number
  readonly bool: number
  readonly float: number
  readonly string: number
  readonly vec3f: number
  readonly pointer: number
}

export interface AinbSection {
  /**
   * Every header field pointing at this offset, e.g. `[0x30, 0x38, 0x50]`.
   *
   * More than one is the normal case rather than a curiosity: when the sections between two fields
   * are empty they all name the same address, which is exactly how this format spells "nothing
   * here". Grouping them means a region is counted once instead of once per field.
   */
  readonly fields: number[]
  /** What this build knows the region to be, or `unidentified`. */
  readonly label: string
  readonly offset: number
  /** Bytes to the next declared region. Derived, because sections carry no size of their own. */
  readonly size: number
  /** `false` for a region skipped by its extent rather than interpreted. */
  readonly read: boolean
}

export interface AinbDocument {
  /** Raw version word. 0x408 for every file in this dump. */
  readonly version: number
  /** `major.minor` split of `version`. The split is the conventional reading, not a verified one. */
  readonly versionText: string
  /** The file's own name from the string pool, e.g. `TutorialMoveTo.root`. */
  readonly name: string
  /** Declared category. `AI` for all 2,574 files in this dump. */
  readonly category: string

  /** Total from the header, which may exceed `commands.length` if the cap was hit. */
  readonly commandCount: number
  readonly commands: AinbCommand[]
  readonly commandsTruncated: boolean

  /** Total from the header, which may exceed `nodes.length` — see {@link AinbDocument.nodesTruncated}. */
  readonly nodeCount: number
  readonly nodes: AinbNode[]
  readonly nodesTruncated: boolean
  /** How many nodes of each raw type the file holds, including any beyond the cap. */
  readonly nodeTypeCounts: { readonly type: number; readonly count: number }[]

  readonly globalParameterCount: number
  readonly globalParameters: AinbGlobalParameter[]
  readonly globalParametersTruncated: boolean

  readonly immediateParameterCounts: AinbValueCounts
  readonly inputParameterCounts: AinbValueCounts
  readonly outputParameterCounts: AinbValueCounts

  /** Every string in the pool, in file order, capped — the pool is where all names live. */
  readonly strings: string[]
  readonly stringCount: number
  readonly stringsTruncated: boolean
  readonly stringPoolBytes: number

  /** Every declared region with its derived extent, including the ones this build does not read. */
  readonly sections: AinbSection[]

  /**
   * Anything that did not add up, in words.
   *
   * A parameter list whose byte span is not a whole number of entries, or a name offset outside the
   * pool, does not stop the file being useful — but it must be visible rather than rounded away.
   * Empty for all 2,574 files in this dump.
   */
  readonly problems: string[]
}

const MAGIC = 'AIB '
const HEADER_SIZE = 0x74
const COMMAND_SIZE = 0x18
const NODE_SIZE = 0x3c

/**
 * The only version measured. Refusing the others is deliberate.
 *
 * AINB has several revisions and they move header fields around; 0x408 is what this title ships and
 * what every offset here was checked against. Reading a 0x404 or 0x407 file with this header size
 * would produce a node count taken from the wrong word — a plausible number, wrong graph.
 */
const VERIFIED_VERSION = 0x408

/** Header fields that hold a section offset, paired with what this build knows them to be. */
const SECTION_FIELDS: { field: number; label: string; read: boolean }[] = [
  { field: 0x20, label: 'global parameters, then per-node bodies (bodies not read)', read: true },
  { field: 0x2c, label: 'immediate parameters', read: true },
  { field: 0x30, label: 'unidentified', read: false },
  { field: 0x34, label: 'input/output parameters', read: true },
  { field: 0x38, label: 'unidentified', read: false },
  { field: 0x3c, label: 'unidentified', read: false },
  { field: 0x40, label: 'unidentified', read: false },
  { field: 0x44, label: 'unidentified (absent from 2,549 of 2,574 files)', read: false },
  { field: 0x48, label: 'unidentified', read: false },
  { field: 0x4c, label: 'unidentified', read: false },
  { field: 0x50, label: 'unidentified', read: false },
  { field: 0x5c, label: 'unidentified', read: false },
  { field: 0x68, label: 'unidentified', read: false },
  { field: 0x6c, label: 'unidentified', read: false },
  { field: 0x70, label: 'unidentified', read: false },
  { field: 0x28, label: 'unidentified (always 4 bytes of zero here)', read: false },
  { field: 0x24, label: 'string pool', read: true }
]

/**
 * Entry strides for the immediate parameter lists, one per value type.
 *
 * Measured, not assumed: the six lists are delimited by offsets and carry no count, so the stride is
 * the only way to turn a byte span into a number of parameters. Taking the GCD of every non-empty
 * span across all 2,574 files gives 12, 12, 12, 12, 20, 12 — the 20 is `vec3f`, which is the same
 * 8-byte entry head as the others plus three floats instead of one word.
 */
const IMMEDIATE_STRIDES = [12, 12, 12, 12, 20, 12]

/**
 * Entry strides for the 12 input/output lists.
 *
 * Same method, and the alternation is what shows the lists are interleaved *per type* — input then
 * output — rather than six inputs followed by six outputs: the GCDs come out 16, 4, 16, 4, 16, 4,
 * 16, 4, 24, 4, 20, 8. An output is a bare name; an input additionally carries where it reads from
 * and a default. `vec3f` is the wide one again (24), and a pointer output is the only 8 (a name and
 * a class name).
 */
const IO_STRIDES = [16, 4, 16, 4, 16, 4, 16, 4, 24, 4, 20, 8]

/**
 * Value-type order for both parameter tables.
 *
 * Derived from the files rather than named from memory. `vec3f` is fixed by its stride, and the
 * other five by cross-referencing every parameter name against the game's own node-definition
 * table (`AI/NodeDefinition/Node.Product.100.aidefn.byml`), which declares each node class's inputs
 * by type. Every non-empty list agrees: list 0 holds `Int` (and C++ enums, which are int-valued),
 * 2 `Bool`, 4 `Float`, 6 `String`, 8 `Vector3`, 10 the user-defined classes — 8,945 `Vector3`
 * against zero other primitives in list 8, 12,275 `String` in list 6, 28,170 class-typed in list 10.
 */
const VALUE_TYPES: AinbValueType[] = ['int', 'bool', 'float', 'string', 'vec3f', 'pointer']

/**
 * Global parameter type order, which is *not* `VALUE_TYPES`.
 *
 * Seven slots, and the order was read off the parameters themselves: slot 0's defaults are all
 * string-pool offsets and its names are `ResultMessageFile`-shaped; slot 1 holds small integers
 * (`MiiListNum`); slot 3 holds real floats (7, 10.5 — `MinWaitSecondForOpening`); slot 4 is 0/1
 * only (`IsRarePattern`); slot 5 has the 12-byte stride and `Pos0`-shaped names; slot 6 carries no
 * default value at all and names actor references (`Mii0`, `Members_List`).
 *
 * Slot 2 has no parameters in any of the 2,574 files, so it is reported as `unknown`. Guessing it
 * from the neighbours would be inventing a type nothing here uses.
 */
const GLOBAL_TYPES: AinbGlobalType[] = [
  'string',
  'int',
  'unknown',
  'float',
  'bool',
  'vec3f',
  'pointer'
]

const GLOBAL_TYPE_COUNT = GLOBAL_TYPES.length
/** 7 slots of {u16 count, u16 firstIndex, u32 defaultValueOffset}. */
const GLOBAL_HEADER_SIZE = GLOBAL_TYPE_COUNT * 8
const GLOBAL_ENTRY_SIZE = 8

/**
 * Caps. A behaviour graph is authored, so nothing here is near them — the largest file in the dump
 * declares 454 nodes — but a damaged header can claim any count, and a viewer that tries to
 * materialise four billion nodes is a hang rather than an error. Every capped list ships its true
 * total beside it so a truncated view says so instead of quietly being short.
 */
const MAX_NODES = 4096
const MAX_COMMANDS = 256
const MAX_GLOBAL_PARAMETERS = 2048
const MAX_STRINGS = 4096

/**
 * The low 22 bits of a parameter's name word are its string offset; the rest are flags.
 *
 * Measured across all 174,794 immediate and io parameters: the only bits ever set above the offset
 * are bit 31 (on 16,491 io parameters) and nothing between 22 and 30, and with this mask every one
 * of those 174,794 offsets lands exactly on a string boundary — the byte before it is a NUL. Global
 * entries additionally use bit 23. What the flags mean is not known, so they are not reported as
 * anything; only the offset is used.
 */
const NAME_OFFSET_MASK = 0x3fffff

export function isAinb(data: Uint8Array): boolean {
  if (data.length < HEADER_SIZE) return false
  for (let at = 0; at < MAGIC.length; at++) {
    if (data[at] !== MAGIC.charCodeAt(at)) return false
  }
  return true
}

export function parseAinb(data: Uint8Array): AinbDocument {
  if (!isAinb(data)) {
    throw new FormatParseError({
      format: 'ainb',
      offset: 0,
      message:
        data.length < HEADER_SIZE
          ? `file is ${data.length} bytes, shorter than the ${HEADER_SIZE}-byte header`
          : 'missing "AIB " signature'
    })
  }

  // Little-endian throughout: there is no byte-order mark, and every file in the dump reads this way.
  const reader = new BinaryReader(data, { littleEndian: true })
  const field = (at: number): number => reader.at(at, () => reader.u32())

  const version = field(0x04)
  if (version !== VERIFIED_VERSION) {
    throw new FormatParseError({
      format: 'ainb',
      offset: 0x04,
      message:
        `version 0x${version.toString(16)} is not supported; this parser was verified against ` +
        `0x${VERIFIED_VERSION.toString(16)} only, and the revisions move header fields`
    })
  }

  const problems: string[] = []
  const commandCount = field(0x0c)
  const nodeCount = field(0x10)
  const stringPool = field(0x24)

  if (stringPool >= data.length) {
    throw new FormatParseError({
      format: 'ainb',
      offset: 0x24,
      message: `string pool starts at ${stringPool}, past the end of a ${data.length}-byte file`
    })
  }

  /*
   * The pool runs from its offset to the end of the file — there is no length, and no section
   * follows it in any of the 2,574 files (the last byte is a NUL in every one).
   */
  const poolBytes = data.subarray(stringPool)
  const stringAt = (offset: number): string => {
    if (offset < 0 || offset >= poolBytes.length) {
      problems.push(`string offset ${offset} is outside the ${poolBytes.length}-byte pool`)
      return ''
    }
    let end = offset
    while (end < poolBytes.length && poolBytes[end] !== 0) end++
    return decodeUtf8(poolBytes.subarray(offset, end))
  }

  const nodesAt = HEADER_SIZE + commandCount * COMMAND_SIZE
  const nodesEnd = nodesAt + nodeCount * NODE_SIZE
  if (nodesEnd > data.length) {
    throw new FormatParseError({
      format: 'ainb',
      offset: 0x10,
      message:
        `${commandCount} command(s) and ${nodeCount} node(s) need ${nodesEnd} bytes, ` +
        `but the file is ${data.length}`
    })
  }

  const globalsAt = field(0x20)
  /*
   * The node array ends exactly where the global section begins in all 2,574 files, which is what
   * pins the 0x18-byte command and 0x3c-byte node strides — get either wrong and this never lands.
   * Slack is reported rather than rejected, since padding is a thing a future revision may add;
   * an overlap is fatal, because then one of the two strides is wrong and every field after is too.
   */
  if (nodesEnd > globalsAt) {
    throw new FormatParseError({
      format: 'ainb',
      offset: 0x20,
      message:
        `the node array ends at ${nodesEnd} but the next section starts at ${globalsAt}, ` +
        'so the command or node stride does not hold for this file'
    })
  }
  if (nodesEnd < globalsAt) {
    problems.push(
      `${globalsAt - nodesEnd} byte(s) sit between the end of the node array and the section at 0x20`
    )
  }

  const commands: AinbCommand[] = []
  for (let index = 0; index < Math.min(commandCount, MAX_COMMANDS); index++) {
    const at = HEADER_SIZE + index * COMMAND_SIZE
    commands.push({
      name: stringAt(field(at)),
      // The command's trailing u16 is 0 in every file in the dump, so it is not reported.
      entryNodeIndex: reader.at(at + 0x14, () => reader.u16()),
      guid: formatGuid(reader.bytesAt(at + 4, 16))
    })
  }

  const nodes: AinbNode[] = []
  const typeCounts = new Map<number, number>()
  for (let index = 0; index < nodeCount; index++) {
    const at = nodesAt + index * NODE_SIZE
    const type = reader.at(at, () => reader.u16())
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
    if (nodes.length >= MAX_NODES) continue
    nodes.push({
      index,
      type,
      userDefined: type === 0,
      name: stringAt(field(at + 8)),
      nameHash: field(at + 0x0c),
      flags: reader.at(at + 6, () => reader.u8()),
      guid: formatGuid(reader.bytesAt(at + 0x2c, 16))
    })
  }

  const globals = readGlobalParameters(reader, globalsAt, stringAt, problems)
  const immediateParameterCounts = readImmediateCounts(reader, field, problems)
  const io = readIoCounts(reader, field, problems)
  const strings = readStrings(poolBytes)

  return {
    version,
    // 0x408 read as major.minor. The split is conventional rather than verified — only one value
    // appears in this dump, so nothing here can distinguish it from a flat number.
    versionText: `${(version >> 8) & 0xff}.${version & 0xff}`,
    name: stringAt(field(0x08)),
    category: stringAt(field(0x60)),
    commandCount,
    commands,
    commandsTruncated: commandCount > commands.length,
    nodeCount,
    nodes,
    nodesTruncated: nodeCount > nodes.length,
    nodeTypeCounts: [...typeCounts]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    globalParameterCount: globals.total,
    globalParameters: globals.parameters,
    globalParametersTruncated: globals.total > globals.parameters.length,
    immediateParameterCounts,
    inputParameterCounts: io.inputs,
    outputParameterCounts: io.outputs,
    strings: strings.slice(0, MAX_STRINGS),
    stringCount: strings.length,
    stringsTruncated: strings.length > MAX_STRINGS,
    stringPoolBytes: poolBytes.length,
    sections: buildSections(field, data.length),
    problems
  }
}

/**
 * The global parameter table: 7 slots of `{u16 count, u16 firstIndex, u32 defaultValueOffset}`,
 * then one flat array of `{u32 nameWord, u32 notesOffset}` entries the slots index into.
 *
 * The total number of entries is `firstIndex + count` of the *last* slot, which reads like a
 * sentinel and is not one — slot 6 holds real parameters (52,087 of them across the dump, actor
 * references with no default value). The arithmetic was checked the only way it can be: the entry
 * array is immediately followed by the default-value blob and then by the per-node parameter
 * bodies, and every node's body offset lands at or just after that computed end in all 2,574
 * files. Getting the entry count wrong moves that boundary and nothing lines up.
 *
 * Default *values* are deliberately not read. The blob is followed, in 379 of the files, by 16, 32
 * or 48 further bytes that are plainly a small table of file references (a string offset and three
 * hash-like words, one entry per referenced file) — and until that table's count can be derived
 * rather than inferred from a gap, reading values past it would be reporting bytes without knowing
 * where they stop.
 */
function readGlobalParameters(
  reader: BinaryReader,
  globalsAt: number,
  stringAt: (offset: number) => string,
  problems: string[]
): { total: number; parameters: AinbGlobalParameter[] } {
  if (globalsAt + GLOBAL_HEADER_SIZE > reader.length) {
    problems.push(`global parameter header at ${globalsAt} runs past the end of the file`)
    return { total: 0, parameters: [] }
  }

  const counts: number[] = []
  const firstIndex: number[] = []
  for (let slot = 0; slot < GLOBAL_TYPE_COUNT; slot++) {
    const at = globalsAt + slot * 8
    counts.push(reader.at(at, () => reader.u16()))
    firstIndex.push(reader.at(at + 2, () => reader.u16()))
  }

  const total = firstIndex[GLOBAL_TYPE_COUNT - 1]! + counts[GLOBAL_TYPE_COUNT - 1]!
  const entriesAt = globalsAt + GLOBAL_HEADER_SIZE
  if (entriesAt + total * GLOBAL_ENTRY_SIZE > reader.length) {
    problems.push(`${total} global parameter(s) declared, which runs past the end of the file`)
    return { total: 0, parameters: [] }
  }

  const parameters: AinbGlobalParameter[] = []
  for (let slot = 0; slot < GLOBAL_TYPE_COUNT; slot++) {
    for (let offset = 0; offset < counts[slot]!; offset++) {
      const index = firstIndex[slot]! + offset
      if (index >= total) {
        problems.push(`global parameter slot ${slot} indexes entry ${index} past the declared ${total}`)
        continue
      }
      if (parameters.length >= MAX_GLOBAL_PARAMETERS) continue
      const at = entriesAt + index * GLOBAL_ENTRY_SIZE
      const nameWord = reader.at(at, () => reader.u32())
      parameters.push({
        name: stringAt(nameWord & NAME_OFFSET_MASK),
        type: GLOBAL_TYPES[slot]!,
        notes: stringAt(reader.at(at + 4, () => reader.u32()) & NAME_OFFSET_MASK),
        index
      })
    }
  }

  parameters.sort((a, b) => a.index - b.index)
  return { total, parameters }
}

/**
 * Immediate parameters: 6 absolute offsets, one per value type, each list running to the next.
 *
 * The last list ends where the input/output table begins, which is the header field at 0x34 — so
 * the six spans are fully determined and no count field is needed. A span that is not a whole
 * number of entries is reported rather than rounded away, because it would mean the stride is wrong
 * for that file; it happens in none of the 2,574.
 */
function readImmediateCounts(
  reader: BinaryReader,
  field: (at: number) => number,
  problems: string[]
): AinbValueCounts {
  const tableAt = field(0x2c)
  if (tableAt <= 0 || tableAt + VALUE_TYPES.length * 4 > reader.length) {
    problems.push(`immediate parameter table at ${tableAt} does not fit in the file`)
    return toCounts([])
  }
  const bounds: number[] = []
  for (let slot = 0; slot < VALUE_TYPES.length; slot++) bounds.push(field(tableAt + slot * 4))
  bounds.push(field(0x34))
  return countLists(bounds, IMMEDIATE_STRIDES, VALUE_TYPES, 'immediate', problems, reader.length)
}

/**
 * Input/output parameters: 12 absolute offsets, interleaved input-then-output per value type.
 *
 * The twelfth list ends at the header field at 0x38, the next section by offset in every file.
 */
function readIoCounts(
  reader: BinaryReader,
  field: (at: number) => number,
  problems: string[]
): { inputs: AinbValueCounts; outputs: AinbValueCounts } {
  const tableAt = field(0x34)
  if (tableAt <= 0 || tableAt + IO_STRIDES.length * 4 > reader.length) {
    problems.push(`input/output parameter table at ${tableAt} does not fit in the file`)
    return { inputs: toCounts([]), outputs: toCounts([]) }
  }
  const bounds: number[] = []
  for (let slot = 0; slot < IO_STRIDES.length; slot++) bounds.push(field(tableAt + slot * 4))
  bounds.push(field(0x38))

  const counts: number[] = []
  for (let slot = 0; slot < IO_STRIDES.length; slot++) {
    counts.push(
      countList(bounds[slot]!, bounds[slot + 1]!, IO_STRIDES[slot]!, `io list ${slot}`, problems, reader.length)
    )
  }

  const pick = (parity: 0 | 1): AinbValueCounts =>
    toCounts(VALUE_TYPES.map((_, type) => counts[type * 2 + parity]!))
  return { inputs: pick(0), outputs: pick(1) }
}

function countLists(
  bounds: number[],
  strides: number[],
  types: readonly AinbValueType[],
  label: string,
  problems: string[],
  fileLength: number
): AinbValueCounts {
  return toCounts(
    types.map((type, slot) =>
      countList(bounds[slot]!, bounds[slot + 1]!, strides[slot]!, `${label} ${type}`, problems, fileLength)
    )
  )
}

function countList(
  from: number,
  to: number,
  stride: number,
  label: string,
  problems: string[],
  fileLength: number
): number {
  if (to < from || to > fileLength) {
    problems.push(`${label} spans [${from}, ${to}), which is not a valid range in this file`)
    return 0
  }
  const span = to - from
  if (span % stride !== 0) {
    problems.push(`${label} spans ${span} bytes, not a whole number of ${stride}-byte entries`)
  }
  return Math.floor(span / stride)
}

function toCounts(values: number[]): AinbValueCounts {
  return {
    int: values[0] ?? 0,
    bool: values[1] ?? 0,
    float: values[2] ?? 0,
    string: values[3] ?? 0,
    vec3f: values[4] ?? 0,
    pointer: values[5] ?? 0
  }
}

/**
 * Every declared region with the extent it must have, derived by sorting the offsets.
 *
 * Sections carry no size of their own, so this is the only honest way to say how big one is — and it
 * is what lets a region this build does not interpret be stepped over rather than guessed at.
 * Fields holding 0 are dropped: that is how this format spells "absent" (the field at 0x44 is 0 in
 * 2,549 of the 2,574 files), and a section reported at offset 0 would overlap the header.
 *
 * Regions are grouped by offset. Several fields sharing one address is the ordinary case for an
 * empty section, and listing each separately would report the same bytes as many times over.
 */
function buildSections(field: (at: number) => number, fileLength: number): AinbSection[] {
  const declared = SECTION_FIELDS.map((entry) => ({ ...entry, offset: field(entry.field) })).filter(
    (entry) => entry.offset > 0 && entry.offset <= fileLength
  )
  const boundaries = [...new Set(declared.map((entry) => entry.offset)), fileLength].sort(
    (a, b) => a - b
  )

  const grouped = new Map<number, { fields: number[]; labels: string[]; read: boolean }>()
  for (const entry of declared) {
    const group = grouped.get(entry.offset) ?? { fields: [], labels: [], read: false }
    group.fields.push(entry.field)
    if (entry.read || entry.label !== 'unidentified') group.labels.push(entry.label)
    group.read = group.read || entry.read
    grouped.set(entry.offset, group)
  }

  return [...grouped]
    .map(([offset, group]) => ({
      fields: group.fields,
      label: group.labels.length > 0 ? [...new Set(group.labels)].join(' + ') : 'unidentified',
      offset,
      size: (boundaries.find((boundary) => boundary > offset) ?? fileLength) - offset,
      read: group.read
    }))
    .sort((a, b) => a.offset - b.offset)
}

/** The pool split on NUL, in file order. Names elsewhere are offsets into exactly this sequence. */
function readStrings(poolBytes: Uint8Array): string[] {
  const strings: string[] = []
  let start = 0
  for (let at = 0; at < poolBytes.length; at++) {
    if (poolBytes[at] !== 0) continue
    strings.push(decodeUtf8(poolBytes.subarray(start, at)))
    start = at + 1
  }
  // A pool not ending in a NUL would leave a trailing run; all 2,574 files here do end in one.
  if (start < poolBytes.length) strings.push(decodeUtf8(poolBytes.subarray(start)))
  return strings
}

/** The 16 GUID bytes as hex, in file order. See {@link AinbCommand.guid} for why not a UUID. */
function formatGuid(bytes: Uint8Array): string {
  let out = ''
  for (let at = 0; at < bytes.length; at++) {
    const byte = bytes[at]!
    out += byte < 16 ? `0${byte.toString(16)}` : byte.toString(16)
  }
  return out
}

/**
 * UTF-8 by hand, because `shared` has no DOM.
 *
 * The purity gate (`tsconfig.shared.json`, `types: []`) means `TextDecoder` is not available here.
 * It is needed rather than optional: global parameter notes in these files are Japanese, so
 * per-byte `fromCharCode` would render them as mojibake and misreport their length.
 *
 * This duplicates the decoder in `formats/msbt`, which is module-private there. Malformed sequences
 * become U+FFFD rather than throwing — one damaged name is not a reason to lose a whole graph.
 */
function decodeUtf8(bytes: Uint8Array): string {
  const units: number[] = []
  let at = 0
  while (at < bytes.length) {
    const first = bytes[at]!

    let codePoint: number
    let length: number
    if (first < 0x80) {
      codePoint = first
      length = 1
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f
      length = 2
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f
      length = 3
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07
      length = 4
    } else {
      units.push(0xfffd)
      at++
      continue
    }

    if (at + length > bytes.length) {
      units.push(0xfffd)
      break
    }

    let valid = true
    for (let index = 1; index < length; index++) {
      const next = bytes[at + index]!
      if ((next & 0xc0) !== 0x80) {
        valid = false
        break
      }
      codePoint = (codePoint << 6) | (next & 0x3f)
    }
    at += length
    if (!valid || codePoint > 0x10ffff) {
      units.push(0xfffd)
      continue
    }

    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000
      units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
    } else {
      units.push(codePoint)
    }
  }

  /*
   * Chunked, because a long pool string spread over one apply would blow the argument limit. 4,096
   * is comfortably inside every engine's cap and the strings here are far shorter, but the pool is
   * attacker-shaped data and this costs nothing.
   */
  let out = ''
  for (let at2 = 0; at2 < units.length; at2 += 4096) {
    out += String.fromCharCode(...units.slice(at2, at2 + 4096))
  }
  return out
}
