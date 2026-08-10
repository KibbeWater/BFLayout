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

/**
 * What an archive entry is, for an icon and for deciding what a click does.
 *
 * Wider than it was, and the reason is worth stating: `bgyml` alone accounts for 38,265 entries
 * in one title's archives — more than every layout, animation and texture combined — and it was
 * classified as `other`, which is to say presented as an unrecognised file even though the BYML
 * reader parses all of them. Same for the scalable fonts the canvas draws real text with.
 */
export const archiveEntryKindSchema = z.enum([
  'layout',
  'animation',
  'texture',
  'font',
  'archive',
  /** BYML, `bgyml` and AAMP: parameter and data trees. */
  'data',
  /** MSBT and MSBP: the game's text. */
  'message',
  'model',
  'shader',
  'audio',
  /** AINB and ASB: logic graphs. */
  'logic',
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

export const openPurposeSchema = z.enum(['layout', 'archive', 'image', 'any'])

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

export const durableLayoutSourceSchema = z.union([
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('archive'),
    archivePath: z.string().min(1),
    entryKey: z.string().min(1)
  })
])

/**
 * One offerable recovery snapshot. `sourceModifiedAt` is null when the file it came
 * from is no longer where the key says it is.
 */
export const snapshotSummarySchema = z.object({
  key: z.string(),
  displayName: z.string(),
  source: durableLayoutSourceSchema,
  updatedAt: z.number().int(),
  sourceModifiedAt: z.number().int().nullable()
})

export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>

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
  document: layoutDocumentSchema,
  /**
   * The durable identity of this document, for keying crash-recovery snapshots.
   * Handed out at open time so a tab can write and discard its own snapshot without
   * a round trip, and — critically — after its main-process session is gone.
   */
  snapshotKey: z.string()
})

export type OpenLayoutResult = z.infer<typeof openLayoutResultSchema>

export const layoutSummarySchema = z.object({
  documentId: z.string(),
  displayName: z.string(),
  source: layoutSourceSchema,
  /**
   * Recomputed from the session's *current* source, so a tab can resync after something
   * moved the file underneath it — a save-as, or an archive saved to a new path.
   */
  snapshotKey: z.string()
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
 * The typefaces one of a layout's named fonts resolves to.
 *
 * `faces` is a fallback chain in the order the game's own descriptor lists it —
 * specialised faces first, main typeface last — which is also the order CSS resolves
 * `font-family` in, so the renderer can hand it to a canvas verbatim.
 *
 * `missing` names faces the descriptor asked for that could not be produced. A chain with
 * gaps still draws ordinary text correctly, so this is reported rather than raised, but it
 * is reported: silently thinner fallback is how a preview drifts from the game without
 * anyone noticing.
 */
export const fontChainSchema = z.object({
  name: z.string(),
  /** Path of the archive the faces came from, for error messages and diagnostics. */
  archive: z.string(),
  faces: z.array(
    z.object({
      /** Family name to register the face under; the filename without its extension. */
      name: z.string(),
      kind: z.enum(['otf', 'ttf', 'ttc']),
      sfnt: binaryPayloadSchema
    })
  ),
  missing: z.array(z.string())
})

export type FontChain = z.infer<typeof fontChainSchema>

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

/**
 * What could be made of a file the editor cannot put on the canvas.
 *
 * Most of a romfs is not a layout. Everything else was either unclassified or classified and
 * then unopenable — clicking a font, a texture container or a data tree in the browser reported
 * "cannot open" for files this build reads perfectly well, and a font *archive* opened as an
 * archive whose every entry did nothing. This is where those go.
 *
 * `content` is a union rather than a set of optional fields so that adding a format cannot
 * silently produce a preview with nothing in it: a new kind has to be handled where it is read.
 */
export const previewContentSchema = z.discriminatedUnion('kind', [
  /**
   * A font archive, or a single face. `complexes` are the `.bfcpx` fallback chains; `faces` carry
   * the decoded sfnt bytes so the renderer can register them and draw actual glyphs.
   */
  z.object({
    kind: z.literal('font'),
    faces: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(['otf', 'ttf', 'ttc']),
        bytes: z.number().int(),
        sfnt: binaryPayloadSchema
      })
    ),
    complexes: z.array(z.object({ name: z.string(), faces: z.array(z.string()) })),
    /** Faces a complex named that are not in this archive, so the gap is visible. */
    missing: z.array(z.string())
  }),
  /** BYML, `bgyml` or AAMP: a parameter tree, shown with the existing viewer. */
  z.object({ kind: z.literal('data'), document: bymlDocumentSchema }),
  /**
   * MSBT: a game's text.
   *
   * Capped rather than sent whole — one table can hold thousands of strings and a single title
   * holds 333,671 of them, so the total is reported and the payload is not.
   */
  z.object({
    kind: z.literal('messages'),
    encoding: z.enum(['utf-8', 'utf-16']),
    total: z.number().int(),
    messages: z.array(
      z.object({ label: z.string(), index: z.number().int(), text: z.string() })
    )
  }),
  /** A BNTX container's own textures, listed for the thumbnail grid. */
  z.object({ kind: z.literal('textures'), textures: z.array(textureInfoSchema) }),
  /**
   * A model container's structure — no geometry.
   *
   * Decoding vertex buffers is a different project; what a `.bfres` can usefully say without one is
   * what is inside it: models, their shape and material counts, and the textures each material
   * references.
   */
  z.object({
    kind: z.literal('model'),
    version: z.string(),
    name: z.string(),
    modelCount: z.number().int(),
    subfileCount: z.number().int(),
    models: z.array(
      z.object({
        name: z.string(),
        shapeCount: z.number().int(),
        materialCount: z.number().int(),
        boneCount: z.number().int(),
        vertexCount: z.number().int(),
        materials: z.array(
          z.object({ name: z.string(), textures: z.array(z.string()), textureCount: z.number().int() })
        )
      })
    ),
    /** Subfile kinds and how many of each — FMDL, FSKA, FMAA and so on. */
    subfileKinds: z.array(z.object({ kind: z.string(), count: z.number().int() }))
  }),
  /**
   * An AAMP parameter tree.
   *
   * `label` on every node is the resolved name *or* the hash as hex, never a guess — AAMP stores
   * CRC32 hashes rather than names, and only some resolve.
   */
  z.object({
    kind: z.literal('parameters'),
    typeName: z.string(),
    version: z.number().int(),
    counts: z.object({
      lists: z.number().int(),
      objects: z.number().int(),
      parameters: z.number().int()
    }),
    unresolvedNames: z.number().int(),
    /** Flattened for display: depth, what it is, its label, and a rendered value for parameters. */
    nodes: z.array(
      z.object({
        depth: z.number().int(),
        kind: z.enum(['list', 'object', 'parameter']),
        label: z.string(),
        type: z.string(),
        value: z.string(),
        /** False when the value type never occurs in the reference dump, so its layout is inferred. */
        verified: z.boolean()
      })
    ),
    total: z.number().int()
  }),
  /**
   * An audio sample's metadata. Never its audio: decoding Nintendo ADPCM is out of scope, and
   * `decodable` says so rather than leaving the user to wonder why nothing plays.
   */
  z.object({
    kind: z.literal('audio'),
    channelCount: z.number().int(),
    sampleRate: z.number().int().nullable(),
    codec: z.string(),
    durationSeconds: z.number().nullable(),
    looping: z.boolean(),
    decodable: z.boolean(),
    undecodableReason: z.string().nullable()
  }),
  /**
   * An AINB logic graph's structure.
   *
   * Node-to-node connections are **not** included, because they are not decoded: the per-node
   * parameter bodies are located and bounds-checked but their layout is unread, so which node feeds
   * which is unknown. Drawing a graph from what is known would mean inventing the edges, so what is
   * shown is what the file actually says — entry points, nodes, types, and the modules it pulls in.
   */
  z.object({
    kind: z.literal('logic'),
    name: z.string(),
    category: z.string(),
    version: z.string(),
    /** Entry points. `entryNodeIndex` is verified in range; that it is the *entry* is inferred. */
    commands: z.array(z.object({ name: z.string(), entryNodeIndex: z.number().int() })),
    nodeCount: z.number().int(),
    nodes: z.array(
      z.object({
        index: z.number().int(),
        type: z.number().int(),
        userDefined: z.boolean(),
        name: z.string()
      })
    ),
    nodeTypeCounts: z.array(z.object({ type: z.number().int(), count: z.number().int() })),
    /**
     * Other AINB files this one pulls in, from nodes whose name ends in `.module`.
     *
     * The one genuine relationship the format gives up without decoding node bodies — a real edge,
     * at file level rather than node level.
     */
    modules: z.array(z.string()),
    globalParameterCount: z.number().int(),
    parameterCounts: z.object({
      immediate: z.number().int(),
      input: z.number().int(),
      output: z.number().int()
    }),
    /** Anything the parser could not reconcile, in words. Empty for every file in the dump. */
    problems: z.array(z.string())
  }),
  /**
   * Recognised but with nothing to show yet. Carries the reason, because "this build does not
   * decode BFRES" and "this file is damaged" are different things to be told.
   */
  z.object({ kind: z.literal('unsupported'), reason: z.string() })
])

export type PreviewContent = z.infer<typeof previewContentSchema>

export const previewSchema = z.object({
  /** Filename or archive entry key, for the heading. */
  name: z.string(),
  /** Four-character magic or a friendly name, e.g. `BFOTF`. */
  format: z.string(),
  compression: compressionKindSchema,
  bytes: z.number().int(),
  content: previewContentSchema
})

export type Preview = z.infer<typeof previewSchema>

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

/**
 * A mod project: the pristine dump, and the layer being built over it.
 *
 * Paths are absolute. `titleId` and `gameVersion` are optional to create but
 * carried everywhere, because deploying and packaging both need the title id and
 * a mod that does not declare the version it was built against cannot be
 * version-gated on import.
 */
/**
 * Per-project settings, every one of which exists because a real project needed
 * it to be different.
 *
 * Defaults are the point: a project that never opens this is configured correctly
 * for the common case. Each field carries its own default, so a stored blob
 * missing half of them — written by an older build — still yields a complete
 * settings object rather than resetting the rest.
 */
export const modProjectSettingsSchema = z.object({
  /**
   * Where a deploy installs. Null auto-detects Astris and Ryujinx, which is right
   * until someone keeps their emulator data somewhere else.
   */
  emulatorDataDir: z.string().nullable().default(null),
  /**
   * Remove deployed files the mod no longer contains.
   *
   * On by default because the alternative is a reverted file the game still loads,
   * which looks exactly like an edit that did not take. Off for a mod that shares
   * its directory with something this app does not manage.
   */
  deployPrune: z.boolean().default(true),
  /**
   * Names that live in the mod folder but are not part of the mod.
   *
   * A romfs overlay is a mirror of the game's tree, so anything in it is handed to
   * the game. Documentation is the thing people reliably put there anyway.
   */
  excludedFiles: z.array(z.string()).default(['README.md']),
  /** ZSTD level for anything this app compresses. 17 is what these files ship at. */
  zstdLevel: z.number().int().min(1).max(22).default(17),
  /**
   * Warn when a file's size changed and no resource size table ships with it.
   *
   * The most common way a mod that is more than same-sized asset swaps goes wrong.
   * Off for a project that patches the table by some other means.
   */
  checkResourceSizeTable: z.boolean().default(true),
  /**
   * Warn when a mod file's name differs from a real one only by a compression
   * suffix — the game asks for an exact path, so such a file is never loaded.
   */
  checkCompressionSuffix: z.boolean().default(true),
  /**
   * Folders to index, relative to the dump. Empty means all of it.
   *
   * A full romfs index reads every file; a project that only ever touches
   * `Layout/` can say so and have it take seconds.
   */
  indexFolders: z.array(z.string()).default([])
})

export type ModProjectSettings = z.infer<typeof modProjectSettingsSchema>

/** A complete settings object from nothing, which is what every default is for. */
export const defaultProjectSettings = (): ModProjectSettings =>
  modProjectSettingsSchema.parse({})

export const modProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  dumpPath: z.string(),
  modPath: z.string(),
  titleId: z.string(),
  /**
   * The mod's directory name under `mods/contents/<title id>/`. Empty means it is
   * derived from the project name — which is only right for a mod that has nothing
   * else installing into the same directory.
   */
  modName: z.string(),
  gameVersion: z.string(),
  settings: modProjectSettingsSchema,
  active: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export type ModProject = z.infer<typeof modProjectSchema>

export const modProjectInputSchema = z.object({
  name: z.string().min(1),
  dumpPath: z.string().min(1),
  modPath: z.string().min(1),
  titleId: z.string().default(''),
  modName: z.string().default(''),
  gameVersion: z.string().default(''),
  settings: modProjectSettingsSchema.partial().optional()
})

export type ModProjectInput = z.infer<typeof modProjectInputSchema>

/**
 * What the mod layer currently holds, for the header badge and the mod summary.
 *
 * `files` is relative to the mod root, which is the form every other part of the
 * feature wants: it is the key into the pristine tree, the path inside a release
 * zip, and what a deploy copies.
 */
export const modLayerStatusSchema = z.object({
  project: modProjectSchema.nullable(),
  files: z.array(
    z.object({
      relativePath: z.string(),
      size: z.number().int(),
      modifiedAt: z.number().int(),
      /** False when the dump has no file at this path — the mod adds it outright. */
      replacesPristine: z.boolean()
    })
  ),
  totalBytes: z.number().int()
})

export type ModLayerStatus = z.infer<typeof modLayerStatusSchema>

/** An emulator data directory a deploy could install into. */
export const deployTargetSchema = z.object({
  label: z.string(),
  dataDir: z.string(),
  /** False when the directory was looked for and is not there. Still listed, so
   * the UI can say where it looked rather than only that it found nothing. */
  exists: z.boolean()
})

export type DeployTarget = z.infer<typeof deployTargetSchema>

export const deployResultSchema = z.object({
  /** The mod's romfs directory inside the emulator's mods tree. */
  target: z.string(),
  dataDir: z.string(),
  modName: z.string(),
  copied: z.number().int(),
  /**
   * Files removed from the deployed copy because the mod no longer contains them.
   * Reported rather than done quietly: a stale file the game still loads looks
   * exactly like an edit that did not take.
   */
  removed: z.array(z.string()),
  bytes: z.number().int()
})

export type DeployResult = z.infer<typeof deployResultSchema>

/**
 * One finding from checking a mod file.
 *
 * `error` means the file is very likely broken for the game; `warning` means it
 * works but something about it deserves a second look; `info` is context, not a
 * problem. Nothing here refuses to deploy — the judgement stays with the person
 * who knows what they were trying to do.
 */
export const checkNoteSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  message: z.string()
})

export type CheckNoteView = z.infer<typeof checkNoteSchema>

export const modCheckedFileSchema = z.object({
  relativePath: z.string(),
  /** What the bytes turned out to be, by magic rather than extension. */
  format: z.string(),
  compression: compressionKindSchema,
  replacesPristine: z.boolean(),
  notes: z.array(checkNoteSchema)
})

export type ModCheckedFile = z.infer<typeof modCheckedFileSchema>

export const modCheckReportSchema = z.object({
  modPath: z.string(),
  files: z.array(modCheckedFileSchema),
  /**
   * Findings about the mod as a whole rather than about one file — the resource
   * size table being the one that matters, since it is a hazard no per-file check
   * can see and the symptom looks nothing like the cause.
   */
  notes: z.array(checkNoteSchema),
  errors: z.number().int(),
  warnings: z.number().int()
})

export type ModCheckReport = z.infer<typeof modCheckReportSchema>

/**
 * What a name in the index turned out to be, and where it lives.
 *
 * `entryName` is set when the name was found inside an archive, which in a romfs
 * is the usual case — the layouts are entries, not files.
 */
export const indexHitSchema = z.object({
  kind: z.string(),
  name: z.string(),
  detail: z.string().nullable(),
  /** Path below the indexed dump root. */
  relativePath: z.string(),
  entryName: z.string().nullable(),
  format: z.string(),
  rootPath: z.string()
})

export type IndexSearchHit = z.infer<typeof indexHitSchema>
export type ReferenceHit = IndexSearchHit

export const indexedDumpSchema = z.object({
  rootPath: z.string(),
  builtAt: z.number().int(),
  fileCount: z.number().int(),
  symbolCount: z.number().int()
})

/**
 * How the current build is going, plus what is already indexed.
 *
 * Polled rather than pushed: it is one small object, the UI wants it on a timer
 * regardless, and a push channel would be a second thing to keep alive across a
 * build that can outlive the window that started it.
 */
export const indexProgressSchema = z.object({
  state: z.enum(['idle', 'building', 'ready', 'failed']),
  rootPath: z.string().nullable(),
  done: z.number().int(),
  total: z.number().int(),
  currentFile: z.string().nullable(),
  /** A summary when ready, the reason when failed. */
  detail: z.string().nullable(),
  indexed: z.array(indexedDumpSchema)
})

export type IndexProgress = z.infer<typeof indexProgressSchema>

/**
 * What the running game last said it was showing.
 *
 * `screen` is the game's own name for it — Colony's SDK already deals in these
 * (`open_screen("ScreenDialog")`). The rest is whatever the plugin can supply;
 * none of it is required, because a screen name alone is enough to search for.
 */
export const gameScreenReportSchema = z.object({
  screen: z.string(),
  layout: z.string().nullable(),
  archive: z.string().nullable(),
  detail: z.string().nullable(),
  receivedAt: z.number().int()
})

export type GameScreenReport = z.infer<typeof gameScreenReportSchema>

export const gameLinkStatusSchema = z.object({
  listening: z.boolean(),
  port: z.number().int(),
  last: gameScreenReportSchema.nullable(),
  /** A failure after startup, so a dead listener is visible rather than merely quiet. */
  error: z.string().nullable()
})

export type GameLinkStatus = z.infer<typeof gameLinkStatusSchema>

/**
 * One MCP tool call, as it happened.
 *
 * Recorded so the work an agent does to your files is something you watch rather
 * than infer. A tool with write access that leaves no trace is one you have to
 * trust blindly.
 */
export const mcpActivitySchema = z.object({
  tool: z.string(),
  /** Truncated: a base64 image or a whole YAML document would swamp the panel. */
  input: z.string(),
  summary: z.string(),
  ok: z.boolean(),
  at: z.number().int()
})

export type McpActivity = z.infer<typeof mcpActivitySchema>

export const mcpStatusSchema = z.object({
  listening: z.boolean(),
  port: z.number().int(),
  error: z.string().nullable(),
  calls: z.number().int(),
  /** Files an agent has written that the app may have open and stale. */
  edited: z.array(z.string())
})

export type McpStatus = z.infer<typeof mcpStatusSchema>

/**
 * One string in a message table.
 *
 * `text` renders inline commands as `{n:group.type}` placeholders. They can be
 * moved, repeated or removed while editing — moving a variable substitution to a
 * different point in a sentence is most of what translating is — but not invented,
 * because a placeholder the message never had has no payload to write.
 */
export const messageEntrySchema = z.object({
  index: z.number().int(),
  label: z.string(),
  text: z.string(),
  /** True when the string carries something the editor cannot express as plain text. */
  hasCommands: z.boolean()
})

export const messageTableSchema = z.object({
  displayName: z.string(),
  encoding: z.enum(['utf-8', 'utf-16']),
  littleEndian: z.boolean(),
  version: z.number().int(),
  sections: z.array(z.string()),
  messages: z.array(messageEntrySchema)
})

export type MessageTable = z.infer<typeof messageTableSchema>

export const messageReplaceResultSchema = z.object({
  dryRun: z.boolean(),
  root: z.string(),
  /** Where writes landed, when a mod project redirected them. */
  modPath: z.string().nullable(),
  totalMessages: z.number().int(),
  files: z.array(
    z.object({
      relativePath: z.string(),
      changed: z.number().int(),
      /**
       * A sample of before/after pairs. A batch edit over thousands of strings that
       * reports only a count is one nobody can check.
       */
      examples: z.array(
        z.object({ label: z.string(), before: z.string(), after: z.string() })
      ),
      /** Why this file was left alone, when it matched but could not be rewritten. */
      refused: z.string().nullable()
    })
  )
})

export type MessageReplaceResult = z.infer<typeof messageReplaceResultSchema>

/**
 * One structural change between the dump's copy of a file and the mod's.
 *
 * Phrased for a person, because this is what a release note and a review are made
 * of. A byte diff of a layout is unreadable and a byte diff of a `.szs` is worse —
 * recompression moves everything.
 */
export const layoutChangeSchema = z.object({
  kind: z.string(),
  target: z.string(),
  detail: z.string()
})

export const modFileDiffSchema = z.object({
  relativePath: z.string(),
  /** True when the dump has nothing at this path. */
  isNew: z.boolean(),
  /** One line, already grouped: "3 panes moved, 1 material changed". */
  summary: z.string(),
  changes: z.array(layoutChangeSchema),
  /** Entry names that differ, for an archive. */
  entries: z.array(z.string())
})

export type ModFileDiff = z.infer<typeof modFileDiffSchema>

export const modDiffReportSchema = z.object({
  modPath: z.string(),
  dumpPath: z.string(),
  files: z.array(modFileDiffSchema),
  totalChanges: z.number().int()
})

export type ModDiffReport = z.infer<typeof modDiffReportSchema>

export const modPackageResultSchema = z.object({
  path: z.string(),
  fileCount: z.number().int(),
  bytes: z.number().int(),
  titleId: z.string(),
  gameVersion: z.string()
})

export type ModPackageResult = z.infer<typeof modPackageResultSchema>

/**
 * What a package says about itself, read without installing it.
 *
 * The separation matters: a mod built against a different game build does not fail
 * cleanly — it loads and the game misbehaves — so the version has to be checked
 * before any bytes reach disk, not after.
 */
export const modPackageInfoSchema = z.object({
  path: z.string(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  author: z.string().nullable(),
  titleId: z.string().nullable(),
  gameVersion: z.string().nullable(),
  files: z.array(z.string()),
  /** Everything worth knowing before installing, phrased plainly. */
  warnings: z.array(z.string())
})

export type ModPackageInfo = z.infer<typeof modPackageInfoSchema>

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

/**
 * Where a browsed file comes from once a mod project is open.
 *
 * `pristine` is the dump's own copy, untouched. `modified` means the mod layer
 * holds a file at the same relative path, which is the one the game would load —
 * so that is the one `path` points at. `added` is a file the mod introduces that
 * the dump has no counterpart for.
 *
 * `pristine` is also what every entry reports when no project is active, which is
 * what keeps the plain file-browser case unchanged.
 */
export const folderOriginSchema = z.enum(['pristine', 'modified', 'added'])
export type FolderOrigin = z.infer<typeof folderOriginSchema>

export const folderEntrySchema = z.object({
  name: z.string(),
  /**
   * What opening this row opens. For a `modified` row that is the mod's copy, not
   * the dump's — the browser shows what the game would load, the same way the
   * emulator's LayeredFS resolves it.
   */
  path: z.string(),
  kind: folderEntryKindSchema,
  /** Bytes on disk; 0 for directories. */
  size: z.number().int().nonnegative(),
  /** True when the name ends in .zs or .szs, so it needs decompressing first. */
  compressed: z.boolean(),
  origin: folderOriginSchema,
  /** The dump's own copy, present only when this row shadows one. */
  pristinePath: z.string().optional(),
  /** Path below the mod root, for reverting. Present on `modified` and `added`. */
  relativePath: z.string().optional()
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
