import { relative, resolve, sep } from 'node:path'

/**
 * Where a write is allowed to land when a mod project is open.
 *
 * A romfs dump is the one copy of the game's files a modder has, and it is not
 * theirs to change: a mod is a *layer* over it, and the emulator's LayeredFS
 * composes the two at load time. So while a project is active the dump is
 * mounted read-only and every save that would land inside it is redirected to
 * the same relative path under the mod directory instead — the file is copied on
 * write, which is exactly the shape the mod has to ship in anyway.
 *
 * This is module-level state rather than an Effect service for the same reason
 * `unsaved.ts` is: it is process-wide, and `FilesService` needs to consult it
 * synchronously from inside a write it has already committed to performing.
 * `ProjectService` owns it and pushes the active project in.
 */

export interface ModLayer {
  /** The pristine dump. Read-only for as long as this layer is active. */
  readonly dumpPath: string
  /** Where redirected writes land, mirroring the dump's own tree. */
  readonly modPath: string
}

/**
 * The part of `path` below `root`, or null when it is not below it at all.
 *
 * Compared case-insensitively except on Linux, because macOS and Windows both
 * resolve `/Romfs/Layout` and `/romfs/layout` to the same file — and a guard
 * that can be stepped around by typing a path differently is not a guard.
 */
export function relativeUnder(root: string, path: string): string | null {
  const fold = process.platform === 'linux' ? (value: string): string => value : lower
  const from = resolve(root)
  const to = resolve(path)
  if (fold(from) === fold(to)) return ''

  const prefix = from.endsWith(sep) ? from : from + sep
  if (!fold(to).startsWith(fold(prefix))) return null
  return relative(from, to)
}

function lower(value: string): string {
  return value.toLowerCase()
}

/** True when `path` is the dump or anything inside it. */
export function isUnderDump(layer: ModLayer, path: string): boolean {
  return relativeUnder(layer.dumpPath, path) !== null
}

/**
 * Where a write to `path` should actually go.
 *
 * Anything outside the dump is left alone — a mod project does not take over
 * every save the app makes, only the ones that would damage the pristine copy.
 */
export function redirectWrite(
  layer: ModLayer,
  path: string
): { readonly path: string; readonly redirected: boolean } {
  const below = relativeUnder(layer.dumpPath, path)
  if (below === null || below === '') return { path, redirected: false }
  return { path: resolve(layer.modPath, below), redirected: true }
}

/**
 * Why a mod directory may not sit inside the dump it layers over.
 *
 * The redirect would then produce a path that is itself under the dump, so every
 * save would still be a write into the pristine copy — the guard would refuse it
 * and saving would be impossible, which is a worse failure than the one it
 * prevents. Refused when the project is created, where it can still be fixed.
 */
export function layerConflict(layer: ModLayer): string | null {
  if (relativeUnder(layer.dumpPath, layer.modPath) !== null) {
    return 'the mod folder is inside the dump; it has to be somewhere else, or every save would be a write into the pristine files'
  }
  if (relativeUnder(layer.modPath, layer.dumpPath) !== null) {
    return 'the dump is inside the mod folder; it has to be somewhere else, or the mod would contain the whole game'
  }
  return null
}

let active: ModLayer | null = null

export function setActiveLayer(layer: ModLayer | null): void {
  active = layer
}

export function getActiveLayer(): ModLayer | null {
  return active
}

/**
 * The redirect, applied against whatever project is active.
 *
 * Callers use this to *choose* a destination, because several of them have to
 * know where the bytes went: a layout session retargets itself after a save-as,
 * and an archive updates the path it will next save to.
 */
export function resolveWrite(path: string): { readonly path: string; readonly redirected: boolean } {
  return active ? redirectWrite(active, path) : { path, redirected: false }
}

/**
 * The backstop, consulted by `FilesService.writeAtomic`.
 *
 * If every caller resolves its destination first this never fires, which is the
 * point: the redirect is the feature and this is the proof that nothing routed
 * around it. It returns the complaint rather than throwing so the caller can
 * fail in its own typed channel.
 */
export function refuseWrite(path: string): string | null {
  if (!active) return null
  const below = relativeUnder(active.dumpPath, path)
  if (below === null) return null
  return `${path} is inside the pristine dump, which this project mounts read-only. Saving here would change the game's own files; edits belong in the mod folder (${active.modPath}).`
}
