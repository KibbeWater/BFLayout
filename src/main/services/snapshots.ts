import { desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'

import type { LayoutDocument } from '@shared/formats/bflyt'
import type { LayoutSource } from '@shared/contract'
import { Db, dbTry } from '@main/db/client'
import { snapshots } from '@main/db/schema'
import type { DbError } from '@main/errors'

/**
 * Crash-recovery snapshots of unsaved documents.
 *
 * The close and quit prompts cover a *deliberate* exit. A crash, a killed process or a
 * power cut still lost everything since the last save, which for an editor whose whole
 * value is careful edits to game files is the remaining way to lose work.
 *
 * What is stored is the document's own JSON, not encoded layout bytes. The point is to
 * restore the editing state exactly — including a document the writer would currently
 * refuse to encode — and re-encoding on a timer would also pay the whole serialisation
 * cost every few seconds.
 *
 * Keyed by document id, so a file being edited replaces its own snapshot rather than
 * accumulating them. Writes are best-effort by design: a failure here must never
 * interrupt editing, so callers log and carry on.
 */

export interface SnapshotRecord {
  readonly documentId: string
  readonly displayName: string
  readonly source: LayoutSource
  readonly document: LayoutDocument
  readonly updatedAt: number
}

export interface SnapshotSummary {
  readonly documentId: string
  readonly displayName: string
  readonly source: LayoutSource
  readonly updatedAt: number
}

export class SnapshotService extends Effect.Service<SnapshotService>()('SnapshotService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db

    const put = (record: {
      documentId: string
      displayName: string
      source: LayoutSource
      document: LayoutDocument
    }): Effect.Effect<void, DbError> =>
      dbTry('write a recovery snapshot', () => {
        const row = {
          documentId: record.documentId,
          displayName: record.displayName,
          source: JSON.stringify(record.source),
          document: JSON.stringify(record.document),
          updatedAt: Date.now()
        }
        // Upsert on the primary key, so re-snapshotting replaces rather than appends.
        db.insert(snapshots)
          .values(row)
          .onConflictDoUpdate({
            target: snapshots.documentId,
            set: {
              displayName: row.displayName,
              source: row.source,
              document: row.document,
              updatedAt: row.updatedAt
            }
          })
          .run()
      })

    /**
     * Summaries only — the documents themselves are megabytes, and the welcome screen
     * needs a name and a time to offer them.
     */
    const list = (): Effect.Effect<SnapshotSummary[], DbError> =>
      dbTry('list recovery snapshots', () => {
        const rows = db
          .select({
            documentId: snapshots.documentId,
            displayName: snapshots.displayName,
            source: snapshots.source,
            updatedAt: snapshots.updatedAt
          })
          .from(snapshots)
          .orderBy(desc(snapshots.updatedAt))
          .all()

        return rows.flatMap((row) => {
          const source = parseSource(row.source)
          // A row whose source will not parse cannot be reopened, so it is not offered.
          if (!source) return []
          return [
            {
              documentId: row.documentId,
              displayName: row.displayName,
              source,
              updatedAt: row.updatedAt
            }
          ]
        })
      })

    const get = (documentId: string): Effect.Effect<SnapshotRecord | null, DbError> =>
      dbTry('read a recovery snapshot', () => {
        const row = db
          .select()
          .from(snapshots)
          .where(eq(snapshots.documentId, documentId))
          .get()
        if (!row) return null

        const source = parseSource(row.source)
        if (!source) return null

        let document: LayoutDocument
        try {
          document = JSON.parse(row.document) as LayoutDocument
        } catch {
          // Half-written JSON is not recoverable; treat it as no snapshot.
          return null
        }

        return {
          documentId: row.documentId,
          displayName: row.displayName,
          source,
          document,
          updatedAt: row.updatedAt
        }
      })

    const remove = (documentId: string): Effect.Effect<void, DbError> =>
      dbTry('discard a recovery snapshot', () => {
        db.delete(snapshots).where(eq(snapshots.documentId, documentId)).run()
      })

    const clear = (): Effect.Effect<void, DbError> =>
      dbTry('discard every recovery snapshot', () => {
        db.delete(snapshots).run()
      })

    return { put, list, get, remove, clear } as const
  })
}) {}

function parseSource(raw: string): LayoutSource | null {
  try {
    const parsed = JSON.parse(raw) as LayoutSource
    return parsed && typeof parsed === 'object' && 'kind' in parsed ? parsed : null
  } catch {
    return null
  }
}
