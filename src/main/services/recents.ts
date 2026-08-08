import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { and, asc, desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'

import type { RecentEntry, RecentKind } from '@shared/contract'
import { Db, dbTry } from '@main/db/client'
import * as schema from '@main/db/schema'
import { DbError, FileNotFoundError } from '@main/errors'

/** Unpinned history beyond this count is trimmed on every add. */
const MAX_UNPINNED = 40

export class RecentsService extends Effect.Service<RecentsService>()('RecentsService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db

    const list = dbTry('list recent files', () =>
      db
        .select()
        .from(schema.recentFiles)
        .orderBy(desc(schema.recentFiles.pinned), desc(schema.recentFiles.lastOpenedAt))
        .all()
    ) as Effect.Effect<RecentEntry[], DbError>

    const prune = dbTry('prune the recent-files list', () => {
      const unpinned = db
        .select({ id: schema.recentFiles.id })
        .from(schema.recentFiles)
        .where(eq(schema.recentFiles.pinned, false))
        .orderBy(desc(schema.recentFiles.lastOpenedAt))
        .all()

      for (const row of unpinned.slice(MAX_UNPINNED)) {
        db.delete(schema.recentFiles).where(eq(schema.recentFiles.id, row.id)).run()
      }
    })

    const add = (input: { path: string; kind: RecentKind }) =>
      Effect.gen(function* () {
        const present = yield* Effect.sync(() => existsSync(input.path))
        if (!present) {
          return yield* Effect.fail(new FileNotFoundError({ path: input.path }))
        }

        const now = Date.now()
        const displayName = basename(input.path)

        yield* dbTry('record a recent file', () =>
          db
            .insert(schema.recentFiles)
            .values({
              path: input.path,
              kind: input.kind,
              displayName,
              pinned: false,
              lastOpenedAt: now
            })
            .onConflictDoUpdate({
              target: schema.recentFiles.path,
              set: { kind: input.kind, displayName, lastOpenedAt: now }
            })
            .run()
        )

        yield* prune

        const row = yield* dbTry('read back the recent file', () =>
          db
            .select()
            .from(schema.recentFiles)
            .where(eq(schema.recentFiles.path, input.path))
            .get()
        )

        if (!row) {
          return yield* Effect.fail(
            new DbError({ detail: 'recent entry missing immediately after upsert' })
          )
        }
        return row satisfies RecentEntry
      })

    const setPinned = (input: { id: number; pinned: boolean }) =>
      dbTry('pin a recent file', () =>
        db
          .update(schema.recentFiles)
          .set({ pinned: input.pinned })
          .where(eq(schema.recentFiles.id, input.id))
          .run()
      )

    const remove = (input: { id: number }) =>
      dbTry('remove a recent file', () =>
        db.delete(schema.recentFiles).where(eq(schema.recentFiles.id, input.id)).run()
      )

    /** Clears history but keeps pinned entries — matches how editors behave. */
    const clear = dbTry('clear recent files', () =>
      db.delete(schema.recentFiles).where(eq(schema.recentFiles.pinned, false)).run()
    )

    /** Drops entries whose file has since been deleted or moved. */
    const pruneMissing = Effect.gen(function* () {
      const rows = yield* dbTry('list recent files to prune', () =>
        db
          .select({ id: schema.recentFiles.id, path: schema.recentFiles.path })
          .from(schema.recentFiles)
          .orderBy(asc(schema.recentFiles.id))
          .all()
      )
      const missing = rows.filter((row) => !existsSync(row.path))
      if (missing.length === 0) return
      yield* dbTry('remove missing recent files', () => {
        for (const row of missing) {
          db
            .delete(schema.recentFiles)
            .where(and(eq(schema.recentFiles.id, row.id), eq(schema.recentFiles.pinned, false)))
            .run()
        }
      })
    })

    return { list, add, setPinned, remove, clear, pruneMissing } as const
  })
}) {}
