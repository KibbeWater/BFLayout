import { FormatWriteError } from '../../binary/errors'
import type { MsbtDocument, MsbtMessage, MsbtRun } from './index'
import { renderRuns } from './index'

/**
 * Editing message text without destroying what is embedded in it.
 *
 * A message is not a string. It is text with inline commands threaded through it —
 * colour changes, button glyphs, variable substitutions — each carrying an opaque
 * payload. The editable form shows those as `{n:1.4}` placeholders, which is
 * readable and, crucially, *movable*: a translator needs to put the player's name
 * somewhere else in the sentence, and that is exactly what reordering a
 * placeholder means.
 *
 * So editing is a merge, not an assignment: the edited string says where the
 * commands go, and the original message says what each one carries.
 */

const PLACEHOLDER = /\{n:(end|\d+\.\d+)\}/g

/**
 * Rebuilds a message's runs from an edited placeholder string.
 *
 * Placeholders are matched to the original commands by group and type, in order.
 * Repeating one reuses that command's payload — legitimate, and the only sensible
 * reading of "the same colour change, twice". Deleting one deletes the command.
 *
 * A placeholder naming a command the message never had is refused, because there
 * is no payload to give it: emitting an empty one produces a file the game reads
 * and misdraws, which is worse than not saving.
 */
export function runsFromText(original: readonly MsbtRun[], text: string): MsbtRun[] {
  const commands = original.filter((run): run is Extract<MsbtRun, { kind: 'command' }> =>
    run.kind === 'command'
  )
  const ends = original.filter((run): run is Extract<MsbtRun, { kind: 'end' }> =>
    run.kind === 'end'
  )

  const usedCommands = new Set<number>()
  const usedEnds = new Set<number>()

  const takeCommand = (group: number, type: number): MsbtRun => {
    const fresh = commands.findIndex(
      (run, at) => !usedCommands.has(at) && run.group === group && run.type === type
    )
    if (fresh !== -1) {
      usedCommands.add(fresh)
      return commands[fresh]!
    }
    const reused = commands.find((run) => run.group === group && run.type === type)
    if (reused) return reused

    throw new FormatWriteError({
      format: 'msbt',
      message: `{n:${group}.${type}} is not a command this message had, so there is no payload to write for it. Inline commands can be moved, repeated or removed, but not invented.`
    })
  }

  const takeEnd = (): MsbtRun => {
    const fresh = ends.findIndex((_, at) => !usedEnds.has(at))
    if (fresh !== -1) {
      usedEnds.add(fresh)
      return ends[fresh]!
    }
    const reused = ends[0]
    if (reused) return reused

    throw new FormatWriteError({
      format: 'msbt',
      message:
        '{n:end} closes an inline command region, and this message had none to close. Remove it, or keep the command it belonged to.'
    })
  }

  const runs: MsbtRun[] = []
  let at = 0
  PLACEHOLDER.lastIndex = 0

  for (let match = PLACEHOLDER.exec(text); match !== null; match = PLACEHOLDER.exec(text)) {
    if (match.index > at) runs.push({ kind: 'text', value: text.slice(at, match.index) })

    const body = match[1]!
    if (body === 'end') {
      runs.push(takeEnd())
    } else {
      const [group, type] = body.split('.').map(Number) as [number, number]
      runs.push(takeCommand(group, type))
    }
    at = match.index + match[0].length
  }

  if (at < text.length) runs.push({ kind: 'text', value: text.slice(at) })
  return runs
}

/**
 * A copy of the document with one message's text replaced.
 *
 * Returns the document unchanged when the text is identical, which is what keeps a
 * dirty flag honest — and, downstream, keeps a mod from shipping a file whose only
 * difference is that it was opened.
 */
export function setMessageText(
  document: MsbtDocument,
  index: number,
  text: string
): MsbtDocument {
  const target = document.messages.find((message) => message.index === index)
  if (!target) {
    throw new FormatWriteError({
      format: 'msbt',
      message: `this table has no message at index ${index}`
    })
  }
  if (target.text === text) return document

  const runs = runsFromText(target.runs, text)
  const updated: MsbtMessage = { ...target, runs, text: renderRuns(runs) }
  return {
    ...document,
    messages: document.messages.map((message) => (message.index === index ? updated : message))
  }
}

export interface ReplacementSummary {
  readonly document: MsbtDocument
  /** How many messages changed, not how many occurrences were replaced. */
  readonly changed: number
  readonly examples: { readonly label: string; readonly before: string; readonly after: string }[]
}

/**
 * Find and replace across a whole table.
 *
 * Operates on the placeholder rendering, so a search can deliberately match one —
 * moving `{n:1.4}` to the end of every line is a real translation task. It also
 * means a careless pattern can eat one, which is why the summary carries examples:
 * a batch edit over 3,000 strings that reports only a count is a batch edit nobody
 * can check.
 */
export function replaceInDocument(
  document: MsbtDocument,
  find: string | RegExp,
  replacement: string,
  options?: { limit?: number }
): ReplacementSummary {
  const pattern =
    typeof find === 'string'
      ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      : new RegExp(find.source, find.flags.includes('g') ? find.flags : `${find.flags}g`)

  const examples: ReplacementSummary['examples'] = []
  let changed = 0

  const messages = document.messages.map((message) => {
    pattern.lastIndex = 0
    const after = message.text.replace(pattern, replacement)
    if (after === message.text) return message

    changed += 1
    if (examples.length < (options?.limit ?? 5)) {
      examples.push({ label: message.label, before: message.text, after })
    }
    const runs = runsFromText(message.runs, after)
    return { ...message, runs, text: renderRuns(runs) }
  })

  return { document: { ...document, messages }, changed, examples }
}
