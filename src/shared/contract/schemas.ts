import * as z from 'zod'

import type { AnimationDocument } from '@shared/formats/bflan/types'
import type { LayoutDocument } from '@shared/formats/bflyt/types'
import type { BymlDocumentView, BymlNodeView } from '@shared/formats/byml/view'

/**
 * Editor settings. Every field carries a default, so `appSettingsSchema.parse({})`
 * yields a complete settings object — that property is what lets the settings
 * service fill gaps per-field instead of failing whole reads.
 */
export const folderViewModeSchema = z.enum(['tree', 'list'])
export type FolderViewMode = z.infer<typeof folderViewModeSchema>

export const appSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  showGrid: z.boolean().default(true),
  gridSize: z.number().int().min(2).max(512).default(32),
  backgroundColor: z.string().default('#2b2b2b'),
  showRootPaneBounds: z.boolean().default(true),
  viewPartsAsNullPanes: z.boolean().default(false),
  transformChildren: z.boolean().default(true),
  snapToGuides: z.boolean().default(true),
  showInvisiblePanes: z.boolean().default(true),
  /**
   * How the folder browser presents a directory: an expanding tree, or a list you
   * drill into. Tree suits hunting through a romfs; list suits a folder with
   * thousands of siblings, where an expanded tree becomes unreadable.
   */
  folderViewMode: folderViewModeSchema.default('tree'),
  /**
   * Which editor panels are visible. Persisted, because a layout you have arranged
   * for the work you are doing should survive a restart.
   */
  showSidebar: z.boolean().default(true),
  showHierarchy: z.boolean().default(true),
  showProperties: z.boolean().default(true),
  showTimeline: z.boolean().default(true),
  /** Panel sizes in CSS pixels, so a dragged layout survives a restart. */
  sidebarWidth: z.number().int().min(160).max(900).default(288),
  propertiesWidth: z.number().int().min(200).max(900).default(320),
  timelineHeight: z.number().int().min(80).max(800).default(220)
})

/** Panels the View menu and the toolbar can toggle. */
export const panelKeySchema = z.enum([
  'showSidebar',
  'showHierarchy',
  'showProperties',
  'showTimeline'
])

export type PanelKey = z.infer<typeof panelKeySchema>

export type AppSettings = z.infer<typeof appSettingsSchema>

export const recentKindSchema = z.enum(['layout', 'archive'])
export type RecentKind = z.infer<typeof recentKindSchema>

export const recentEntrySchema = z.object({
  id: z.number().int(),
  path: z.string(),
  kind: recentKindSchema,
  displayName: z.string(),
  pinned: z.boolean(),
  lastOpenedAt: z.number().int()
})

export type RecentEntry = z.infer<typeof recentEntrySchema>

export const windowStateSchema = z.object({
  x: z.number().int().nullable(),
  y: z.number().int().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maximized: z.boolean()
})

export type WindowState = z.infer<typeof windowStateSchema>

/** Returned by mutations with nothing meaningful to say. */
export const okSchema = z.object({ ok: z.literal(true) })

export const compressionKindSchema = z.enum(['none', 'yaz0', 'zstd'])

export const archiveEntryKindSchema = z.enum([
  'layout',
  'animation',
  'texture',
  'font',
  'archive',
  'other'
])

export const archiveEntryInfoSchema = z.object({
  /** Stable handle: the name, or "#" + hex hash for unnamed entries. */
  key: z.string(),
  name: z.string().nullable(),
  displayName: z.string(),
  size: z.number().int().nonnegative(),
  kind: archiveEntryKindSchema,
  named: z.boolean()
})

export type ArchiveEntryInfo = z.infer<typeof archiveEntryInfoSchema>

export const archiveDescriptorSchema = z.object({
  archiveId: z.string(),
  path: z.string(),
  displayName: z.string(),
  compression: compressionKindSchema,
  littleEndian: z.boolean(),
  hasNames: z.boolean(),
  /** Entries with no recoverable name; they can be read but not replaced. */
  unnamedCount: z.number().int().nonnegative(),
  dirty: z.boolean(),
  entries: z.array(archiveEntryInfoSchema)
})

export type ArchiveDescriptor = z.infer<typeof archiveDescriptorSchema>

export const openPurposeSchema = z.enum(['layout', 'archive', 'any'])

/** Where a layout came from: a loose file, or an entry inside an open archive. */
export const layoutSourceSchema = z.union([
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('archive'),
    archiveId: z.string(),
    entryKey: z.string()
  })
])

export type LayoutSource = z.infer<typeof layoutSourceSchema>

/**
 * The layout document is passed through by type rather than validated field by
 * field. Deep-validating a tree with thousands of nodes on every open and save
 * costs real time, and the binary codec has already proven the shape — both
 * ends compile against the same LayoutDocument type.
 */
export const layoutDocumentSchema = z.custom<LayoutDocument>(
  (value) => typeof value === 'object' && value !== null
)

export const openLayoutResultSchema = z.object({
  documentId: z.string(),
  displayName: z.string(),
  source: layoutSourceSchema,
  document: layoutDocumentSchema
})

export type OpenLayoutResult = z.infer<typeof openLayoutResultSchema>

export const layoutSummarySchema = z.object({
  documentId: z.string(),
  displayName: z.string(),
  source: layoutSourceSchema
})

export type LayoutSummary = z.infer<typeof layoutSummarySchema>

/**
 * A binary payload crossing the RPC boundary.
 *
 * In practice this is always a `Blob` — the one binary type oRPC's serializer
 * transports natively (as multipart, not JSON). It cannot be *typed* as Blob
 * here: `shared/` compiles with no DOM and no Node lib, so only the members the
 * contract actually needs are declared. Main constructs a real Blob and the
 * renderer receives one; this interface is the narrow waist between them.
 *
 * A plain `Uint8Array` would be a bug: the serializer has no case for it and
 * would expand a multi-megabyte texture into a JSON object of numeric keys.
 */
export interface BinaryPayload {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export const binaryPayloadSchema = z.custom<BinaryPayload>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BinaryPayload).arrayBuffer === 'function'
)

/** One texture inside a BNTX container that a layout can reference. */
export const textureInfoSchema = z.object({
  /** Texture name as a layout's texture list spells it. */
  name: z.string(),
  /** Human-readable origin: archive entry key, or a file path. */
  container: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  mipCount: z.number().int(),
  /** e.g. "BC3 (unorm)" — from the BNTX format word. */
  format: z.string(),
  /** False when this build has no decoder; the editor shows a placeholder. */
  decodable: z.boolean()
})

export type TextureInfo = z.infer<typeof textureInfoSchema>

/**
 * Containers that could not be read are reported alongside the ones that could,
 * rather than being dropped: a layout whose textures are missing because one
 * BNTX failed to parse should say so, not silently render untextured.
 */
export const textureListSchema = z.object({
  textures: z.array(textureInfoSchema),
  containerCount: z.number().int(),
  unreadable: z.array(z.object({ container: z.string(), detail: z.string() }))
})

export type TextureList = z.infer<typeof textureListSchema>

export const decodedTextureSchema = z.object({
  name: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  format: z.string(),
  /** Straight RGBA8: four bytes per pixel, top-left origin, no premultiply. */
  rgba: binaryPayloadSchema
})

export type DecodedTexture = z.infer<typeof decodedTextureSchema>

/**
 * Like the layout document, passed through by type rather than field-validated:
 * the codec has already proven the shape and both ends share the type.
 */
/**
 * A parsed BYML document on its way to the viewer. Validated by the codec, so this
 * is a passthrough for the same reason layoutDocumentSchema is.
 */
export const bymlDocumentSchema = z.custom<BymlDocumentView>(
  (value) => typeof value === 'object' && value !== null
)

export type { BymlDocumentView, BymlNodeView }

export const animationDocumentSchema = z.custom<AnimationDocument>(
  (value) => typeof value === 'object' && value !== null
)

export const animationSourceSchema = layoutSourceSchema

export const openAnimationResultSchema = z.object({
  animationId: z.string(),
  displayName: z.string(),
  source: layoutSourceSchema,
  document: animationDocumentSchema
})

export type OpenAnimationResult = z.infer<typeof openAnimationResultSchema>

/** An animation sitting next to a layout, offered for playback. */
export const animationCandidateSchema = z.object({
  /** Archive entry key, or absolute path for a loose file. */
  key: z.string(),
  displayName: z.string(),
  size: z.number().int()
})

export type AnimationCandidate = z.infer<typeof animationCandidateSchema>

/**
 * A restorable session: which files were open, not their contents. The files on
 * disk are the truth, so restoring re-reads and re-parses them.
 */
export const workspaceSnapshotSchema = z.object({
  archives: z.array(z.string()),
  layouts: z.array(
    z.object({
      archivePath: z.string().optional(),
      entryKey: z.string().optional(),
      filePath: z.string().optional()
    })
  )
})

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>

export const folderEntryKindSchema = z.enum([
  'directory',
  'layout',
  'animation',
  'texture',
  'font',
  /** A layout archive — .blarc/.lyarc, the thing this editor actually opens. */
  'layoutArchive',
  'fontArchive',
  'archive',
  'byml',
  'model',
  'audio',
  'text',
  'other'
])

export type FolderEntryKind = z.infer<typeof folderEntryKindSchema>

export const folderEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: folderEntryKindSchema,
  /** Bytes on disk; 0 for directories. */
  size: z.number().int().nonnegative(),
  /** True when the name ends in .zs or .szs, so it needs decompressing first. */
  compressed: z.boolean()
})

export type FolderEntry = z.infer<typeof folderEntrySchema>

/**
 * One directory's contents. Listings are per-directory rather than a whole tree:
 * a romfs dump runs to tens of thousands of files and walking it eagerly would
 * stall the app before showing anything.
 */
export const folderListingSchema = z.object({
  path: z.string(),
  /** Null at a filesystem root. */
  parent: z.string().nullable(),
  entries: z.array(folderEntrySchema)
})

export type FolderListing = z.infer<typeof folderListingSchema>
