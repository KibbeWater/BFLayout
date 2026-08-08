import { Context } from 'effect'

export interface PathsShape {
  /** Directory for the sqlite database and other mutable app state. */
  readonly userData: string
  /** Directory holding generated drizzle migration SQL. */
  readonly migrations: string
}

/**
 * Declared as a bare tag with no Electron import so services depending on it
 * (Db and everything above it) can be exercised in plain vitest with a stub
 * layer. The live implementation lives in paths-live.ts.
 */
export class Paths extends Context.Tag('Paths')<Paths, PathsShape>() {}
