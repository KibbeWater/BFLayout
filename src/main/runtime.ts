import { Layer, ManagedRuntime } from 'effect'

import { Db } from './db/client'
import { AnimationService } from './services/animation'
import { ArchiveService } from './services/archive'
import { CompressionService } from './services/compression'
import { DialogService } from './services/dialog'
import { FilesService } from './services/files'
import { FolderService } from './services/folder'
import { LayoutService } from './services/layout'
import { PathsLive } from './services/paths-live'
import { RecentsService } from './services/recents'
import { SettingsService } from './services/settings'
import { TextureService } from './services/textures'
import { WindowStateService } from './services/window-state'
import { WorkspaceService } from './services/workspace'

/**
 * Db and the leaf services are provided once beneath everything else rather
 * than listed as each service's dependency, so layer memoization gives all of
 * them the same sqlite connection and the same in-memory archive sessions.
 */
export const AppLayer = Layer.mergeAll(
  SettingsService.Default,
  RecentsService.Default,
  WindowStateService.Default,
  DialogService.Default,
  LayoutService.Default,
  TextureService.Default,
  AnimationService.Default,
  WorkspaceService.Default,
  FolderService.Default
).pipe(
  Layer.provideMerge(ArchiveService.Default),
  Layer.provideMerge(Layer.mergeAll(FilesService.Default, CompressionService.Default)),
  Layer.provide(Db.Default),
  Layer.provide(PathsLive)
)

export const runtime = ManagedRuntime.make(AppLayer)

export type AppServices = Layer.Layer.Success<typeof AppLayer>
