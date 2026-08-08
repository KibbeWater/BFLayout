import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
