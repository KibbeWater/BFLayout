import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const recentFiles = sqliteTable(
  'recent_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    path: text('path').notNull(),
    kind: text('kind', { enum: ['layout', 'archive'] }).notNull(),
    displayName: text('display_name').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    lastOpenedAt: integer('last_opened_at').notNull()
  },
  (t) => [uniqueIndex('recent_files_path_idx').on(t.path)]
)

export const windowState = sqliteTable('window_state', {
  id: text('id').primaryKey(),
  x: integer('x'),
  y: integer('y'),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  maximized: integer('maximized', { mode: 'boolean' }).notNull().default(false)
})

/**
 * Mod projects: a pristine dump, and the layer being built over it.
 *
 * A mod is not a set of edited game files, it is the small set of files that
 * *replace* game files — which is what the emulator's LayeredFS composes and
 * what a release ships. Holding both paths together is what lets a save be
 * redirected out of the dump and into the layer without the user thinking about
 * it (see `mod-layer.ts`).
 *
 * `active` is a column rather than a settings key so that deleting a project
 * cannot leave a dangling id pointing at nothing. At most one row carries it,
 * which the service maintains by clearing the rest in the same transaction.
 */
export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    dumpPath: text('dump_path').notNull(),
    modPath: text('mod_path').notNull(),
    /** Used to place a deploy, and to name the folder inside a release zip. */
    titleId: text('title_id').notNull().default(''),
    /**
     * The mod's own directory name under `mods/contents/<title id>/`.
     *
     * Not derived from the project name, because it has to *match* whatever else
     * installs into the same mod. A mod that is more than asset replacement has a
     * code half too — Colony ships a `subsdk9` loader into
     * `contents/<title>/colony/exefs` and its romfs into `…/colony/romfs` — and a
     * deploy that invented `tomodachi-mm` would quietly install a second, parallel
     * mod rather than the asset half of the one that exists.
     *
     * Empty means "derive it from the name", which is right for a mod that is only
     * assets and has nothing to agree with.
     */
    modName: text('mod_name').notNull().default(''),
    /**
     * The dump's game version. Recorded so an imported mod built against a
     * different one can be refused loudly rather than producing a game that
     * crashes in ways that look like the mod's own bugs.
     */
    gameVersion: text('game_version').notNull().default(''),
    /**
     * Per-project settings as JSON.
     *
     * A blob rather than columns: these are read together, written whole, and the
     * set grows every time a project turns out to have a quirk. Validated per
     * field on read, so an older row missing half of them still yields a complete
     * settings object.
     */
    settings: text('settings').notNull().default('{}'),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [uniqueIndex('projects_mod_path_idx').on(t.modPath)]
)

/**
 * One indexed dump.
 *
 * Keyed by root path rather than by project, because a dump outlives any one mod
 * built against it and two projects over the same dump should share the work —
 * indexing a romfs means reading every file in it, which is the most expensive
 * thing this app does.
 */
export const indexRuns = sqliteTable(
  'index_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    rootPath: text('root_path').notNull(),
    builtAt: integer('built_at').notNull(),
    fileCount: integer('file_count').notNull(),
    symbolCount: integer('symbol_count').notNull()
  },
  (t) => [uniqueIndex('index_runs_root_idx').on(t.rootPath)]
)

/**
 * A file in the dump — or an entry inside one of its archives.
 *
 * Archive members are rows in their own right rather than something hanging off
 * the container, because that is how a romfs is really shaped: the 544 layouts in
 * this game are entries inside 567 archives, and an index that stopped at the
 * container would be an index of container names.
 */
export const indexFiles = sqliteTable(
  'index_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull(),
    /** Path below the indexed root, forward slashes. */
    relativePath: text('relative_path').notNull(),
    /** Set for an entry inside an archive; null for a loose file. */
    entryName: text('entry_name'),
    format: text('format').notNull(),
    size: integer('size').notNull()
  },
  (t) => [index('index_files_run_idx').on(t.runId, t.relativePath)]
)

export const indexSymbols = sqliteTable(
  'index_symbols',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    detail: text('detail')
  },
  (t) => [
    // Exact-name lookup is the reverse-reference query — "who uses this texture" —
    // and it has to stay fast independently of the full-text search.
    index('index_symbols_name_idx').on(t.name),
    index('index_symbols_file_idx').on(t.fileId)
  ]
)

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  openTabs: text('open_tabs').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/**
 * Crash-recovery snapshots of unsaved documents.
 *
 * The close-and-quit prompts cover a *deliberate* exit; a crash, a power cut or a
 * killed process still lost everything since the last save. The renderer owns the
 * working document, so it hands one over on a debounced timer and this is where it
 * lands — as the document's own JSON rather than encoded layout bytes, because the
 * point is to restore the editing state exactly, including edits the writer would
 * refuse to encode.
 *
 * Keyed by the *durable* identity of the file — its path, plus the entry name for a
 * layout inside an archive — and not by the document id. Document ids are minted per
 * open and restart from the beginning every launch, so keying persistent rows by them
 * meant one file's snapshot could be claimed by another file on the next run, and that
 * a save could never find the row it was supposed to discard. See `snapshot-key.ts`.
 *
 * Replaced on re-edit, discarded on a successful save, and cleared on an explicit
 * discard.
 */

export const snapshots = sqliteTable('snapshots', {
  key: text('key').primaryKey(),
  displayName: text('display_name').notNull(),
  document: text('document').notNull(),
  updatedAt: integer('updated_at').notNull()
})
