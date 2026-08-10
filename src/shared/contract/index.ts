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
  previewSchema,
  snapshotSummarySchema,
  bymlDocumentSchema,
  deployResultSchema,
  deployTargetSchema,
  folderListingSchema,
  gameLinkStatusSchema,
  mcpActivitySchema,
  mcpStatusSchema,
  indexHitSchema,
  messageReplaceResultSchema,
  messageTableSchema,
  indexProgressSchema,
  modCheckReportSchema,
  modDiffReportSchema,
  modPackageInfoSchema,
  modPackageResultSchema,
  modLayerStatusSchema,
  modProjectInputSchema,
  modProjectSchema,
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
  },
  /**
   * A write refused because its destination is mounted read-only — the pristine
   * dump of an open mod project, in practice. Separate from IO_ERROR because
   * nothing is broken and retrying cannot help: the message says where the edit
   * belongs instead.
   */
  READ_ONLY: {
    message: 'That location is read-only',
    data: z.object({ path: z.string(), detail: z.string() })
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
  /**
   * `title` matters when more than one folder is chosen in a row — a project setup
   * asks for a dump and then a mod folder, and two identical dialogs is how the
   * second answer ends up in the first field.
   */
  openFolder: base
    .input(z.object({ title: z.string().optional(), buttonLabel: z.string().optional() }))
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
  save: base.input(z.object({ archiveId: z.string(), path: z.string().optional() })).output(
    z.object({
      archive: archiveDescriptorSchema,
      /**
       * True when a mod project moved this write out of the pristine dump and into
       * the mod layer. The descriptor's `path` already says where it landed; this
       * says the app chose that, so the UI can explain itself the first time rather
       * than appearing to save somewhere at random.
       */
      redirected: z.boolean()
    })
  ),
  /**
   * Writes one entry's bytes to a file.
   *
   * The way anything other than a decoded texture gets *out* of an archive. Everything in one
   * — layouts, animations, texture containers, BYML — was readable in the app and unreachable
   * from outside it, which is most of what a user of the tool this replaces does all day.
   */
  extractEntry: base
    .input(
      z.object({
        archiveId: z.string(),
        entryKey: z.string().min(1),
        path: z.string().min(1)
      })
    )
    .output(z.object({ path: z.string(), bytes: z.number().int() })),
  /**
   * Replaces one entry's bytes from a file.
   *
   * Still the answer for a texture whose format has no encoder here. `textures.importPng` now
   * writes pixels straight into a container — but only in place, which means the size must be
   * unchanged and the format uncompressed. For anything BCn or ASTC the missing piece is a
   * *compressor*, and swapping in a `.bntx` built elsewhere needs none of them.
   *
   * The bytes go in uncompressed: Yaz0 or ZSTD is applied to the whole archive on save, not per
   * entry. An entry whose name could not be recovered cannot be replaced, and says so.
   */
  importEntry: base
    .input(
      z.object({
        archiveId: z.string(),
        entryKey: z.string().min(1),
        path: z.string().min(1)
      })
    )
    .output(
      z.object({
        archive: archiveDescriptorSchema,
        bytes: z.number().int(),
        /**
         * What the new bytes look like to the sniffer, so the UI can say when someone has just
         * imported something the app cannot read — a real mistake to make silently.
         */
        detected: z.string()
      })
    ),
  /**
   * Adds a file to the archive, from a file on disk.
   *
   * Mods add files, and until now nothing here could — an archive could only ever
   * hold the entries it shipped with. Refused in an archive with unrecovered
   * names, like every other structural edit: writing a SARC needs all of them.
   */
  addEntry: base
    .input(
      z.object({
        archiveId: z.string(),
        name: z.string().min(1),
        path: z.string().min(1)
      })
    )
    .output(z.object({ archive: archiveDescriptorSchema, bytes: z.number().int() })),
  deleteEntry: base
    .input(z.object({ archiveId: z.string(), entryKey: z.string().min(1) }))
    .output(archiveDescriptorSchema),
  /** A rehash, not a relabel: SARC finds entries by the hash of their name. */
  renameEntry: base
    .input(
      z.object({
        archiveId: z.string(),
        entryKey: z.string().min(1),
        name: z.string().min(1)
      })
    )
    .output(archiveDescriptorSchema),
  duplicateEntry: base
    .input(
      z.object({
        archiveId: z.string(),
        entryKey: z.string().min(1),
        name: z.string().min(1)
      })
    )
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
        snapshotKey: z.string(),
        /**
         * True when a mod project moved this save out of the pristine dump and
         * into the mod layer. The UI says so the first time, because a save that
         * silently writes somewhere other than where the file was opened from is
         * exactly the kind of helpfulness that reads as a bug.
         */
        redirected: z.boolean()
      })
    ),
  close: base.input(z.object({ documentId: z.string() })).output(okSchema)
}

/**
 * Mod projects: a pristine dump, and the layer being built over it.
 *
 * Activating one changes what saving means process-wide — writes that would land
 * in the dump are redirected into the layer, and the dump itself is refused — so
 * this is deliberately a small, explicit surface rather than something inferred
 * from which folder happens to be open.
 */
export const projectContract = {
  list: base.output(z.array(modProjectSchema)),
  active: base.output(modProjectSchema.nullable()),
  create: base.input(modProjectInputSchema).output(modProjectSchema),
  update: base
    .input(z.object({ id: z.number().int(), patch: modProjectInputSchema.partial() }))
    .output(modProjectSchema),
  /** `null` deactivates, which unmounts the read-only dump. */
  setActive: base
    .input(z.object({ id: z.number().int().nullable() }))
    .output(modProjectSchema.nullable()),
  remove: base.input(z.object({ id: z.number().int() })).output(okSchema),
  /** What the layer holds right now: every file, and whether it replaces or adds. */
  status: base.output(modLayerStatusSchema),
  /**
   * Drops one file from the mod layer, so the dump's copy applies again.
   *
   * Deleting is the revert: a mod that ships a byte-identical file still shadows
   * the original, and would go on shadowing it after a game update changed the
   * real one. `hadPristine` is false when the file was an addition, which means
   * the revert removed content rather than restoring anything.
   */
  revert: base
    .input(z.object({ relativePath: z.string().min(1) }))
    .output(z.object({ relativePath: z.string(), hadPristine: z.boolean() }))
}

/**
 * Installing the mod layer where the emulator will find it.
 *
 * A copy, not a build: the layer is already the shape a romfs mod ships in. This
 * deliberately stops at installing — starting the game is a separate decision.
 */
/**
 * Checking every file the mod contains before it is deployed.
 *
 * Reports rather than refuses: a mod is entitled to ship a file this build cannot
 * read, and the person who made it is better placed to judge than the checker is.
 */
export const modCheckContract = {
  run: base.output(modCheckReportSchema)
}

/**
 * Searching a dump by the names inside its files.
 *
 * Browsing cannot answer "which layout has a pane called BtnOk" or "where is this
 * string", because the names live inside binary containers. Reading the dump once
 * into sqlite makes both instant, which changes what the tool is for: most of
 * modding a game this size is finding things, not editing them.
 */
export const indexContract = {
  status: base.output(indexProgressSchema),
  /** Starts a background build and returns immediately with the new status. */
  build: base.input(z.object({ rootPath: z.string().min(1) })).output(indexProgressSchema),
  search: base
    .input(
      z.object({
        query: z.string(),
        kinds: z.array(z.string()).optional(),
        rootPath: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional()
      })
    )
    .output(z.array(indexHitSchema)),
  /**
   * Every file that names something — the reverse edge. Exact-name rather than a
   * search, so a texture called `Btn` does not drag in `BtnLarge`.
   */
  references: base
    .input(
      z.object({
        name: z.string().min(1),
        kinds: z.array(z.string()).optional(),
        rootPath: z.string().optional(),
        limit: z.number().int().min(1).max(2000).optional()
      })
    )
    .output(z.array(indexHitSchema)),
  /** Distinct names of one kind — what feeds archive name recovery. */
  names: base
    .input(z.object({ kind: z.string().min(1), rootPath: z.string().optional() }))
    .output(z.array(z.string())),
  drop: base.input(z.object({ rootPath: z.string().min(1) })).output(okSchema)
}

/**
 * A loopback listener the running game can report its current screen to.
 *
 * Off unless started, bound to 127.0.0.1, and it only ever *records* what it is
 * told — the jump is offered, never taken. A tool that opens files because
 * something on a socket asked it to is a tool with a remote-control problem.
 */
export const gameLinkContract = {
  status: base.output(gameLinkStatusSchema),
  start: base
    .input(z.object({ port: z.number().int().min(1024).max(65535).default(47600) }))
    .output(gameLinkStatusSchema),
  stop: base.output(gameLinkStatusSchema),
  /** Forgets the last report, so a stale banner can be dismissed. */
  clear: base.output(gameLinkStatusSchema)
}

/**
 * The game's text, readable and now writable.
 *
 * Message tables are the most-edited files in modding. Saving goes through the
 * same copy-on-write path as everything else, so editing one out of a pristine
 * dump produces a file in the mod layer and leaves the dump alone.
 */
export const messagesContract = {
  open: base.input(z.object({ source: layoutSourceSchema })).output(messageTableSchema),
  save: base
    .input(
      z.object({
        source: layoutSourceSchema,
        edits: z.array(z.object({ index: z.number().int(), text: z.string() }))
      })
    )
    .output(
      z.object({
        bytes: z.number().int(),
        changed: z.number().int(),
        redirected: z.boolean(),
        /** Null for an archive entry, whose bytes reach disk when the archive is saved. */
        path: z.string().nullable()
      })
    ),
  /**
   * Find and replace across every message table under a folder.
   *
   * Run it with `dryRun` first. The result carries before/after examples because a
   * pattern that matched more than intended across thousands of files is not
   * something a count can tell you.
   */
  replaceAll: base
    .input(
      z.object({
        root: z.string().min(1),
        find: z.string().min(1),
        replacement: z.string(),
        regex: z.boolean().default(false),
        dryRun: z.boolean().default(true)
      })
    )
    .output(messageReplaceResultSchema)
}

/**
 * What the mod changes, expressed structurally rather than in bytes.
 *
 * Doubles as the release changelog: it is the only view that says a button moved
 * rather than that a file differs.
 */
export const modDiffContract = {
  run: base.output(modDiffReportSchema)
}

/**
 * Mods as something other people can install.
 *
 * The zip is the standard `contents/<title id>/romfs/…` shape, so it is the mod
 * rather than a BFLayout format — someone who has never heard of this editor can
 * drop it into their emulator's mods folder. The manifest rides alongside and
 * records the game build it was made for.
 */
export const packageContract = {
  export: base
    .input(
      z.object({
        path: z.string().min(1),
        version: z.string().default('1.0.0'),
        author: z.string().default('')
      })
    )
    .output(modPackageResultSchema),
  /** Reads a package without installing it, so a mismatch is caught first. */
  inspect: base.input(z.object({ path: z.string().min(1) })).output(modPackageInfoSchema),
  import: base
    .input(z.object({ path: z.string().min(1), overwrite: z.boolean().default(false) }))
    .output(z.object({ imported: z.array(z.string()), skipped: z.array(z.string()) }))
}

/**
 * The MCP server the app hosts.
 *
 * Distinct from the stdio one Claude Code launches: this one can see what is open,
 * so a tool call that names no file means the layout on screen — and every call it
 * serves is recorded and shown, because an agent writing your files should be
 * something you watch.
 */
export const mcpContract = {
  status: base.output(mcpStatusSchema),
  start: base
    .input(z.object({ port: z.number().int().min(1024).max(65535).default(47601) }))
    .output(mcpStatusSchema),
  stop: base.output(mcpStatusSchema),
  /** Most recent calls, newest first. */
  activity: base
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .output(z.array(mcpActivitySchema)),
  clear: base.output(okSchema),
  /** Told once the renderer has reloaded whatever an agent wrote underneath it. */
  acknowledgeEdits: base.output(okSchema)
}

export const deployContract = {
  /** Emulator data directories, present or not, so the UI can say where it looked. */
  targets: base.output(z.array(deployTargetSchema)),
  run: base
    .input(z.object({ dataDir: z.string().optional(), modName: z.string().optional() }))
    .output(deployResultSchema)
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

/**
 * A look at a file the editor cannot put on the canvas.
 *
 * Most of a romfs is not a layout, and everything else used to be a dead end — classified, then
 * unopenable. One procedure for both sources, because "open the thing I clicked" should not
 * depend on whether it is loose on disk or inside an archive.
 */
export const previewContract = {
  open: base.input(z.object({ source: layoutSourceSchema })).output(previewSchema)
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
   * The way a texture gets *out*: the archives ship BNTX with Tegra swizzling and BCn or
   * ASTC compression, which no image editor opens. `importPng` is the way back in, for
   * the formats there is an encoder for.
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
    ),
  /**
   * Replaces one texture's pixels from an image, in place.
   *
   * In place is the design, not a limitation of convenience: the container's
   * offsets and the relocation table `nn::gfx` uses at load are left untouched, so
   * a rewritten file cannot be structurally wrong. The cost is two refusals —
   * dimensions must match, and the format must be one there is an encoder for,
   * which means uncompressed. Both come back naming what to do instead.
   */
  importPng: base
    .input(
      z.object({
        source: layoutSourceSchema,
        name: z.string().min(1),
        path: z.string().min(1)
      })
    )
    .output(
      z.object({
        container: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        mipsWritten: z.number().int(),
        /** Null for a texture inside an archive, whose bytes land when it is saved. */
        path: z.string().nullable(),
        redirected: z.boolean()
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
  preview: previewContract,
  animation: animationContract,
  folder: folderContract,
  byml: bymlContract,
  snapshot: snapshotContract,
  project: projectContract,
  deploy: deployContract,
  modCheck: modCheckContract,
  index: indexContract,
  gameLink: gameLinkContract,
  mcp: mcpContract,
  messages: messagesContract,
  modDiff: modDiffContract,
  package: packageContract
}

export type Contract = typeof contract
