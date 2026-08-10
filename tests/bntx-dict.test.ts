import { describe, expect, it } from 'vitest'

import { buildDict, differingBit, keyBit, lookupDict } from '@shared/formats/bntx/dict'

/**
 * The `_DIC` radix tree a BNTX carries to turn a texture name into an index.
 *
 * Rebuilding it wrongly is the worst available outcome — the file parses, every
 * texture is present and correct, and the game cannot find one by name — so this
 * was settled by measurement against 470 shipped containers rather than by
 * reasoning. `writeBntx` reproduces all 470 byte for byte, which is what makes
 * the tree here trustworthy; these pin the rules that got it there.
 *
 * The node values below are read from `Button_MainMenu_00`'s container, which is
 * also the one whose art prompted all of this.
 */

describe('bit numbering', () => {
  /** Byte 0 is the *last* character, not the first. */
  it('counts bytes back from the end of the name', () => {
    expect(keyBit('BtnMainMenu^s', 0)).toBe('s'.charCodeAt(0) & 1)
    expect(keyBit('BtnMainMenu^s', 8)).toBe('^'.charCodeAt(0) & 1)
    // Bit 1 of the byte one back from the end.
    expect(keyBit('BtnMainMenu^s', 9)).toBe(('^'.charCodeAt(0) >> 1) & 1)
  })

  it('reads a bit past the start of the name as zero', () => {
    expect(keyBit('ab', 800)).toBe(0)
    expect(keyBit('ab', -1)).toBe(0)
  })

  /**
   * Two names differing in one character: the shipped tree splits them on the
   * *lowest* set bit of the difference, which is backwards from the usual patricia
   * convention and was the single hardest thing here to establish.
   */
  it('splits on the lowest differing bit, at the first byte that differs from the end', () => {
    // 'L' ^ 'R' is 0x1e — bits 1, 2, 3 and 4 all differ; the tree tests bit 1.
    expect(differingBit('BtnBalloon_LS^w', 'BtnBalloon_RS^w')).toBe((3 << 3) | 1)
  })

  it('distinguishes names that differ only in a trailing digit', () => {
    expect(differingBit('Hand_Stroke_00^w', 'Hand_Stroke_01^w')).toBe((2 << 3) | 0)
    expect(differingBit('Hand_Stroke_00^w', 'Hand_Stroke_02^w')).toBe((2 << 3) | 1)
    expect(differingBit('Hand_Stroke_00^w', 'Hand_Stroke_04^w')).toBe((2 << 3) | 2)
  })

  /**
   * A name compared against the root's empty name differs at its own last byte,
   * so the first node lands on the lowest set bit of that byte — not on bit 0.
   * `^w` is odd and lands on 0; `^r` and `+f` are even and do not.
   */
  it('treats a byte past the shorter name as zero', () => {
    expect(differingBit('Hand_Stroke_00^w', '')).toBe(0)
    expect(differingBit('RoughLine_00^r', '')).toBe(1)
    expect(differingBit('BalloonArrow^t', '')).toBe(2)
    expect(differingBit('Indirect_BtnFrame+f', '')).toBe(1)
  })
})

describe('building a tree', () => {
  const NAMES = [
    'BtnBalloon_LS^w',
    'BtnBalloon_RS^w',
    'BtnMainMenu^s',
    'HarfCircleLine_00^s',
    'RoughLine_00^r',
    'White8_00^s'
  ]

  /** Node i + 1 is texture i, which is what lets a lookup return an index. */
  it('reproduces the tree shipped in Button_MainMenu_00', () => {
    expect(buildDict(NAMES).map((node) => [node.reference, node.left, node.right])).toEqual([
      [-1, 1, 0],
      [0, 5, 3],
      [25, 1, 2],
      [2, 4, 2],
      [16, 6, 3],
      [1, 0, 5],
      [40, 6, 4]
    ])
  })

  /**
   * The two textures of `Balloon_MiiS_00`, which is the smallest container that
   * needs both corrections at once.
   *
   * `^t` and `^r` both end in an even byte, so comparing against the root's empty
   * name puts them on bits 2 and 1 rather than bit 0 — and the second name's bit
   * is *lower* than the first's, so it has to be inserted above the root's
   * existing child rather than below it. Getting that wrong builds a tree whose
   * references decrease with depth, which no lookup can walk.
   */
  it('inserts a name whose separating bit is lower than everything already there', () => {
    const nodes = buildDict(['BalloonMiiS_00^t', 'MiiFace^r'])
    expect(nodes.map((node) => [node.reference, node.left, node.right])).toEqual([
      [-1, 2, 0],
      [2, 0, 1],
      [1, 1, 2]
    ])
    // The later name sits above the earlier one: references grow with depth.
    expect(nodes[2]!.reference).toBeLessThan(nodes[1]!.reference)
    expect(lookupDict(nodes, 'BalloonMiiS_00^t')).toBe(0)
    expect(lookupDict(nodes, 'MiiFace^r')).toBe(1)
  })

  it('answers a lookup for every name it was built from', () => {
    const nodes = buildDict(NAMES)
    for (const [at, name] of NAMES.entries()) expect(lookupDict(nodes, name), name).toBe(at)
  })

  it('reports a name it does not hold', () => {
    expect(lookupDict(buildDict(NAMES), 'NotHere^s')).toBe(-1)
    expect(lookupDict(buildDict([]), 'anything')).toBe(-1)
  })

  /** Long runs of near-identical names are where a wrong descent shows up first. */
  it('answers a lookup across a run of names differing in one digit', () => {
    const run = Array.from({ length: 12 }, (_, at) => `Hand_Pick_Close${String(at).padStart(2, '0')}^w`)
    const nodes = buildDict(run)
    for (const [at, name] of run.entries()) expect(lookupDict(nodes, name), name).toBe(at)
  })

  it('handles a single texture', () => {
    const nodes = buildDict(['Only^s'])
    expect(nodes).toHaveLength(2)
    expect(lookupDict(nodes, 'Only^s')).toBe(0)
  })
})
