import { statSync } from 'node:fs'
import { desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'

import type { LayoutDocument } from '@shared/formats/bflyt'
import {
  parseSnapshotKey,
  snapshotKeyPath,
  type DurableLayoutSource,
  type SnapshotSummary
} from '@shared/contract'
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
 * Keyed by the *durable* identity of the file rather than by document id; see
 * `snapshot-key.ts` for why that distinction is the whole design. Writes are
 * best-effort: a failure here must never interrupt editing, so callers log and carry on.
 */

export interface SnapshotRecord {
  readonly key: string
  readonly displayName: string
  readonly document: LayoutDocument
  readonly updatedAt: number
}

export class SnapshotService extends Effect.Service<SnapshotService>()('SnapshotService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db

    const put = (record: {
      key: string
      displayName: string
      document: LayoutDocument
    }): Effect.Effect<void, DbError> =>
      dbTry('write a recovery snapshot', () => {
        const row = {
          key: record.key,
          displayName: record.displayName,
          document: JSON.stringify(record.document),
          updatedAt: Date.now()
        }
        // Upsert on the primary key, so re-snapshotting replaces rather than appends.
        db.insert(snapshots)
          .values(row)
          .onConflictDoUpdate({
            target: snapshots.key,
            set: {
              displayName: row.displayName,
              document: row.document,
              updatedAt: row.updatedAt
            }
          })
          .run()
      })

    /**
     * Summaries only — the documents themselves are megabytes, and the welcome screen
     * needs a name, a time and somewhere to point.
     *
     * Each row is stat'd so the offer can say whether the file has moved on since the
     * snapshot was taken. Restoring hours-old edits over a file someone has since
     * changed elsewhere is the one way this feature could itself destroy work, and the
     * user is the only one who can judge it — so the answer is surfaced, not guessed at.
     */
    const list = (): Effect.Effect<SnapshotSummary[], DbError> =>
      dbTry('list recovery snapshots', () => {
        const rows = db
          .select({
            key: snapshots.key,
            displayName: snapshots.displayName,
            updatedAt: snapshots.updatedAt
          })
          .from(snapshots)
          .orderBy(desc(snapshots.updatedAt))
          .all()

        return rows.flatMap((row) => {
          const source = parseSnapshotKey(row.key)
          // A key this build cannot read names nothing reopenable, so it is not offered.
          if (!source) return []
          return [
            {
              key: row.key,
              displayName: row.displayName,
              source,
              updatedAt: row.updatedAt,
              sourceModifiedAt: modifiedAt(source)
            }
          ]
        })
      })

    const get = (key: string): Effect.Effect<SnapshotRecord | null, DbError> =>
      dbTry('read a recovery snapshot', () => {
        const row = db.select().from(snapshots).where(eq(snapshots.key, key)).get()
        if (!row) return null

        let document: LayoutDocument
        try {
          document = JSON.parse(row.document) as LayoutDocument
        } catch {
          // Half-written JSON is not recoverable; treat it as no snapshot.
          return null
        }

        return {
          key: row.key,
          displayName: row.displayName,
          document,
          updatedAt: row.updatedAt
        }
      })

    const remove = (key: string): Effect.Effect<void, DbError> =>
      dbTry('discard a recovery snapshot', () => {
        db.delete(snapshots).where(eq(snapshots.key, key)).run()
      })

    const clear = (): Effect.Effect<void, DbError> =>
      dbTry('discard every recovery snapshot', () => {
        db.delete(snapshots).run()
      })

    return { put, list, get, remove, clear } as const
  })
}) {}

/**
 * Last-written time of the file a snapshot came from, or null if it is not there any
 * more. A missing file is not an error here — a snapshot for something that has since
 * been moved or deleted is still worth offering, it just cannot be reopened.
 */
function modifiedAt(source: DurableLayoutSource): number | null {
  try {
    return Math.round(statSync(snapshotKeyPath(source)).mtimeMs)
  } catch {
    return null
  }
}
