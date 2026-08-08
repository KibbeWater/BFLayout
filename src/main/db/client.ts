import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Effect } from 'effect'

import { DbError } from '@main/errors'
import { Paths } from '@main/services/paths'
import * as schema from './schema'

export type AppDatabase = BetterSQLite3Database<typeof schema>

/** Wraps a synchronous better-sqlite3 call as a typed Effect failure. */
/**
 * Wraps a synchronous better-sqlite3 call into a typed failure. `what` names the
 * operation, so a DB_ERROR reaching the UI says which one failed rather than just
 * quoting sqlite.
 */
export const dbTry = <A>(what: string, f: () => A): Effect.Effect<A, DbError> =>
  Effect.try({
    try: f,
    catch: (cause) =>
      new DbError({
        detail: `could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })

export class Db extends Effect.Service<Db>()('Db', {
  scoped: Effect.gen(function* () {
    const paths = yield* Paths

    const sqlite = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          mkdirSync(paths.userData, { recursive: true })
          return new Database(join(paths.userData, 'bflayout.db'))
        },
        catch: (cause) =>
          new DbError({
            detail: `could not open database: ${cause instanceof Error ? cause.message : String(cause)}`
          })
      }),
      (handle) => Effect.sync(() => handle.close())
    )

    yield* dbTry('enable write-ahead logging', () => sqlite.pragma('journal_mode = WAL'))

    const db = drizzle(sqlite, { schema })

    yield* Effect.try({
      try: () => migrate(db, { migrationsFolder: paths.migrations }),
      catch: (cause) =>
        new DbError({
          detail: `migration failed: ${cause instanceof Error ? cause.message : String(cause)}`
        })
    })

    return { db }
  })
}) {}
