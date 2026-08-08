import { Effect } from 'effect'

import { appSettingsSchema, type AppSettings } from '@shared/contract'
import { Db, dbTry } from '@main/db/client'
import * as schema from '@main/db/schema'

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export class SettingsService extends Effect.Service<SettingsService>()('SettingsService', {
  effect: Effect.gen(function* () {
    const { db } = yield* Db

    const get = Effect.gen(function* () {
      const rows = yield* dbTry('read settings', () => db.select().from(schema.settings).all())
      const stored = new Map(rows.map((row) => [row.key, row.value]))

      // Validated per field rather than as one object: a single corrupt row
      // must not reset every other setting to its default.
      const result: Record<string, unknown> = {}
      for (const [key, field] of Object.entries(appSettingsSchema.shape)) {
        const raw = stored.get(key)
        const candidate = raw === undefined ? undefined : safeJson(raw)
        const parsed = field.safeParse(candidate)
        result[key] = parsed.success ? parsed.data : field.parse(undefined)
      }
      return result as AppSettings
    })

    const patch = (input: Partial<AppSettings>) =>
      Effect.gen(function* () {
        const entries = Object.entries(input).filter(([, value]) => value !== undefined)
        if (entries.length > 0) {
          const now = Date.now()
          yield* dbTry('write a setting', () =>
            db.transaction((tx) => {
              for (const [key, value] of entries) {
                const encoded = JSON.stringify(value)
                tx.insert(schema.settings)
                  .values({ key, value: encoded, updatedAt: now })
                  .onConflictDoUpdate({
                    target: schema.settings.key,
                    set: { value: encoded, updatedAt: now }
                  })
                  .run()
              }
            })
          )
        }
        return yield* get
      })

    return { get, patch } as const
  })
}) {}
