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
 * Keyed by document id, so reopening the same file replaces its snapshot rather than
 * accumulating them. Cleared on a successful save, and on an explicit discard.
 */
export const snapshots = sqliteTable('snapshots', {
  documentId: text('document_id').primaryKey(),
  displayName: text('display_name').notNull(),
  /** The LayoutSource as JSON, so a recovered document knows where it came from. */
  source: text('source').notNull(),
  document: text('document').notNull(),
  updatedAt: integer('updated_at').notNull()
})
