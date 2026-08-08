import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { Db, dbTry } from '@main/db/client'
import { workspaces } from '@main/db/schema'
import type { DbError } from '@main/errors'

/**
 * Remembers which files were open so a restart can offer them back.
 *
 * Only *paths* are stored, never document state: the files on disk are the truth,
 * and restoring a stale in-memory copy over a file someone edited elsewhere would
 * be a way to lose work. Restoring therefore re-reads and re-parses.
 *
 * A single row named "last" is upserted rather than a history of sessions, which
 * is all the UI needs.
 */

const LAST_SESSION = 'last'

export interface WorkspaceSnapshot {
  /** Archive paths that were open. */
  readonly archives: string[]
  /** Layouts, as an archive path plus entry key, or a loose file path. */
  readonly layouts: { archivePath?: string; entryKey?: string; filePath?: string }[]
}

const EMPTY: WorkspaceSnapshot = { archives: [], layouts: [] }

export class WorkspaceService extends Effect.Service<WorkspaceService>()('WorkspaceService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db

    const save = (snapshot: WorkspaceSnapshot): Effect.Effect<void, DbError> =>
      dbTry('save the workspace', () => {
        const now = Date.now()
        const payload = JSON.stringify(snapshot)
        const existing = db
          .select()
          .from(workspaces)
          .where(eq(workspaces.name, LAST_SESSION))
          .all()

        if (existing.length > 0) {
          db.update(workspaces)
            .set({ openTabs: payload, updatedAt: now })
            .where(eq(workspaces.name, LAST_SESSION))
            .run()
        } else {
          db.insert(workspaces)
            .values({ name: LAST_SESSION, openTabs: payload, updatedAt: now })
            .run()
        }
      })

    const load: Effect.Effect<WorkspaceSnapshot, DbError> = dbTry('load the workspace', () => {
      const rows = db.select().from(workspaces).where(eq(workspaces.name, LAST_SESSION)).all()
      const row = rows[0]
      if (!row) return EMPTY

      // A corrupt or older-shaped payload must not stop the app from starting;
      // an empty session is a perfectly good fallback.
      try {
        const parsed = JSON.parse(row.openTabs) as Partial<WorkspaceSnapshot>
        return {
          archives: Array.isArray(parsed.archives)
            ? parsed.archives.filter((path): path is string => typeof path === 'string')
            : [],
          layouts: Array.isArray(parsed.layouts) ? parsed.layouts : []
        }
      } catch {
        return EMPTY
      }
    })

    const clear: Effect.Effect<void, DbError> = dbTry('clear the workspace', () => {
      db.delete(workspaces).where(eq(workspaces.name, LAST_SESSION)).run()
    })

    return { save, load, clear } as const
  })
}) {}
