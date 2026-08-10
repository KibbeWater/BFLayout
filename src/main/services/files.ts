import { mkdir, readdir, readFile, stat, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'

import { FileNotFoundError, IoError, ReadOnlyError } from '@main/errors'
import { refuseWrite } from '@main/mod-layer'

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isMissing(cause: unknown): boolean {
  return (cause as { code?: string } | null)?.code === 'ENOENT'
}

export class FilesService extends Effect.Service<FilesService>()('FilesService', {
  sync: () => {
    const read = (path: string): Effect.Effect<Uint8Array, FileNotFoundError | IoError> =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await readFile(path)),
        catch: (cause) =>
          isMissing(cause)
            ? new FileNotFoundError({ path })
            : new IoError({ path, detail: describe(cause) })
      })

    /**
     * Writes via a temporary file in the same directory then renames, so an
     * interrupted save cannot leave a half-written layout where the original was.
     *
     * Every write in the app funnels through here, which is why the read-only
     * check lives here too. Callers that save into a mod project have already
     * redirected their destination out of the pristine dump (`resolveWrite`), so
     * this refusal should never fire — it is the backstop that makes "the dump is
     * read-only" a fact about the process rather than a convention each caller
     * has to remember.
     *
     * The parent directory is created because a redirected write is usually the
     * first thing the mod layer has ever held at that path.
     */
    const writeAtomic = (
      path: string,
      data: Uint8Array
    ): Effect.Effect<void, IoError | ReadOnlyError> =>
      Effect.gen(function* () {
        const refusal = refuseWrite(path)
        if (refusal !== null) {
          return yield* Effect.fail(new ReadOnlyError({ path, detail: refusal }))
        }

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            const temp = join(dirname(path), `.${Date.now().toString(36)}.bflayout.tmp`)
            try {
              await writeFile(temp, data)
              await rename(temp, path)
            } catch (cause) {
              throw cause instanceof Error ? cause : new Error(String(cause))
            }
          },
          catch: (cause) => new IoError({ path, detail: describe(cause) })
        })
      })

    const exists = (path: string): Effect.Effect<boolean> =>
      Effect.tryPromise({
        try: async () => {
          await stat(path)
          return true
        },
        catch: () => new IoError({ path, detail: 'stat failed' })
      }).pipe(Effect.orElseSucceed(() => false))

    const size = (path: string): Effect.Effect<number, FileNotFoundError | IoError> =>
      Effect.tryPromise({
        try: async () => (await stat(path)).size,
        catch: (cause) =>
          isMissing(cause)
            ? new FileNotFoundError({ path })
            : new IoError({ path, detail: describe(cause) })
      })

    /**
     * File names directly inside `path`. A directory that cannot be read yields
     * an empty list rather than failing: callers use this to *discover* optional
     * siblings, and a missing folder simply means there is nothing to find.
     */
    const listDir = (path: string): Effect.Effect<string[]> =>
      Effect.tryPromise({
        try: async () => {
          const entries = await readdir(path, { withFileTypes: true })
          return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
        },
        catch: (cause) => new IoError({ path, detail: describe(cause) })
      }).pipe(Effect.orElseSucceed((): string[] => []))

    return { read, writeAtomic, exists, size, listDir } as const
  }
}) {}
