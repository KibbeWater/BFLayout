import type { BymlDocument, BymlNode } from './types'

/**
 * The shape a BYML document takes when it crosses the RPC boundary.
 *
 * Identical to the parsed tree except for binary nodes, which are replaced by a
 * summary. Two reasons: oRPC's serialiser has no case for `Uint8Array` and would
 * expand one into a JSON object of numeric keys, and a viewer has no use for the
 * bytes anyway — a length and a short hex preview say everything the tree can
 * usefully show. `bigint` needs no special handling; the serialiser does support
 * it, and 64-bit values must not be narrowed to `number`.
 */
export type BymlNodeView =
  | Exclude<BymlNode, { kind: 'binary' } | { kind: 'array' } | { kind: 'map' } | { kind: 'hashmap' }>
  | {
      readonly kind: 'binary'
      readonly byteLength: number
      /** First few bytes as hex, so the viewer can show something concrete. */
      readonly preview: string
      readonly alignment?: number
    }
  | { readonly kind: 'array'; readonly items: readonly BymlNodeView[] }
  | {
      readonly kind: 'map'
      readonly entries: readonly { readonly key: string; readonly value: BymlNodeView }[]
    }
  | {
      readonly kind: 'hashmap'
      readonly entries: readonly { readonly hash: number; readonly value: BymlNodeView }[]
    }

export interface BymlDocumentView {
  readonly version: number
  readonly littleEndian: boolean
  readonly root: BymlNodeView | null
  /** Total nodes, so the viewer can warn before rendering a huge tree. */
  readonly nodeCount: number
}

const PREVIEW_BYTES = 16

function hexPreview(data: Uint8Array): string {
  const shown = [...data.subarray(0, PREVIEW_BYTES)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ')
  return data.length > PREVIEW_BYTES ? `${shown} …` : shown
}

function toNodeView(node: BymlNode): BymlNodeView {
  switch (node.kind) {
    case 'binary':
      return {
        kind: 'binary',
        byteLength: node.data.length,
        preview: hexPreview(node.data),
        ...(node.alignment === undefined ? {} : { alignment: node.alignment })
      }
    case 'array':
      return { kind: 'array', items: node.items.map(toNodeView) }
    case 'map':
      return {
        kind: 'map',
        entries: node.entries.map((entry) => ({ key: entry.key, value: toNodeView(entry.value) }))
      }
    case 'hashmap':
      return {
        kind: 'hashmap',
        entries: node.entries.map((entry) => ({ hash: entry.hash, value: toNodeView(entry.value) }))
      }
    default:
      return node
  }
}

export function toBymlView(document: BymlDocument, nodeCount: number): BymlDocumentView {
  return {
    version: document.version,
    littleEndian: document.littleEndian,
    root: document.root === null ? null : toNodeView(document.root),
    nodeCount
  }
}

/** Whether a view node has children the tree should let you expand. */
export function isViewContainer(node: BymlNodeView): boolean {
  return node.kind === 'array' || node.kind === 'map' || node.kind === 'hashmap'
}

/** How many children a view node has, for the collapsed summary. */
export function viewChildCount(node: BymlNodeView): number {
  switch (node.kind) {
    case 'array':
      return node.items.length
    case 'map':
    case 'hashmap':
      return node.entries.length
    default:
      return 0
  }
}

/** A short, single-line rendering of a scalar node's value. */
export function formatScalar(node: BymlNodeView): string {
  switch (node.kind) {
    case 'null':
      return 'null'
    case 'bool':
      return node.value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(node.value)
    case 'int':
    case 'uint':
      return String(node.value)
    case 'int64':
    case 'uint64':
      return `${node.value}n`
    case 'float':
    case 'double':
      // Floats in these files are usually round numbers stored imprecisely, so a
      // short representation reads better than the full repr.
      return Number.isInteger(node.value) ? node.value.toFixed(1) : String(node.value)
    case 'binary':
      return `${node.byteLength} bytes`
    default:
      return ''
  }
}
