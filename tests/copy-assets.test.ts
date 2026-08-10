import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { parseBntx } from '@shared/formats/bntx'
import { writeBflyt } from '@shared/formats/bflyt'
import {
  createLayoutDocument,
  createMaterial,
  createPicturePane
} from '@shared/formats/bflyt/create'
import { sarcHash, writeSarc, type SarcArchive } from '@shared/formats/sarc'
import { copyPanesBetween, readLayout, resolveTarget } from '@headless/engine'
import { buildBntx, testPattern } from './helpers/bntx-fixture'

/**
 * Copying panes between archives, with the textures they need.
 *
 * The document half — panes, materials, remapped indices — is covered in
 * `headless-edit`. This is the half that only shows up across archives: the
 * destination ends up *naming* textures its archive does not contain, and nothing
 * fails. The layout parses, the panes draw, and they draw untextured.
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
      alignment: 4
    }))
  }
  return writeSarc(archive)
}

/** A container whose *filename* deliberately differs from the texture inside it. */
function container(textureName: string): Uint8Array {
  return buildBntx({
    containerName: '__Combined',
    textureName,
    width: 8,
    height: 8,
    rgba: testPattern(8, 8)
  })
}

function scene(): { source: string; destination: string } {
  const root = mkdtempSync(join(tmpdir(), 'bflayout-copy-'))
  scratch.push(root)

  const from = createLayoutDocument({ name: 'Source' })
  from.textures = ['Btn']
  const material = createMaterial('BtnMaterial')
  material.textureMaps = [{ textureIndex: 0, flag1: 0, flag2: 0 }]
  from.materials = [material]
  from.rootPane!.children.push(createPicturePane('Copied', 0))

  const to = createLayoutDocument({ name: 'Destination' })

  const source = join(root, 'source.szs')
  const destination = join(root, 'destination.szs')

  writeFileSync(
    source,
    archiveOf([
      { name: 'blyt/Source.bflyt', data: writeBflyt(from, new Map()) },
      { name: 'timg/__Combined.bntx', data: container('Btn') }
    ])
  )
  writeFileSync(
    destination,
    archiveOf([{ name: 'blyt/Destination.bflyt', data: writeBflyt(to, new Map()) }])
  )
  return { source, destination }
}

const parseBntxSafely = (data: Uint8Array): boolean => {
  try {
    parseBntx(data)
    return true
  } catch {
    return false
  }
}

/** Every texture name held by every BNTX in an archive. */
async function texturesIn(path: string): Promise<string[]> {
  const target = await resolveTarget(path)
  const names: string[] = []
  for (const entry of target.archive?.entries ?? []) {
    if (entry.name === null) continue
    try {
      for (const texture of parseBntx(entry.data).textures) names.push(texture.name)
    } catch {
      // Not a container.
    }
  }
  return names
}

describe('copying panes between archives', () => {
  it('carries the container holding a texture the destination lacks', async () => {
    const { source, destination } = scene()
    expect(await texturesIn(destination)).toEqual([])

    const result = await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied']
    })

    expect(result.report.panes).toEqual(['Copied'])
    expect(result.carried).toHaveLength(1)
    // The texture is now genuinely present, not merely named.
    expect(await texturesIn(destination)).toContain('Btn')
  })

  it('leaves the copied pane pointing at a texture that exists', async () => {
    const { source, destination } = scene()
    await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied']
    })

    const document = await readLayout(destination, 'blyt/Destination.bflyt')
    const pane = document.rootPane!.children[0]!
    const materialIndex = pane.kind === 'pic1' ? pane.materialIndex : -1
    const map = document.materials[materialIndex]!.textureMaps[0]!

    expect(document.textures[map.textureIndex]).toBe('Btn')
    expect(await texturesIn(destination)).toContain('Btn')
  })

  /**
   * Turning it off is a legitimate choice when the textures live in a shared
   * archive the game loads anyway — but it has to be a choice, not the default.
   */
  it('can be told not to carry them', async () => {
    const { source, destination } = scene()
    const result = await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied'],
      carryTextures: false
    })

    expect(result.carried).toEqual([])
    expect(await texturesIn(destination)).toEqual([])
  })

  it('does not copy a container the destination already has the texture from', async () => {
    const { source, destination } = scene()
    // First copy brings it; a second must not bring it again.
    await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied']
    })
    const second = await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied']
    })

    expect(second.carried).toEqual([])
    expect((await texturesIn(destination)).filter((name) => name === 'Btn')).toHaveLength(1)
  })

  /**
   * Merging into the destination's own container, rather than adding a second.
   *
   * A layout archive can hold exactly one texture container: nn::ui2d resolves
   * textures through the hardcoded path `timg/__Combined.bntx` by exact path and
   * never enumerates an archive's entries. This used to add a second container
   * under `timg/__From_<stem>.bntx`, which the engine simply never opened — the
   * copied panes' textures stayed unresolved and the game died dereferencing
   * null inside nn::ui2d::ResourceTextureInfo while building the layout. Then it
   * refused outright, which was honest and a dead end.
   *
   * The destination here already has its own textures, which is the ordinary
   * case for copying a button into a real screen, so this path is the rule
   * rather than the exception.
   */
  it('merges into the container the destination already has', async () => {
    const { source } = scene()
    const root = mkdtempSync(join(tmpdir(), 'bflayout-copy-'))
    scratch.push(root)

    const to = createLayoutDocument({ name: 'Destination' })
    to.textures = ['Base']
    const destination = join(root, 'destination.szs')
    writeFileSync(
      destination,
      archiveOf([
        { name: 'blyt/Destination.bflyt', data: writeBflyt(to, new Map()) },
        { name: 'timg/__Combined.bntx', data: container('Base') }
      ])
    )

    const result = await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied']
    })

    expect(result.carried.join(' ')).toMatch(/merged into/)
    // Both the destination's own art and the incoming texture, in one container.
    expect((await texturesIn(destination)).sort()).toEqual(['Base', 'Btn'])
  })

  /** One container, still — a second would never be opened. */
  it('leaves the archive with exactly one texture container', async () => {
    const { source } = scene()
    const root = mkdtempSync(join(tmpdir(), 'bflayout-copy-'))
    scratch.push(root)

    const to = createLayoutDocument({ name: 'Destination' })
    to.textures = ['Base']
    const destination = join(root, 'destination.szs')
    writeFileSync(
      destination,
      archiveOf([
        { name: 'blyt/Destination.bflyt', data: writeBflyt(to, new Map()) },
        { name: 'timg/__Combined.bntx', data: container('Base') }
      ])
    )

    await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied']
    })

    const target = await resolveTarget(destination)
    const containers = (target.archive?.entries ?? []).filter(
      (entry) => entry.name !== null && parseBntxSafely(entry.data)
    )
    expect(containers.map((entry) => entry.name)).toEqual(['timg/__Combined.bntx'])
  })

  /** The escape hatch has to keep working, or the refusal is a dead end. */
  it('still copies into an already-textured archive when told not to carry', async () => {
    const { source } = scene()
    const root = mkdtempSync(join(tmpdir(), 'bflayout-copy-'))
    scratch.push(root)

    const to = createLayoutDocument({ name: 'Destination' })
    to.textures = ['Base']
    const destination = join(root, 'destination.szs')
    writeFileSync(
      destination,
      archiveOf([
        { name: 'blyt/Destination.bflyt', data: writeBflyt(to, new Map()) },
        { name: 'timg/__Combined.bntx', data: container('Base') }
      ])
    )

    const result = await copyPanesBetween({
      fromPath: source,
      fromEntry: 'blyt/Source.bflyt',
      toPath: destination,
      toEntry: 'blyt/Destination.bflyt',
      panes: ['Copied'],
      carryTextures: false
    })

    expect(result.report.panes).toEqual(['Copied'])
    expect(result.carried).toEqual([])
    expect(await texturesIn(destination)).toEqual(['Base'])
  })
})
