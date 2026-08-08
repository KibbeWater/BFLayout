import { implement } from '@orpc/server'
import { Effect } from 'effect'

import { contract, parseSnapshotKey } from '@shared/contract'
import { AnimationService } from '@main/services/animation'
import { ArchiveService } from '@main/services/archive'
import { DialogService } from '@main/services/dialog'
import { BymlService } from '@main/services/byml'
import { SnapshotService } from '@main/services/snapshots'
import { FolderService } from '@main/services/folder'
import { FontService } from '@main/services/fonts'
import { LayoutService } from '@main/services/layout'
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

  openFolder: os.dialog.openFolder.handler(() =>
    run(Effect.flatMap(DialogService, (s) => s.openFolder))
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

const bymlRoutes = {
  open: os.byml.open.handler(({ input }) =>
    run(Effect.flatMap(BymlService, (s) => s.open(input.path)))
  )
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
  byml: bymlRoutes,
  snapshot: snapshotRoutes
})

export type AppRouter = typeof router
