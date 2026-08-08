/**
 * BYML ("Binary YAML"), Nintendo's binary tree serialisation format.
 *
 * A BYML document is a tree of typed nodes rooted at a map or an array. Games
 * use it for essentially all non-asset configuration — this game ships 49 `.byml`
 * (version 2, big-endian) and 1763 `.bgyml` (version 7, little-endian) files
 * covering sound parameters, walking grids, actor definitions and so on.
 *
 * Node types are one byte. The container types matter for parsing because they
 * store an offset rather than a value:
 *
 *   0xa0 string     inline u32 index into the string table
 *   0xa1 binary     offset to (u32 size, bytes)
 *   0xa2 file       offset to (u32 size, u32 alignment, bytes)   -- version 7
 *   0xc0 array      offset to a container
 *   0xc1 map        offset to a container, keys from the hash-key table
 *   0xc2 strings     a string table, only ever reached from the header
 *   0xd0 bool       inline u32, non-zero is true
 *   0xd1 int        inline i32
 *   0xd2 float      inline f32
 *   0xd3 uint       inline u32
 *   0xd4 int64      offset to an i64
 *   0xd5 uint64     offset to a u64
 *   0xd6 double     offset to an f64
 *   0xff null       inline, value ignored
 */

export const BymlNodeType = {
  /**
   * A map keyed by 32-bit hashes rather than by strings.
   *
   * Undocumented and absent from every reference implementation I could find; its
   * layout was read off the bytes of this game's version 7 files, where 51 files
   * use it. Unlike 0xc1 it stores the entries first and the value type bytes
   * afterwards:
   *
   *   u8 0x20, u24 count
   *   count x (u32 keyHash, u32 valueOrOffset)
   *   count x u8 nodeType, padded to four bytes
   *
   * Entries are sorted by hash, presumably so the game can binary-search them.
   * The original key strings are not in the file, so only the hash can be shown.
   */
  HashMap: 0x20,
  String: 0xa0,
  Binary: 0xa1,
  File: 0xa2,
  Array: 0xc0,
  Map: 0xc1,
  StringTable: 0xc2,
  Bool: 0xd0,
  Int: 0xd1,
  Float: 0xd2,
  UInt: 0xd3,
  Int64: 0xd4,
  UInt64: 0xd5,
  Double: 0xd6,
  Null: 0xff
} as const

/**
 * Whether a node type carries its value in its 4-byte slot or points at it.
 *
 * Enumerated rather than expressed as a range. `type >= Array` looks like it means
 * "container", but 0xc0 is below the inline scalars — Bool, Int, Float, UInt and
 * Null are all above it — so a range test called every one of them an offset node.
 */
export function isOffsetNode(type: number): boolean {
  switch (type) {
    case BymlNodeType.Binary:
    case BymlNodeType.File:
    case BymlNodeType.HashMap:
    case BymlNodeType.Array:
    case BymlNodeType.Map:
    case BymlNodeType.StringTable:
    case BymlNodeType.Int64:
    case BymlNodeType.UInt64:
    case BymlNodeType.Double:
      return true
    default:
      return false
  }
}

export interface BymlMapEntry {
  readonly key: string
  readonly value: BymlNode
}

export interface BymlHashEntry {
  /** The 32-bit key hash. The string it was made from is not in the file. */
  readonly hash: number
  readonly value: BymlNode
}

/**
 * One node of the tree.
 *
 * The distinction between `int`/`uint` and `int64`/`uint64`/`double` is kept
 * rather than collapsed to a single number, because a writer has to reproduce the
 * original type byte and a value like 1 gives no clue which it was.
 */
export type BymlNode =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'uint'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'int64'; readonly value: bigint }
  | { readonly kind: 'uint64'; readonly value: bigint }
  | { readonly kind: 'double'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | {
      readonly kind: 'binary'
      readonly data: Uint8Array
      /** Present only for 0xa2 "file" nodes, which carry an explicit alignment. */
      readonly alignment?: number
    }
  | { readonly kind: 'array'; readonly items: readonly BymlNode[] }
  | { readonly kind: 'map'; readonly entries: readonly BymlMapEntry[] }
  | { readonly kind: 'hashmap'; readonly entries: readonly BymlHashEntry[] }

export interface BymlDocument {
  readonly version: number
  readonly littleEndian: boolean
  /** Null when the file holds a header but no root node, which is legal. */
  readonly root: BymlNode | null
}

/** The type byte a node round-trips as. */
export function nodeTypeOf(node: BymlNode): number {
  switch (node.kind) {
    case 'null':
      return BymlNodeType.Null
    case 'bool':
      return BymlNodeType.Bool
    case 'int':
      return BymlNodeType.Int
    case 'uint':
      return BymlNodeType.UInt
    case 'float':
      return BymlNodeType.Float
    case 'int64':
      return BymlNodeType.Int64
    case 'uint64':
      return BymlNodeType.UInt64
    case 'double':
      return BymlNodeType.Double
    case 'string':
      return BymlNodeType.String
    case 'binary':
      return node.alignment === undefined ? BymlNodeType.Binary : BymlNodeType.File
    case 'array':
      return BymlNodeType.Array
    case 'map':
      return BymlNodeType.Map
    case 'hashmap':
      return BymlNodeType.HashMap
  }
}

/** Human-readable type name, for the viewer and for error messages. */
export function nodeTypeName(node: BymlNode): string {
  switch (node.kind) {
    case 'binary':
      return node.alignment === undefined ? 'binary' : 'file'
    case 'array':
      return `array[${node.items.length}]`
    case 'map':
      return `map{${node.entries.length}}`
    case 'hashmap':
      return `hashmap{${node.entries.length}}`
    default:
      return node.kind
  }
}

/** Whether a node has children, so the viewer knows what is expandable. */
export function isContainer(node: BymlNode): boolean {
  return node.kind === 'array' || node.kind === 'map' || node.kind === 'hashmap'
}

/**
 * Walks the tree depth-first, visiting each node with the path taken to reach it.
 * Paths use dotted keys and bracketed indices, so they read like the source YAML.
 */
export function walkByml(
  root: BymlNode,
  visit: (node: BymlNode, path: string) => void,
  path = ''
): void {
  visit(root, path)
  if (root.kind === 'array') {
    root.items.forEach((item, index) => walkByml(item, visit, `${path}[${index}]`))
    return
  }
  if (root.kind === 'map') {
    for (const entry of root.entries) {
      walkByml(entry.value, visit, path === '' ? entry.key : `${path}.${entry.key}`)
    }
    return
  }
  if (root.kind === 'hashmap') {
    for (const entry of root.entries) {
      // Hashed keys have no recoverable name, so the path shows the hash.
      const label = `<${entry.hash.toString(16).padStart(8, '0')}>`
      walkByml(entry.value, visit, path === '' ? label : `${path}.${label}`)
    }
  }
}

/** Total node count, used to decide whether the viewer should lazy-render. */
export function countNodes(root: BymlNode): number {
  let total = 0
  walkByml(root, () => {
    total++
  })
  return total
}
