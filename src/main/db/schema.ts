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
