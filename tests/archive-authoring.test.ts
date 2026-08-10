import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { writeBflyt } from '@shared/formats/bflyt'
import { createLayoutDocument } from '@shared/formats/bflyt/create'
import {
  GPU_ALIGNMENT,
  needsPageAlignment,
  parseSarc,
  sarcAlignmentFor,
  sarcHash,
  writeSarc,
  type SarcArchive
} from '@shared/formats/sarc'
import { checkBytes } from '@shared/mod/check'
import { decompress } from '@headless/compression'
import {
  cloneArchive,
  createAnimationFile,
  createArchive,
  createLayoutFile,
  editArchiveEntries,
  readAnimation,
  readLayout,
  resolveTarget
} from '@headless/engine'
import { buildBntx, testPattern } from './helpers/bntx-fixture'

/**
 * Authoring archives from nothing, and the packing rules that make them load.
 *
 * Every case here came from a real session that got stuck: there was no way to
 * create an archive, no way to rename an entry, and no way to make a BFLAN — so a
 * custom screen could not be built without shelling out, and one that *was* built
 * crashed inside the driver because a shader had been packed at 0x80.
 */

const scratch: string[] = []
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'bflayout-authoring-'))
  scratch.push(path)
  return path
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** A donor shaped like a real screen: a layout, its animations, and a shader. */
function donor(directory: string, stem: string): string {
  const document = createLayoutDocument({ name: stem })
  const shader = new Uint8Array(2048)
  shader.set(new TextEncoder().encode('BNSH'), 0)

  const archive: SarcArchive = {
    littleEndian: true,
    version: 0x0100,
    hashKey: 0x65,
    hasNames: true,
    originalDataOffset: 0,
    entries: [
      { name: `blyt/${stem}.bflyt`, data: writeBflyt(document, new Map()) },
      { name: `anim/${stem}_In.bflan`, data: new Uint8Array([1, 2, 3, 4]) },
      { name: `anim/${stem}_Loop.bflan`, data: new Uint8Array([5, 6, 7, 8]) },
      { name: 'bgsh/__ArchiveShader.bnsh', data: shader },
      {
        name: 'timg/__Combined.bntx',
        data: buildBntx({
          containerName: '__Combined',
          textureName: 'Btn',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      }
    ].map((file) => ({
      nameHash: sarcHash(file.name, 0x65),
      name: file.name,
      data: file.data,
      originalOffset: 0,
      originalLength: -1,
      alignment: sarcAlignmentFor(file.name)
    }))
  }

  const path = join(directory, `${stem}.Nin_NX_NVN.blarc`)
  writeFileSync(path, writeSarc(archive))
  return path
}

/** Absolute offsets of the entries that must sit on a page boundary. */
async function gpuOffsets(path: string): Promise<{ name: string; absolute: number }[]> {
  const raw = new Uint8Array(readFileSync(path))
  const archive = parseSarc((await decompress(raw)).data)
  return archive.entries
    .filter((entry) => entry.name !== null && needsPageAlignment(entry.name))
    .map((entry) => ({
      name: entry.name!,
      absolute: archive.originalDataOffset + entry.originalOffset
    }))
}

describe('alignment by kind', () => {
  it('gives GPU resources a page and everything else a floor', () => {
    expect(sarcAlignmentFor('timg/__Combined.bntx')).toBe(GPU_ALIGNMENT)
    expect(sarcAlignmentFor('bgsh/__ArchiveShader.bnsh')).toBe(GPU_ALIGNMENT)
    expect(sarcAlignmentFor('blyt/Menu.bflyt')).toBeLessThan(GPU_ALIGNMENT)
  })

  /**
   * The failure this exists for: a `.bntx` added to an archive that has none used
   * to inherit 4 bytes from nothing, and a texture container off a page boundary
   * crashes inside the driver with nothing naming the packing.
   */
  it('page-aligns a GPU resource added to an archive that had none', async () => {
    const directory = root()
    const path = join(directory, 'empty.blarc')

    await createArchive({ path })
    writeFileSync(
      join(directory, 'source.bntx'),
      buildBntx({
        containerName: '__Combined',
        textureName: 'Btn',
        width: 8,
        height: 8,
        rgba: testPattern(8, 8)
      })
    )
    await editArchiveEntries({
      path,
      add: { name: 'timg/__Combined.bntx', fromFile: join(directory, 'source.bntx') }
    })

    for (const entry of await gpuOffsets(path)) {
      expect(entry.absolute % GPU_ALIGNMENT, entry.name).toBe(0)
    }
  })

  it('reports a misaligned GPU resource as an error', () => {
    // Hand-packed at a 4-byte alignment, which is what produced the crash.
    const shader = new Uint8Array(64)
    shader.set(new TextEncoder().encode('BNSH'), 0)
    const archive: SarcArchive = {
      littleEndian: true,
      version: 0x0100,
      hashKey: 0x65,
      hasNames: true,
      originalDataOffset: 0,
      entries: [
        {
          nameHash: sarcHash('bgsh/__ArchiveShader.bnsh', 0x65),
          name: 'bgsh/__ArchiveShader.bnsh',
          data: shader,
          originalOffset: 0,
          originalLength: -1,
          alignment: 4
        }
      ]
    }

    const result = checkBytes('bad.szs', writeSarc(archive))
    const errors = result.notes.filter((note) => note.level === 'error')
    expect(errors.some((note) => note.message.includes('boundary'))).toBe(true)
  })
})

describe('creating an archive', () => {
  it('makes an empty one, with compression from the extension', async () => {
    const directory = root()
    const zstd = await createArchive({ path: join(directory, 'a.blarc.zs') })
    const plain = await createArchive({ path: join(directory, 'b.blarc') })

    expect(zstd.compression).toBe('zstd')
    expect(plain.compression).toBe('none')
    expect((await resolveTarget(zstd.path)).archive?.entries).toEqual([])
  })

  it('refuses to overwrite one that exists', async () => {
    const directory = root()
    const path = join(directory, 'a.blarc')
    await createArchive({ path })
    await expect(createArchive({ path })).rejects.toThrow(/already exists/)
  })

  /** The whole point: from nothing to a screen without shelling out. */
  it('takes a layout and an animation once created', async () => {
    const directory = root()
    const path = join(directory, 'My_Screen.Nin_NX_NVN.blarc.zs')

    await createArchive({ path })
    await createLayoutFile({ path, entry: 'blyt/My_Screen.bflyt', name: 'My_Screen', width: 1920, height: 1080 })
    await createAnimationFile({ path, entry: 'anim/My_Screen_In.bflan', name: 'In', frameSize: 20 })

    const layout = await readLayout(path, 'blyt/My_Screen.bflyt')
    expect(layout.info.name).toBe('My_Screen')
    expect(layout.info.width).toBe(1920)

    const animation = await readAnimation(path, 'anim/My_Screen_In.bflan')
    expect(animation.tag?.name).toBe('In')
    expect(animation.info?.frameSize).toBe(20)
  })
})

describe('cloning a screen', () => {
  it('renames the layout and every sibling animation together', async () => {
    const directory = root()
    const from = donor(directory, 'Common_Text_00')
    const to = join(directory, 'Common_CantTouch_00.Nin_NX_NVN.blarc')

    const result = await cloneArchive({
      fromPath: from,
      toPath: to,
      renameFrom: 'Common_Text_00',
      renameTo: 'Common_CantTouch_00'
    })

    const names = (await resolveTarget(to)).archive!.entries.map((entry) => entry.name).sort()
    expect(names).toEqual([
      'anim/Common_CantTouch_00_In.bflan',
      'anim/Common_CantTouch_00_Loop.bflan',
      'bgsh/__ArchiveShader.bnsh',
      'blyt/Common_CantTouch_00.bflyt',
      'timg/__Combined.bntx'
    ])
    expect(result.renamed).toHaveLength(3)
  })

  /**
   * The game resolves animations by layout name, so an entry and the layout inside
   * it disagreeing is a trap for whoever opens it next.
   */
  it("updates the layout's own internal name", async () => {
    const directory = root()
    const from = donor(directory, 'Common_Text_00')
    const to = join(directory, 'Common_CantTouch_00.blarc')

    await cloneArchive({
      fromPath: from,
      toPath: to,
      renameFrom: 'Common_Text_00',
      renameTo: 'Common_CantTouch_00'
    })

    const layout = await readLayout(to, 'blyt/Common_CantTouch_00.bflyt')
    expect(layout.info.name).toBe('Common_CantTouch_00')
  })

  it('keeps GPU resources page-aligned through the copy', async () => {
    const directory = root()
    const to = join(directory, 'clone.blarc')
    await cloneArchive({ fromPath: donor(directory, 'Screen'), toPath: to })

    const offsets = await gpuOffsets(to)
    expect(offsets.length).toBe(2)
    for (const entry of offsets) expect(entry.absolute % GPU_ALIGNMENT, entry.name).toBe(0)
  })

  it('copies verbatim when no rename is given', async () => {
    const directory = root()
    const to = join(directory, 'copy.blarc')
    const result = await cloneArchive({ fromPath: donor(directory, 'Screen'), toPath: to })

    expect(result.renamed).toEqual([])
    expect(result.entries).toBe(5)
  })
})

describe('editing entries', () => {
  it('renames one, rehashing it so the game can still find it', async () => {
    const directory = root()
    const path = donor(directory, 'Screen')

    await editArchiveEntries({
      path,
      rename: { from: 'anim/Screen_In.bflan', to: 'anim/Screen_Custom.bflan' }
    })

    const archive = (await resolveTarget(path)).archive!
    const renamed = archive.entries.find((entry) => entry.name === 'anim/Screen_Custom.bflan')!
    expect(renamed).toBeDefined()
    // Found by the hash of its name, so a relabel alone would strand it.
    expect(renamed.nameHash).toBe(sarcHash('anim/Screen_Custom.bflan', archive.hashKey))
  })

  it('deletes one', async () => {
    const directory = root()
    const path = donor(directory, 'Screen')
    const result = await editArchiveEntries({ path, remove: 'anim/Screen_Loop.bflan' })
    expect(result.entries).not.toContain('anim/Screen_Loop.bflan')
  })

  it('refuses a rename onto a name already taken', async () => {
    const directory = root()
    const path = donor(directory, 'Screen')
    await expect(
      editArchiveEntries({
        path,
        rename: { from: 'anim/Screen_In.bflan', to: 'anim/Screen_Loop.bflan' }
      })
    ).rejects.toThrow(/already has an entry/)
  })

  it('names what is there when an entry is not found', async () => {
    const directory = root()
    const path = donor(directory, 'Screen')
    await expect(
      editArchiveEntries({ path, rename: { from: 'anim/Nope.bflan', to: 'anim/X.bflan' } })
    ).rejects.toThrow(/blyt\/Screen\.bflyt/)
  })
})
