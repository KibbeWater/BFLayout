import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { layerConflict } from '@main/mod-layer'
import { modDirectoryName } from '@main/services/deploy'

/**
 * Setting a project up, and the ways it goes wrong quietly.
 *
 * Every case here is one where the app would otherwise accept the input and fail
 * much later — at a save, or at a deploy that installed into the wrong place. That
 * gap is the expensive part: by then the person has done the work.
 */

const temporary: string[] = []

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'bflayout-project-'))
  temporary.push(path)
  return path
}

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true })
})

describe('layerConflict', () => {
  it('accepts a dump and a mod folder that are unrelated', () => {
    // The real shape: a dump under Documents/projects and a mod inside a git repo.
    expect(
      layerConflict({
        dumpPath: '/Users/someone/Documents/projects/Tomodachi/romfs_104',
        modPath: '/Users/someone/Documents/VSC/Tomodachi-MM/romfs'
      })
    ).toBeNull()
  })

  it('refuses a mod folder inside the dump, which would make saving impossible', () => {
    expect(
      layerConflict({ dumpPath: '/dump/romfs', modPath: '/dump/romfs/mods/mine' })
    ).toMatch(/inside the dump/)
  })
})

/**
 * The mod's directory name under `mods/contents/<title id>/`.
 *
 * A mod that is more than asset replacement installs a code half into the same
 * directory — Colony puts a subsdk9 in `colony/exefs` and its assets in
 * `colony/romfs`. A name derived from the project would deploy a second, parallel
 * mod that the loader's own deploy does not manage.
 */
describe('modDirectoryName', () => {
  it('keeps a name that is already a safe directory', () => {
    expect(modDirectoryName('colony')).toBe('colony')
  })

  it('slugs a project name into something a filesystem accepts', () => {
    expect(modDirectoryName('Tomodachi-MM')).toBe('tomodachi-mm')
    expect(modDirectoryName('Bigger Buttons!')).toBe('bigger-buttons')
  })

  it('never produces an empty directory name', () => {
    expect(modDirectoryName('   ')).toBe('mod')
    expect(modDirectoryName('!!!')).toBe('mod')
  })
})

/**
 * The romfs overlay convention, as Colony's own deploy defines it: the folder is
 * the source of truth, mirrored with `--delete` and `--exclude 'README.md'`.
 * Matching that exactly is what keeps the two tools agreeing about what the mod
 * contains — otherwise BFLayout would package and deploy a README into the game's
 * romfs that Colony's deploy deliberately leaves out.
 */
describe('the mod layer walk', () => {
  it('leaves README.md out and keeps everything else', async () => {
    const { walkFiles } = await import('@main/walk')
    const { Effect } = await import('effect')

    const root = scratch()
    mkdirSync(join(root, 'Layout'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# romfs overlay')
    writeFileSync(join(root, '.DS_Store'), 'junk')
    writeFileSync(join(root, 'Layout', 'Menu.szs'), 'bytes')
    writeFileSync(join(root, 'Layout', 'notes.md'), 'kept: only README is special')

    const found = await Effect.runPromise(walkFiles(root))
    const paths = found.map((file) => file.relativePath).sort()

    expect(paths).toEqual(['Layout/Menu.szs', 'Layout/notes.md'])
    // The files are still on disk; they are simply not part of the mod.
    expect(existsSync(join(root, 'README.md'))).toBe(true)
  })
})
