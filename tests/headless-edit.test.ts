import { describe, expect, it } from 'vitest'

import { parseBflan, writeBflan } from '@shared/formats/bflan'
import type { AnimationDocument } from '@shared/formats/bflan/types'
import { parseBflyt, writeBflyt } from '@shared/formats/bflyt'
import {
  createLayoutDocument,
  createMaterial,
  createPartPane,
  createPicturePane,
  createTextPane
} from '@shared/formats/bflyt/create'
import type { LayoutDocument } from '@shared/formats/bflyt/types'
import {
  addPane,
  addTrack,
  copyPanes,
  animationTracks,
  deletePane,
  duplicatePane,
  editAnimation,
  editMaterial,
  paneNames,
  putKeyframe,
  removeKeyframe,
  removeTrack,
  renamePane,
  reorderPane,
  reparentPane,
  setKeyframes
} from '@headless/edit'

/**
 * The document surgery behind the CLI and the MCP tools.
 *
 * These run against documents that then go through the real writers, because the
 * failure that matters is not "the function returned" — it is an edit that
 * produces a file the game will not load, or one that quietly loses something.
 */

function layout(): LayoutDocument {
  const document = createLayoutDocument({ name: 'Menu' })
  document.materials = [createMaterial('BtnMaterial')]
  document.textures = ['Header.bntx', 'Btn.bntx']

  const panel = createPicturePane('Panel', 0)
  const button = createPicturePane('BtnOk', 0)
  const label = createPicturePane('Label', 0)
  panel.children.push(button, label)
  document.rootPane!.children.push(panel)
  return document
}

/** Round-trips through the writer, which is the real test of an edit. */
const survives = (document: LayoutDocument): LayoutDocument =>
  parseBflyt(writeBflyt(document, new Map())).document

describe('layout structure', () => {
  it('adds a pane under a named parent and it survives a write', () => {
    const document = layout()
    addPane(document, { kind: 'txt1', name: 'Caption', parent: 'Panel', size: [100, 20] })

    const written = survives(document)
    expect(paneNames(written)).toContain('Caption')
    const panel = written.rootPane!.children[0]!
    expect(panel.children.map((child) => child.name)).toEqual(['BtnOk', 'Label', 'Caption'])
  })

  /**
   * Names are how every tool addresses a pane, so a duplicate would make each
   * later edit apply to whichever the search happened to find first.
   */
  it('refuses a name that is already taken', () => {
    expect(() => addPane(layout(), { kind: 'pic1', name: 'BtnOk' })).toThrow(/already has a pane/)
  })

  it('refuses a pane kind it does not know, and says which exist', () => {
    expect(() => addPane(layout(), { kind: 'xxx1', name: 'New' })).toThrow(/pan1, pic1, txt1/)
  })

  it('deletes a pane and its subtree', () => {
    const document = layout()
    expect(deletePane(document, 'Panel')).toMatch(/2 descendant/)
    expect(paneNames(survives(document))).toEqual(['RootPane'])
  })

  /** Deleting it would leave the layout with nothing to draw. */
  it('refuses to delete the root', () => {
    expect(() => deletePane(layout(), 'RootPane')).toThrow(/root pane/)
  })

  it('duplicates a subtree, renaming every pane in it', () => {
    const document = layout()
    duplicatePane(document, 'Panel')

    const names = paneNames(survives(document))
    expect(names).toContain('Panel_copy')
    expect(names).toContain('BtnOk_copy')
    expect(names).toContain('Label_copy')
    // And the originals are untouched.
    expect(names).toContain('BtnOk')
    // No name appears twice, which is what makes the copy addressable.
    expect(new Set(names).size).toBe(names.length)
  })

  it('renames a pane', () => {
    const document = layout()
    renamePane(document, 'BtnOk', 'BtnConfirm')
    expect(paneNames(survives(document))).toContain('BtnConfirm')
  })

  it('reparents a pane', () => {
    const document = layout()
    reparentPane(document, 'BtnOk', 'RootPane')
    const written = survives(document)
    expect(written.rootPane!.children.map((child) => child.name)).toContain('BtnOk')
  })

  /**
   * Moving a pane inside its own subtree would detach the subtree from the tree:
   * still reachable from itself, never drawn again.
   */
  it('refuses to reparent a pane into its own subtree', () => {
    expect(() => reparentPane(layout(), 'Panel', 'BtnOk')).toThrow(/detach/)
  })

  it('reorders among siblings, which is z-order', () => {
    const document = layout()
    reorderPane(document, 'Label', 0)
    const panel = survives(document).rootPane!.children[0]!
    expect(panel.children.map((child) => child.name)).toEqual(['Label', 'BtnOk'])
  })
})

describe('materials', () => {
  it('sets a colour and marks the material for re-encoding', () => {
    const document = layout()
    editMaterial(document, 'BtnMaterial', { blackColor: [255, 0, 0, 255] })

    // The dirty flag is what tells the writer to rebuild rather than replay the
    // original bytes; without it the save reports success and writes the old colour.
    expect(document.materials[0]!.dirty).toBe(true)
    expect(survives(document).materials[0]!.blackColor).toEqual([255, 0, 0, 255])
  })

  it('refuses a texture index outside the layout list, and says what is there', () => {
    expect(() => editMaterial(layout(), 'BtnMaterial', { textureIndices: [7] })).toThrow(
      /Header\.bntx, Btn\.bntx/
    )
  })

  it('refuses a colour channel outside 0-255', () => {
    expect(() => editMaterial(layout(), 'BtnMaterial', { blackColor: [300, 0, 0, 255] })).toThrow(
      /0 to 255/
    )
  })

  it('names the materials that exist when one is not found', () => {
    expect(() => editMaterial(layout(), 'Nope', { blackColor: [0, 0, 0, 0] })).toThrow(
      /BtnMaterial/
    )
  })
})

function animation(): AnimationDocument {
  const document: AnimationDocument = {
    version: { major: 8, minor: 0, micro: 0, micro2: 0 },
    littleEndian: true,
    tag: {
      name: 'Menu_In',
      order: 0,
      startFrame: 0,
      endFrame: 30,
      childBinding: false,
      groups: [],
      trailing: [],
      userData: []
    },
    info: { frameSize: 30, loop: false, textures: [], entries: [] },
    unknownSections: []
  }
  addTrack(document, {
    entry: 'BtnOk',
    tag: 'FLPA',
    targetByte: 1,
    keyframes: [
      { frame: 0, value: -100, slope: 0 },
      { frame: 30, value: 0, slope: 0 }
    ]
  })
  return document
}

/** Round-trips through the animation writer. */
const survivesAnimation = (document: AnimationDocument): AnimationDocument =>
  parseBflan(writeBflan(document)).document

describe('animations', () => {
  it('adds a track, creating the entry and tag it needs', () => {
    const document = animation()
    const message = addTrack(document, {
      entry: 'Label',
      tag: 'FLVI',
      targetByte: 0,
      curve: 'step',
      keyframes: [{ frame: 0, value: 0, slope: 0 }]
    })

    expect(message).toMatch(/created its entry and tag/)
    const tracks = animationTracks(survivesAnimation(document))
    expect(tracks.map((track) => `${track.entry}:${track.tag}`)).toEqual([
      'BtnOk:FLPA',
      'Label:FLVI'
    ])
  })

  /** Names the property rather than the byte, which is what makes a track readable. */
  it('describes a track by what it animates', () => {
    const [track] = animationTracks(animation())
    expect(track).toMatchObject({
      entry: 'BtnOk',
      tagName: 'Transform',
      targetName: 'Translate Y'
    })
  })

  it('replaces a curve and keeps the keys in frame order', () => {
    const document = animation()
    setKeyframes(
      document,
      { entry: 'BtnOk', tag: 'FLPA', target: 1 },
      [
        { frame: 20, value: 5, slope: 0 },
        { frame: 0, value: 0, slope: 0 }
      ],
      'hermite'
    )

    const [track] = animationTracks(survivesAnimation(document))
    // Out of order in, in order out: the evaluator walks them assuming it.
    expect(track!.keyframes.map((key) => key.frame)).toEqual([0, 20])
  })

  it('replaces rather than duplicates a key at the same frame', () => {
    const document = animation()
    putKeyframe(document, { entry: 'BtnOk', tag: 'FLPA', target: 1 }, { frame: 0, value: 42, slope: 0 })

    const [track] = animationTracks(survivesAnimation(document))
    expect(track!.keyframes).toHaveLength(2)
    expect(track!.keyframes[0]).toMatchObject({ frame: 0, value: 42 })
  })

  it('removes a keyframe', () => {
    const document = animation()
    putKeyframe(document, { entry: 'BtnOk', tag: 'FLPA', target: 1 }, { frame: 15, value: 1, slope: 0 })
    removeKeyframe(document, { entry: 'BtnOk', tag: 'FLPA', target: 1 }, 15)

    const [track] = animationTracks(survivesAnimation(document))
    expect(track!.keyframes.map((key) => key.frame)).toEqual([0, 30])
  })

  /** A track with no keys has no value to evaluate. */
  it('refuses to remove the last keyframe', () => {
    const document = animation()
    removeKeyframe(document, { entry: 'BtnOk', tag: 'FLPA', target: 1 }, 30)
    expect(() => removeKeyframe(document, { entry: 'BtnOk', tag: 'FLPA', target: 1 }, 0)).toThrow(
      /only keyframe/
    )
  })

  it('drops the tag and entry when their last track goes', () => {
    const document = animation()
    removeTrack(document, { entry: 'BtnOk', tag: 'FLPA', target: 1 })
    expect(survivesAnimation(document).info?.entries).toHaveLength(0)
  })

  it('refuses a duplicate track and points at set_keyframes', () => {
    expect(() =>
      addTrack(animation(), {
        entry: 'BtnOk',
        tag: 'FLPA',
        targetByte: 1,
        keyframes: [{ frame: 0, value: 0, slope: 0 }]
      })
    ).toThrow(/set_keyframes/)
  })

  it('says what an animation drives when asked for something it does not', () => {
    expect(() =>
      setKeyframes(animation(), { entry: 'Ghost', tag: 'FLPA', target: 1 }, [
        { frame: 0, value: 0, slope: 0 }
      ])
    ).toThrow(/It drives: BtnOk/)
  })

  it('edits length, looping and the frame range', () => {
    const document = animation()
    editAnimation(document, { frameSize: 60, loop: true, endFrame: 60 })

    const written = survivesAnimation(document)
    expect(written.info?.frameSize).toBe(60)
    expect(written.info?.loop).toBe(true)
    expect(written.tag?.endFrame).toBe(60)
  })
})

/**
 * Copying between layouts.
 *
 * The thing that makes this more than a clone is that a pane refers to its
 * material by *index*, and materials refer to textures by index. Paste a pane
 * alone and it points at whatever sits at that index in the destination — which
 * is not an error anywhere. It draws, with the wrong texture, and nothing says so.
 */
describe('copyPanes', () => {
  function source(): LayoutDocument {
    const document = createLayoutDocument({ name: 'Source' })
    document.textures = ['Unused.bntx', 'Wanted.bntx']
    document.fonts = ['Unused.bfcpx', 'Wanted.bfcpx']

    const material = createMaterial('SourceMaterial')
    material.textureMaps = [{ textureIndex: 1, flag1: 0, flag2: 0 }]
    document.materials = [createMaterial('Other'), material]

    const picture = createPicturePane('Copied', 1)
    document.rootPane!.children.push(picture)
    return document
  }

  function destination(): LayoutDocument {
    const document = createLayoutDocument({ name: 'Destination' })
    document.textures = ['Existing.bntx']
    document.materials = [createMaterial('Existing')]
    return document
  }

  it('remaps the material index, so the copy draws with the right material', () => {
    const into = destination()
    const report = copyPanes(source(), into, ['Copied'])

    expect(report.materials).toEqual(['SourceMaterial'])
    const copied = into.rootPane!.children[0]!
    // Source index 1; the destination already had one material, so it lands at 1
    // here too — but by resolution, not by coincidence.
    const index = copied.kind === 'pic1' ? copied.materialIndex : -1
    expect(into.materials[index]!.name).toBe('SourceMaterial')
  })

  it("remaps the material's own texture index", () => {
    const into = destination()
    copyPanes(source(), into, ['Copied'])

    const material = into.materials.find((candidate) => candidate.name === 'SourceMaterial')!
    // It wanted "Wanted.bntx", which is index 1 in the source and 1 in the
    // destination only after being appended to it.
    expect(into.textures[material.textureMaps[0]!.textureIndex]).toBe('Wanted.bntx')
  })

  it('brings only the textures that are actually used', () => {
    const into = destination()
    const report = copyPanes(source(), into, ['Copied'])

    expect(report.textures).toEqual(['Wanted.bntx'])
    expect(into.textures).not.toContain('Unused.bntx')
  })

  it('remaps a font index for a text pane', () => {
    const from = source()
    const text = createTextPane('Label', 1)
    text.fontIndex = 1
    from.rootPane!.children.push(text)

    const into = destination()
    copyPanes(from, into, ['Label'])

    const copied = into.rootPane!.children[0]!
    const index = copied.kind === 'txt1' ? copied.fontIndex : -1
    expect(into.fonts[index]).toBe('Wanted.bfcpx')
  })

  it('reuses a texture the destination already names', () => {
    const from = source()
    from.textures = ['Existing.bntx']
    from.materials[1]!.textureMaps = [{ textureIndex: 0, flag1: 0, flag2: 0 }]

    const into = destination()
    const report = copyPanes(from, into, ['Copied'])

    // A texture name is a file name: two layouts naming it mean the same image.
    expect(report.textures).toEqual([])
    expect(into.textures).toEqual(['Existing.bntx'])
  })

  /**
   * A material name is local, so two layouts can easily have different materials
   * called the same thing. Reusing the destination's would change how the copy
   * draws for a reason nobody would ever find.
   */
  it('imports a same-named but different material under its own name, and says so', () => {
    const from = source()
    from.materials[1]!.name = 'Existing'
    from.materials[1]!.blackColor = [1, 2, 3, 4]

    const into = destination()
    const report = copyPanes(from, into, ['Copied'])

    expect(report.materials).toEqual(['Existing_copy'])
    expect(report.warnings.join(' ')).toMatch(/already had a different material/)
  })

  it('reuses a material that is genuinely identical', () => {
    const from = source()
    from.materials[1] = { ...createMaterial('Existing') }

    const into = destination()
    const report = copyPanes(from, into, ['Copied'])
    expect(report.materials).toEqual([])
    expect(into.materials).toHaveLength(1)
  })

  it('renames a copied pane whose name the destination already uses', () => {
    const into = destination()
    into.rootPane!.children.push(createPicturePane('Copied', 0))

    const report = copyPanes(source(), into, ['Copied'])
    expect(report.panes).toEqual(['Copied_copy'])
  })

  it('warns that a part pane needs its external layout to exist', () => {
    const from = source()
    from.rootPane!.children.push(createPartPane('Part', 'Other.bflyt'))

    const report = copyPanes(from, destination(), ['Part'])
    expect(report.warnings.join(' ')).toMatch(/Other\.bflyt/)
  })

  it('copies a whole subtree, and the result still writes', () => {
    const from = source()
    const group = createPicturePane('Group', 1)
    group.children.push(createPicturePane('Child', 1))
    from.rootPane!.children.push(group)

    const into = destination()
    copyPanes(from, into, ['Group'])
    expect(paneNames(survives(into))).toEqual(
      expect.arrayContaining(['Group', 'Child'])
    )
  })
})
