import { basename } from 'node:path'
import { Effect } from 'effect'

import { FormatParseError, FormatWriteError, UnsupportedFormatError } from '@shared/binary/errors'
import type { SupportedCompression } from '@shared/formats/compression'
import { classifyEntry } from '@shared/formats/entry-kind'
import {
  isSarc,
  parseSarc,
  recoverSarcNames,
  replaceSarcEntry,
  sarcHash,
  writeSarc,
  type SarcArchive,
  type SarcEntry
} from '@shared/formats/sarc'
import type { ArchiveDescriptor, ArchiveEntryInfo } from '@shared/contract'
import { FileNotFoundError, IoError, NotFoundError } from '@main/errors'
import { CompressionService } from './compression'
import { FilesService } from './files'

interface OpenArchive {
  readonly id: string
  readonly path: string
  readonly compression: SupportedCompression
  archive: SarcArchive
  dirty: boolean
}

/**
 * Entries are addressed by a stable key so hash-only archives stay usable:
 * named entries use their name, unnamed ones use "#" plus the hex hash.
 */
export function entryKey(entry: SarcEntry): string {
  return entry.name ?? `#${entry.nameHash.toString(16).padStart(8, '0')}`
}

function findByKey(archive: SarcArchive, key: string): SarcEntry | undefined {
  if (key.startsWith('#')) {
    const hash = Number.parseInt(key.slice(1), 16)
    return archive.entries.find((entry) => entry.nameHash === hash)
  }
  return (
    archive.entries.find((entry) => entry.name === key) ??
    archive.entries.find((entry) => entry.nameHash === sarcHash(key, archive.hashKey))
  )
}

function describeEntries(archive: SarcArchive): ArchiveEntryInfo[] {
  return archive.entries.map((entry) => {
    const key = entryKey(entry)
    const display = entry.name ?? key
    return {
      key,
      name: entry.name,
      displayName: display,
      size: entry.data.length,
      kind: classifyEntry(display),
      named: entry.name !== null
    }
  })
}

export class ArchiveService extends Effect.Service<ArchiveService>()('ArchiveService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const compression = yield* CompressionService

    const open = new Map<string, OpenArchive>()
    let sequence = 0

    const describe = (entry: OpenArchive): ArchiveDescriptor => ({
      archiveId: entry.id,
      path: entry.path,
      displayName: basename(entry.path),
      compression: entry.compression,
      littleEndian: entry.archive.littleEndian,
      hasNames: entry.archive.hasNames,
      unnamedCount: entry.archive.entries.filter((e) => e.name === null).length,
      dirty: entry.dirty,
      entries: describeEntries(entry.archive)
    })

    const get = (
      archiveId: string
    ): Effect.Effect<OpenArchive, NotFoundError> => {
      const found = open.get(archiveId)
      return found
        ? Effect.succeed(found)
        : Effect.fail(new NotFoundError({ kind: 'archive', id: archiveId }))
    }

    const openPath = (
      path: string
    ): Effect.Effect<
      ArchiveDescriptor,
      FileNotFoundError | IoError | UnsupportedFormatError | FormatParseError
    > =>
      Effect.gen(function* () {
        // Reopening the same file returns the existing session so unsaved
        // edits are never silently discarded.
        for (const entry of open.values()) {
          if (entry.path === path) return describe(entry)
        }

        const raw = yield* files.read(path)
        const { data, kind } = yield* compression.decompress(raw)

        if (!isSarc(data)) {
          return yield* Effect.fail(
            new UnsupportedFormatError({
              detected: kind === 'none' ? 'unknown' : kind,
              message: `${basename(path)} is not a SARC archive`
            })
          )
        }

        const archive = yield* Effect.try({
          try: () => parseSarc(data),
          catch: (cause) =>
            cause instanceof FormatParseError
              ? cause
              : new FormatParseError({
                  format: 'sarc',
                  offset: 0,
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        const id = `arch_${++sequence}`
        const session: OpenArchive = { id, path, compression: kind, archive, dirty: false }
        open.set(id, session)
        return describe(session)
      })

    const readEntry = (
      archiveId: string,
      key: string
    ): Effect.Effect<Uint8Array, NotFoundError> =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)
        const entry = findByKey(session.archive, key)
        if (!entry) {
          return yield* Effect.fail(new NotFoundError({ kind: 'archive entry', id: key }))
        }
        return entry.data
      })

    const replaceEntry = (
      archiveId: string,
      key: string,
      data: Uint8Array
    ): Effect.Effect<ArchiveDescriptor, NotFoundError | FormatWriteError> =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)
        const entry = findByKey(session.archive, key)
        if (!entry) {
          return yield* Effect.fail(new NotFoundError({ kind: 'archive entry', id: key }))
        }
        if (entry.name === null) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'sarc',
              section: key,
              message: 'cannot replace an entry whose name is unknown'
            })
          )
        }
        session.archive = replaceSarcEntry(session.archive, entry.name, data)
        session.dirty = true
        return describe(session)
      })

    /** Fills in missing names from candidates (layout txl1 lists, mostly). */
    const recoverNames = (
      archiveId: string,
      candidates: readonly string[]
    ): Effect.Effect<ArchiveDescriptor, NotFoundError> =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)
        session.archive = recoverSarcNames(session.archive, candidates)
        return describe(session)
      })

    const save = (
      archiveId: string,
      targetPath?: string
    ): Effect.Effect<
      ArchiveDescriptor,
      NotFoundError | IoError | FormatWriteError | UnsupportedFormatError
    > =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)

        const packed = yield* Effect.try({
          try: () => writeSarc(session.archive),
          catch: (cause) =>
            cause instanceof FormatWriteError
              ? cause
              : new FormatWriteError({
                  format: 'sarc',
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        const bytes = yield* compression.compress(packed, session.compression)
        const destination = targetPath ?? session.path
        yield* files.writeAtomic(destination, bytes)

        const saved: OpenArchive = { ...session, path: destination, dirty: false }
        open.set(archiveId, saved)
        return describe(saved)
      })

    /**
     * Drops an archive session.
     *
     * Refuses while it holds unsaved changes, because dropping it discards them: a layout save
     * writes its re-encoded entry into *this* in-memory archive (`replaceEntry`), and nothing
     * has reached disk until the archive itself is saved. The UI already disables its Close
     * button for a dirty archive, but a guard that lives only in the renderer is advisory —
     * the archive lives here, so the refusal belongs here too.
     *
     * `force` is for a caller that has genuinely decided to discard, which is the same thing
     * the tab-close prompt asks about. Nothing passes it yet; it exists so that a future
     * "close and discard" does not have to reach around this check.
     */
    const close = (
      archiveId: string,
      force = false
    ): Effect.Effect<void, FormatWriteError> =>
      Effect.gen(function* () {
        const session = open.get(archiveId)
        if (session && session.dirty && !force) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'sarc',
              message: `${basename(session.path)} has unsaved changes; save it before closing`
            })
          )
        }
        open.delete(archiveId)
      })

    const list = Effect.sync(() => [...open.values()].map(describe))

    const describeOne = (
      archiveId: string
    ): Effect.Effect<ArchiveDescriptor, NotFoundError> => Effect.map(get(archiveId), describe)

    return {
      openPath,
      readEntry,
      replaceEntry,
      recoverNames,
      save,
      close,
      list,
      describeOne
    } as const
  })
}) {}
