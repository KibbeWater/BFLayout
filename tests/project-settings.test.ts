import { describe, expect, it } from 'vitest'

import {
  defaultProjectSettings,
  modProjectSettingsSchema,
  type ModProjectSettings
} from '@shared/contract'

/**
 * Project settings, and the property that makes them safe to add to.
 *
 * Every field carries its own default, so a blob written by an older build — one
 * missing whatever has been added since — still parses into a complete settings
 * object. Without that, adding a setting would silently reset every project that
 * had never seen it.
 */

/** What the service does on read: validate per field, never as one object. */
function readSettings(stored: unknown): ModProjectSettings {
  const source = (stored ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(modProjectSettingsSchema.shape)) {
    const candidate = field.safeParse(source[key])
    out[key] = candidate.success ? candidate.data : field.parse(undefined)
  }
  return out as ModProjectSettings
}

describe('project settings', () => {
  it('produces a complete object from nothing', () => {
    const settings = defaultProjectSettings()
    expect(settings).toMatchObject({
      emulatorDataDir: null,
      deployPrune: true,
      excludedFiles: ['README.md'],
      zstdLevel: 17,
      checkResourceSizeTable: true,
      checkCompressionSuffix: true,
      indexFolders: []
    })
  })

  /** The defaults are the promise that a project which never opens settings is right. */
  it('defaults to the safe side of every judgement call', () => {
    const settings = defaultProjectSettings()
    // Pruning on: a stale deployed file is loaded by the game and looks like an
    // edit that did not take.
    expect(settings.deployPrune).toBe(true)
    // Both checks on: each catches a failure that is otherwise silent.
    expect(settings.checkResourceSizeTable).toBe(true)
    expect(settings.checkCompressionSuffix).toBe(true)
  })

  it('fills in a field an older build never wrote', () => {
    const stored = { deployPrune: false }
    const settings = readSettings(stored)

    expect(settings.deployPrune).toBe(false)
    expect(settings.zstdLevel).toBe(17)
    expect(settings.excludedFiles).toEqual(['README.md'])
  })

  /**
   * One bad value must not take the rest with it. Validating the object as a
   * whole would reject it entirely and reset every setting the user had chosen.
   */
  it('keeps the good settings when one is corrupt', () => {
    const settings = readSettings({
      zstdLevel: 'not a number',
      deployPrune: false,
      excludedFiles: ['README.md', 'notes.txt']
    })

    expect(settings.zstdLevel).toBe(17)
    expect(settings.deployPrune).toBe(false)
    expect(settings.excludedFiles).toEqual(['README.md', 'notes.txt'])
  })

  it('survives a blob that is not an object at all', () => {
    expect(readSettings(null)).toEqual(defaultProjectSettings())
    expect(readSettings('nonsense')).toEqual(defaultProjectSettings())
  })

  it('refuses a ZSTD level outside what the format allows', () => {
    expect(readSettings({ zstdLevel: 99 }).zstdLevel).toBe(17)
    expect(readSettings({ zstdLevel: 0 }).zstdLevel).toBe(17)
    expect(readSettings({ zstdLevel: 3 }).zstdLevel).toBe(3)
  })

  it('lets a project say nothing is excluded', () => {
    expect(readSettings({ excludedFiles: [] }).excludedFiles).toEqual([])
  })
})
