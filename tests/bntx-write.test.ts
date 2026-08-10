import { describe, expect, it } from 'vitest'

import { isBntx, mergeBntx, parseBntx, writeBntx } from '@shared/formats/bntx'
import { lookupDict } from '@shared/formats/bntx/dict'
import type { BntxContainer } from '@shared/formats/bntx/container'
import { buildBntx, testPattern } from './helpers/bntx-fixture'

/**
 * Writing a BNTX container.
 *
 * This exists for merging. A layout archive can hold exactly one texture
 * container — nn::ui2d opens `timg/__Combined.bntx` by that exact path and never
 * enumerates an archive — so copying panes between archives needs the *union* of
 * two containers, and a union needs a serializer. Before there was one, a
 * cross-archive copy could only refuse.
 *
 * The property that makes this trustworthy is not in this file: every one of the
 * 470 containers in a shipped romfs parses and rewrites byte for byte, which is
 * what pins the relocation table and the radix tree rather than merely making
 * them plausible. What is here are the invariants that hold for a container built
 * from nothing, where there is no original to compare against.
 */

const container = (name: string, textures: string[]): BntxContainer =>
  parseBntx(
    buildBntx({
      containerName: name,
      textureName: textures[0]!,
      width: 8,
      height: 8,
      rgba: testPattern(8, 8)
    })
  )

/** A container with several textures, built by merging one-texture fixtures. */
function withTextures(names: readonly string[]): BntxContainer {
  let out = container('__Combined', [names[0]!])
  for (const name of names.slice(1)) {
    out = mergeBntx(out, container('__Other', [name])).container
  }
  return out
}

describe('round-tripping a container', () => {
  it('writes something that reads back as itself', () => {
    const original = container('__Combined', ['Btn'])
    const reread = parseBntx(writeBntx(original))

    expect(isBntx(writeBntx(original))).toBe(true)
    expect(reread.name).toBe('__Combined')
    expect(reread.textures.map((texture) => texture.name)).toEqual(['Btn'])
  })

  /** The pixels are carried, never re-encoded — there is no BCn compressor. */
  it('carries tiled pixel data through untouched', () => {
    const original = container('__Combined', ['Btn'])
    const reread = parseBntx(writeBntx(original))

    expect([...reread.textures[0]!.imageData]).toEqual([...original.textures[0]!.imageData])
    expect(reread.textures[0]!.format).toBe(original.textures[0]!.format)
    expect(reread.textures[0]!.tileMode).toBe(original.textures[0]!.tileMode)
    expect(reread.textures[0]!.blockHeightLog2).toBe(original.textures[0]!.blockHeightLog2)
  })

  it('is stable: writing twice gives the same bytes', () => {
    const original = container('__Combined', ['Btn'])
    const once = writeBntx(original)
    expect([...writeBntx(parseBntx(once))]).toEqual([...once])
  })

  /**
   * The runtime maps texture data rather than copying it, so a payload off its
   * alignment boundary is a fault inside the driver with nothing naming the file.
   */
  it('starts the payload on the container alignment boundary', () => {
    const written = writeBntx(withTextures(['A^s', 'B^s', 'C^s']))
    const parsed = parseBntx(written)
    for (const texture of parsed.textures) {
      expect(texture.dataOffset % texture.alignment, texture.name).toBe(0)
    }
  })

  it('reports its own size honestly', () => {
    const written = writeBntx(withTextures(['A^s', 'B^s']))
    const view = new DataView(written.buffer, written.byteOffset, written.byteLength)
    expect(view.getUint32(0x1c, true)).toBe(written.length)
  })

  /** Every texture has to be findable by name, or it may as well not be there. */
  it('builds a dictionary that finds every texture it holds', () => {
    const names = ['Btn^s', 'Frame^r', 'Glow^t', 'White8_00^w']
    const written = writeBntx(withTextures(names))
    const view = new DataView(written.buffer, written.byteOffset, written.byteLength)

    const dict = view.getUint32(0x38, true)
    const count = view.getUint32(dict + 4, true)
    expect(count).toBe(names.length)

    const nodes = []
    for (let at = 0; at <= count; at++) {
      const base = dict + 8 + at * 16
      nodes.push({
        reference: view.getInt32(base, true),
        left: view.getUint16(base + 4, true),
        right: view.getUint16(base + 6, true),
        name: at === 0 ? '' : names[at - 1]!
      })
    }
    for (const [at, name] of names.entries()) expect(lookupDict(nodes, name), name).toBe(at)
  })
})

describe('refusing what cannot be written', () => {
  it('refuses an empty container', () => {
    const empty = { ...container('__Combined', ['Btn']), textures: [] }
    expect(() => writeBntx(empty)).toThrow(/at least one texture/)
  })

  /** Two textures sharing a name means one is unreachable by the only lookup there is. */
  it('refuses duplicate texture names', () => {
    const one = container('__Combined', ['Btn'])
    const doubled = { ...one, textures: [one.textures[0]!, one.textures[0]!] }
    expect(() => writeBntx(doubled)).toThrow(/both called Btn/)
  })
})

describe('merging two containers', () => {
  it('produces the union', () => {
    const result = mergeBntx(container('__Combined', ['Base']), container('__Other', ['Btn']))

    expect(result.added).toEqual(['Btn'])
    expect(result.container.textures.map((texture) => texture.name)).toEqual(['Base', 'Btn'])
    expect(parseBntx(writeBntx(result.container)).textures.map((t) => t.name)).toEqual(['Base', 'Btn'])
  })

  it('keeps the destination container name', () => {
    const result = mergeBntx(container('__Combined', ['Base']), container('__Other', ['Btn']))
    expect(parseBntx(writeBntx(result.container)).name).toBe('__Combined')
  })

  /**
   * A name already present belongs to the destination's own art, which its other
   * layouts are drawing with. Replacing it would break panes nobody was editing.
   */
  it('leaves a texture the destination already has alone', () => {
    const destination = container('__Combined', ['Btn'])
    const result = mergeBntx(destination, container('__Other', ['Btn']))

    expect(result.added).toEqual([])
    expect(result.skipped).toEqual(['Btn'])
    expect(result.container.textures).toHaveLength(1)
  })

  it('can take only the textures asked for', () => {
    const source = withTextures(['Btn', 'Frame', 'Glow'])
    const result = mergeBntx(container('__Combined', ['Base']), source, ['Frame'])

    expect(result.added).toEqual(['Frame'])
    expect(result.container.textures.map((texture) => texture.name)).toEqual(['Base', 'Frame'])
  })

  it('names what is there when asked for a texture the source lacks', () => {
    expect(() =>
      mergeBntx(container('__Combined', ['Base']), container('__Other', ['Btn']), ['Nope'])
    ).toThrow(/Btn/)
  })

  /** The merged file has to survive the trip back through the parser intact. */
  it('keeps every pixel through the merge and the write', () => {
    const destination = container('__Combined', ['Base'])
    const source = container('__Other', ['Btn'])
    const merged = parseBntx(writeBntx(mergeBntx(destination, source).container))

    const base = merged.textures.find((texture) => texture.name === 'Base')!
    const btn = merged.textures.find((texture) => texture.name === 'Btn')!
    expect([...base.imageData]).toEqual([...destination.textures[0]!.imageData])
    expect([...btn.imageData]).toEqual([...source.textures[0]!.imageData])
  })
})
