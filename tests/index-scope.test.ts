import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Effect } from 'effect'

import { setExcludedNames, walkFiles } from '@main/walk'

/**
 * Scoping the index to a few folders.
 *
 * A romfs is tens of thousands of files and several gigabytes, every one of which
 * the indexer decompresses and parses. A project that only touches `Layout/` can
 * say so — but the paths it produces still have to be relative to the *dump*, or
 * every entry in the index points somewhere that does not exist.
 */

const scratch: string[] = []

function dump(): string {
  const root = mkdtempSync(join(tmpdir(), 'bflayout-index-'))
  scratch.push(root)

  mkdirSync(join(root, 'Layout'), { recursive: true })
  mkdirSync(join(root, 'Message', 'Deep'), { recursive: true })
  mkdirSync(join(root, 'Sound'), { recursive: true })

  writeFileSync(join(root, 'Layout', 'Menu.szs'), 'a')
  writeFileSync(join(root, 'Message', 'Text.msbt'), 'b')
  writeFileSync(join(root, 'Message', 'Deep', 'More.msbt'), 'c')
  writeFileSync(join(root, 'Sound', 'Big.bars'), 'd')
  return root
}

afterEach(() => {
  setExcludedNames(['README.md'])
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** What the index does: walk each scoped folder, then re-root its paths. */
async function scopedWalk(root: string, folders: readonly string[]): Promise<string[]> {
  const roots =
    folders.length > 0
      ? folders.map((folder) => ({ path: join(root, folder), prefix: folder }))
      : [{ path: root, prefix: '' }]

  const found: string[] = []
  for (const entry of roots) {
    const files = await Effect.runPromise(Effect.orElseSucceed(walkFiles(entry.path), () => []))
    for (const file of files) {
      found.push(entry.prefix === '' ? file.relativePath : `${entry.prefix}/${file.relativePath}`)
    }
  }
  return found.sort()
}

describe('index scoping', () => {
  it('walks the whole dump when no folders are named', async () => {
    expect(await scopedWalk(dump(), [])).toEqual([
      'Layout/Menu.szs',
      'Message/Deep/More.msbt',
      'Message/Text.msbt',
      'Sound/Big.bars'
    ])
  })

  it('reads only the folders named', async () => {
    expect(await scopedWalk(dump(), ['Layout'])).toEqual(['Layout/Menu.szs'])
  })

  /**
   * The part that would otherwise be wrong in a way nothing catches: a scoped walk
   * reports paths relative to the folder it was pointed at, so without re-rooting
   * every index entry would say `Menu.szs` and nothing could open it.
   */
  it('keeps paths relative to the dump, not to the scoped folder', async () => {
    const scoped = await scopedWalk(dump(), ['Message'])
    expect(scoped).toEqual(['Message/Deep/More.msbt', 'Message/Text.msbt'])
    expect(scoped.every((path) => path.startsWith('Message/'))).toBe(true)
  })

  it('takes several folders', async () => {
    expect(await scopedWalk(dump(), ['Layout', 'Sound'])).toEqual([
      'Layout/Menu.szs',
      'Sound/Big.bars'
    ])
  })

  it('is empty rather than broken when a named folder does not exist', async () => {
    expect(await scopedWalk(dump(), ['Nope'])).toEqual([])
  })
})
