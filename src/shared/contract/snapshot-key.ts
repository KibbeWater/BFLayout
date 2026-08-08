/**
 * The durable identity of a document being edited, used to key crash-recovery
 * snapshots.
 *
 * Snapshots outlive the process that wrote them, so they cannot be keyed by anything
 * the process mints. `documentId` and `archiveId` are both per-session handles — they
 * restart from the beginning every launch — and keying persistent rows by them meant a
 * snapshot of one file could be claimed by an entirely different file on the next run.
 *
 * A key names the file on disk instead: its path, plus the entry inside it for a layout
 * that lives in an archive. Two consequences fall out of that and both are wanted:
 * re-editing the same file after a crash replaces its own snapshot rather than adding
 * one, and a successful save can discard the right row without needing a live session.
 *
 * The key is also parseable back into a source, so restoring is a matter of reopening
 * what it names rather than trusting a handle that no longer exists.
 */

/** A source identified by durable filesystem coordinates rather than session handles. */
export type DurableLayoutSource =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'archive'; readonly archivePath: string; readonly entryKey: string }

/**
 * `\n` is the separator because it cannot appear in a path on any platform this runs
 * on, while `#`, `:` and `|` all can.
 */
const SEPARATOR = '\n'

export function snapshotKeyFor(source: DurableLayoutSource): string {
  return source.kind === 'file'
    ? `file${SEPARATOR}${source.path}`
    : `archive${SEPARATOR}${source.archivePath}${SEPARATOR}${source.entryKey}`
}

/**
 * Reads a key back. Returns null for anything unrecognised — a row written by an older
 * build, or a truncated value — so a bad row is skipped rather than crashing recovery.
 */
export function parseSnapshotKey(key: string): DurableLayoutSource | null {
  const parts = key.split(SEPARATOR)
  if (parts[0] === 'file' && parts.length === 2 && parts[1]) {
    return { kind: 'file', path: parts[1] }
  }
  if (parts[0] === 'archive' && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: 'archive', archivePath: parts[1], entryKey: parts[2] }
  }
  return null
}

/** The file a key ultimately lives in — what to stat when checking for staleness. */
export function snapshotKeyPath(source: DurableLayoutSource): string {
  return source.kind === 'file' ? source.path : source.archivePath
}
