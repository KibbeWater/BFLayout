import { join } from 'node:path'
import { Effect } from 'effect'

import type { ModPackageInfo, ModPackageResult } from '@shared/contract'
import {
  DbError,
  FileNotFoundError,
  IoError,
  NotFoundError,
  ReadOnlyError
} from '@main/errors'
import { walkFiles } from '@main/walk'
import { readZip, writeZip, type ZipEntry } from '@main/zip'
import { FilesService } from './files'
import { ProjectService } from './projects'

/**
 * Turning a mod into something someone else can install, and back.
 *
 * The shape is the one every Switch mod loader already reads —
 * `contents/<title id>/romfs/…` inside a zip — so the package is not a BFLayout
 * format that has to be unpacked by BFLayout. It is the mod, and a person who has
 * never heard of this editor can drop it into their emulator's mods folder.
 *
 * The manifest sits alongside rather than in place of that, and exists for one
 * reason above the rest: it records the game version the mod was built against.
 * A layout mod for the wrong build does not fail cleanly — it loads, the offsets
 * mean something else, and the game misbehaves in ways nobody attributes to the
 * mod. Colony's loader takes the same position for the same reason: an
 * unrecognised build disables it entirely rather than half-working.
 */

const MANIFEST = 'bflayout-mod.json'

interface Manifest {
  readonly format: 1
  readonly name: string
  readonly version: string
  readonly author: string
  readonly titleId: string
  readonly gameVersion: string
  readonly files: string[]
  readonly createdWith: string
}

export class PackageService extends Effect.Service<PackageService>()('PackageService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const projects = yield* ProjectService

    /**
     * Writes the mod out as a zip.
     *
     * `createdAt` is deliberately absent from the manifest. A package that differs
     * every time it is built cannot be checksummed, and "did anything actually
     * change since the last release" is a question worth being able to answer.
     */
    const exportMod = (options: {
      path: string
      version: string
      author: string
    }): Effect.Effect<
      ModPackageResult,
      DbError | FileNotFoundError | IoError | ReadOnlyError | NotFoundError
    > =>
      Effect.gen(function* () {
        const project = yield* projects.active
        if (!project) {
          return yield* Effect.fail(
            new NotFoundError({ kind: 'active mod project', id: 'packaging needs one' })
          )
        }
        if (project.titleId.trim() === '') {
          return yield* Effect.fail(
            new IoError({
              detail: `${project.name} has no title ID, and a romfs mod is found by title — without one there is nowhere in the package to put the files.`
            })
          )
        }

        const layer = yield* walkFiles(project.modPath)
        if (layer.length === 0) {
          return yield* Effect.fail(
            new IoError({
              path: project.modPath,
              detail: 'the mod folder is empty, so there is nothing to package'
            })
          )
        }

        const titleId = project.titleId.trim().toLowerCase()
        const entries: ZipEntry[] = []
        for (const file of layer) {
          const data = yield* files.read(file.absolutePath)
          entries.push({ name: `contents/${titleId}/romfs/${file.relativePath}`, data })
        }

        const manifest: Manifest = {
          format: 1,
          name: project.name,
          version: options.version,
          author: options.author,
          titleId,
          gameVersion: project.gameVersion,
          files: layer.map((file) => file.relativePath).sort(),
          createdWith: 'BFLayout'
        }
        entries.push({
          name: MANIFEST,
          data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
        })

        const zipped = yield* Effect.try({
          try: () => writeZip(entries),
          catch: (cause) =>
            new IoError({
              path: options.path,
              detail: cause instanceof Error ? cause.message : String(cause)
            })
        })
        yield* files.writeAtomic(options.path, zipped)

        return {
          path: options.path,
          fileCount: layer.length,
          bytes: zipped.length,
          titleId,
          gameVersion: project.gameVersion
        }
      })

    /**
     * Reads a package without installing it.
     *
     * Separate from importing on purpose. A mod built against a different game
     * version is the failure worth catching, and catching it means telling someone
     * *before* the files are on disk — after which the damage is done and the only
     * clue is a game that misbehaves.
     */
    const inspect = (
      path: string
    ): Effect.Effect<
      ModPackageInfo,
      DbError | FileNotFoundError | IoError | NotFoundError
    > =>
      Effect.gen(function* () {
        const data = yield* files.read(path)
        const entries = yield* Effect.try({
          try: () => readZip(data),
          catch: (cause) =>
            new IoError({
              path,
              detail: cause instanceof Error ? cause.message : String(cause)
            })
        })

        const manifestEntry = entries.find((entry) => entry.name === MANIFEST)
        const manifest = manifestEntry
          ? (JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Partial<Manifest>)
          : null

        const romfs = entries
          .map((entry) => /^contents\/[^/]+\/romfs\/(.+)$/.exec(entry.name)?.[1])
          .filter((name): name is string => name !== undefined)

        const project = yield* projects.active
        const warnings: string[] = []

        if (!manifest) {
          warnings.push(
            'This package has no BFLayout manifest, so there is no record of which game build it was made for. It may still be a perfectly good mod — just check what it targets before installing.'
          )
        } else if (project) {
          if (
            manifest.gameVersion &&
            project.gameVersion &&
            manifest.gameVersion !== project.gameVersion
          ) {
            warnings.push(
              `Built for game version ${manifest.gameVersion}; this project's dump is ${project.gameVersion}. Layout files are tied to the build they came from — installing this is likely to produce problems that look like game bugs rather than mod bugs.`
            )
          }
          if (manifest.titleId && project.titleId && manifest.titleId !== project.titleId.toLowerCase()) {
            warnings.push(
              `Built for title ${manifest.titleId}; this project is ${project.titleId}. This is a mod for a different game.`
            )
          }
        }

        if (romfs.length === 0) {
          warnings.push(
            'No files under contents/<title id>/romfs/ — this does not look like a romfs mod, and importing it would add nothing.'
          )
        }

        return {
          path,
          name: manifest?.name ?? null,
          version: manifest?.version ?? null,
          author: manifest?.author ?? null,
          titleId: manifest?.titleId ?? null,
          gameVersion: manifest?.gameVersion ?? null,
          files: romfs.sort(),
          warnings
        }
      })

    /**
     * Unpacks a package into the active project's mod folder.
     *
     * Into the *mod layer*, never the dump — the guard in `mod-layer.ts` would
     * refuse the write anyway, and going through the same folder every other edit
     * lands in means an imported mod can immediately be diffed, checked and
     * reverted file by file like anything else.
     */
    const importMod = (options: {
      path: string
      overwrite: boolean
    }): Effect.Effect<
      { imported: string[]; skipped: string[] },
      DbError | FileNotFoundError | IoError | ReadOnlyError | NotFoundError
    > =>
      Effect.gen(function* () {
        const project = yield* projects.active
        if (!project) {
          return yield* Effect.fail(
            new NotFoundError({ kind: 'active mod project', id: 'importing needs one' })
          )
        }

        const data = yield* files.read(options.path)
        const entries = yield* Effect.try({
          try: () => readZip(data),
          catch: (cause) =>
            new IoError({
              path: options.path,
              detail: cause instanceof Error ? cause.message : String(cause)
            })
        })

        const imported: string[] = []
        const skipped: string[] = []

        for (const entry of entries) {
          const relative = /^contents\/[^/]+\/romfs\/(.+)$/.exec(entry.name)?.[1]
          if (relative === undefined) continue

          /*
           * A path that climbs out of the mod folder is refused rather than
           * sanitised. This reads archives strangers built, and an entry called
           * `../../../etc/something` is not a mistake to quietly correct — it is a
           * reason to stop trusting the package.
           */
          if (relative.split('/').includes('..')) {
            return yield* Effect.fail(
              new IoError({
                path: options.path,
                detail: `this package contains an entry that points outside the mod folder (${entry.name}). It has not been imported.`
              })
            )
          }

          const destination = join(project.modPath, relative)
          if (!options.overwrite && (yield* files.exists(destination))) {
            skipped.push(relative)
            continue
          }

          yield* files.writeAtomic(destination, entry.data)
          imported.push(relative)
        }

        return { imported: imported.sort(), skipped: skipped.sort() }
      })

    return { exportMod, inspect, importMod } as const
  })
}) {}
