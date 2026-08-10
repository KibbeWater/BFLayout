import { mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

import type {
  ModLayerStatus,
  ModProject,
  ModProjectInput,
  ModProjectSettings
} from '@shared/contract'
import { modProjectSettingsSchema } from '@shared/contract'
import { Db, dbTry } from '@main/db/client'
import { projects } from '@main/db/schema'
import { DbError, IoError, NotFoundError } from '@main/errors'
import { setZstdLevel } from '@main/compression-level'
import { layerConflict, setActiveLayer, type ModLayer } from '@main/mod-layer'
import { setExcludedNames, walkFiles } from '@main/walk'

/**
 * Mod projects — the thing that turns a file editor into a modding tool.
 *
 * Everything else in the feature hangs off the active project: saves redirect out
 * of its dump and into its layer, the browser merges the two trees, validation and
 * packaging read the layer, and deploy copies it. So this service owns one piece
 * of process-wide state beyond the database — the active layer in `mod-layer.ts` —
 * and is careful to keep the two in step: every path that changes which project is
 * active pushes the result there, including the failure paths.
 */

/**
 * Settings are validated per field, not as one object.
 *
 * A blob written by an older build is missing whatever was added since, and a
 * single unparseable value must not reset every other setting to its default —
 * the same rule the app's own settings follow.
 */
function readSettings(stored: string): ModProjectSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    parsed = {}
  }
  const source = (parsed ?? {}) as Record<string, unknown>

  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(modProjectSettingsSchema.shape)) {
    const candidate = field.safeParse(source[key])
    out[key] = candidate.success ? candidate.data : field.parse(undefined)
  }
  return out as ModProjectSettings
}

const row = (record: typeof projects.$inferSelect): ModProject => ({
  id: record.id,
  name: record.name,
  dumpPath: record.dumpPath,
  modPath: record.modPath,
  titleId: record.titleId,
  modName: record.modName,
  gameVersion: record.gameVersion,
  settings: readSettings(record.settings),
  active: record.active,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt
})

const layerOf = (project: ModProject): ModLayer => ({
  dumpPath: project.dumpPath,
  modPath: project.modPath
})

export class ProjectService extends Effect.Service<ProjectService>()('ProjectService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db

    const list: Effect.Effect<ModProject[], DbError> = dbTry('list mod projects', () =>
      db.select().from(projects).all().map(row)
    )

    const active: Effect.Effect<ModProject | null, DbError> = dbTry(
      'read the active mod project',
      () => {
        const found = db.select().from(projects).where(eq(projects.active, true)).all()[0]
        return found ? row(found) : null
      }
    )

    /**
     * Republishes the active project into the process-wide layer.
     *
     * Called after every mutation rather than only after `setActive`, because
     * editing a project's paths while it is active changes where saves land — and
     * a stale layer would keep redirecting writes to the old mod folder, which
     * looks exactly like edits silently going nowhere.
     */
    const syncLayer: Effect.Effect<ModProject | null, DbError> = Effect.tap(active, (project) =>
      Effect.sync(() => {
        setActiveLayer(project ? layerOf(project) : null)
        /*
         * Published alongside the layer for the same reason: what counts as part
         * of the mod is a property of the project, and every walk of the layer —
         * status, check, diff, deploy, package — has to agree about it.
         */
        setExcludedNames(project?.settings.excludedFiles ?? ['README.md'])
        setZstdLevel(project?.settings.zstdLevel ?? 17)
      })
    )

    const get = (id: number): Effect.Effect<ModProject, DbError | NotFoundError> =>
      Effect.gen(function* () {
        const found = yield* dbTry('read a mod project', () =>
          db.select().from(projects).where(eq(projects.id, id)).all()[0]
        )
        if (!found) {
          return yield* Effect.fail(new NotFoundError({ kind: 'mod project', id: String(id) }))
        }
        return row(found)
      })

    /**
     * Both paths are checked before anything is written.
     *
     * A dump that does not exist is a typo, and a mod folder nested inside the
     * dump would make every save a refused write into the pristine copy — see
     * `layerConflict`. Catching them here means the project cannot be created in
     * a state where saving is impossible, which is a much better place to find
     * out than the first time someone tries to save.
     */
    const create = (
      input: ModProjectInput
    ): Effect.Effect<ModProject, DbError | IoError | NotFoundError> =>
      Effect.gen(function* () {
        const dumpPath = resolve(input.dumpPath)
        const modPath = resolve(input.modPath)

        const dumpExists = yield* Effect.tryPromise({
          try: async () => (await stat(dumpPath)).isDirectory(),
          catch: () => new IoError({ path: dumpPath, detail: 'could not be read' })
        }).pipe(Effect.orElseSucceed(() => false))
        if (!dumpExists) {
          return yield* Effect.fail(
            new IoError({
              path: dumpPath,
              detail: `${dumpPath} is not a folder this app can read; point the project at an extracted romfs directory`
            })
          )
        }

        const conflict = layerConflict({ dumpPath, modPath })
        if (conflict !== null) {
          return yield* Effect.fail(new IoError({ path: modPath, detail: conflict }))
        }

        /*
         * The mod folder is created rather than required to exist.
         *
         * Naming where a mod should go is the user's decision; making the directory
         * is not a surprise that needs asking about. Refusing here instead would
         * mean the first thing a new project asks you to do is go and make an empty
         * folder in Finder — and the failure people actually make is pointing at a
         * *file*, which is worth catching.
         */
        const modKind = yield* Effect.tryPromise({
          try: async () => ((await stat(modPath)).isDirectory() ? 'directory' : 'file'),
          catch: () => new IoError({ detail: 'stat failed' })
        }).pipe(Effect.orElseSucceed(() => 'missing' as const))

        if (modKind === 'file') {
          return yield* Effect.fail(
            new IoError({
              path: modPath,
              detail: `${modPath} is a file. The mod folder is a directory the edited copies are written into.`
            })
          )
        }
        if (modKind === 'missing') {
          yield* Effect.tryPromise({
            try: () => mkdir(modPath, { recursive: true }),
            catch: (cause) =>
              new IoError({
                path: modPath,
                detail: `could not create ${modPath}: ${cause instanceof Error ? cause.message : String(cause)}`
              })
          })
        }

        /*
         * A second project over the same mod folder is refused by name rather than
         * by sqlite. The unique index would otherwise surface as "UNIQUE constraint
         * failed: projects.mod_path", which is true, unreadable, and does not
         * mention the project already using it.
         */
        const clash = yield* dbTry('check for an existing project', () =>
          db.select().from(projects).where(eq(projects.modPath, modPath)).all()[0]
        )
        if (clash) {
          return yield* Effect.fail(
            new IoError({
              path: modPath,
              detail: `“${clash.name}” already builds into ${modPath}. Open that project instead, or choose a different mod folder.`
            })
          )
        }

        const now = Date.now()
        const created = yield* dbTry('create a mod project', () =>
          db
            .insert(projects)
            .values({
              name: input.name,
              dumpPath,
              modPath,
              titleId: input.titleId,
              modName: input.modName,
              gameVersion: input.gameVersion,
              settings: JSON.stringify(modProjectSettingsSchema.parse(input.settings ?? {})),
              active: false,
              createdAt: now,
              updatedAt: now
            })
            .returning()
            .all()[0]!
        )
        return row(created)
      })

    const update = (
      id: number,
      patch: Partial<ModProjectInput>
    ): Effect.Effect<ModProject, DbError | IoError | NotFoundError> =>
      Effect.gen(function* () {
        const existing = yield* get(id)
        const dumpPath = resolve(patch.dumpPath ?? existing.dumpPath)
        const modPath = resolve(patch.modPath ?? existing.modPath)

        const conflict = layerConflict({ dumpPath, modPath })
        if (conflict !== null) {
          return yield* Effect.fail(new IoError({ path: modPath, detail: conflict }))
        }

        yield* dbTry('update a mod project', () =>
          db
            .update(projects)
            .set({
              name: patch.name ?? existing.name,
              dumpPath,
              modPath,
              titleId: patch.titleId ?? existing.titleId,
              modName: patch.modName ?? existing.modName,
              gameVersion: patch.gameVersion ?? existing.gameVersion,
              // Merged, not replaced: a caller changing one setting must not
              // silently reset the others to their defaults.
              settings: JSON.stringify({ ...existing.settings, ...(patch.settings ?? {}) }),
              updatedAt: Date.now()
            })
            .where(eq(projects.id, id))
            .run()
        )
        yield* syncLayer
        return yield* get(id)
      })

    /**
     * Makes one project active, or none.
     *
     * Clearing every other row in the same transaction is what keeps "at most one
     * active" true; doing it in two statements would leave a window where two
     * projects both claim the layer, and whichever `active` read won would decide
     * where someone's next save landed.
     */
    const setActive = (
      id: number | null
    ): Effect.Effect<ModProject | null, DbError | NotFoundError> =>
      Effect.gen(function* () {
        if (id !== null) yield* get(id)

        yield* dbTry('activate a mod project', () =>
          db.transaction((tx) => {
            tx.update(projects).set({ active: false }).run()
            if (id !== null) {
              tx.update(projects).set({ active: true }).where(eq(projects.id, id)).run()
            }
          })
        )
        return yield* syncLayer
      })

    const remove = (id: number): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        yield* dbTry('delete a mod project', () =>
          db.delete(projects).where(eq(projects.id, id)).run()
        )
        // Deleting the active project has to release the layer, or the dump stays
        // mounted read-only against a project that no longer exists.
        yield* syncLayer
      })

    /**
     * Everything the mod layer holds, with each file marked as a replacement or an
     * addition.
     *
     * The distinction is the one a modder needs: a replacement is only as good as
     * the pristine file it shadows (rename the original upstream and the mod stops
     * applying), while an addition is a file the game will only load if something
     * else references it.
     */
    const status: Effect.Effect<ModLayerStatus, DbError> = Effect.gen(function* () {
      const project = yield* active
      if (!project) return { project: null, files: [], totalBytes: 0 }

      const found = yield* Effect.orElseSucceed(walkFiles(project.modPath), () => [])
      const files: ModLayerStatus['files'] = []
      let totalBytes = 0
      for (const file of found) {
        const pristine = yield* Effect.tryPromise({
          try: async () => (await stat(join(project.dumpPath, file.relativePath))).isFile(),
          catch: () => new IoError({ detail: 'stat failed' })
        }).pipe(Effect.orElseSucceed(() => false))

        totalBytes += file.size
        files.push({
          relativePath: file.relativePath,
          size: file.size,
          modifiedAt: file.modifiedAt,
          replacesPristine: pristine
        })
      }

      files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      return { project, files, totalBytes }
    })

    /**
     * Drops one file from the mod layer, so the dump's own copy applies again.
     *
     * Deleting the file *is* the revert — that is the whole appeal of building a
     * mod as a layer, and it is why this cannot be done by copying the pristine
     * bytes back over the mod's copy: a mod that ships a byte-identical file still
     * shadows the original, and would keep shadowing it after a game update
     * changed the real one.
     *
     * Refuses to leave a hole: a file the mod *added* has no pristine copy to fall
     * back to, so reverting it deletes content outright. That is still the right
     * operation, but the caller is told which of the two happened.
     */
    const revert = (
      relativePath: string
    ): Effect.Effect<
      { relativePath: string; hadPristine: boolean },
      DbError | IoError | NotFoundError
    > =>
      Effect.gen(function* () {
        const project = yield* active
        if (!project) {
          return yield* Effect.fail(new NotFoundError({ kind: 'active mod project', id: '' }))
        }

        const clean = relativePath.replace(/^[/\\]+/, '')
        if (clean === '' || clean.split(/[/\\]/).includes('..')) {
          return yield* Effect.fail(
            new IoError({
              path: relativePath,
              detail: `${relativePath} is not a path inside the mod folder`
            })
          )
        }

        const target = join(project.modPath, clean)

        /*
         * One file at a time, never a directory.
         *
         * A directory in the mod layer is badged like a file is — its presence
         * means there are changes below it — so it is reachable by the same call.
         * Removing one would delete an unbounded amount of someone's work in a
         * single step, and the confirmation they saw named one file. Refused; the
         * files inside can each be reverted.
         */
        const directory = yield* Effect.tryPromise({
          try: async () => (await stat(target)).isDirectory(),
          catch: () => new IoError({ detail: 'stat failed' })
        }).pipe(Effect.orElseSucceed(() => false))
        if (directory) {
          return yield* Effect.fail(
            new IoError({
              path: target,
              detail: `${clean} is a folder. Revert the files inside it individually — removing a whole folder of mod work in one step is not something this can undo.`
            })
          )
        }

        const hadPristine = yield* Effect.tryPromise({
          try: async () => (await stat(join(project.dumpPath, clean))).isFile(),
          catch: () => new IoError({ detail: 'stat failed' })
        }).pipe(Effect.orElseSucceed(() => false))

        yield* Effect.tryPromise({
          try: () => rm(target, { force: true }),
          catch: (cause) =>
            new IoError({
              path: target,
              detail: cause instanceof Error ? cause.message : String(cause)
            })
        })

        return { relativePath: clean, hadPristine }
      })

    // Restores the layer on boot, so a project that was active when the app closed
    // is active again before the first save can be attempted.
    yield* syncLayer

    return { list, active, get, create, update, setActive, remove, status, revert } as const
  })
}) {}
