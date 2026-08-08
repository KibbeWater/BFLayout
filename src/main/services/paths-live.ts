import { join } from 'node:path'
import { app } from 'electron'
import { Effect, Layer } from 'effect'

import { Paths } from './paths'

export const PathsLive = Layer.effect(
  Paths,
  Effect.sync(() => ({
    userData: app.getPath('userData'),
    // electron-builder ships drizzle/ via extraResources when packaged.
    migrations: app.isPackaged
      ? join(process.resourcesPath, 'drizzle')
      : join(app.getAppPath(), 'drizzle')
  }))
)
