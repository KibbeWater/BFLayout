import { basename } from 'node:path'
import { Effect } from 'effect'

import { FormatParseError, FormatWriteError, UnsupportedFormatError } from '@shared/binary/errors'
import { detectCompression, type SupportedCompression } from '@shared/formats/compression'
import { classifyEntry } from '@shared/formats/entry-kind'
import {
  isSarc,
  parseSarc,
  recoverSarcNames,
  replaceSarcEntry,
  sarcAlignmentFor,
  sarcHash,
  writeSarc,
  type SarcArchive,
  type SarcEntry
} from '@shared/formats/sarc'
import type { ArchiveDescriptor, ArchiveEntryInfo } from '@shared/contract'
import { FileNotFoundError, IoError, NotFoundError, ReadOnlyError } from '@main/errors'
import { resolveWrite } from '@main/mod-layer'
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

        /*
         * A named entry is not enough: writing a SARC needs *every* name, so one unnamed entry
         * anywhere makes the whole archive unwritable. Replacing something in it would produce
         * changes that could never be saved — and, since a dirty archive refuses to close, no
         * way out but quitting and losing them. Refused up front instead.
         */
        const unnamed = session.archive.entries.filter((candidate) => candidate.name === null)
        if (unnamed.length > 0) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'sarc',
              section: key,
              message: `${unnamed.length} of ${session.archive.entries.length} entries in ${basename(session.path)} have no stored name, so this archive cannot be written back at all`
            })
          )
        }

        session.archive = replaceSarcEntry(session.archive, entry.name, data)
        /*
         * Identical bytes leave the archive alone. Extract-then-reimport is a no-op — the doc
         * above says so — and dirtying on it made that claim false: the archive would demand a
         * save, refuse to close, and count against the quit prompt, all for a change that was
         * not one.
         */
        if (!sameBytes(entry.data, data)) session.dirty = true
        return describe(session)
      })

    /**
     * Why every structural edit checks the same thing first.
     *
     * Writing a SARC needs *every* entry's name, so one unnamed entry anywhere
     * makes the whole archive unwritable. Adding, renaming or duplicating in such
     * an archive would produce work that could never be saved — and a dirty
     * archive refuses to close, so the only way out would be quitting and losing
     * it. Refused up front, with the count, which is also the hint that recovering
     * names is the thing to do next.
     */
    const requireWritable = (
      session: OpenArchive,
      what: string
    ): Effect.Effect<void, FormatWriteError> => {
      const unnamed = session.archive.entries.filter((entry) => entry.name === null)
      if (unnamed.length === 0) return Effect.void
      return Effect.fail(
        new FormatWriteError({
          format: 'sarc',
          section: what,
          message: `${unnamed.length} of ${session.archive.entries.length} entries in ${basename(session.path)} have no stored name, so this archive cannot be written back at all. Recover the names first.`
        })
      )
    }

    const withEntries = (session: OpenArchive, entries: SarcEntry[]): void => {
      session.archive = { ...session.archive, entries }
      session.dirty = true
    }

    /**
     * Adds a file to the archive.
     *
     * Mods add files, and until now nothing here could: an archive could only ever
     * have the entries it shipped with. The alignment is inherited from a sibling
     * with the same extension where one exists — textures are aligned to 0x1000 in
     * every archive in this dump, and getting that wrong is the kind of thing the
     * game notices and nothing else does.
     */
    const addEntry = (
      archiveId: string,
      name: string,
      data: Uint8Array
    ): Effect.Effect<ArchiveDescriptor, NotFoundError | FormatWriteError> =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)
        yield* requireWritable(session, name)

        if (findByKey(session.archive, name)) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'sarc',
              section: name,
              message: `${basename(session.path)} already has an entry called ${name}; replace it instead`
            })
          )
        }

        /*
         * Alignment from the entry's *kind*, not from whichever sibling happens to
         * share its extension. Inheriting was wrong exactly when it mattered: the
         * first `.bntx` or `.bnsh` added to an archive that has none got 4 bytes,
         * and a GPU resource off a page boundary crashes inside the driver's reader
         * with nothing pointing at the packing.
         */
        withEntries(session, [
          ...session.archive.entries,
          {
            nameHash: sarcHash(name, session.archive.hashKey),
            name,
            data,
            originalOffset: 0,
            // -1 means "not from the original file", which is what stops the writer
            // trying to put it back at an offset it never had.
            originalLength: -1,
            alignment: sarcAlignmentFor(name)
          }
        ])
        return describe(session)
      })

    const deleteEntry = (
      archiveId: string,
      key: string
    ): Effect.Effect<ArchiveDescriptor, NotFoundError | FormatWriteError> =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)
        const entry = findByKey(session.archive, key)
        if (!entry) {
          return yield* Effect.fail(new NotFoundError({ kind: 'archive entry', id: key }))
        }
        yield* requireWritable(session, key)

        withEntries(
          session,
          session.archive.entries.filter((candidate) => candidate !== entry)
        )
        return describe(session)
      })

    /**
     * Renames an entry, which is a rehash rather than a relabel.
     *
     * SARC looks entries up by the hash of their name, so the stored hash has to be
     * recomputed — a rename that changed only the string would produce an archive
     * where the game cannot find the file it just read the name of.
     */
    const renameEntry = (
      archiveId: string,
      key: string,
      name: string
    ): Effect.Effect<ArchiveDescriptor, NotFoundError | FormatWriteError> =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)
        const entry = findByKey(session.archive, key)
        if (!entry) {
          return yield* Effect.fail(new NotFoundError({ kind: 'archive entry', id: key }))
        }
        yield* requireWritable(session, key)

        if (name !== entry.name && findByKey(session.archive, name)) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'sarc',
              section: name,
              message: `${basename(session.path)} already has an entry called ${name}`
            })
          )
        }

        withEntries(
          session,
          session.archive.entries.map((candidate) =>
            candidate === entry
              ? {
                  ...candidate,
                  name,
                  nameHash: sarcHash(name, session.archive.hashKey),
                  // The bytes no longer belong at their original offset once the
                  // name table around them has changed size.
                  originalLength: -1
                }
              : candidate
          )
        )
        return describe(session)
      })

    const duplicateEntry = (
      archiveId: string,
      key: string,
      name: string
    ): Effect.Effect<ArchiveDescriptor, NotFoundError | FormatWriteError> =>
      Effect.gen(function* () {
        const session = yield* get(archiveId)
        const entry = findByKey(session.archive, key)
        if (!entry) {
          return yield* Effect.fail(new NotFoundError({ kind: 'archive entry', id: key }))
        }
        return yield* addEntry(archiveId, name, entry.data)
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
      { archive: ArchiveDescriptor; redirected: boolean },
      NotFoundError | IoError | ReadOnlyError | FormatWriteError | UnsupportedFormatError
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
        /*
         * An archive opened out of the pristine dump saves into the mod layer, and
         * the session then points at the copy — so the next save writes there
         * directly, and a layout tab backed by this archive stays attached to the
         * file it will actually end up in.
         */
        const { path: destination, redirected } = resolveWrite(targetPath ?? session.path)
        yield* files.writeAtomic(destination, bytes)

        const saved: OpenArchive = { ...session, path: destination, dirty: false }
        open.set(archiveId, saved)
        return { archive: describe(saved), redirected }
      })

    /**
     * Writes one entry's bytes to a file.
     *
     * Byte-for-byte what the archive holds, uncompressed — the compression in a `.szs` wraps
     * the whole SARC, not each entry — so the result is exactly what the game's own loader
     * would see, and re-importing it is a no-op.
     */
    const extractEntry = (
      archiveId: string,
      key: string,
      path: string
    ): Effect.Effect<{ path: string; bytes: number }, NotFoundError | IoError | ReadOnlyError> =>
      Effect.gen(function* () {
        const data = yield* readEntry(archiveId, key)
        yield* files.writeAtomic(path, data)
        return { path, bytes: data.length }
      })

    /**
     * Replaces one entry's bytes with the contents of a file.
     *
     * Still how a compressed texture is replaced: `TextureService.importPng` writes pixels
     * into a container in place, which needs the size unchanged and the format uncompressed.
     * A `.bntx` built elsewhere has neither restriction.
     *
     * The new bytes are sniffed and reported rather than checked: refusing anything this build
     * cannot parse would block the legitimate case of importing a format it does not model, and
     * accepting it silently would let someone put an unreadable entry into an archive and only
     * find out later. Saying what arrived leaves the judgement where it belongs.
     */
    const importEntry = (
      archiveId: string,
      key: string,
      path: string
    ): Effect.Effect<
      { archive: ArchiveDescriptor; bytes: number; detected: string },
      NotFoundError | FormatWriteError | FileNotFoundError | IoError
    > =>
      Effect.gen(function* () {
        const data = yield* files.read(path)
        const archive = yield* replaceEntry(archiveId, key, data)
        return { archive, bytes: data.length, detected: describeBytes(data) }
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
      addEntry,
      deleteEntry,
      renameEntry,
      duplicateEntry,
      extractEntry,
      importEntry,
      recoverNames,
      save,
      close,
      list,
      describeOne
    } as const
  })
}) {}

/**
 * What a blob looks like from its magic, for reporting an import back to the user.
 *
 * Deliberately shallow: the point is to say "that is a BFLYT" or "that is nothing I know",
 * not to validate. A full parse here would reject files the app cannot read but the game can.
 */
function describeBytes(data: Uint8Array): string {
  const compression = detectCompression(data)
  if (compression !== 'none') return compression
  if (data.length < 4) return 'empty'
  const magic = String.fromCharCode(...data.subarray(0, 4))
  if (/^[\x20-\x7e]{4}$/.test(magic)) return magic
  return 'unrecognised'
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false
  return true
}
