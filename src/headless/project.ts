import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'

import { modProjectSettingsSchema, type ModProjectSettings } from '@shared/contract'
import { setZstdLevel } from '@main/compression-level'
import { setActiveLayer } from '@main/mod-layer'
import { setExcludedNames } from '@main/walk'

/**
 * The headless tools reading the app's mod project.
 *
 * Without this the CLI and the MCP server are a way to edit a pristine dump by
 * accident. The app makes the dump read-only and redirects saves into the mod
 * folder; a second tool that writes the same files with none of that is not a
 * companion, it is a hole in the guarantee — and the hole is invisible, because
 * the write succeeds.
 *
 * So they read the same database the app writes, take the active project from it,
 * and install it into the same process-wide layer (`mod-layer.ts`) that the app's
 * own writes go through. The copy-on-write and the refusal then apply here for
 * exactly the same reason and by exactly the same code.
 *
 * Read-only, and never a writer: the app owns this database. A tool that also
 * wrote it would be two processes racing over which project is active.
 */

export interface HeadlessProject {
  readonly name: string
  readonly dumpPath: string
  readonly modPath: string
  readonly titleId: string
  readonly modName: string
  readonly gameVersion: string
  readonly settings: ModProjectSettings
}

/**
 * Where Electron puts `userData` for this app, per platform.
 *
 * Derived rather than asked for, because asking would mean booting Electron —
 * which is the one thing these tools exist not to do. The app name comes from
 * `package.json`, which is what Electron defaults to.
 */
export function userDataDirectory(appName = 'bflayout'): string {
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', appName)
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), appName)
  }
  return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), appName)
}

/**
 * Settings validated per field, exactly as the app validates them.
 *
 * A blob written by a newer build than this binary, or an older one missing
 * fields, still yields a complete settings object — and one bad value does not
 * reset the rest.
 */
function readSettings(stored: string): ModProjectSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    parsed = {}
  }
  const source = (parsed ?? {}) as Record<string, unknown>

  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(modProjectSettingsSchema.shape)) {
    const candidate = field.safeParse(source[key])
    out[key] = candidate.success ? candidate.data : field.parse(undefined)
  }
  return out as ModProjectSettings
}

export interface ProjectLookup {
  readonly project: HeadlessProject | null
  /** Why there is no project, when there is none — a path, or a reason. */
  readonly detail: string
}

/**
 * Loads the active project and installs it as the write layer.
 *
 * Failure is never fatal. A missing database means the app has not been run, and
 * an unreadable one is not a reason to refuse to look at a file — both simply
 * mean there is no project, which is a normal way to use these tools.
 */
export function loadActiveProject(options?: { databasePath?: string }): ProjectLookup {
  const path = options?.databasePath ?? join(userDataDirectory(), 'bflayout.db')
  if (!existsSync(path)) {
    setActiveLayer(null)
    return {
      project: null,
      detail: `no BFLayout database at ${path} — writes go straight to the files named, with no mod layer`
    }
  }

  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const row = db
        .prepare(
          'select name, dump_path, mod_path, title_id, mod_name, game_version, settings from projects where active = 1 limit 1'
        )
        .get() as
        | {
            name: string
            dump_path: string
            mod_path: string
            title_id: string
            mod_name: string
            game_version: string
            settings: string
          }
        | undefined

      if (!row) {
        setActiveLayer(null)
        return {
          project: null,
          detail: 'no mod project is active in BFLayout — writes go straight to the files named'
        }
      }

      const project: HeadlessProject = {
        name: row.name,
        dumpPath: row.dump_path,
        modPath: row.mod_path,
        titleId: row.title_id,
        modName: row.mod_name,
        gameVersion: row.game_version,
        settings: readSettings(row.settings)
      }
      setActiveLayer({ dumpPath: project.dumpPath, modPath: project.modPath })
      /*
       * The rest of the project's settings, published the same way the app
       * publishes them. Without this the headless tools would compress at a
       * different level and disagree about what belongs to the mod — the sort of
       * divergence that shows up as an unexplained diff much later.
       */
      setZstdLevel(project.settings.zstdLevel)
      setExcludedNames(project.settings.excludedFiles)
      return {
        project,
        detail: `${project.name}: ${project.dumpPath} is read-only, edits land in ${project.modPath}`
      }
    } finally {
      db.close()
    }
  } catch (cause) {
    /*
     * An older database without the `mod_name` column lands here, as does one
     * being migrated by a running app. Reporting it and carrying on unprotected
     * would be the wrong trade — the whole point is that the dump cannot be
     * written by accident — so the layer is left unset *and* the reason is
     * returned, and callers surface it rather than swallowing it.
     */
    setActiveLayer(null)
    return {
      project: null,
      detail: `could not read the BFLayout database at ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    }
  }
}
