import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Effect } from 'effect'

import { isBflan } from '@shared/formats/bflan'
import { isBflyt } from '@shared/formats/bflyt'
import { isBntx } from '@shared/formats/bntx'
import { isSarc } from '@shared/formats/sarc'
import { detectCompression } from '@shared/formats/compression'
import type { FolderEntry, FolderEntryKind, FolderListing } from '@shared/contract'
import { FileNotFoundError, IoError } from '@main/errors'
import { CompressionService } from './compression'
import { FilesService } from './files'

/**
 * Browses a folder on disk — a dumped romfs, in practice.
 *
 * Listings are per-directory. A romfs dump is tens of thousands of files across a
 * deep tree, and walking it up front would stall the app before showing anything;
 * one `readdir` per directory keeps navigation instant however large the dump is.
 *
 * Sizes come from `stat` per entry, which is the one unavoidable cost. Directories
 * are reported with size 0 rather than being measured, because summing a subtree
 * means walking it — exactly what this avoids.
 */

/**
 * Extension to kind. Modern titles double up extensions (`.blarc.zs`), so the
 * outer compression suffix is stripped before matching.
 */
function classify(name: string, isDirectory: boolean): FolderEntryKind {
  if (isDirectory) return 'directory'

  const lower = name.toLowerCase()
  // Modern titles stack suffixes: Foo.Nin_NX_NVN.blarc.zs. Strip the compression
  // suffix and read the extension left of it; the platform tag in the middle is
  // irrelevant because extname only looks at the last dot.
  const withoutCompression = lower.endsWith('.zs') ? lower.slice(0, -3) : lower
  const extension = extname(withoutCompression)

  switch (extension) {
    case '.bflyt':
      return 'layout'
    case '.bflan':
      return 'animation'
    case '.bntx':
      return 'texture'
    case '.bffnt':
      return 'font'
    // Layout and font archives are called out separately: in a romfs they are the
    // difference between "this is what I came here for" and "this is 60,000 other
    // files", and one icon for every container hides that.
    case '.blarc':
    case '.lyarc':
      return 'layoutArchive'
    case '.bfarc':
      return 'fontArchive'
    case '.szs':
    case '.sarc':
    case '.arc':
    case '.pack':
    case '.zs':
      return 'archive'
    case '.byml':
    case '.bgyml':
      return 'byml'
    case '.bfres':
    case '.bnsh':
    case '.bushvt':
      return 'model'
    case '.bwav':
    case '.bars':
    case '.bfsar':
      return 'audio'
    case '.txt':
    case '.csv':
    case '.json':
      return 'text'
    default:
      return 'other'
  }
}

/** True when the name carries an outer compression suffix. */
function isCompressed(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.zs') || lower.endsWith('.szs')
}

export class FolderService extends Effect.Service<FolderService>()('FolderService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const compression = yield* CompressionService

    const list = (
      path: string
    ): Effect.Effect<FolderListing, FileNotFoundError | IoError> =>
      Effect.gen(function* () {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(path, { withFileTypes: true }),
          catch: (cause) =>
            (cause as { code?: string }).code === 'ENOENT'
              ? new FileNotFoundError({ path })
              : new IoError({
                  path,
                  detail: cause instanceof Error ? cause.message : String(cause)
                })
        })

        const described: FolderEntry[] = []
        for (const entry of entries) {
          // Dotfiles are noise in a game dump and hide nothing useful.
          if (entry.name.startsWith('.')) continue
          const full = join(path, entry.name)
          const directory = entry.isDirectory()

          // A file that cannot be stat'd (a broken symlink, say) is still listed;
          // dropping it silently would make the folder look emptier than it is.
          const size = directory
            ? 0
            : yield* Effect.orElseSucceed(
                Effect.tryPromise({
                  try: () => stat(full),
                  catch: () => new IoError({ path: full, detail: 'stat failed' })
                }),
                () => ({ size: 0 })
              ).pipe(Effect.map((info) => info.size))

          described.push({
            name: entry.name,
            path: full,
            kind: classify(entry.name, directory),
            size,
            compressed: !directory && isCompressed(entry.name)
          })
        }

        // Directories first, then by name — the ordering people expect from a
        // file browser, and it keeps deep dumps navigable.
        described.sort((a, b) => {
          if (a.kind === 'directory' !== (b.kind === 'directory')) {
            return a.kind === 'directory' ? -1 : 1
          }
          return a.name.localeCompare(b.name, undefined, { numeric: true })
        })

        const parent = dirname(path)
        return { path, parent: parent === path ? null : parent, entries: described }
      })

    /**
     * Sniffs what a file actually is, decompressing first when needed.
     *
     * Extensions in a romfs are only a hint — `.blarc.zs` is a ZSTD-compressed
     * SARC, and plenty of files carry names this build has never seen. Reading the
     * magic is the only reliable answer, and it is what decides whether the editor
     * offers to open the file.
     */
    const identify = (
      path: string
    ): Effect.Effect<
      {
        path: string
        format: string
        compression: 'none' | 'yaz0' | 'zstd'
        opensAs: 'archive' | 'layout' | 'animation' | 'texture' | 'byml' | 'none'
        detail: string
      },
      FileNotFoundError | IoError
    > =>
      Effect.gen(function* () {
        const raw = yield* files.read(path)
        const outer = detectCompression(raw)

        const decompressed = yield* Effect.orElseSucceed(compression.decompress(raw), () => ({
          data: raw,
          kind: 'none' as const
        }))
        const data = decompressed.data

        const name = basename(path)
        type Identified = {
          path: string
          format: string
          compression: 'none' | 'yaz0' | 'zstd'
          opensAs: 'archive' | 'layout' | 'animation' | 'texture' | 'byml' | 'none'
          detail: string
        }
        const label = (
          format: string,
          opensAs: Identified['opensAs'],
          detail: string
        ): Identified => ({ path, format, compression: decompressed.kind, opensAs, detail })
        let result: Identified

        if (isSarc(data)) {
          result = label('SARC', 'archive', `${name} is a SARC archive`)
        } else if (isBflyt(data)) {
          result = label('BFLYT', 'layout', `${name} is a layout`)
        } else if (isBflan(data)) {
          result = label('BFLAN', 'animation', `${name} is an animation`)
        } else if (isBntx(data)) {
          result = label('BNTX', 'texture', `${name} is a texture container`)
        } else if (isByml(data)) {
          result = label('BYML', 'byml', `${name} is a BYML document`)
        } else {
          const magic = [...data.slice(0, 4)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(' ')
          result = label(
            'unknown',
            'none',
            `${name} starts with ${magic}, which this build does not recognise`
          )
        }

        // Report the outer compression even when decompression failed, so the UI
        // can say "ZSTD, but unreadable" rather than just "unknown".
        return { ...result, compression: decompressed.kind === 'none' ? outerKind(outer) : decompressed.kind }
      })

    return { list, identify } as const
  })
}) {}

function outerKind(kind: string): 'none' | 'yaz0' | 'zstd' {
  return kind === 'yaz0' || kind === 'zstd' ? kind : 'none'
}

/** BYML magic: "BY" or "YB", then a 16-bit version. */
function isByml(data: Uint8Array): boolean {
  if (data.length < 4) return false
  const big = data[0] === 0x42 && data[1] === 0x59
  const little = data[0] === 0x59 && data[1] === 0x42
  return big || little
}
