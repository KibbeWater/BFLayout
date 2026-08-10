import { FormatParseError } from '@shared/binary/errors'
import type { AnimationDocument } from '@shared/formats/bflan/types'
import { nextPaneId } from '@shared/formats/bflyt'
import type { LayoutDocument, Pane } from '@shared/formats/bflyt/types'
import { fromYaml, toYaml, type YamlValue } from './yaml'

/**
 * Layouts and animations as text, so a mod can be reviewed.
 *
 * A binary mod is a black box in version control. You can see *that* a `.szs`
 * changed and nothing about what — no review, no merge, no bisect, no way to tell
 * a moved button from a rebuilt file. This is the thing Switch Toolbox
 * structurally cannot do, and it changes what a group of people can build
 * together rather than merely making one person faster.
 *
 * The binary stays the artefact. This is a projection of the same model the
 * editor and the writer already share, which is what makes it trustworthy: every
 * layout in the dump re-encodes byte for byte from the model alone, so text that
 * reproduces the model reproduces the file.
 */

const FORMAT_VERSION = 1

/**
 * Fields that exist only inside a running editor.
 *
 * Pane ids come from a counter that never resets and identify a node only within
 * the process that minted it. Writing them out would put a value in the file that
 * means nothing anywhere else — and, worse, would produce a diff every time a
 * layout was opened and re-exported without being changed.
 */
const EDITOR_ONLY = new Set(['id'])

function strip(value: unknown): YamlValue {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(strip)
  if (value instanceof Uint8Array) return [...value]
  if (typeof value === 'object') {
    const out: Record<string, YamlValue> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (EDITOR_ONLY.has(key)) continue
      if (child === undefined) continue
      out[key] = strip(child)
    }
    return out
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  return String(value)
}

/** Re-mints the ids that were deliberately left out, depth first. */
function restoreIds(pane: Pane): void {
  ;(pane as { id: string }).id = nextPaneId()
  for (const child of pane.children ?? []) restoreIds(child)
}

export function layoutToText(document: LayoutDocument): string {
  return toYaml({
    /*
     * A version on the text form itself, separate from the layout's own. It costs
     * one line and it is the difference between "this file was written by an older
     * build" and an unexplained parse failure two years from now.
     */
    bflayout: { kind: 'bflyt', textVersion: FORMAT_VERSION },
    layout: strip(document)
  })
}

export function layoutFromText(source: string): LayoutDocument {
  const parsed = fromYaml(source)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('the file is not a layout text document')
  }

  const header = (parsed as Record<string, YamlValue>)['bflayout']
  const kind =
    header !== null && typeof header === 'object' && !Array.isArray(header)
      ? (header as Record<string, YamlValue>)['kind']
      : null
  if (kind !== 'bflyt') {
    return fail(
      kind === 'bflan'
        ? 'this is an animation, not a layout'
        : 'the file has no BFLayout header, so it is not a layout text document'
    )
  }

  const body = (parsed as Record<string, YamlValue>)['layout']
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('the document has no layout body')
  }

  const document = body as unknown as LayoutDocument
  /*
   * Ids are restored rather than defaulted. Every part of the editor keys off
   * them — selection, undo, the preserved-bytes table — and a document whose panes
   * shared an id, or had none, would fail in ways that look like anything except a
   * missing field.
   */
  if (document.rootPane) restoreIds(document.rootPane)
  if (document.rootGroup) restoreIds(document.rootGroup as unknown as Pane)
  return document
}

export function animationToText(document: AnimationDocument): string {
  return toYaml({
    bflayout: { kind: 'bflan', textVersion: FORMAT_VERSION },
    animation: strip(document)
  })
}

export function animationFromText(source: string): AnimationDocument {
  const parsed = fromYaml(source)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('the file is not an animation text document')
  }

  const body = (parsed as Record<string, YamlValue>)['animation']
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return fail('the document has no animation body')
  }
  return body as unknown as AnimationDocument
}

function fail(message: string): never {
  throw new FormatParseError({ format: 'bflayout-text', offset: 0, message })
}
