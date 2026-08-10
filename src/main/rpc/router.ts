import { resolve } from 'node:path'
import { implement } from '@orpc/server'
import { Effect } from 'effect'

import { contract, parseSnapshotKey } from '@shared/contract'
import { AnimationService } from '@main/services/animation'
import { ArchiveService } from '@main/services/archive'
import { DeployService } from '@main/services/deploy'
import { DialogService } from '@main/services/dialog'
import { BymlService } from '@main/services/byml'
import { SnapshotService } from '@main/services/snapshots'
import { FolderService } from '@main/services/folder'
import { FontService } from '@main/services/fonts'
import { PreviewService } from '@main/services/preview'
import { FilesService } from '@main/services/files'
import { GameLinkService } from '@main/services/game-link'
import { IndexService } from '@main/services/index-service'
import { LayoutService } from '@main/services/layout'
import { MessageService } from '@main/services/messages'
import { McpHttpService } from '@main/services/mcp-http'
import { ModCheckService } from '@main/services/mod-check'
import { ModDiffService } from '@main/services/mod-diff'
import { PackageService } from '@main/services/package'
import { ProjectService } from '@main/services/projects'
import { RecentsService } from '@main/services/recents'
import { SettingsService } from '@main/services/settings'
import { TextureService } from '@main/services/textures'
import { WindowStateService } from '@main/services/window-state'
import { WorkspaceService } from '@main/services/workspace'
import { NotFoundError } from '@main/errors'
import { FormatWriteError } from '@shared/binary/errors'
import { setUnsavedCount } from '@main/unsaved'
import { run } from './run'

const os = implement(contract)

const ok = { ok: true } as const

const settings = {
  get: os.app.settings.get.handler(() => run(Effect.flatMap(SettingsService, (s) => s.get))),

  patch: os.app.settings.patch.handler(({ input }) =>
    run(Effect.flatMap(SettingsService, (s) => s.patch(input)))
  )
}

const recents = {
  list: os.app.recents.list.handler(() => run(Effect.flatMap(RecentsService, (s) => s.list))),

  add: os.app.recents.add.handler(({ input }) =>
    run(Effect.flatMap(RecentsService, (s) => s.add(input)))
  ),

  setPinned: os.app.recents.setPinned.handler(async ({ input }) => {
    await run(Effect.flatMap(RecentsService, (s) => s.setPinned(input)))
    return ok
  }),

  remove: os.app.recents.remove.handler(async ({ input }) => {
    await run(Effect.flatMap(RecentsService, (s) => s.remove(input)))
    return ok
  }),

  clear: os.app.recents.clear.handler(async () => {
    await run(Effect.flatMap(RecentsService, (s) => s.clear))
    return ok
  })
}

const windowState = {
  get: os.app.windowState.get.handler(() =>
    run(Effect.flatMap(WindowStateService, (s) => s.get))
  ),

  set: os.app.windowState.set.handler(async ({ input }) => {
    await run(Effect.flatMap(WindowStateService, (s) => s.set(input)))
    return ok
  })
}

const folderRoutes = {
  list: os.folder.list.handler(({ input }) =>
    run(Effect.flatMap(FolderService, (s) => s.list(input.path)))
  ),

  identify: os.folder.identify.handler(({ input }) =>
    run(Effect.flatMap(FolderService, (s) => s.identify(input.path)))
  )
}

const workspace = {
  get: os.app.workspace.get.handler(() =>
    run(Effect.flatMap(WorkspaceService, (s) => s.load))
  ),

  set: os.app.workspace.set.handler(async ({ input }) => {
    await run(Effect.flatMap(WorkspaceService, (s) => s.save(input)))
    return ok
  }),

  clear: os.app.workspace.clear.handler(async () => {
    await run(Effect.flatMap(WorkspaceService, (s) => s.clear))
    return ok
  })
}

/**
 * The renderer's unsaved-tab count, mirrored into main so the window-close and
 * quit handlers can see it. See src/main/unsaved.ts for why it is not a service.
 */
const setUnsaved = os.app.setUnsavedCount.handler(({ input }) => {
  setUnsavedCount(input.count)
  return ok
})

const dialogRoutes = {
  confirmDiscard: os.dialog.confirmDiscard.handler(({ input }) =>
    run(Effect.flatMap(DialogService, (s) => s.confirmDiscard(input)))
  ),

  openFiles: os.dialog.openFiles.handler(({ input }) =>
    run(
      Effect.flatMap(DialogService, (s) =>
        s.openFiles({
          purpose: input.purpose,
          ...(input.multiple === undefined ? {} : { multiple: input.multiple })
        })
      )
    )
  ),

  openFolder: os.dialog.openFolder.handler(({ input }) =>
    run(
      Effect.flatMap(DialogService, (s) =>
        s.openFolder({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.buttonLabel === undefined ? {} : { buttonLabel: input.buttonLabel })
        })
      )
    )
  ),

  saveFileAs: os.dialog.saveFileAs.handler(({ input }) =>
    run(
      Effect.flatMap(DialogService, (s) =>
        s.saveFileAs({
          purpose: input.purpose,
          ...(input.defaultName === undefined ? {} : { defaultName: input.defaultName })
        })
      )
    )
  )
}

/**
 * Refuses a structural edit to an entry a tab is editing.
 *
 * The tab holds its own copy of the layout, so its next save re-encodes that under
 * the key it was opened with — resurrecting a deleted entry, or duplicating a
 * renamed one. The edit would appear to work and be quietly undone later.
 */
const refuseWhileOpen = (
  archiveId: string,
  entryKey: string,
  what: string
): Effect.Effect<void, FormatWriteError, LayoutService> =>
  Effect.gen(function* () {
    const layouts = yield* LayoutService
    const open = yield* layouts.list
    const holder = open.find(
      (entry) =>
        entry.source.kind === 'archive' &&
        entry.source.archiveId === archiveId &&
        entry.source.entryKey === entryKey
    )
    if (holder) {
      yield* Effect.fail(
        new FormatWriteError({
          format: 'sarc',
          section: entryKey,
          message: `${holder.displayName} is open in the editor; close that tab before ${what} it, or its next save will put the entry back`
        })
      )
    }
  })

const archiveRoutes = {
  open: os.archive.open.handler(({ input }) =>
    run(Effect.flatMap(ArchiveService, (s) => s.openPath(input.path)))
  ),

  get: os.archive.get.handler(({ input }) =>
    run(Effect.flatMap(ArchiveService, (s) => s.describeOne(input.archiveId)))
  ),

  list: os.archive.list.handler(() => run(Effect.flatMap(ArchiveService, (s) => s.list))),

  recoverNames: os.archive.recoverNames.handler(({ input }) =>
    run(Effect.flatMap(ArchiveService, (s) => s.recoverNames(input.archiveId, input.candidates)))
  ),

  save: os.archive.save.handler(({ input }) =>
    run(Effect.flatMap(ArchiveService, (s) => s.save(input.archiveId, input.path)))
  ),

  extractEntry: os.archive.extractEntry.handler(({ input }) =>
    run(
      Effect.flatMap(ArchiveService, (s) =>
        s.extractEntry(input.archiveId, input.entryKey, input.path)
      )
    )
  ),

  /**
   * Replacing an entry is refused while a document from it is open.
   *
   * Otherwise the import is silently undone: that tab holds its own copy of the layout, and its
   * next save re-encodes *that* over the bytes just imported. The user would see a successful
   * import, keep working, save, and find their imported file gone with nothing having reported a
   * problem.
   *
   * The check lives here rather than in ArchiveService because only LayoutService knows what is
   * open, and it depends on ArchiveService — so the router is the one place that can see both.
   * It is main-side on purpose: the archive and the sessions both live here, and a renderer
   * guard would be advisory.
   */
  importEntry: os.archive.importEntry.handler(({ input }) =>
    run(
      Effect.gen(function* () {
        const layouts = yield* LayoutService
        const open = yield* layouts.list
        const holder = open.find(
          (entry) =>
            entry.source.kind === 'archive' &&
            entry.source.archiveId === input.archiveId &&
            entry.source.entryKey === input.entryKey
        )
        if (holder) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'sarc',
              section: input.entryKey,
              message: `${holder.displayName} is open in the editor; close that tab before replacing it, or its next save will overwrite the imported file`
            })
          )
        }

        const archives = yield* ArchiveService
        return yield* archives.importEntry(input.archiveId, input.entryKey, input.path)
      })
    )
  ),

  addEntry: os.archive.addEntry.handler(({ input }) =>
    run(
      Effect.gen(function* () {
        const filesService = yield* FilesService
        const data = yield* filesService.read(input.path)
        const archives = yield* ArchiveService
        const archive = yield* archives.addEntry(input.archiveId, input.name, data)
        return { archive, bytes: data.length }
      })
    )
  ),

  /**
   * Deleting and renaming are refused while a tab holds a layout from the entry.
   *
   * Same reasoning as the import refusal above: that tab's next save writes its own
   * copy back under the old key, which would either resurrect a deleted entry or
   * leave a renamed one duplicated. Only the router sees both the archive and the
   * open documents.
   */
  deleteEntry: os.archive.deleteEntry.handler(({ input }) =>
    run(
      Effect.gen(function* () {
        yield* refuseWhileOpen(input.archiveId, input.entryKey, 'deleting')
        const archives = yield* ArchiveService
        return yield* archives.deleteEntry(input.archiveId, input.entryKey)
      })
    )
  ),

  renameEntry: os.archive.renameEntry.handler(({ input }) =>
    run(
      Effect.gen(function* () {
        yield* refuseWhileOpen(input.archiveId, input.entryKey, 'renaming')
        const archives = yield* ArchiveService
        return yield* archives.renameEntry(input.archiveId, input.entryKey, input.name)
      })
    )
  ),

  duplicateEntry: os.archive.duplicateEntry.handler(({ input }) =>
    run(
      Effect.flatMap(ArchiveService, (s) =>
        s.duplicateEntry(input.archiveId, input.entryKey, input.name)
      )
    )
  ),

  close: os.archive.close.handler(async ({ input }) => {
    await run(Effect.flatMap(ArchiveService, (s) => s.close(input.archiveId)))
    return ok
  })
}

const layoutRoutes = {
  open: os.layout.open.handler(({ input }) =>
    run(Effect.flatMap(LayoutService, (s) => s.openLayout(input.source)))
  ),

  list: os.layout.list.handler(() => run(Effect.flatMap(LayoutService, (s) => s.list))),

  parts: os.layout.parts.handler(({ input }) =>
    run(Effect.flatMap(LayoutService, (s) => s.parts(input.source, input.names)))
  ),

  save: os.layout.save.handler(({ input }) =>
    run(
      Effect.flatMap(LayoutService, (s) => s.save(input.documentId, input.document, input.path))
    )
  ),

  close: os.layout.close.handler(async ({ input }) => {
    await run(Effect.flatMap(LayoutService, (s) => s.close(input.documentId)))
    return ok
  })
}

const textureRoutes = {
  list: os.textures.list.handler(({ input }) =>
    run(Effect.flatMap(TextureService, (s) => s.list(input.source)))
  ),

  get: os.textures.get.handler(({ input }) =>
    run(Effect.flatMap(TextureService, (s) => s.get(input.source, input.name, input.mip)))
  ),

  importPng: os.textures.importPng.handler(({ input }) =>
    run(
      Effect.flatMap(TextureService, (s) => s.importPng(input.source, input.name, input.path))
    )
  ),

  exportPng: os.textures.exportPng.handler(({ input }) =>
    run(
      Effect.flatMap(TextureService, (s) =>
        s.exportPng(input.source, input.name, input.path, input.mip)
      )
    )
  )
}

const animationRoutes = {
  list: os.animation.list.handler(({ input }) =>
    run(Effect.flatMap(AnimationService, (s) => s.list(input.source)))
  ),

  open: os.animation.open.handler(({ input }) =>
    run(Effect.flatMap(AnimationService, (s) => s.openAnimation(input.source, input.key)))
  ),

  close: os.animation.close.handler(async ({ input }) => {
    await run(Effect.flatMap(AnimationService, (s) => s.close(input.animationId)))
    return ok
  })
}

const snapshotRoutes = {
  put: os.snapshot.put.handler(async ({ input }) => {
    await run(Effect.flatMap(SnapshotService, (s) => s.put(input)))
    return ok
  }),

  list: os.snapshot.list.handler(() => run(Effect.flatMap(SnapshotService, (s) => s.list()))),

  /**
   * Reopens the file a snapshot names and swaps the recovered document in, so the tab
   * the renderer gets back is indistinguishable from a normal open — session, preserved
   * bytes and all — and can therefore be saved.
   *
   * A row whose document will not parse, or whose key this build cannot read, is
   * reported as gone rather than half-restored: the caller discards it and says so.
   */
  restore: os.snapshot.restore.handler(({ input }) =>
    run(
      Effect.gen(function* () {
        const snapshotService = yield* SnapshotService
        const record = yield* snapshotService.get(input.key)
        const source = parseSnapshotKey(input.key)
        if (!record || !source) {
          return yield* Effect.fail(new NotFoundError({ kind: 'recovery snapshot', id: input.key }))
        }

        const layouts = yield* LayoutService
        const opened = yield* layouts.restore(source, record.document)
        return { ...opened, updatedAt: record.updatedAt }
      })
    )
  ),

  remove: os.snapshot.remove.handler(async ({ input }) => {
    await run(Effect.flatMap(SnapshotService, (s) => s.remove(input.key)))
    return ok
  }),

  clear: os.snapshot.clear.handler(async () => {
    await run(Effect.flatMap(SnapshotService, (s) => s.clear()))
    return ok
  })
}

/**
 * Font lookups are read-only and cached in main, so this is a thin passthrough. A layout
 * whose fonts cannot be found is a normal outcome — not every dump ships a Font directory
 * — and the typed NOT_FOUND lets the renderer fall back quietly rather than shout.
 */
const fontRoutes = {
  chain: os.fonts.chain.handler(({ input }) =>
    run(Effect.flatMap(FontService, (s) => s.chain(input.source, input.name)))
  )
}

const previewRoutes = {
  open: os.preview.open.handler(({ input }) =>
    run(Effect.flatMap(PreviewService, (s) => s.open(input.source)))
  )
}

const bymlRoutes = {
  open: os.byml.open.handler(({ input }) =>
    run(Effect.flatMap(BymlService, (s) => s.open(input.path)))
  )
}

const projectRoutes = {
  list: os.project.list.handler(() => run(Effect.flatMap(ProjectService, (s) => s.list))),

  active: os.project.active.handler(() => run(Effect.flatMap(ProjectService, (s) => s.active))),

  create: os.project.create.handler(({ input }) =>
    run(Effect.flatMap(ProjectService, (s) => s.create(input)))
  ),

  update: os.project.update.handler(({ input }) =>
    run(Effect.flatMap(ProjectService, (s) => s.update(input.id, input.patch)))
  ),

  setActive: os.project.setActive.handler(({ input }) =>
    run(Effect.flatMap(ProjectService, (s) => s.setActive(input.id)))
  ),

  remove: os.project.remove.handler(async ({ input }) => {
    await run(Effect.flatMap(ProjectService, (s) => s.remove(input.id)))
    return ok
  }),

  status: os.project.status.handler(() => run(Effect.flatMap(ProjectService, (s) => s.status))),

  /**
   * Reverting is refused while a tab is editing the file being reverted.
   *
   * Same shape as the archive-import refusal above, and the same reasoning: that
   * tab holds its own copy, so its next save would recreate the mod file the
   * revert had just deleted. The revert would appear to work, the badge would
   * clear, and the change would come back on the next save with nothing having
   * reported a problem. Only the router sees both the project and the open
   * documents, so the check lives here.
   */
  revert: os.project.revert.handler(({ input }) =>
    run(
      Effect.gen(function* () {
        const projects = yield* ProjectService
        const project = yield* projects.active
        if (!project) {
          return yield* Effect.fail(new NotFoundError({ kind: 'active mod project', id: '' }))
        }

        const target = resolve(project.modPath, input.relativePath)
        const layouts = yield* LayoutService
        const open = yield* layouts.list
        const holder = open.find(
          (entry) => entry.source.kind === 'file' && resolve(entry.source.path) === target
        )
        if (holder) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'mod',
              section: input.relativePath,
              message: `${holder.displayName} is open in the editor; close that tab before reverting, or its next save will put the file straight back`
            })
          )
        }

        const archives = yield* ArchiveService
        const openArchives = yield* archives.list
        const archiveHolder = openArchives.find(
          (entry) => resolve(entry.path) === target && entry.dirty
        )
        if (archiveHolder) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'mod',
              section: input.relativePath,
              message: `${archiveHolder.displayName} is open with unsaved changes; save or close it before reverting`
            })
          )
        }

        return yield* projects.revert(input.relativePath)
      })
    )
  )
}

const deployRoutes = {
  targets: os.deploy.targets.handler(() => run(Effect.flatMap(DeployService, (s) => s.targets))),

  run: os.deploy.run.handler(({ input }) =>
    run(
      Effect.flatMap(DeployService, (s) =>
        s.run({
          ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
          ...(input.modName === undefined ? {} : { modName: input.modName })
        })
      )
    )
  )
}

const modCheckRoutes = {
  run: os.modCheck.run.handler(() => run(Effect.flatMap(ModCheckService, (s) => s.run)))
}

const indexRoutes = {
  status: os.index.status.handler(() => run(Effect.flatMap(IndexService, (s) => s.status))),

  build: os.index.build.handler(({ input }) =>
    run(Effect.flatMap(IndexService, (s) => s.start(input.rootPath)))
  ),

  search: os.index.search.handler(({ input }) =>
    run(
      Effect.flatMap(IndexService, (s) =>
        s.search({
          query: input.query,
          ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
          ...(input.rootPath === undefined ? {} : { rootPath: input.rootPath }),
          ...(input.limit === undefined ? {} : { limit: input.limit })
        })
      )
    )
  ),

  references: os.index.references.handler(({ input }) =>
    run(
      Effect.flatMap(IndexService, (s) =>
        s.references({
          name: input.name,
          ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
          ...(input.rootPath === undefined ? {} : { rootPath: input.rootPath }),
          ...(input.limit === undefined ? {} : { limit: input.limit })
        })
      )
    )
  ),

  names: os.index.names.handler(({ input }) =>
    run(
      Effect.flatMap(IndexService, (s) =>
        s.names({
          kind: input.kind,
          ...(input.rootPath === undefined ? {} : { rootPath: input.rootPath })
        })
      )
    )
  ),

  drop: os.index.drop.handler(async ({ input }) => {
    await run(Effect.flatMap(IndexService, (s) => s.drop(input.rootPath)))
    return ok
  })
}

const gameLinkRoutes = {
  status: os.gameLink.status.handler(() => run(Effect.flatMap(GameLinkService, (s) => s.status))),

  start: os.gameLink.start.handler(({ input }) =>
    run(Effect.flatMap(GameLinkService, (s) => s.start(input.port)))
  ),

  stop: os.gameLink.stop.handler(() =>
    run(Effect.flatMap(GameLinkService, (s) => Effect.zipRight(s.stop, s.status)))
  ),

  clear: os.gameLink.clear.handler(() =>
    run(Effect.flatMap(GameLinkService, (s) => Effect.zipRight(s.clear, s.status)))
  )
}

const messageRoutes = {
  open: os.messages.open.handler(({ input }) =>
    run(Effect.flatMap(MessageService, (s) => s.open(input.source)))
  ),

  save: os.messages.save.handler(({ input }) =>
    run(Effect.flatMap(MessageService, (s) => s.save(input.source, input.edits)))
  ),

  replaceAll: os.messages.replaceAll.handler(({ input }) =>
    run(Effect.flatMap(MessageService, (s) => s.replaceAll(input)))
  )
}

const modDiffRoutes = {
  run: os.modDiff.run.handler(() => run(Effect.flatMap(ModDiffService, (s) => s.run)))
}

const packageRoutes = {
  export: os.package.export.handler(({ input }) =>
    run(Effect.flatMap(PackageService, (s) => s.exportMod(input)))
  ),

  inspect: os.package.inspect.handler(({ input }) =>
    run(Effect.flatMap(PackageService, (s) => s.inspect(input.path)))
  ),

  import: os.package.import.handler(({ input }) =>
    run(Effect.flatMap(PackageService, (s) => s.importMod(input)))
  )
}

const mcpRoutes = {
  status: os.mcp.status.handler(() => run(Effect.flatMap(McpHttpService, (s) => s.status))),

  start: os.mcp.start.handler(({ input }) =>
    run(Effect.flatMap(McpHttpService, (s) => s.start(input.port)))
  ),

  stop: os.mcp.stop.handler(() =>
    run(Effect.flatMap(McpHttpService, (s) => Effect.zipRight(s.stop, s.status)))
  ),

  activity: os.mcp.activity.handler(({ input }) =>
    run(Effect.flatMap(McpHttpService, (s) => s.recent(input.limit)))
  ),

  clear: os.mcp.clear.handler(async () => {
    await run(Effect.flatMap(McpHttpService, (s) => s.clear))
    return ok
  }),

  acknowledgeEdits: os.mcp.acknowledgeEdits.handler(async () => {
    await run(Effect.flatMap(McpHttpService, (s) => s.acknowledgeEdits))
    return ok
  })
}

export const router = os.router({
  app: { settings, recents, windowState, workspace, setUnsavedCount: setUnsaved },
  dialog: dialogRoutes,
  archive: archiveRoutes,
  layout: layoutRoutes,
  textures: textureRoutes,
  animation: animationRoutes,
  folder: folderRoutes,
  fonts: fontRoutes,
  preview: previewRoutes,
  byml: bymlRoutes,
  snapshot: snapshotRoutes,
  project: projectRoutes,
  deploy: deployRoutes,
  modCheck: modCheckRoutes,
  index: indexRoutes,
  gameLink: gameLinkRoutes,
  mcp: mcpRoutes,
  messages: messageRoutes,
  modDiff: modDiffRoutes,
  package: packageRoutes
})

export type AppRouter = typeof router
