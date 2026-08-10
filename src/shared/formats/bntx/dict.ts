/**
 * `_DIC` — the radix tree nn::gfx uses to find a texture by name.
 *
 * A BNTX carries its texture names twice: once in the string pool, and once as a
 * patricia trie the runtime walks to turn a name into an index. Writing a
 * container means rebuilding that trie, and rebuilding it *wrong* is the quiet
 * kind of wrong — the file parses, every texture is present and correct, and the
 * game simply fails to find one by name.
 *
 * Node layout, 16 bytes each, with node 0 a sentinel root:
 *
 *   0x00 reference i32   the bit this node tests, -1 for the root
 *   0x04 left u16        node to take when that bit is 0
 *   0x06 right u16       node to take when it is 1
 *   0x08 name pointer u64
 *
 * Bits are numbered from the *end* of the name: `reference >> 3` counts bytes
 * back from the last character, and `reference & 7` selects the bit within that
 * byte from the least significant end.
 *
 * None of that was guessable. All four plausible bit rules were measured against
 * the 470 containers of a shipped romfs, and this one is the family by a wide
 * margin — end-relative bytes, lowest set bit, scored 142 byte-identical against
 * 63, 18 and 18 for the alternatives. Two further corrections took it the rest of
 * the way, and both are documented where they live: comparing against the root's
 * empty name (`differingBit`) and inserting above the first node (`descend`).
 *
 * **Rebuilds all 470 shipped dictionaries byte for byte, and every one answers a
 * lookup for every name it holds.**
 */

export interface DictNode {
  readonly reference: number
  readonly left: number
  readonly right: number
  readonly name: string
}

/** The bit a node tests, counting back from the end of the name. */
export function keyBit(key: string, reference: number): number {
  if (reference < 0) return 0
  const at = key.length - (reference >> 3) - 1
  if (at < 0 || at >= key.length) return 0
  return (key.charCodeAt(at) >> (reference & 7)) & 1
}

/**
 * The bit that distinguishes two names.
 *
 * Scans outward from the *end* of both names, stops at the first byte that
 * differs, and takes the **lowest** set bit of the difference. Both halves of that
 * are the opposite of the usual patricia convention — most tries scan from the
 * start and split on the highest differing bit — and both were settled by
 * measurement rather than by reasoning about what a trie ought to do.
 *
 * A byte past the start of the shorter name reads as zero rather than ending the
 * comparison. That sounds like a detail about unequal-length names and is really
 * about the *root*, whose name is empty: a name compared against it differs at its
 * own last byte, so the first node lands on the lowest set bit of that byte. Ending
 * the scan early instead put every such name on bit 0, which is right only for the
 * names whose last character happens to be odd — `^w` yes, `^r` and `+f` no.
 */
export function differingBit(a: string, b: string): number {
  const length = Math.max(a.length, b.length)
  for (let back = 0; back < length; back++) {
    const left = back < a.length ? a.charCodeAt(a.length - back - 1) : 0
    const right = back < b.length ? b.charCodeAt(b.length - back - 1) : 0
    const diff = left ^ right
    if (diff === 0) continue
    let bit = 0
    while (((diff >> bit) & 1) === 0) bit++
    return (back << 3) | bit
  }
  return 0
}

/**
 * Builds the trie for a list of names, in the order the textures appear.
 *
 * Node `i + 1` belongs to texture `i`, which is what lets a lookup return an
 * index directly rather than carrying one.
 *
 * Insertion is the textbook patricia two-pass: find the nearest existing name to
 * learn which bit separates them, then walk again to the depth a node testing that
 * bit belongs at.
 */
export function buildDict(names: readonly string[]): DictNode[] {
  const nodes: { reference: number; left: number; right: number; name: string }[] = [
    { reference: -1, left: 0, right: 0, name: '' }
  ]

  /**
   * Walks toward `name`, stopping at a back edge or at `until`.
   *
   * References *increase* with depth, so an edge leading to a reference that is
   * not greater than the current one is the trie pointing back at itself, and
   * that is where a walk ends. `until` stops the walk early, at the depth a node
   * testing that bit belongs.
   *
   * The test comes before the step, so a walk can end without moving at all.
   * Stepping first makes it impossible to insert a node *above* the root's only
   * child, which is exactly what a name whose separating bit is lower than
   * everything already in the tree needs — and produces a tree whose references
   * decrease with depth, which no lookup can walk.
   */
  const descend = (name: string, until: number): { parent: number; child: number } => {
    let parent = 0
    let child = nodes[0]!.left
    while (nodes[child]!.reference > nodes[parent]!.reference && nodes[child]!.reference < until) {
      parent = child
      const node = nodes[parent]!
      child = keyBit(name, node.reference) === 1 ? node.right : node.left
    }
    return { parent, child }
  }

  for (const name of names) {
    const index = nodes.length

    // First pass finds the name this one is closest to, which is what the
    // separating bit has to be computed against.
    const nearest = descend(name, Number.POSITIVE_INFINITY).child
    const reference = differingBit(name, nodes[nearest]!.name)

    // Second pass finds where a node testing that bit belongs.
    const { parent, child } = descend(name, reference)

    const bit = keyBit(name, reference)
    nodes.push({
      reference,
      left: bit === 1 ? child : index,
      right: bit === 1 ? index : child,
      name
    })

    const above = nodes[parent]!
    if (keyBit(name, above.reference) === 1) above.right = index
    else above.left = index
  }

  return nodes
}

/**
 * Walks the trie the way the runtime does.
 *
 * Exported so a built tree can be proved to answer correctly for every name it
 * was built from, which is the property that actually matters — the byte layout
 * is only a means to it.
 */
export function lookupDict(nodes: readonly DictNode[], name: string): number {
  if (nodes.length <= 1) return -1
  let parent = 0
  let child = nodes[0]!.left
  while (nodes[child]!.reference > nodes[parent]!.reference) {
    parent = child
    const node = nodes[parent]!
    child = keyBit(name, node.reference) === 1 ? node.right : node.left
  }
  return nodes[child]!.name === name ? child - 1 : -1
}
