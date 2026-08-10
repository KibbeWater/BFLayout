import { readdir, stat } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'
import { Effect } from 'effect'

import { IoError } from '@main/errors'

export interface WalkedFile {
  /** Path below the walk root, always with forward slashes. */
  readonly relativePath: string
  readonly absolutePath: string
  readonly size: number
  readonly modifiedAt: number
}

/**
 * Every file below `root`, depth first.
 *
 * The folder browser deliberately never does this — a romfs is tens of thousands
 * of files and listing it up front would stall the app. A *mod layer* is the
 * opposite: it is the handful of files someone has actually changed, and every
 * operation on it (status, validate, package, deploy) needs the whole set. So the
 * full walk lives here, separate from `FolderService`, and is only ever pointed at
 * the layer.
 *
 * Relative paths are normalised to forward slashes because they are used as keys
 * against the dump, as entry names inside a release zip, and in manifests that
 * have to mean the same thing on another machine.
 */
/**
 * Names that live in a mod folder but are not part of the mod.
 *
 * A romfs overlay is a mirror of the game's own tree, so anything in it is a file
 * the game will be handed. Documentation is the one thing people reliably put
 * there anyway — Colony's `romfs/README.md` explains the overlay to whoever opens
 * the repo — and its own deploy excludes exactly this, so matching that is what
 * keeps the two tools agreeing about what the mod contains.
 */
let excluded = new Set(['readme.md'])

/**
 * What the active project says is not part of its mod.
 *
 * Module-level for the same reason the read-only layer is: every walk of the mod
 * has to agree about it, and threading a project through `status`, `check`,
 * `diff`, `deploy` and `package` would be five chances for one of them to
 * disagree. `ProjectService` publishes it whenever the active project changes.
 */
export function setExcludedNames(names: readonly string[]): void {
  excluded = new Set(names.map((name) => name.toLowerCase()))
}

export function walkFiles(root: string): Effect.Effect<WalkedFile[], IoError> {
  return Effect.tryPromise({
    try: async () => {
      const found: WalkedFile[] = []

      const visit = async (directory: string, prefix: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
          // Dotfiles are the app's own temp files and the OS's metadata; neither
          // belongs in a mod.
          if (entry.name.startsWith('.')) continue
          if (excluded.has(entry.name.toLowerCase())) continue
          const absolutePath = join(directory, entry.name)
          const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name

          if (entry.isDirectory()) {
            await visit(absolutePath, relativePath)
            continue
          }
          if (!entry.isFile()) continue

          const info = await stat(absolutePath)
          found.push({
            relativePath,
            absolutePath,
            size: info.size,
            modifiedAt: Math.trunc(info.mtimeMs)
          })
        }
      }

      await visit(root, '')
      return found
    },
    catch: (cause) =>
      new IoError({
        path: root,
        detail: cause instanceof Error ? cause.message : String(cause)
      })
  })
}

/** A relative path in the form `walkFiles` produces, from a native one. */
export function toPosixRelative(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}
