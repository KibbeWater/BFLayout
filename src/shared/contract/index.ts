import { oc } from '@orpc/contract'
import * as z from 'zod'

import {
  appSettingsSchema,
  animationCandidateSchema,
  archiveDescriptorSchema,
  compressionKindSchema,
  decodedTextureSchema,
  openAnimationResultSchema,
  layoutDocumentSchema,
  layoutSourceSchema,
  layoutSummarySchema,
  okSchema,
  openLayoutResultSchema,
  openPurposeSchema,
  recentEntrySchema,
  recentKindSchema,
  fontChainSchema,
  snapshotSummarySchema,
  bymlDocumentSchema,
  folderListingSchema,
  textureListSchema,
  windowStateSchema,
  workspaceSnapshotSchema
} from './schemas'

export * from './schemas'
export * from './snapshot-key'

/**
 * Every procedure shares this error vocabulary. Main maps its Effect tagged
 * errors onto these codes exhaustively (src/main/rpc/errors.ts), and the
 * renderer discriminates them with oRPC's isDefinedError.
 */
const base = oc.errors({
  FILE_NOT_FOUND: {
    message: 'File not found',
    data: z.object({ path: z.string() })
  },
  IO_ERROR: {
    message: 'Filesystem operation failed',
    data: z.object({ path: z.string().optional(), detail: z.string() })
  },
  PARSE_ERROR: {
    message: 'Could not parse file',
    data: z.object({
      format: z.string(),
      offset: z.number().int(),
      section: z.string().optional(),
      detail: z.string()
    })
  },
  WRITE_ERROR: {
    message: 'Could not serialize file',
    data: z.object({
      format: z.string(),
      section: z.string().optional(),
      detail: z.string()
    })
  },
  UNSUPPORTED_FORMAT: {
    message: 'Unsupported file format',
    data: z.object({ detected: z.string(), detail: z.string() })
  },
  NOT_FOUND: {
    message: 'Resource not found',
    data: z.object({ kind: z.string(), id: z.string() })
  },
  DB_ERROR: {
    message: 'Local database error',
    data: z.object({ detail: z.string() })
  }
})

export const appContract = {
  settings: {
    get: base.output(appSettingsSchema),
    patch: base.input(appSettingsSchema.partial()).output(appSettingsSchema)
  },
  recents: {
    list: base.output(z.array(recentEntrySchema)),
    add: base
      .input(z.object({ path: z.string().min(1), kind: recentKindSchema }))
      .output(recentEntrySchema),
    setPinned: base
      .input(z.object({ id: z.number().int(), pinned: z.boolean() }))
      .output(okSchema),
    remove: base.input(z.object({ id: z.number().int() })).output(okSchema),
    clear: base.output(okSchema)
  },
  windowState: {
    get: base.output(windowStateSchema.nullable()),
    set: base.input(windowStateSchema).output(okSchema)
  },
  workspace: {
    get: base.output(workspaceSnapshotSchema),
    set: base.input(workspaceSnapshotSchema).output(okSchema),
    clear: base.output(okSchema)
  },
  /**
   * Tells main how many tabs hold unsaved edits.
   *
   * Main cannot see the document store, but it owns window close and application
   * quit — both of which used to discard unsaved work without a word. Pushing the
   * count on every change means the close handler can answer synchronously, which
   * it has to: `win.on('close')` cannot await a round trip to the renderer.
   */
  setUnsavedCount: base.input(z.object({ count: z.number().int().min(0) })).output(okSchema)
}

/**
 * Crash-recovery snapshots.
 *
 * The renderer owns the working document, so it pushes one on a debounced timer while a
 * tab holds unsaved edits. The close prompts cover a deliberate exit; this covers the
 * process going away without one.
 */
export const snapshotContract = {
  put: base
    .input(
      z.object({
        key: z.string().min(1),
        displayName: z.string(),
        document: layoutDocumentSchema
      })
    )
    .output(okSchema),
  list: base.output(z.array(snapshotSummarySchema)),
  /**
   * Reopens what the key names, then swaps the snapshot's document in.
   *
   * Going through a real open is the point: it re-establishes the main-process session
   * and the preserved section bytes, without which the recovered document could be
   * edited but never saved.
   */
  restore: base
    .input(z.object({ key: z.string().min(1) }))
    .output(openLayoutResultSchema.extend({ updatedAt: z.number().int() })),
  remove: base.input(z.object({ key: z.string().min(1) })).output(okSchema),
  clear: base.output(okSchema)
}

export const dialogContract = {
  /**
   * Asks whether to save, discard, or keep editing before losing changes.
   *
   * A native modal rather than an in-app one because it guards a destructive
   * action: it must be impossible to miss, and it must be able to block a window
   * that is already on its way out.
   */
  confirmDiscard: base
    .input(z.object({ name: z.string(), scope: z.enum(['tab', 'window']) }))
    .output(z.object({ choice: z.enum(['save', 'discard', 'cancel']) })),
  openFolder: base
    .output(z.object({ canceled: z.boolean(), path: z.string().nullable() })),
  openFiles: base
    .input(z.object({ purpose: openPurposeSchema, multiple: z.boolean().optional() }))
    .output(z.object({ canceled: z.boolean(), paths: z.array(z.string()) })),
  saveFileAs: base
    .input(z.object({ purpose: openPurposeSchema, defaultName: z.string().optional() }))
    .output(z.object({ canceled: z.boolean(), path: z.string().nullable() }))
}

export const archiveContract = {
  open: base.input(z.object({ path: z.string().min(1) })).output(archiveDescriptorSchema),
  get: base.input(z.object({ archiveId: z.string() })).output(archiveDescriptorSchema),
  list: base.output(z.array(archiveDescriptorSchema)),
  /** Supplies candidate names for a hash-only archive. */
  recoverNames: base
    .input(z.object({ archiveId: z.string(), candidates: z.array(z.string()) }))
    .output(archiveDescriptorSchema),
  save: base
    .input(z.object({ archiveId: z.string(), path: z.string().optional() }))
    .output(archiveDescriptorSchema),
  close: base.input(z.object({ archiveId: z.string() })).output(okSchema)
}

export const layoutContract = {
  open: base.input(z.object({ source: layoutSourceSchema })).output(openLayoutResultSchema),
  list: base.output(z.array(layoutSummarySchema)),
  /**
   * Resolves the external layouts a prt1 part pane instantiates, so the canvas can
   * draw the part's actual contents instead of an empty box.
   *
   * Batched by design: a layout can hold dozens of parts and one round trip per
   * part would show the panel filling in piecemeal. Parts that cannot be found are
   * returned as failures rather than omitted, so the UI can say which are missing.
   */
  parts: base
    .input(z.object({ source: layoutSourceSchema, names: z.array(z.string()) }))
    .output(
      z.object({
        resolved: z.array(z.object({ name: z.string(), document: layoutDocumentSchema })),
        missing: z.array(z.object({ name: z.string(), detail: z.string() }))
      })
    ),
  /**
   * The renderer owns the working document and sends it back to be written, so
   * canvas interaction never round-trips through IPC.
   *
   * `path` performs a save-as for a file-backed layout. It is rejected for a
   * layout inside an archive: writing one entry to a loose file would silently
   * detach it from the archive it belongs to, so the archive is saved instead.
   */
  save: base
    .input(
      z.object({
        documentId: z.string(),
        document: layoutDocumentSchema,
        path: z.string().min(1).optional()
      })
    )
    .output(
      z.object({
        bytes: z.number().int(),
        dirty: z.boolean(),
        /** Where it ended up; differs from the input on a save-as. */
        source: layoutSourceSchema,
        displayName: z.string(),
        /**
         * The durable identity after the save. A save-as moves the file, and a key still
         * naming the old one meant crash recovery would restore the new edits into — and
         * then save over — the very file the user had moved away from.
         */
        snapshotKey: z.string()
      })
    ),
  close: base.input(z.object({ documentId: z.string() })).output(okSchema)
}

/**
 * Textures are addressed by the layout's own source, because that is what
 * decides where to look for them: an entry in an archive searches that archive's
 * texture folder first, a loose .bflyt searches the directory beside it.
 */
/**
 * The typefaces a layout's text panes are drawn with.
 *
 * A layout's font list names `.bfcpx` complexes, which name obfuscated scalable faces in a
 * *different* archive — so this is a lookup across the dump, not inside the layout. The
 * faces come back as a fallback chain the renderer can hand straight to a canvas.
 */
export const fontsContract = {
  chain: base
    .input(z.object({ source: layoutSourceSchema, name: z.string().min(1) }))
    .output(fontChainSchema)
}

export const texturesContract = {
  list: base.input(z.object({ source: layoutSourceSchema })).output(textureListSchema),
  get: base
    .input(
      z.object({
        source: layoutSourceSchema,
        name: z.string().min(1),
        mip: z.number().int().min(0).optional()
      })
    )
    .output(decodedTextureSchema),
  /**
   * Writes a decoded texture to a PNG.
   *
   * Textures are otherwise read-only, and this is the way one gets *out*: the archives
   * ship BNTX with Tegra swizzling and BCn or ASTC compression, which no image editor
   * opens.
   */
  exportPng: base
    .input(
      z.object({
        source: layoutSourceSchema,
        name: z.string().min(1),
        path: z.string().min(1),
        mip: z.number().int().min(0).optional()
      })
    )
    .output(
      z.object({
        path: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        bytes: z.number().int()
      })
    )
}

/**
 * Animations are found relative to the layout they animate, the same way textures
 * are: the archive's anim/ folder, then the rest of the archive, then the folder
 * beside a loose .bflyt.
 */
export const animationContract = {
  list: base
    .input(z.object({ source: layoutSourceSchema }))
    .output(z.array(animationCandidateSchema)),
  open: base
    .input(z.object({ source: layoutSourceSchema, key: z.string().min(1) }))
    .output(openAnimationResultSchema),
  close: base.input(z.object({ animationId: z.string() })).output(okSchema)
}

/**
 * Browsing a folder on disk — a dumped romfs, in practice.
 *
 * Listings are per-directory, so opening a 60,000-file dump costs one readdir
 * rather than a full walk.
 */
/**
 * Reading BYML configuration documents.
 *
 * Read-only: there is no BYML writer, so nothing here can save one back. Opening
 * is stateless — the whole tree comes over in one call and main keeps nothing —
 * because these documents are small (the largest in this game is 19,369 nodes),
 * unlike layouts which stay open and editable.
 */
export const bymlContract = {
  open: base.input(z.object({ path: z.string().min(1) })).output(bymlDocumentSchema)
}

export const folderContract = {
  list: base.input(z.object({ path: z.string().min(1) })).output(folderListingSchema),
  /** Recognises what a file is by sniffing it, decompressing first if needed. */
  identify: base
    .input(z.object({ path: z.string().min(1) }))
    .output(
      z.object({
        path: z.string(),
        format: z.string(),
        compression: compressionKindSchema,
        /** How the editor can open it, if at all. */
        opensAs: z.enum(['archive', 'layout', 'animation', 'texture', 'byml', 'none']),
        detail: z.string()
      })
    )
}

export const contract = {
  app: appContract,
  dialog: dialogContract,
  archive: archiveContract,
  layout: layoutContract,
  textures: texturesContract,
  fonts: fontsContract,
  animation: animationContract,
  folder: folderContract,
  byml: bymlContract,
  snapshot: snapshotContract
}

export type Contract = typeof contract
