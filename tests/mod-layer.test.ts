import { afterEach, describe, expect, it } from 'vitest'

import {
  getActiveLayer,
  isUnderDump,
  layerConflict,
  redirectWrite,
  refuseWrite,
  relativeUnder,
  resolveWrite,
  setActiveLayer
} from '@main/mod-layer'

const DUMP = '/games/tomodachi/romfs'
const MOD = '/mods/my-mod/romfs'

afterEach(() => setActiveLayer(null))

describe('relativeUnder', () => {
  it('reports the path below the root', () => {
    expect(relativeUnder(DUMP, `${DUMP}/Layout/Menu.szs`)).toBe('Layout/Menu.szs')
  })

  it('reports the root itself as empty rather than null', () => {
    expect(relativeUnder(DUMP, DUMP)).toBe('')
  })

  it('rejects a path outside the root', () => {
    expect(relativeUnder(DUMP, '/games/other/romfs/Layout')).toBeNull()
  })

  /**
   * The prefix check has to be on a path *separator* boundary. Comparing raw
   * prefixes makes a sibling directory whose name merely starts with the root's
   * look like it is inside it, and the dump guard would then refuse writes to a
   * folder it has no business protecting.
   */
  it('does not treat a same-prefixed sibling as being inside', () => {
    expect(relativeUnder(DUMP, `${DUMP}-backup/Layout/Menu.szs`)).toBeNull()
  })
})

describe('redirectWrite', () => {
  const layer = { dumpPath: DUMP, modPath: MOD }

  it('moves a write inside the dump to the same relative path in the mod', () => {
    expect(redirectWrite(layer, `${DUMP}/Layout/Menu.szs`)).toEqual({
      path: `${MOD}/Layout/Menu.szs`,
      redirected: true
    })
  })

  it('leaves a write outside the dump alone', () => {
    const elsewhere = '/Users/someone/Desktop/Menu.szs'
    expect(redirectWrite(layer, elsewhere)).toEqual({ path: elsewhere, redirected: false })
  })

  it('leaves a write already in the mod layer alone', () => {
    const inLayer = `${MOD}/Layout/Menu.szs`
    expect(redirectWrite(layer, inLayer)).toEqual({ path: inLayer, redirected: false })
  })

  it('sees the dump', () => {
    expect(isUnderDump(layer, `${DUMP}/Font/Nintendo.bfarc`)).toBe(true)
    expect(isUnderDump(layer, `${MOD}/Font/Nintendo.bfarc`)).toBe(false)
  })
})

/**
 * A mod folder inside the dump would redirect every save to a path that is itself
 * under the dump — so the guard would refuse it and saving would be impossible.
 * Refused at creation, where the paths can still be changed.
 */
describe('layerConflict', () => {
  it('refuses a mod folder nested in the dump', () => {
    expect(layerConflict({ dumpPath: DUMP, modPath: `${DUMP}/mods/mine` })).toMatch(/inside the dump/)
  })

  it('refuses a dump nested in the mod folder', () => {
    expect(layerConflict({ dumpPath: `${MOD}/romfs`, modPath: MOD })).toMatch(/inside the mod folder/)
  })

  it('accepts two unrelated folders', () => {
    expect(layerConflict({ dumpPath: DUMP, modPath: MOD })).toBeNull()
  })
})

describe('the active layer', () => {
  it('is inert with no project open', () => {
    expect(getActiveLayer()).toBeNull()
    expect(resolveWrite(`${DUMP}/Layout/Menu.szs`)).toEqual({
      path: `${DUMP}/Layout/Menu.szs`,
      redirected: false
    })
    expect(refuseWrite(`${DUMP}/Layout/Menu.szs`)).toBeNull()
  })

  it('redirects and then refuses once a project is active', () => {
    setActiveLayer({ dumpPath: DUMP, modPath: MOD })

    // What every caller does before writing.
    expect(resolveWrite(`${DUMP}/Layout/Menu.szs`).path).toBe(`${MOD}/Layout/Menu.szs`)

    // And the backstop, for anything that did not.
    expect(refuseWrite(`${DUMP}/Layout/Menu.szs`)).toMatch(/read-only/)
    expect(refuseWrite(`${MOD}/Layout/Menu.szs`)).toBeNull()
  })

  it('stops guarding when the project is deactivated', () => {
    setActiveLayer({ dumpPath: DUMP, modPath: MOD })
    setActiveLayer(null)
    expect(refuseWrite(`${DUMP}/Layout/Menu.szs`)).toBeNull()
  })
})
