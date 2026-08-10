import type { UserDataEntry } from './types'

/**
 * Which user data entries name other panes, and what they name.
 *
 * User data is a free-form key/value bag, but a handful of keys are *behavioural*:
 * the runtime reads them and wires panes together. `AdjustToTextOn` is the one
 * with teeth — a pane carrying it resizes itself, every frame, to fit the text
 * panes it names. That makes duplication a trap. Copy such a pane and the copy
 * keeps the original's value, so it sits there driving itself from panes that
 * belong to something else, and nothing about the file looks wrong.
 *
 * These live here rather than in the headless tools because the checker needs
 * them too, and a rule that disagreed with the editor about what a reference is
 * would be worse than no rule.
 */

/**
 * Keys whose string value names panes.
 *
 * A list, not a heuristic. Matching any string that happens to equal a pane name
 * would rewrite labels, texture stems and message keys that merely collide, and a
 * wrong rewrite is invisible until the game runs. These are the keys a survey of
 * all 544 layouts in a shipped romfs turned up; missing one nobody has catalogued
 * is recoverable, corrupting one that is known is not.
 */
export const PANE_REFERENCE_KEYS: readonly string[] = [
  'AdjustToTextOn',
  'LocalizeReplaceOn',
  'CaptureUseName',
  'DynamicCaptureUseName'
]

/**
 * The pane names in a reference value.
 *
 * Shipped files store several, newline-separated — `Balloon_Message_00` points one
 * window at `T_Text_00\nT_Big_00\nT_Small_00`. Reading the whole string as a single
 * name reports every multi-target entry in the game as broken, which is how this
 * was got wrong the first time.
 */
export function referencedPanes(entry: UserDataEntry): string[] {
  if (entry.kind !== 'string' || entry.stringValue === null) return []
  if (!PANE_REFERENCE_KEYS.includes(entry.name)) return []
  return entry.stringValue.split('\n').filter((name) => name.length > 0)
}

/**
 * The part of a reference the layout holding it can be expected to contain, if any.
 *
 * References are paths, and only some of them are local:
 *
 * - `T_Text_00` — a pane in this layout. Resolvable.
 * - `L_Key_00/T_KeyTxt_00` — into a part pane, so only `L_Key_00` is this
 *   layout's; the rest lives in the part's own file.
 * - `/N_Capture_00` — rooted, meaning a pane in whatever layout embeds this one.
 *   Nothing here can resolve it, and two shipped layouts do exactly this.
 *
 * Returns null when the reference is not this layout's to resolve, so callers can
 * tell "absent" from "not mine to know" rather than reporting both as broken.
 */
export function localSegment(reference: string): string | null {
  if (reference.startsWith('/')) return null
  return reference.split('/')[0] ?? reference
}
