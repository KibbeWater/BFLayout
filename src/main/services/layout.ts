import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { Effect } from 'effect'

import { FormatParseError, FormatWriteError, UnsupportedFormatError } from '@shared/binary/errors'
import {
  isBflyt,
  isDocumentDirty,
  parseBflyt,
  writeBflyt,
  type LayoutDocument,
  type PreservedSources
} from '@shared/formats/bflyt'
import {
  snapshotKeyFor,
  type DurableLayoutSource,
  type LayoutSource,
  type OpenLayoutResult
} from '@shared/contract'
import { FileNotFoundError, IoError, NotFoundError, ReadOnlyError } from '@main/errors'
import { resolveWrite } from '@main/mod-layer'
import { ArchiveService } from './archive'
import { FilesService } from './files'

interface OpenDocument {
  readonly id: string
  source: LayoutSource
  displayName: string
  /**
   * Original bytes for every section, so a save re-encodes only what changed.
   * Deliberately kept here rather than in the document: the renderer owns the
   * editable model and has no use for buffers it cannot interpret.
   */
  readonly sources: PreservedSources
  document: LayoutDocument
}

export class LayoutService extends Effect.Service<LayoutService>()('LayoutService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const archives = yield* ArchiveService

    const open = new Map<string, OpenDocument>()

    const sourceLabel = (source: LayoutSource): string =>
      source.kind === 'file' ? basename(source.path) : source.entryKey.split('/').pop()!

    /**
     * The path-based identity of a source, for keying anything that outlives the process.
     * An archive source carries a session-local `archiveId`, so this resolves it to the
     * archive's actual path.
     *
     * Never fails. An archive can be closed while a layout from it is still open, and an
     * unresolvable key is not a reason for `save` to refuse to write or for `list` to
     * refuse to answer — both used to, the moment one session's archive went away. The
     * empty string means "no durable identity", which callers already handle: the renderer
     * reports that such a tab cannot be snapshotted rather than sending an invalid request.
     */
    const durableKey = (source: LayoutSource): Effect.Effect<string> =>
      source.kind === 'file'
        ? Effect.succeed(snapshotKeyFor({ kind: 'file', path: source.path }))
        : Effect.orElseSucceed(
            Effect.map(archives.describeOne(source.archiveId), (descriptor) =>
              snapshotKeyFor({
                kind: 'archive',
                archivePath: descriptor.path,
                entryKey: source.entryKey
              })
            ),
            () => ''
          )

    const readBytes = (
      source: LayoutSource
    ): Effect.Effect<Uint8Array, FileNotFoundError | IoError | NotFoundError> =>
      source.kind === 'file'
        ? files.read(source.path)
        : archives.readEntry(source.archiveId, source.entryKey)

    const openLayout = (
      source: LayoutSource
    ): Effect.Effect<
      OpenLayoutResult,
      FileNotFoundError | IoError | NotFoundError | UnsupportedFormatError | FormatParseError
    > =>
      Effect.gen(function* () {
        const bytes = yield* readBytes(source)

        if (!isBflyt(bytes)) {
          return yield* Effect.fail(
            new UnsupportedFormatError({
              detected: 'unknown',
              message: `${sourceLabel(source)} is not a BFLYT layout`
            })
          )
        }

        const parsed = yield* Effect.try({
          try: () => parseBflyt(bytes),
          catch: (cause) =>
            cause instanceof FormatParseError
              ? cause
              : new FormatParseError({
                  format: 'bflyt',
                  offset: 0,
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        /*
         * A UUID rather than a counter. Ids used to be `doc_1, doc_2, …` restarting
         * every launch, which meant anything persisted against one — a recovery
         * snapshot — could be claimed by an unrelated file on the next run. Even with
         * snapshots now keyed by path, an id that cannot repeat removes a whole class
         * of mistaken identity for free.
         */
        const id = randomUUID()
        const snapshotKey = yield* durableKey(source)
        open.set(id, {
          id,
          source,
          displayName: sourceLabel(source),
          sources: parsed.sources,
          document: parsed.document
        })

        return {
          documentId: id,
          displayName: sourceLabel(source),
          source,
          document: parsed.document,
          snapshotKey
        }
      })

    const get = (documentId: string): Effect.Effect<OpenDocument, NotFoundError> => {
      const found = open.get(documentId)
      return found
        ? Effect.succeed(found)
        : Effect.fail(new NotFoundError({ kind: 'layout document', id: documentId }))
    }

    /**
     * Serializes the renderer's document against the preserved sources, then
     * writes it back where it came from.
     */
    const save = (
      documentId: string,
      document: LayoutDocument,
      targetPath?: string
    ): Effect.Effect<
      {
        bytes: number
        dirty: boolean
        source: LayoutSource
        displayName: string
        snapshotKey: string
        redirected: boolean
      },
      NotFoundError | IoError | ReadOnlyError | FormatWriteError | UnsupportedFormatError
    > =>
      Effect.gen(function* () {
        const session = yield* get(documentId)
        let redirected = false

        if (targetPath && session.source.kind === 'archive') {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'bflyt',
              section: session.source.entryKey,
              message:
                'this layout lives inside an archive; save the archive to a new path instead'
            })
          )
        }

        const encoded = yield* Effect.try({
          try: () => writeBflyt(document, session.sources),
          catch: (cause) =>
            cause instanceof FormatWriteError
              ? cause
              : new FormatWriteError({
                  format: 'bflyt',
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        if (session.source.kind === 'file') {
          /*
           * With a mod project open, a save of a file that came out of the pristine
           * dump lands in the mod layer instead — the copy-on-write that makes a
           * mod a *layer* rather than a set of edited game files.
           *
           * The session is then retargeted at the copy, which is the same thing a
           * save-as does and for the same reason: the next plain save must go where
           * this one went. It also means the tab's crash-recovery key follows the
           * file, so a crash after the first save restores into the mod copy rather
           * than proposing to write the dump.
           */
          const { path: destination, redirected: intoLayer } = resolveWrite(
            targetPath ?? session.source.path
          )
          redirected = intoLayer
          yield* files.writeAtomic(destination, encoded)
          // A save-as retargets the session, so the next plain save goes to the
          // new file rather than silently back to the original.
          session.source = { kind: 'file', path: destination }
          session.displayName = basename(destination)
        } else {
          yield* archives.replaceEntry(
            session.source.archiveId,
            session.source.entryKey,
            encoded
          )
        }

        session.document = document
        return {
          bytes: encoded.length,
          dirty: isDocumentDirty(document),
          source: session.source,
          displayName: session.displayName,
          // Derived from the retargeted source, not the one the save started with.
          snapshotKey: yield* durableKey(session.source),
          redirected
        }
      })

    /**
     * Resolves part layouts by name.
     *
     * Names in a prt1 pane are bare filenames like "Button.bflyt", so the search
     * mirrors how textures and animations are found: the archive's blyt/ folder
     * first, then anywhere else in it, then beside a loose layout. Matching is
     * case-insensitive with the extension optional, because layouts and archives
     * disagree about both.
     */
    const parts = (
      source: LayoutSource,
      names: readonly string[]
    ): Effect.Effect<
      {
        resolved: { name: string; document: LayoutDocument }[]
        missing: { name: string; detail: string }[]
      },
      NotFoundError
    > =>
      Effect.gen(function* () {
        const resolved: { name: string; document: LayoutDocument }[] = []
        const missing: { name: string; detail: string }[] = []
        if (names.length === 0) return { resolved, missing }

        const wanted = (value: string): string => {
          const base = value.split(/[\\/]/).pop() ?? value
          return base.toLowerCase().replace(/\.bflyt$/, '')
        }

        // Candidate list is built once for all names rather than per name.
        const candidates: { label: string; load: Effect.Effect<Uint8Array, unknown> }[] = []
        if (source.kind === 'archive') {
          const descriptor = yield* archives.describeOne(source.archiveId)
          const layouts = descriptor.entries.filter((entry) => entry.kind === 'layout')
          const inFolder = layouts.filter((entry) =>
            entry.displayName.toLowerCase().startsWith('blyt/')
          )
          const elsewhere = layouts.filter(
            (entry) => !entry.displayName.toLowerCase().startsWith('blyt/')
          )
          for (const entry of [...inFolder, ...elsewhere]) {
            candidates.push({
              label: entry.displayName,
              load: archives.readEntry(source.archiveId, entry.key)
            })
          }
        } else {
          const directory = dirname(source.path)
          for (const folder of [directory, join(directory, 'blyt')]) {
            for (const name of yield* files.listDir(folder)) {
              if (!name.toLowerCase().endsWith('.bflyt')) continue
              const path = join(folder, name)
              candidates.push({ label: path, load: files.read(path) })
            }
          }
        }

        for (const name of new Set(names)) {
          const target = wanted(name)
          const match = candidates.find((candidate) => wanted(candidate.label) === target)
          if (!match) {
            missing.push({ name, detail: 'no layout with that name was found' })
            continue
          }

          // One unparseable part must not lose the others.
          const loaded = yield* Effect.either(match.load)
          if (loaded._tag === 'Left') {
            missing.push({ name, detail: 'could not be read' })
            continue
          }
          if (!isBflyt(loaded.right)) {
            missing.push({ name, detail: `${match.label} is not a BFLYT layout` })
            continue
          }
          const parsed = yield* Effect.either(
            Effect.try(() => parseBflyt(loaded.right).document)
          )
          if (parsed._tag === 'Left') {
            missing.push({
              name,
              detail: parsed.left instanceof Error ? parsed.left.message : 'could not be parsed'
            })
            continue
          }
          resolved.push({ name, document: parsed.right })
        }

        return { resolved, missing }
      })

    /**
     * Opens what a durable snapshot key names, then substitutes the recovered document
     * for the one that was just parsed.
     *
     * Going through a real open is the whole point. A recovered document used to be
     * pushed straight into a renderer tab with no main-process session behind it, so
     * every save failed with "layout document not found" — the one thing the feature
     * exists to do. Reopening the file gives it a session *and* the preserved section
     * bytes, so the recovered edits save exactly as if they had never been lost. The
     * file's own current contents are read and then discarded, which is the cost of
     * getting those blobs.
     */
    const restore = (
      source: DurableLayoutSource,
      document: LayoutDocument
    ): Effect.Effect<
      OpenLayoutResult,
      FileNotFoundError | IoError | NotFoundError | UnsupportedFormatError | FormatParseError
    > =>
      Effect.gen(function* () {
        const live: LayoutSource =
          source.kind === 'file'
            ? source
            : {
                kind: 'archive',
                archiveId: (yield* archives.openPath(source.archivePath)).archiveId,
                entryKey: source.entryKey
              }

        const opened = yield* openLayout(live)
        const session = yield* get(opened.documentId)
        session.document = document

        /*
         * The preserved bytes from that parse are thrown away, deliberately.
         *
         * They are keyed by node id, and node ids come from a counter that is global to
         * the module and never resets — so they identify a node only within the process
         * that minted them. The recovered document's ids came from the process that
         * crashed. Keeping both would let `writeBflyt` replay one pane's original bytes
         * under a different pane, producing a structurally valid file quietly carrying
         * the wrong sections; where the ids merely failed to line up it would silently
         * fall back to a full re-encode anyway.
         *
         * So: always the full re-encode, from the recovered model alone. That is exact —
         * every one of the 544 layouts and 2,187 animations in the dump re-encodes byte
         * for byte from the model, which is precisely what `validate:romfs` forces — and
         * it is the only version of this that cannot mix two files together. Byte
         * preservation is an optimisation for untouched sections; a recovered document
         * has no untouched sections to preserve, because the bytes it came from are gone.
         */
        session.sources.clear()

        return { ...opened, document }
      })

    const close = (documentId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        open.delete(documentId)
      })

    /*
     * Suspended, which is not optional here.
     *
     * `Effect.forEach([...open.values()], …)` spreads the map when the *service* is built,
     * not when the effect runs — and the service layer is memoised and constructed once, at
     * which point no documents are open. So the effect closed over an empty array forever
     * and `list` returned `[]` for every call, which no error surfaced anywhere: the caller
     * that resyncs recovery keys after an archive save-as simply applied an empty map and
     * left every key naming the old path. The previous `Effect.sync(() => …)` was lazy for
     * the same reason; this restores that.
     */
    const list = Effect.suspend(() =>
      Effect.forEach([...open.values()], (entry) =>
        Effect.map(durableKey(entry.source), (snapshotKey) => ({
          documentId: entry.id,
          displayName: entry.displayName,
          source: entry.source,
          snapshotKey
        }))
      )
    )

    return { openLayout, restore, save, close, list, get, parts } as const
  })
}) {}
