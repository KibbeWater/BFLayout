import { join, posix, resolve } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'

import type { IndexProgress, IndexSearchHit, ReferenceHit } from '@shared/contract'
import { extractFile } from '@shared/mod/symbols'
import { Db, dbTry } from '@main/db/client'
import { indexFiles, indexRuns, indexSymbols } from '@main/db/schema'
import { DbError, IoError, NotFoundError } from '@main/errors'
import { walkFiles, type WalkedFile } from '@main/walk'
import { CompressionService } from './compression'
import { FilesService } from './files'
import { ProjectService } from './projects'

/**
 * A searchable index of everything nameable in a dump.
 *
 * This is the answer to the question that actually costs a modder their day:
 * *where is it*. A romfs is tens of thousands of files with no table of contents,
 * the names that matter live inside binary containers, and browsing cannot find
 * any of them. Reading the whole dump once and writing the names into sqlite
 * turns "which layout has a pane called BtnOk" from an afternoon into a keystroke.
 *
 * Built in the background, because reading a whole dump takes minutes and the app
 * has to stay usable while it happens. Progress is polled rather than pushed: it
 * is one small object, the UI wants it on a timer anyway, and a push channel would
 * be a second thing to keep alive across a build that can outlive a window.
 */

/** Full-text search over symbol names and details. */
const CREATE_FTS = sql`
  CREATE VIRTUAL TABLE IF NOT EXISTS index_search USING fts5(
    name,
    detail,
    symbol_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  )
`

/**
 * Turns whatever someone typed into something FTS5 will accept.
 *
 * FTS5's MATCH syntax is a query language, so a bare search string containing a
 * quote, a hyphen or a bare `AND` is a syntax error rather than a search — which
 * would turn an ordinary search box into a source of errors. Every term is quoted
 * as a phrase, and the last one gets a prefix `*` so results narrow as you type.
 */
export function toMatchQuery(raw: string): string | null {
  const terms = raw.trim().split(/\s+/).filter((term) => term.length > 0)
  if (terms.length === 0) return null

  return terms
    .map((term, at) => {
      const quoted = `"${term.replace(/"/g, '""')}"`
      return at === terms.length - 1 ? `${quoted}*` : quoted
    })
    .join(' ')
}

interface BuildState {
  readonly state: 'idle' | 'building' | 'ready' | 'failed'
  readonly rootPath: string | null
  readonly done: number
  readonly total: number
  readonly currentFile: string | null
  readonly detail: string | null
}

const IDLE: BuildState = {
  state: 'idle',
  rootPath: null,
  done: 0,
  total: 0,
  currentFile: null,
  detail: null
}

export class IndexService extends Effect.Service<IndexService>()('IndexService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db
    const files = yield* FilesService
    const compression = yield* CompressionService
    const projects = yield* ProjectService

    yield* dbTry('create the search index', () => db.run(CREATE_FTS))

    /**
     * One folder's files, with paths relative to the *index root*.
     *
     * `walkFiles` reports relative to whatever it was pointed at, so a scoped walk
     * of `<dump>/Layout` would produce `Menu.szs` where the rest of the index
     * expects `Layout/Menu.szs` — and every path in it would be wrong in a way
     * that only shows up when something tries to open one.
     */
    const collect = async (root: string, prefix: string): Promise<WalkedFile[]> => {
      const found = await Effect.runPromise(
        Effect.orElseSucceed(walkFiles(root), (): WalkedFile[] => [])
      )
      if (prefix === '') return found
      return found.map((file) => ({
        ...file,
        relativePath: posix.join(prefix.split(/[\\/]/).join('/'), file.relativePath)
      }))
    }

    let build: BuildState = IDLE
    /** Set while a build is running, so a second request can be refused rather than racing it. */
    let running = false

    const status: Effect.Effect<IndexProgress, DbError> = Effect.gen(function* () {
      const runs = yield* dbTry('read index runs', () => db.select().from(indexRuns).all())
      return {
        state: build.state,
        rootPath: build.rootPath,
        done: build.done,
        total: build.total,
        currentFile: build.currentFile,
        detail: build.detail,
        indexed: runs.map((run) => ({
          rootPath: run.rootPath,
          builtAt: run.builtAt,
          fileCount: run.fileCount,
          symbolCount: run.symbolCount
        }))
      }
    })

    const runIdFor = (rootPath: string): Effect.Effect<number, DbError | NotFoundError> =>
      Effect.gen(function* () {
        const found = yield* dbTry('find the index', () =>
          db.select().from(indexRuns).where(eq(indexRuns.rootPath, rootPath)).all()[0]
        )
        if (!found) {
          return yield* Effect.fail(
            new NotFoundError({ kind: 'index', id: `${rootPath} has not been indexed yet` })
          )
        }
        return found.id
      })

    /**
     * Reads every file under `rootPath` and writes what it finds.
     *
     * Rows are replaced wholesale rather than diffed. A dump does not change —
     * that is the entire premise of a mod project — so an incremental index would
     * be complexity in service of a case that does not arise, and a stale row is
     * far worse than a rebuild: it sends someone to a file that no longer says
     * what the index claims.
     */
    const rebuild = async (rootPath: string): Promise<void> => {
      const started = Date.now()
      build = { ...IDLE, state: 'building', rootPath, detail: 'listing files' }

      /*
       * Only the folders the project asked for.
       *
       * A romfs is 66,000 files and several gigabytes, every one of which this
       * decompresses and parses. A project that only ever touches `Layout/` can
       * say so and have the index take seconds — and the setting is worth nothing
       * unless it is read here, which is the point that was missed the first time.
       *
       * The scope is only applied to the project's *own* dump: indexing some
       * other folder is a deliberate act and should not inherit a restriction
       * meant for the dump.
       */
      const project = await Effect.runPromise(
        Effect.orElseSucceed(projects.active, () => null)
      )
      const scope =
        project && resolve(project.dumpPath) === resolve(rootPath)
          ? project.settings.indexFolders
          : []

      const roots =
        scope.length > 0
          ? scope.map((folder) => ({ path: join(rootPath, folder), prefix: folder }))
          : [{ path: rootPath, prefix: '' }]

      const walked: WalkedFile[] = []
      for (const root of roots) walked.push(...(await collect(root.path, root.prefix)))

      build = {
        ...build,
        total: walked.length,
        detail:
          scope.length > 0
            ? `${scope.join(', ')} only — widen it in the project's settings`
            : null
      }

      const existing = db.select().from(indexRuns).where(eq(indexRuns.rootPath, rootPath)).all()[0]
      if (existing) {
        db.transaction((tx) => {
          const ids = tx
            .select({ id: indexFiles.id })
            .from(indexFiles)
            .where(eq(indexFiles.runId, existing.id))
            .all()
          for (const row of ids) {
            tx.run(sql`DELETE FROM index_search WHERE symbol_id IN (SELECT id FROM index_symbols WHERE file_id = ${row.id})`)
            tx.delete(indexSymbols).where(eq(indexSymbols.fileId, row.id)).run()
          }
          tx.delete(indexFiles).where(eq(indexFiles.runId, existing.id)).run()
          tx.delete(indexRuns).where(eq(indexRuns.id, existing.id)).run()
        })
      }

      const runId = db
        .insert(indexRuns)
        .values({ rootPath, builtAt: started, fileCount: 0, symbolCount: 0 })
        .returning()
        .all()[0]!.id

      let symbolCount = 0
      let fileCount = 0

      /*
       * Batched into transactions of a few hundred files. One transaction for the
       * whole dump holds a write lock for minutes and loses everything if anything
       * goes wrong at the end; one per file makes 60,000 fsyncs.
       */
      const BATCH = 200
      for (let at = 0; at < walked.length; at += BATCH) {
        const slice = walked.slice(at, at + BATCH)
        const prepared: {
          relativePath: string
          entryName: string | null
          format: string
          size: number
          symbols: { kind: string; name: string; detail?: string }[]
        }[] = []

        for (const file of slice) {
          build = { ...build, done: at, currentFile: file.relativePath }

          const raw = await Effect.runPromise(
            Effect.either(files.read(file.absolutePath))
          )
          if (raw._tag === 'Left') continue

          const decompressed = await Effect.runPromise(
            Effect.orElseSucceed(compression.decompress(raw.right), () => ({
              data: raw.right,
              kind: 'none' as const
            }))
          )

          for (const extracted of extractFile(file.relativePath, decompressed.data)) {
            prepared.push({
              relativePath: file.relativePath,
              entryName: extracted.entryName ?? null,
              format: extracted.format,
              size: file.size,
              symbols: extracted.symbols.map((symbol) => ({
                kind: symbol.kind,
                name: symbol.name,
                ...(symbol.detail === undefined ? {} : { detail: symbol.detail })
              }))
            })
          }
        }

        db.transaction((tx) => {
          for (const entry of prepared) {
            const fileId = tx
              .insert(indexFiles)
              .values({
                runId,
                relativePath: entry.relativePath,
                entryName: entry.entryName,
                format: entry.format,
                size: entry.size
              })
              .returning()
              .all()[0]!.id
            fileCount += 1

            for (const symbol of entry.symbols) {
              const symbolId = tx
                .insert(indexSymbols)
                .values({
                  fileId,
                  kind: symbol.kind,
                  name: symbol.name,
                  detail: symbol.detail ?? null
                })
                .returning()
                .all()[0]!.id
              tx.run(
                sql`INSERT INTO index_search (name, detail, symbol_id) VALUES (${symbol.name}, ${symbol.detail ?? ''}, ${symbolId})`
              )
              symbolCount += 1
            }
          }
        })
      }

      db.update(indexRuns).set({ fileCount, symbolCount }).where(eq(indexRuns.id, runId)).run()

      build = {
        state: 'ready',
        rootPath,
        done: walked.length,
        total: walked.length,
        currentFile: null,
        detail: `${fileCount.toLocaleString()} files, ${symbolCount.toLocaleString()} names in ${Math.round((Date.now() - started) / 1000)}s`
      }
    }

    /**
     * Starts a build and returns immediately.
     *
     * Refuses a second one rather than queueing it: two builds over the same root
     * would interleave their deletes and inserts, and the loser would leave half
     * an index behind that still claims to be complete.
     */
    const start = (rootPath: string): Effect.Effect<IndexProgress, DbError | IoError> =>
      Effect.gen(function* () {
        if (running) {
          return yield* Effect.fail(
            new IoError({
              path: rootPath,
              detail: `already indexing ${build.rootPath ?? 'a dump'}; wait for that to finish`
            })
          )
        }

        running = true
        void rebuild(rootPath)
          .catch((cause: unknown) => {
            // The failure has to survive into the status, or the UI shows a build
            // that stopped at 40% with nothing to say about why.
            build = {
              ...build,
              state: 'failed',
              currentFile: null,
              detail: cause instanceof Error ? cause.message : String(cause)
            }
          })
          .finally(() => {
            running = false
          })

        return yield* status
      })

    /**
     * Free-text search across every indexed name.
     *
     * Ranked by FTS5 and capped, because a two-letter query against 300,000
     * messages matches most of them and a UI that tries to show all of it stops
     * being a search.
     */
    const search = (options: {
      query: string
      kinds?: readonly string[]
      rootPath?: string
      limit?: number
    }): Effect.Effect<IndexSearchHit[], DbError> =>
      Effect.gen(function* () {
        const match = toMatchQuery(options.query)
        if (match === null) return []

        const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000)
        const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : null

        return yield* dbTry('search the index', () => {
          const rows = db.all<{
            kind: string
            name: string
            detail: string | null
            relative_path: string
            entry_name: string | null
            format: string
            root_path: string
          }>(sql`
            SELECT s.kind, s.name, s.detail, f.relative_path, f.entry_name, f.format, r.root_path
            FROM index_search
            JOIN index_symbols s ON s.id = index_search.symbol_id
            JOIN index_files f ON f.id = s.file_id
            JOIN index_runs r ON r.id = f.run_id
            WHERE index_search MATCH ${match}
              ${kinds ? sql`AND s.kind IN (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})` : sql``}
              ${options.rootPath ? sql`AND r.root_path = ${options.rootPath}` : sql``}
            ORDER BY rank
            LIMIT ${limit}
          `)

          return rows.map((row) => ({
            kind: row.kind,
            name: row.name,
            detail: row.detail,
            relativePath: row.relative_path,
            entryName: row.entry_name,
            format: row.format,
            rootPath: row.root_path
          }))
        })
      })

    /**
     * Every file that names `name` — the reverse edge.
     *
     * "Who uses this texture", "what instantiates this part layout", "which
     * animation drives this pane". The index stores references in the direction
     * files declare them; asking the other way is the whole point, and it is an
     * exact-name lookup rather than a search so a texture called `Btn` does not
     * drag in `BtnLarge`.
     */
    const references = (options: {
      name: string
      kinds?: readonly string[]
      rootPath?: string
      limit?: number
    }): Effect.Effect<ReferenceHit[], DbError> =>
      Effect.gen(function* () {
        const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000)
        const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : null

        return yield* dbTry('look up references', () => {
          const rows = db.all<{
            kind: string
            name: string
            detail: string | null
            relative_path: string
            entry_name: string | null
            format: string
            root_path: string
          }>(sql`
            SELECT s.kind, s.name, s.detail, f.relative_path, f.entry_name, f.format, r.root_path
            FROM index_symbols s
            JOIN index_files f ON f.id = s.file_id
            JOIN index_runs r ON r.id = f.run_id
            WHERE s.name = ${options.name} COLLATE NOCASE
              ${kinds ? sql`AND s.kind IN (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})` : sql``}
              ${options.rootPath ? sql`AND r.root_path = ${options.rootPath}` : sql``}
            ORDER BY f.relative_path
            LIMIT ${limit}
          `)

          return rows.map((row) => ({
            kind: row.kind,
            name: row.name,
            detail: row.detail,
            relativePath: row.relative_path,
            entryName: row.entry_name,
            format: row.format,
            rootPath: row.root_path
          }))
        })
      })

    const drop = (rootPath: string): Effect.Effect<void, DbError | NotFoundError> =>
      Effect.gen(function* () {
        const runId = yield* runIdFor(rootPath)
        yield* dbTry('drop the index', () =>
          db.transaction((tx) => {
            const ids = tx
              .select({ id: indexFiles.id })
              .from(indexFiles)
              .where(eq(indexFiles.runId, runId))
              .all()
            for (const row of ids) {
              tx.run(
                sql`DELETE FROM index_search WHERE symbol_id IN (SELECT id FROM index_symbols WHERE file_id = ${row.id})`
              )
              tx.delete(indexSymbols).where(eq(indexSymbols.fileId, row.id)).run()
            }
            tx.delete(indexFiles).where(eq(indexFiles.runId, runId)).run()
            tx.delete(indexRuns).where(eq(indexRuns.id, runId)).run()
          })
        )
        if (build.rootPath === rootPath) build = IDLE
      })

    /** Every distinct name of a kind, for feeding archive name recovery. */
    const names = (options: {
      kind: string
      rootPath?: string
    }): Effect.Effect<string[], DbError> =>
      dbTry('list indexed names', () => {
        const rows = options.rootPath
          ? db
              .select({ name: indexSymbols.name })
              .from(indexSymbols)
              .innerJoin(indexFiles, eq(indexFiles.id, indexSymbols.fileId))
              .innerJoin(indexRuns, eq(indexRuns.id, indexFiles.runId))
              .where(
                and(eq(indexSymbols.kind, options.kind), eq(indexRuns.rootPath, options.rootPath))
              )
              .all()
          : db
              .select({ name: indexSymbols.name })
              .from(indexSymbols)
              .where(eq(indexSymbols.kind, options.kind))
              .all()
        return [...new Set(rows.map((row) => row.name))]
      })

    return { status, start, search, references, drop, names } as const
  })
}) {}
