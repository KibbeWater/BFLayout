import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createAnimation, parseBflan, writeBflan } from '@shared/formats/bflan'
import type { AnimationDocument } from '@shared/formats/bflan/types'
import { writeBflyt } from '@shared/formats/bflyt'
import {
  createLayoutDocument,
  createMaterial,
  createPicturePane
} from '@shared/formats/bflyt/create'
import type { LayoutDocument } from '@shared/formats/bflyt/types'
import { sarcAlignmentFor, sarcHash, writeSarc, type SarcArchive } from '@shared/formats/sarc'
import { copyAnimationBetween, readAnimation, readLayout, resolveTarget } from '@headless/engine'
import { groupList } from '@headless/edit'
import { buildBntx, testPattern } from './helpers/bntx-fixture'

/**
 * Copying an animation between archives.
 *
 * `copy_panes` remaps material and texture *indices*, because a pane referring to
 * the wrong index is not an error anywhere — it draws, with the wrong texture. A
 * BFLAN has no such index: it binds to panes and materials by **name**. So there
 * is nothing to remap, and instead a different silence: a track naming a pane the
 * destination does not have loads fine and animates nothing at all. No parser, no
 * checker and no packer can tell that apart from an animation that is simply not
 * playing yet.
 *
 * Which is why every one of these is about what the copy *reports*.
 */

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

function archiveOf(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const archive: SarcArchive = {
    littleEndian: true,
    version: 0x0100,
    hashKey: 0x65,
    hasNames: true,
    originalDataOffset: 0,
    entries: files.map((file) => ({
      nameHash: sarcHash(file.name, 0x65),
      name: file.name,
      data: file.data,
      originalOffset: 0,
      originalLength: -1,
      alignment: sarcAlignmentFor(file.name)
    }))
  }
  return writeSarc(archive)
}

/** An animation driving one pane and one material, the way a real one does. */
function wave(): AnimationDocument {
  const document = createAnimation('Wave', 40)
  document.info!.entries = [
    {
      name: 'P_Fluid_00',
      target: 'pane',
      userField: null,
      tags: [
        {
          signature: 'FLPA',
          leading: null,
          components: [
            {
              index: 0,
              target: 0,
              curve: 'hermite',
              keyframes: [
                { frame: 0, value: 0, slope: 0 },
                { frame: 20, value: 32, slope: 0 },
                { frame: 40, value: 0, slope: 0 }
              ]
            }
          ]
        }
      ]
    },
    {
      name: 'M_Fluid',
      target: 'material',
      userField: null,
      tags: [
        {
          // null, not 0: a leading word encodes the entry as target byte 2, the
          // FLEU user-field form, and it reads back as a *pane* target.
          signature: 'FLTS',
          leading: null,
          components: [
            {
              index: 0,
              target: 0,
              curve: 'hermite',
              keyframes: [
                { frame: 0, value: 0, slope: 0 },
                { frame: 40, value: 1, slope: 0 }
              ]
            }
          ]
        }
      ]
    }
  ]
  return document
}

function layout(panes: string[], materials: string[], name = 'Screen'): LayoutDocument {
  const document = createLayoutDocument({ name })
  document.materials = materials.map((material) => createMaterial(material))
  for (const [at, pane] of panes.entries()) {
    document.rootPane!.children.push(createPicturePane(pane, Math.min(at, materials.length - 1)))
  }
  return document
}

interface Scene {
  source: string
  destination: string
}

function scene(options?: {
  panes?: string[]
  materials?: string[]
  animation?: AnimationDocument
  sourceTextures?: string[]
  destinationHasContainer?: boolean
}): Scene {
  const root = mkdtempSync(join(tmpdir(), 'bflayout-anim-'))
  scratch.push(root)

  const source = join(root, 'Donor.szs')
  const destination = join(root, 'Screen.szs')

  const sourceFiles = [
    { name: 'blyt/Donor.bflyt', data: writeBflyt(layout(['P_Fluid_00'], ['M_Fluid'], 'Donor'), new Map()) },
    { name: 'anim/Donor_Loop.bflan', data: writeBflan(options?.animation ?? wave()) }
  ]
  for (const texture of options?.sourceTextures ?? []) {
    sourceFiles.push({
      name: 'timg/__Combined.bntx',
      data: buildBntx({
        containerName: '__Combined',
        textureName: texture,
        width: 8,
        height: 8,
        rgba: testPattern(8, 8)
      })
    })
  }
  writeFileSync(source, archiveOf(sourceFiles))

  const destinationFiles = [
    {
      name: 'blyt/Screen.bflyt',
      data: writeBflyt(
        layout(options?.panes ?? ['P_Fluid_00'], options?.materials ?? ['M_Fluid']),
        new Map()
      )
    }
  ]
  if (options?.destinationHasContainer) {
    destinationFiles.push({
      name: 'timg/__Combined.bntx',
      data: buildBntx({
        containerName: '__Combined',
        textureName: 'Base',
        width: 8,
        height: 8,
        rgba: testPattern(8, 8)
      })
    })
  }
  writeFileSync(destination, archiveOf(destinationFiles))

  return { source, destination }
}

const copy = (
  places: Scene,
  extra?: Partial<Parameters<typeof copyAnimationBetween>[0]>
): ReturnType<typeof copyAnimationBetween> =>
  copyAnimationBetween({
    fromPath: places.source,
    fromEntry: 'anim/Donor_Loop.bflan',
    toPath: places.destination,
    toEntry: 'anim/Screen_Loop.bflan',
    ...extra
  })

describe('carrying the animation across', () => {
  it('lands as a playable entry with its tracks intact', async () => {
    const places = scene()
    const result = await copy(places)

    expect(result.entry).toBe('anim/Screen_Loop.bflan')
    expect(result.tracks).toBe(2)

    const reread = await readAnimation(places.destination, 'anim/Screen_Loop.bflan')
    expect(reread.tag?.name).toBe('Wave')
    expect(reread.info?.frameSize).toBe(40)
    expect(reread.info?.entries.map((entry) => entry.name)).toEqual(['P_Fluid_00', 'M_Fluid'])
  })

  it('keeps the keyframes exactly', async () => {
    const places = scene()
    await copy(places)

    const reread = await readAnimation(places.destination, 'anim/Screen_Loop.bflan')
    const track = reread.info!.entries[0]!.tags[0]!.components[0]!
    expect(track.keyframes).toEqual([
      { frame: 0, value: 0, slope: 0 },
      { frame: 20, value: 32, slope: 0 },
      { frame: 40, value: 0, slope: 0 }
    ])
  })

  it('leaves the source archive alone', async () => {
    const places = scene()
    await copy(places)

    const source = await resolveTarget(places.source)
    expect(source.archive!.entries.map((entry) => entry.name)).toContain('anim/Donor_Loop.bflan')
    expect(source.archive!.entries).toHaveLength(2)
  })
})

describe('targets the destination does not have', () => {
  /**
   * The whole reason this reports rather than just copying. Nothing downstream
   * can tell this apart from an animation that has not been triggered yet.
   */
  it('names a pane the destination layout lacks', async () => {
    const places = scene({ panes: ['P_Something_Else'], materials: ['M_Fluid'] })
    const result = await copy(places)

    expect(result.missingPanes).toEqual(['P_Fluid_00'])
    expect(result.missingMaterials).toEqual([])
    expect(result.warnings.join(' ')).toMatch(/drives nothing/)
  })

  it('names a material the destination layout lacks', async () => {
    const places = scene({ panes: ['P_Fluid_00'], materials: ['M_Other'] })
    const result = await copy(places)

    expect(result.missingMaterials).toEqual(['M_Fluid'])
    expect(result.missingPanes).toEqual([])
  })

  /** Binding decides which panes an animation applies to, so a missing group is silent too. */
  it('names a group the destination layout lacks', async () => {
    const animation = wave()
    animation.tag!.groups = ['G_Btn_00']
    const places = scene({ animation })
    const result = await copy(places)

    expect(result.missingGroups).toEqual(['G_Btn_00'])
    expect(result.warnings.join(' ')).toMatch(/applies to none of them and does nothing/)
  })

  it('stays quiet when every target resolves', async () => {
    const result = await copy(scene())
    expect(result.missingPanes).toEqual([])
    expect(result.missingMaterials).toEqual([])
    expect(result.warnings).toEqual([])
  })

  /** A pane and a material may share a name, so the target kind decides which. */
  it('checks a material target against materials, not panes', async () => {
    const places = scene({ panes: ['P_Fluid_00', 'M_Fluid'], materials: ['M_Other'] })
    const result = await copy(places)
    expect(result.missingMaterials).toEqual(['M_Fluid'])
  })
})

describe('creating the group the animation binds to', () => {
  /**
   * The failure this closes. Correct tracks, resolving targets, and a pat1 bound
   * to a group the destination has no equivalent of — so the animation applies to
   * nothing and the screen sits still. Reporting it was not enough; there was no
   * way to fix it from here.
   */
  it('builds the missing group from the panes the animation drives', async () => {
    const animation = wave()
    animation.tag!.groups = ['G_InOut_00']
    const places = scene({ animation })

    const result = await copy(places, { createGroups: true })

    expect(result.missingGroups).toEqual([])
    expect(result.createdGroups).toEqual(['G_InOut_00 (P_Fluid_00)'])

    const layout = await readLayout(places.destination, 'blyt/Screen.bflyt')
    expect(groupList(layout)).toEqual([{ name: 'G_InOut_00', panes: ['P_Fluid_00'] }])
  })

  it('leaves the layout alone unless asked', async () => {
    const animation = wave()
    animation.tag!.groups = ['G_InOut_00']
    const places = scene({ animation })

    await copy(places)
    expect(groupList(await readLayout(places.destination, 'blyt/Screen.bflyt'))).toEqual([])
  })

  /** Material targets are not panes, so they have no business in a pane group. */
  it('puts only panes in it', async () => {
    const animation = wave()
    animation.tag!.groups = ['G_InOut_00']
    const places = scene({ animation, panes: ['P_Fluid_00'], materials: ['M_Fluid'] })

    const result = await copy(places, { createGroups: true })
    expect(result.createdGroups).toEqual(['G_InOut_00 (P_Fluid_00)'])
  })

  /**
   * A group built from targets that do not resolve would list panes that are not
   * there — the same silent nothing, one level down. Better to refuse and say so.
   */
  it('will not build one out of targets the layout does not have', async () => {
    const animation = wave()
    animation.tag!.groups = ['G_InOut_00']
    const places = scene({ animation, panes: ['P_Unrelated'], materials: ['M_Fluid'] })

    const result = await copy(places, { createGroups: true })
    expect(result.createdGroups).toEqual([])
    expect(result.missingGroups).toEqual(['G_InOut_00'])
    expect(result.warnings.join(' ')).toMatch(/not one pane this animation drives exists/)
  })

  it('creates the group renaming pointed it at', async () => {
    const animation = wave()
    animation.tag!.groups = ['G_InOut_00']
    const places = scene({ animation })

    const result = await copy(places, {
      createGroups: true,
      rename: { G_InOut_00: 'G_Wave_00' }
    })
    expect(result.createdGroups).toEqual(['G_Wave_00 (P_Fluid_00)'])
  })

  /** Naming the flag is the difference between a report and a fix. */
  it('names the way out in the warning', async () => {
    const animation = wave()
    animation.tag!.groups = ['G_InOut_00']
    const result = await copy(scene({ animation }))

    expect(result.warnings.join(' ')).toMatch(/create_groups: true/)
    expect(result.warnings.join(' ')).toMatch(/add_group/)
  })
})

describe('retargeting on the way in', () => {
  /** The route when the destination's panes are named differently. */
  it('rewrites targets through the rename map', async () => {
    const places = scene({ panes: ['P_Fluid_01'], materials: ['M_Fluid_01'] })
    const result = await copy(places, {
      rename: { P_Fluid_00: 'P_Fluid_01', M_Fluid: 'M_Fluid_01' }
    })

    expect(result.renamed).toEqual(['P_Fluid_00 → P_Fluid_01', 'M_Fluid → M_Fluid_01'])
    expect(result.missingPanes).toEqual([])
    expect(result.missingMaterials).toEqual([])

    const reread = await readAnimation(places.destination, 'anim/Screen_Loop.bflan')
    expect(reread.info?.entries.map((entry) => entry.name)).toEqual(['P_Fluid_01', 'M_Fluid_01'])
  })

  it('reports what a rename left behind', async () => {
    const places = scene({ panes: ['P_Fluid_01'], materials: ['M_Fluid'] })
    const result = await copy(places, { rename: { P_Fluid_00: 'P_Nope' } })

    expect(result.renamed).toEqual(['P_Fluid_00 → P_Nope'])
    expect(result.missingPanes).toEqual(['P_Nope'])
  })
})

describe('the name the game looks it up by', () => {
  /**
   * The game resolves a layout's animations by the *layout's* name, so an entry
   * called anything else is loaded by nobody — the same trap that makes
   * clone_archive rename every sibling animation together.
   */
  it('warns when the entry name does not match the layout it drives', async () => {
    const places = scene()
    const result = await copy(places, { toEntry: 'anim/Wave_Loop.bflan' })

    expect(result.warnings.join(' ')).toMatch(/never loaded/)
    expect(result.warnings.join(' ')).toMatch(/Screen/)
  })

  it('is quiet when the entry name matches', async () => {
    const result = await copy(scene(), { toEntry: 'anim/Screen_In.bflan' })
    expect(result.warnings.join(' ')).not.toMatch(/never loaded/)
  })
})

describe('pattern textures', () => {
  /** FLTP keyframe values index the animation's own table; what it names must exist. */
  it('reports a pattern texture the destination archive does not hold', async () => {
    const animation = wave()
    animation.info!.textures = ['Wave_00', 'Wave_01']
    const places = scene({ animation, destinationHasContainer: true })

    const result = await copy(places)
    expect(result.missingTextures).toEqual(['Wave_00', 'Wave_01'])
    expect(result.warnings.join(' ')).toMatch(/sample nothing/)
  })

  it('merges the ones the source archive can supply', async () => {
    const animation = wave()
    animation.info!.textures = ['Wave_00']
    const places = scene({
      animation,
      sourceTextures: ['Wave_00'],
      destinationHasContainer: true
    })

    const result = await copy(places)
    expect(result.missingTextures).toEqual([])
    expect(result.carried.join(' ')).toMatch(/merged into/)
  })

  it('says nothing about textures for an animation with no pattern table', async () => {
    const result = await copy(scene({ destinationHasContainer: true }))
    expect(result.missingTextures).toEqual([])
    expect(result.carried).toEqual([])
  })
})

describe('refusing what cannot be done', () => {
  it('refuses a source that is not an animation', async () => {
    const places = scene()
    await expect(
      copyAnimationBetween({
        fromPath: places.source,
        fromEntry: 'blyt/Donor.bflyt',
        toPath: places.destination
      })
    ).rejects.toThrow(/not a BFLAN/)
  })

  it('refuses a destination that is not an archive', async () => {
    const places = scene()
    const loose = join(mkdtempSync(join(tmpdir(), 'bflayout-anim-')), 'loose.bflan')
    scratch.push(loose)
    writeFileSync(loose, writeBflan(createAnimation('X', 10)))

    await expect(
      copyAnimationBetween({
        fromPath: places.source,
        fromEntry: 'anim/Donor_Loop.bflan',
        toPath: loose
      })
    ).rejects.toThrow(/not an archive/)
  })

  it('names the layouts when given one that is not there', async () => {
    const places = scene()
    await expect(copy(places, { layoutEntry: 'blyt/Nope.bflyt' })).rejects.toThrow(/not a layout/)
  })

  /** Nothing to check against is itself worth saying, not worth being quiet about. */
  it('says so when the destination has no layout to check against', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bflayout-anim-'))
    scratch.push(root)
    const bare = join(root, 'Bare.szs')
    writeFileSync(bare, archiveOf([{ name: 'timg/__Combined.bntx', data: buildBntx({ containerName: '__Combined', textureName: 'Base', width: 8, height: 8, rgba: testPattern(8, 8) }) }]))

    const places = scene()
    const result = await copyAnimationBetween({
      fromPath: places.source,
      fromEntry: 'anim/Donor_Loop.bflan',
      toPath: bare,
      toEntry: 'anim/Bare_Loop.bflan'
    })
    expect(result.warnings.join(' ')).toMatch(/holds no layout/)
    expect(parseBflan((await resolveTarget(bare, 'anim/Bare_Loop.bflan')).bytes).document.info?.entries).toHaveLength(2)
  })
})
