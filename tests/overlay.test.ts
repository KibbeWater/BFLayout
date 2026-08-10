import { describe, expect, it } from 'vitest'

import type { FolderEntry } from '@shared/contract'
import { mergeOverlay } from '@main/services/folder'

/**
 * The overlay rule, without a filesystem.
 *
 * This is the composition the emulator's LayeredFS performs at load time, and the
 * browser has to match it exactly — a row that opens the dump's copy of a file the
 * mod has already replaced would make an edit look lost, and saving again would
 * write a second copy from stale bytes.
 */

const file = (name: string, path: string, size = 10): FolderEntry => ({
  name,
  path,
  kind: 'layout',
  size,
  compressed: false,
  origin: 'pristine'
})

const DUMP = '/dump/Layout'
const MOD = '/mod/Layout'

describe('mergeOverlay', () => {
  it('leaves a file only the dump has alone', () => {
    const merged = mergeOverlay([file('A.bflyt', `${DUMP}/A.bflyt`)], [], 'Layout')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ origin: 'pristine', path: `${DUMP}/A.bflyt` })
    // Nothing to revert, so no key for one.
    expect(merged[0]!.relativePath).toBeUndefined()
  })

  it('opens the mod copy of a replaced file, and remembers the original', () => {
    const merged = mergeOverlay(
      [file('A.bflyt', `${DUMP}/A.bflyt`, 100)],
      [{ ...file('A.bflyt', `${MOD}/A.bflyt`, 120), origin: 'added' }],
      'Layout'
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      origin: 'modified',
      // The one the game would load.
      path: `${MOD}/A.bflyt`,
      pristinePath: `${DUMP}/A.bflyt`,
      relativePath: 'Layout/A.bflyt',
      // And the mod's size, not the dump's.
      size: 120
    })
  })

  it('marks a file only the mod has as added', () => {
    const merged = mergeOverlay(
      [file('A.bflyt', `${DUMP}/A.bflyt`)],
      [{ ...file('New.bflyt', `${MOD}/New.bflyt`), origin: 'added' }],
      'Layout'
    )

    expect(merged.map((entry) => entry.origin).sort()).toEqual(['added', 'pristine'])
    const added = merged.find((entry) => entry.origin === 'added')
    expect(added).toMatchObject({ relativePath: 'Layout/New.bflyt' })
    // An addition shadows nothing, so there is no pristine copy to go back to —
    // which is what tells the UI that reverting it deletes rather than restores.
    expect(added?.pristinePath).toBeUndefined()
  })

  it('keys a revert from the project root, not the directory', () => {
    const merged = mergeOverlay(
      [],
      [{ ...file('A.bflyt', `${MOD}/deep/A.bflyt`), origin: 'added' }],
      'Layout/deep'
    )
    expect(merged[0]!.relativePath).toBe('Layout/deep/A.bflyt')
  })

  it('needs no prefix at the project root', () => {
    const merged = mergeOverlay([], [{ ...file('A.szs', '/mod/A.szs'), origin: 'added' }], '')
    expect(merged[0]!.relativePath).toBe('A.szs')
  })
})
