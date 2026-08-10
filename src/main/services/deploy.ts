import { homedir } from 'node:os'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'

import type { DeployResult, DeployTarget } from '@shared/contract'
import { DbError, IoError, NotFoundError } from '@main/errors'
import { walkFiles } from '@main/walk'
import { ProjectService } from './projects'

/**
 * Installing the mod layer where the emulator will load it.
 *
 * A romfs mod is discovered at `mods/contents/<title id>/<mod name>/romfs`, and
 * the emulator composes it over the game's own files at load time — which is
 * exactly what the mod layer already is, so deploying is a copy rather than a
 * build step.
 *
 * The candidate directories are the ones Colony's `loader/deploy.sh` already
 * knows: Astris is a macOS-native Ryujinx fork whose data lives inside an app
 * container, but the tree underneath is Ryujinx's verbatim, so one layout covers
 * both. Nothing here launches the emulator — deploying and running are separate
 * decisions, and a tool that starts a game because you saved a file is a tool
 * people learn to be afraid of.
 */

interface Candidate {
  readonly label: string
  readonly dataDir: string
}

function candidates(): Candidate[] {
  const home = homedir()
  const found: Candidate[] = [
    {
      label: 'Astris',
      dataDir: join(
        home,
        'Library/Containers/V380-Ori.Astris/Data/Library/Application Support/Ryujinx'
      )
    },
    { label: 'Ryujinx (macOS)', dataDir: join(home, 'Library/Application Support/Ryujinx') },
    { label: 'Ryujinx (Linux)', dataDir: join(home, '.config/Ryujinx') }
  ]

  const appData = process.env['APPDATA']
  if (appData) found.push({ label: 'Ryujinx (Windows)', dataDir: join(appData, 'Ryujinx') })
  return found
}

/** A mod name safe to use as a directory, derived from the project's. */
export function modDirectoryName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'mod' : cleaned
}

export class DeployService extends Effect.Service<DeployService>()('DeployService', {
  effect: Effect.gen(function* () {
    const projects = yield* ProjectService

    /** Which emulator data directories are actually present on this machine. */
    const targets: Effect.Effect<DeployTarget[]> = Effect.promise(async () => {
      const found: DeployTarget[] = []
      for (const candidate of candidates()) {
        let exists = false
        try {
          exists = (await stat(candidate.dataDir)).isDirectory()
        } catch {
          exists = false
        }
        found.push({ label: candidate.label, dataDir: candidate.dataDir, exists })
      }
      return found
    })

    /**
     * Copies the mod layer into an emulator's mods directory.
     *
     * Files the layer no longer contains are removed from the deployed copy, and
     * this is not optional. Reverting a file and then deploying would otherwise
     * leave the old copy in place and the game would go on loading it — the edit
     * would look like it had not taken, and the obvious next move (revert
     * something else, deploy again) makes it no clearer. What was removed is
     * reported alongside what was written.
     *
     * The pruning is confined to this mod's own directory, which the deploy owns
     * by name. Nothing outside `mods/contents/<title>/<mod>/romfs` is touched.
     */
    const run = (options: {
      dataDir?: string
      modName?: string
    }): Effect.Effect<DeployResult, DbError | IoError | NotFoundError> =>
      Effect.gen(function* () {
        const project = yield* projects.active
        if (!project) {
          return yield* Effect.fail(
            new NotFoundError({ kind: 'active mod project', id: 'deploy needs one' })
          )
        }
        if (project.titleId.trim() === '') {
          return yield* Effect.fail(
            new IoError({
              detail: `${project.name} has no title ID, and a mod is found by title: it has to live under mods/contents/<title id>/. Add one to the project first.`
            })
          )
        }

        /*
         * Explicit argument, then the project's own setting, then auto-detection.
         * The setting exists for the machine that keeps its emulator data
         * somewhere the three known locations do not cover.
         */
        const dataDir =
          options.dataDir ?? project.settings.emulatorDataDir ?? (yield* firstPresent)
        /*
         * The project's own mod name wins over one derived from its title.
         *
         * A mod that is more than asset replacement installs a code half as well,
         * into the same `contents/<title>/<mod>/` directory — Colony puts a
         * `subsdk9` in `colony/exefs` and its assets in `colony/romfs`. Deriving a
         * name here would install a second, parallel mod that the loader's own
         * deploy does not manage, and the two would drift.
         */
        const modName = modDirectoryName(
          options.modName ?? (project.modName.trim() !== '' ? project.modName : project.name)
        )
        const romfsDir = join(
          dataDir,
          'mods',
          'contents',
          project.titleId.trim().toLowerCase(),
          modName,
          'romfs'
        )

        const wanted = yield* walkFiles(project.modPath)
        if (wanted.length === 0) {
          return yield* Effect.fail(
            new IoError({
              path: project.modPath,
              detail: `${project.modPath} is empty, so there is nothing to deploy. Edit and save a file from the dump first — that is what puts a copy in your mod folder.`
            })
          )
        }

        const existing = yield* Effect.orElseSucceed(walkFiles(romfsDir), () => [])
        const keep = new Set(wanted.map((file) => file.relativePath))

        const removed: string[] = []
        let bytes = 0

        yield* Effect.tryPromise({
          try: async () => {
            for (const file of wanted) {
              const destination = join(romfsDir, file.relativePath)
              await mkdir(dirname(destination), { recursive: true })
              await copyFile(file.absolutePath, destination)
              bytes += file.size
            }

            /*
             * Pruning is on by default because a reverted file left behind is
             * still loaded by the game, which looks exactly like an edit that did
             * not take. It is a setting for a mod sharing its directory with
             * something this app does not manage.
             */
            if (project.settings.deployPrune) {
              for (const stale of existing) {
                if (keep.has(stale.relativePath)) continue
                await rm(stale.absolutePath, { force: true })
                removed.push(stale.relativePath)
              }
            }
          },
          catch: (cause) =>
            new IoError({
              path: romfsDir,
              detail: cause instanceof Error ? cause.message : String(cause)
            })
        })

        return {
          target: romfsDir,
          dataDir,
          modName,
          copied: wanted.length,
          removed,
          bytes
        }
      })

    /**
     * The first emulator directory that exists.
     *
     * Failing with the full list of places looked in is deliberate: "no emulator
     * found" with nothing else to go on is not actionable, and the answer is
     * usually to pass the path explicitly.
     */
    const firstPresent: Effect.Effect<string, IoError> = Effect.gen(function* () {
      const all = yield* targets
      const present = all.find((candidate) => candidate.exists)
      if (present) return present.dataDir
      return yield* Effect.fail(
        new IoError({
          detail:
            'no emulator data directory was found. Looked in: ' +
            all.map((candidate) => candidate.dataDir).join(', ') +
            '. Choose one explicitly if the emulator keeps its data somewhere else.'
        })
      )
    })

    return { targets, run } as const
  })
}) {}
