import { useEffect } from 'react'

import { getClient } from '@renderer/lib/orpc'
import { useDocuments } from '@renderer/editor/store/document'
import { usePlayback } from '@renderer/editor/store/playback'
import { useWorkspace } from '@renderer/editor/store/workspace'

/**
 * Closes archives nothing refers to any more.
 *
 * `archive.close` existed and was implemented and was called by nothing, so every archive
 * opened in a session stayed open for the rest of it. That is not merely a leak: resolving a
 * texture name searches the layout's own archive first and then **every other open archive**,
 * which is a deliberate feature — layouts routinely reference a shared texture archive opened
 * separately — but it means browsing a dump made texture lookups progressively slower *and*
 * progressively more likely to bind a same-named texture from an archive whose tab was closed
 * twenty minutes ago.
 *
 * Reference counting rather than closing on tab close, because an archive can be referenced
 * three different ways and any one of them is enough to keep it:
 *
 *   - an open layout tab whose source is an entry in it,
 *   - the archive the browser is currently showing,
 *   - the archive a loaded animation came from.
 *
 * Reconciling against all three from one place is what makes this safe. Doing it at each
 * close site instead would need every site to know about the other two, and the third — the
 * animation — is loaded from a panel that has no idea tabs exist.
 *
 * Reopening is cheap and idempotent: `openPath` dedupes on path, so a mistake here costs a
 * re-read, not correctness.
 */

/** A short delay, so opening a layout from an archive is not raced by the sweep. */
const SETTLE_MS = 2000

export function useArchiveSessions(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    /** Ids already closed, so a failed close is not retried in a tight loop. */
    const closed = new Set<string>()

    const referenced = (): Set<string> => {
      const ids = new Set<string>()
      for (const tab of useDocuments.getState().tabs) {
        if (tab.source.kind === 'archive') ids.add(tab.source.archiveId)
      }
      const browsing = useWorkspace.getState().activeArchiveId
      if (browsing) ids.add(browsing)
      const animation = usePlayback.getState().source
      if (animation && animation.kind === 'archive') ids.add(animation.archiveId)
      return ids
    }

    const sweep = (): void => {
      const keep = referenced()
      void (async () => {
        const client = getClient()
        try {
          const open = await client.archive.list()
          for (const archive of open) {
            if (keep.has(archive.archiveId) || closed.has(archive.archiveId)) continue
            /*
             * An archive with unsaved edits is never dropped. Closing it would discard the
             * in-memory entry replacements a layout save wrote into it, which is the one way
             * this could lose work rather than merely free memory.
             */
            if (archive.dirty) continue
            closed.add(archive.archiveId)
            await client.archive
              .close({ archiveId: archive.archiveId })
              .catch((cause: unknown) =>
                console.warn('[bflayout] could not close an archive:', cause)
              )
          }
        } catch (cause) {
          // Nothing user-visible depends on this succeeding; the cost of failure is the
          // situation that existed before it was written.
          console.warn('[bflayout] could not reconcile open archives:', cause)
        }
      })()
    }

    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(sweep, SETTLE_MS)
    }

    const unsubscribe = [
      useDocuments.subscribe(schedule),
      useWorkspace.subscribe(schedule),
      usePlayback.subscribe(schedule)
    ]
    return () => {
      if (timer) clearTimeout(timer)
      for (const stop of unsubscribe) stop()
    }
  }, [])
}
