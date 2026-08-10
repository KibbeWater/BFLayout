import { Layer, ManagedRuntime } from 'effect'

import { Db } from './db/client'
import { AnimationService } from './services/animation'
import { ArchiveService } from './services/archive'
import { CompressionService } from './services/compression'
import { DeployService } from './services/deploy'
import { DialogService } from './services/dialog'
import { FilesService } from './services/files'
import { BymlService } from './services/byml'
import { SnapshotService } from './services/snapshots'
import { FolderService } from './services/folder'
import { GameLinkService } from './services/game-link'
import { IndexService } from './services/index-service'
import { LayoutService } from './services/layout'
import { MessageService } from './services/messages'
import { McpHttpService } from './services/mcp-http'
import { ModCheckService } from './services/mod-check'
import { ModDiffService } from './services/mod-diff'
import { PackageService } from './services/package'
import { PathsLive } from './services/paths-live'
import { ProjectService } from './services/projects'
import { RecentsService } from './services/recents'
import { SettingsService } from './services/settings'
import { TextureService } from './services/textures'
import { FontService } from './services/fonts'
import { PreviewService } from './services/preview'
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
  TextureService.Default,
  FontService.Default,
  PreviewService.Default,
  AnimationService.Default,
  WorkspaceService.Default,
  FolderService.Default,
  BymlService.Default,
  SnapshotService.Default,
  DeployService.Default,
  ModCheckService.Default,
  IndexService.Default,
  GameLinkService.Default,
  MessageService.Default,
  ModDiffService.Default,
  PackageService.Default,
  /*
   * Above LayoutService in the composition rather than beside it: the MCP server
   * reports which layouts are open, so it depends on the service that knows.
   */
  McpHttpService.Default
).pipe(
  /*
   * Beneath the services that use it, and merged rather than merely provided so it
   * stays reachable from the router.
   *
   * Its construction is what republishes the active project's read-only dump into
   * `mod-layer.ts`, and being part of the composition means that happens when the
   * runtime is built — before any save can be attempted, rather than the first
   * time something happens to ask for a project.
   */
  Layer.provideMerge(LayoutService.Default),
  Layer.provideMerge(ProjectService.Default),
  Layer.provideMerge(ArchiveService.Default),
  Layer.provideMerge(Layer.mergeAll(FilesService.Default, CompressionService.Default)),
  Layer.provide(Db.Default),
  Layer.provide(PathsLive)
)

export const runtime = ManagedRuntime.make(AppLayer)

export type AppServices = Layer.Layer.Success<typeof AppLayer>
