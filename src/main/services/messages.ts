import { basename } from 'node:path'
import { Effect } from 'effect'

import { FormatParseError, FormatWriteError, UnsupportedFormatError } from '@shared/binary/errors'
import { isMsbt, parseMsbt, writeMsbt, type MsbtDocument } from '@shared/formats/msbt'
import { replaceInDocument, setMessageText } from '@shared/formats/msbt/editing'
import type { LayoutSource, MessageReplaceResult, MessageTable } from '@shared/contract'
import { DbError, FileNotFoundError, IoError, NotFoundError, ReadOnlyError } from '@main/errors'
import { resolveWrite } from '@main/mod-layer'
import { walkFiles } from '@main/walk'
import { ArchiveService } from './archive'
import { CompressionService } from './compression'
import { FilesService } from './files'
import { ProjectService } from './projects'

/**
 * Reading and writing the game's text.
 *
 * Message tables are the most-edited files in modding — translations, renames,
 * jokes — and until now they were readable here and nothing more. The codec change
 * that makes writing safe is described in `formats/msbt`: inline commands keep
 * their payloads, so a string can be rewritten without losing the colour change or
 * the variable substitution embedded in it.
 *
 * Saving goes through the same copy-on-write path as everything else, so editing a
 * table out of a pristine dump produces a file in the mod layer and leaves the
 * dump alone.
 */

function describeMessages(document: MsbtDocument, name: string): MessageTable {
  return {
    displayName: name,
    encoding: document.encoding,
    littleEndian: document.littleEndian,
    version: document.version,
    sections: document.sections,
    messages: document.messages.map((message) => ({
      index: message.index,
      label: message.label,
      text: message.text,
      /**
       * Whether the string carries anything the editor cannot express as text.
       * Editing one of these is fine — placeholders can be moved, repeated or
       * removed — but it is worth knowing before you start.
       */
      hasCommands: message.runs.some((run) => run.kind !== 'text')
    }))
  }
}

export class MessageService extends Effect.Service<MessageService>()('MessageService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const archives = yield* ArchiveService
    const compression = yield* CompressionService
    const projects = yield* ProjectService

    const readSource = (
      source: LayoutSource
    ): Effect.Effect<Uint8Array, FileNotFoundError | IoError | NotFoundError> =>
      source.kind === 'file'
        ? files.read(source.path)
        : archives.readEntry(source.archiveId, source.entryKey)

    const label = (source: LayoutSource): string =>
      source.kind === 'file' ? basename(source.path) : source.entryKey.split('/').pop()!

    const parse = (
      source: LayoutSource
    ): Effect.Effect<
      MsbtDocument,
      FileNotFoundError | IoError | NotFoundError | UnsupportedFormatError | FormatParseError
    > =>
      Effect.gen(function* () {
        const raw = yield* readSource(source)
        const { data } = yield* Effect.orElseSucceed(compression.decompress(raw), () => ({
          data: raw,
          kind: 'none' as const
        }))

        if (!isMsbt(data)) {
          return yield* Effect.fail(
            new UnsupportedFormatError({
              detected: 'unknown',
              message: `${label(source)} is not an MSBT message table`
            })
          )
        }

        return yield* Effect.try({
          try: () => parseMsbt(data),
          catch: (cause) =>
            cause instanceof FormatParseError
              ? cause
              : new FormatParseError({
                  format: 'msbt',
                  offset: 0,
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })
      })

    const open = (
      source: LayoutSource
    ): Effect.Effect<
      MessageTable,
      FileNotFoundError | IoError | NotFoundError | UnsupportedFormatError | FormatParseError
    > => Effect.map(parse(source), (document) => describeMessages(document, label(source)))

    /**
     * Applies edits and writes the table back.
     *
     * The file is re-read and re-parsed rather than a session being held open. A
     * message table is not a working document the way a layout is — there is no
     * canvas state to keep — and re-reading means an edit is applied to what is on
     * disk now rather than to a copy that may be minutes old.
     */
    const save = (
      source: LayoutSource,
      edits: readonly { index: number; text: string }[]
    ): Effect.Effect<
      { bytes: number; changed: number; redirected: boolean; path: string | null },
      | FileNotFoundError
      | IoError
      | ReadOnlyError
      | NotFoundError
      | UnsupportedFormatError
      | FormatParseError
      | FormatWriteError
    > =>
      Effect.gen(function* () {
        let document = yield* parse(source)
        let changed = 0

        for (const edit of edits) {
          const next = yield* Effect.try({
            try: () => setMessageText(document, edit.index, edit.text),
            catch: (cause) =>
              cause instanceof FormatWriteError
                ? cause
                : new FormatWriteError({
                    format: 'msbt',
                    message: cause instanceof Error ? cause.message : String(cause)
                  })
          })
          // setMessageText returns the same object when nothing moved, which is what
          // keeps "changed" a count of real edits rather than of attempts.
          if (next !== document) changed += 1
          document = next
        }

        const encoded = yield* Effect.try({
          try: () => writeMsbt(document),
          catch: (cause) =>
            cause instanceof FormatWriteError
              ? cause
              : new FormatWriteError({
                  format: 'msbt',
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        if (source.kind === 'file') {
          const { path, redirected } = resolveWrite(source.path)
          yield* files.writeAtomic(path, encoded)
          return { bytes: encoded.length, changed, redirected, path }
        }

        /*
         * Into the in-memory archive, exactly as a layout save does. The bytes reach
         * disk when the archive itself is saved — which is also what routes them
         * through the mod layer.
         */
        yield* archives.replaceEntry(source.archiveId, source.entryKey, encoded)
        return { bytes: encoded.length, changed, redirected: false, path: null }
      })

    /**
     * Find and replace across every message table under a folder.
     *
     * The reason this exists as a batch: a translation touches thousands of strings
     * across thousands of files, and doing it one table at a time is not a workflow,
     * it is a reason not to try.
     *
     * `dryRun` is the default in spirit if not in signature — every caller should
     * run it first. The result carries examples rather than only a count, because a
     * pattern that matched more than intended across 3,406 files is not something a
     * number can tell you.
     */
    const replaceAll = (options: {
      root: string
      find: string
      replacement: string
      regex: boolean
      dryRun: boolean
    }): Effect.Effect<
      MessageReplaceResult,
      DbError | FileNotFoundError | IoError | ReadOnlyError | FormatWriteError
    > =>
      Effect.gen(function* () {
        const pattern: string | RegExp = options.regex
          ? yield* Effect.try({
              try: () => new RegExp(options.find, 'g'),
              catch: () =>
                new FormatWriteError({
                  format: 'msbt',
                  message: `${options.find} is not a valid regular expression`
                })
            })
          : options.find

        const project = yield* projects.active
        const walked = yield* walkFiles(options.root)

        const changedFiles: MessageReplaceResult['files'] = []
        let totalMessages = 0

        for (const file of walked) {
          const raw = yield* Effect.either(files.read(file.absolutePath))
          if (raw._tag === 'Left') continue
          if (!isMsbt(raw.right)) continue

          const parsed = yield* Effect.either(Effect.try(() => parseMsbt(raw.right)))
          if (parsed._tag === 'Left') continue

          const result = yield* Effect.either(
            Effect.try(() => replaceInDocument(parsed.right, pattern, options.replacement))
          )
          if (result._tag === 'Left') {
            /*
             * A replacement that would invent an inline command is refused per file
             * rather than aborting the run: one impossible edit among 3,406 tables
             * must not throw away the 3,405 that were fine.
             */
            changedFiles.push({
              relativePath: file.relativePath,
              changed: 0,
              examples: [],
              refused:
                result.left instanceof Error ? result.left.message : 'could not be rewritten'
            })
            continue
          }
          if (result.right.changed === 0) continue

          totalMessages += result.right.changed
          const written = options.dryRun
            ? null
            : yield* Effect.try({
                try: () => writeMsbt(result.right.document),
                catch: (cause) =>
                  new FormatWriteError({
                    format: 'msbt',
                    section: file.relativePath,
                    message: cause instanceof Error ? cause.message : String(cause)
                  })
              })

          if (written) {
            const { path } = resolveWrite(file.absolutePath)
            yield* files.writeAtomic(path, written)
          }

          changedFiles.push({
            relativePath: file.relativePath,
            changed: result.right.changed,
            examples: result.right.examples,
            refused: null
          })
        }

        return {
          dryRun: options.dryRun,
          root: options.root,
          /** Where the writes went, so a redirect into the mod layer is legible. */
          modPath: project?.modPath ?? null,
          files: changedFiles,
          totalMessages
        }
      })

    return { open, save, replaceAll } as const
  })
}) {}
