import { implement } from '@orpc/server'
import { Effect } from 'effect'

import { contract, parseSnapshotKey } from '@shared/contract'
import { AnimationService } from '@main/services/animation'
import { ArchiveService } from '@main/services/archive'
import { DialogService } from '@main/services/dialog'
import { BymlService } from '@main/services/byml'
import { SnapshotService } from '@main/services/snapshots'
import { FolderService } from '@main/services/folder'
import { LayoutService } from '@main/services/layout'
import { RecentsService } from '@main/services/recents'
import { SettingsService } from '@main/services/settings'
import { TextureService } from '@main/services/textures'
import { WindowStateService } from '@main/services/window-state'
import { WorkspaceService } from '@main/services/workspace'
import { NotFoundError } from '@main/errors'
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
  byml: bymlRoutes,
  snapshot: snapshotRoutes
})

export type AppRouter = typeof router
