import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

import type { WindowState } from '@shared/contract'
import { Db, dbTry } from '@main/db/client'
import * as schema from '@main/db/schema'

const MAIN_WINDOW = 'main'

export class WindowStateService extends Effect.Service<WindowStateService>()('WindowStateService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db

    const get = Effect.gen(function* () {
      const row = yield* dbTry('read the saved window position', () =>
        db.select().from(schema.windowState).where(eq(schema.windowState.id, MAIN_WINDOW)).get()
      )
      if (!row) return null
      return {
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        maximized: row.maximized
      } satisfies WindowState
    })

    const set = (state: WindowState) =>
      dbTry('save the window position', () =>
        db
          .insert(schema.windowState)
          .values({ id: MAIN_WINDOW, ...state })
          .onConflictDoUpdate({ target: schema.windowState.id, set: { ...state } })
          .run()
      )

    return { get, set } as const
  })
}) {}
