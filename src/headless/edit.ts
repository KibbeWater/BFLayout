import type {
  AnimationComponent,
  AnimationDocument,
  AnimationEntry,
  AnimationTag,
  CurveKind,
  Keyframe
} from '@shared/formats/bflan/types'
import { tagName, targetName } from '@shared/formats/bflan/types'
import {
  createBoundaryPane,
  createGroup,
  createMaterial,
  createNullPane,
  createPartPane,
  createPicturePane,
  createTextPane,
  createWindowPane
} from '@shared/formats/bflyt/create'
import { nextPaneId } from '@shared/formats/bflyt/panes'
import { localSegment, referencedPanes } from '@shared/formats/bflyt/userdata'
import type {
  GroupPane,
  LayoutDocument,
  Material,
  Pane,
  PaneKind,
  Rgba,
  UserDataEntry,
  UserDataValueKind
} from '@shared/formats/bflyt/types'

/**
 * Document surgery for the headless tools.
 *
 * The app does the same work through `editor/commands.ts`, which is built around
 * undo entries and pane *ids* — the right shape for a canvas where every action
 * has to be reversible and the selection is a live object. Neither applies here:
 * a command-line invocation and a tool call both address panes by *name*, because
 * that is the only identity that survives between one process and the next, and
 * neither has an undo stack to push onto. So these are plain functions over a
 * document, and the file on disk is the thing that gets undone.
 *
 * Everything mutates in place and returns a description of what changed, which is
 * what the caller reports back. An operation that cannot be done throws with a
 * message naming the alternative rather than returning a quiet failure.
 */

// ------------------------------------------------------------------ layouts

export function findPaneByName(document: LayoutDocument, name: string): Pane | null {
  const visit = (pane: Pane): Pane | null => {
    if (pane.name === name) return pane
    for (const child of pane.children) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  return document.rootPane ? visit(document.rootPane) : null
}

/** Every pane, with its parent, so structural edits can find both ends. */
export function flatten(
  document: LayoutDocument
): { pane: Pane; parent: Pane | null; depth: number }[] {
  const out: { pane: Pane; parent: Pane | null; depth: number }[] = []
  const visit = (pane: Pane, parent: Pane | null, depth: number): void => {
    out.push({ pane, parent, depth })
    for (const child of pane.children) visit(child, pane, depth + 1)
  }
  if (document.rootPane) visit(document.rootPane, null, 0)
  return out
}

export function paneNames(document: LayoutDocument): string[] {
  return flatten(document).map((entry) => entry.pane.name)
}

/**
 * Names are how everything addresses a pane, so a duplicate is refused.
 *
 * Shipped layouts do contain repeated names — `Null` several times over — and
 * nothing here breaks them. But a *new* pane sharing a name would make every
 * later edit ambiguous, silently applying to whichever the search found first.
 */
function requireFreeName(document: LayoutDocument, name: string): void {
  if (name.trim() === '') throw new Error('a pane needs a name')
  if (findPaneByName(document, name)) {
    throw new Error(
      `this layout already has a pane called ${name}. Names are how panes are addressed here, so a second one would make every later edit ambiguous.`
    )
  }
}

const MAKERS: Record<string, (name: string) => Pane> = {
  pan1: (name) => createNullPane(name),
  pic1: (name) => createPicturePane(name, 0),
  txt1: (name) => createTextPane(name, 0),
  wnd1: (name) => createWindowPane(name, 0),
  bnd1: (name) => createBoundaryPane(name),
  prt1: (name) => createPartPane(name, '')
}

export const PANE_KINDS = Object.keys(MAKERS) as readonly PaneKind[]

export interface AddPaneOptions {
  readonly kind: string
  readonly name: string
  readonly parent?: string
  readonly translate?: readonly [number, number, number]
  readonly size?: readonly [number, number]
  readonly text?: string
  readonly part?: string
  readonly at?: number
}

export function addPane(document: LayoutDocument, options: AddPaneOptions): string {
  const make = MAKERS[options.kind]
  if (!make) {
    throw new Error(
      `${options.kind} is not a pane kind. Use one of: ${PANE_KINDS.join(', ')}.`
    )
  }
  requireFreeName(document, options.name)

  const parent = options.parent
    ? findPaneByName(document, options.parent)
    : document.rootPane
  if (!parent) {
    throw new Error(
      options.parent
        ? `no pane called ${options.parent} to add this under`
        : 'this layout has no root pane to add anything to'
    )
  }

  const pane = make(options.name)
  if (options.translate) pane.translate = [...options.translate]
  if (options.size) {
    pane.width = options.size[0]
    pane.height = options.size[1]
  }
  if (options.text !== undefined) {
    if (pane.kind !== 'txt1') throw new Error('only a txt1 pane has text')
    pane.text = options.text
  }
  if (options.part !== undefined) {
    if (pane.kind !== 'prt1') throw new Error('only a prt1 pane instantiates a layout')
    pane.externalLayoutName = options.part
  }

  const at = options.at ?? parent.children.length
  parent.children.splice(Math.max(0, Math.min(at, parent.children.length)), 0, pane)
  return `${options.kind} pane ${options.name} added under ${parent.name}`
}

export function deletePane(document: LayoutDocument, name: string): string {
  const entry = flatten(document).find((candidate) => candidate.pane.name === name)
  if (!entry) throw new Error(`no pane called ${name}`)
  if (!entry.parent) {
    throw new Error(
      `${name} is the root pane. Deleting it would leave the layout with nothing to draw; delete its children instead.`
    )
  }

  const removed = 1 + flatten(document).filter((c) => contains(entry.pane, c.pane)).length - 1
  entry.parent.children = entry.parent.children.filter((child) => child !== entry.pane)
  return removed > 1 ? `${name} and ${removed - 1} descendant(s) removed` : `${name} removed`
}

function contains(ancestor: Pane, pane: Pane): boolean {
  if (ancestor === pane) return true
  return ancestor.children.some((child) => contains(child, pane))
}

/**
 * Copies a pane and its subtree under the same parent.
 *
 * Every name in the copy is suffixed, because a duplicate that reused them would
 * produce a layout where half the panes cannot be addressed unambiguously — and
 * duplicating is nearly always the first half of "and now change this one".
 */
export interface DuplicateReport {
  readonly message: string
  readonly name: string
  /** Reference values rewritten to point at the copy's own panes. */
  readonly remapped: readonly string[]
  /**
   * References that still point outside the copy.
   *
   * Sometimes deliberate — a shared capture target is named by many panes on
   * purpose — and sometimes the whole bug. Either way the copy now behaves as a
   * collaborator of the original, which is worth saying out loud.
   */
  readonly warnings: readonly string[]
}

export function duplicatePane(
  document: LayoutDocument,
  name: string,
  suffix = '_copy'
): DuplicateReport {
  const entry = flatten(document).find((candidate) => candidate.pane.name === name)
  if (!entry) throw new Error(`no pane called ${name}`)
  if (!entry.parent) throw new Error(`${name} is the root pane, so it has no sibling to copy into`)

  const taken = new Set(paneNames(document))
  const renames = new Map<string, string>()
  const rename = (base: string): string => {
    let candidate = `${base}${suffix}`
    let counter = 2
    while (taken.has(candidate)) candidate = `${base}${suffix}${counter++}`
    taken.add(candidate)
    renames.set(base, candidate)
    return candidate
  }

  const copy = (pane: Pane): Pane => {
    const clone = JSON.parse(JSON.stringify(pane)) as Pane
    clone.name = rename(pane.name)
    // A fresh identity: the writer replays a clean pane's original bytes keyed by
    // id, so a clone sharing one would be written out as the pane it came from,
    // new name and all.
    clone.id = nextPaneId(pane.kind)
    clone.children = pane.children.map(copy)
    return clone
  }

  const clone = copy(entry.pane)
  const at = entry.parent.children.indexOf(entry.pane) + 1
  entry.parent.children.splice(at, 0, clone)

  const { remapped, warnings } = retargetReferences(clone, renames)
  const tail = warnings.length > 0 ? `; ${warnings.length} reference(s) still point outside the copy` : ''
  return {
    message: `${name} duplicated as ${clone.name}${tail}`,
    name: clone.name,
    remapped,
    warnings
  }
}

/**
 * Points a copied subtree's user data at its own panes.
 *
 * A reference naming something that was copied alongside it means "my text pane",
 * and the copy's version of that pane is the one it should drive — so it is
 * rewritten. A reference to anything else cannot be repaired here: the copy really
 * does now name a pane it does not own, and only the person duplicating it knows
 * whether that was the point.
 */
function retargetReferences(
  root: Pane,
  renames: ReadonlyMap<string, string>
): { remapped: string[]; warnings: string[] } {
  const remapped: string[] = []
  const warnings: string[] = []

  const visit = (pane: Pane): void => {
    for (const entry of pane.userData?.entries ?? []) {
      const references = referencedPanes(entry)
      if (references.length === 0) continue

      let changed = false
      const updated = references.map((reference) => {
        const [head, ...rest] = reference.split('/')
        // A rooted reference has an empty first segment, so it never matches a
        // rename and falls through to the warning, which is right: it names a
        // pane in the embedding layout, and copying this one changes nothing.
        const to = head === undefined || head === '' ? undefined : renames.get(head)
        if (to === undefined) {
          warnings.push(`${pane.name}.${entry.name} still points at ${reference}`)
          return reference
        }
        changed = true
        remapped.push(`${pane.name}.${entry.name}: ${reference} → ${[to, ...rest].join('/')}`)
        return [to, ...rest].join('/')
      })

      if (changed) {
        entry.stringValue = updated.join('\n')
        entry.itemCount = entry.stringValue.length + 1
        pane.userData!.dirty = true
      }
    }
    for (const child of pane.children) visit(child)
  }

  visit(root)
  return { remapped, warnings }
}

export function renamePane(document: LayoutDocument, name: string, to: string): string {
  const pane = findPaneByName(document, name)
  if (!pane) throw new Error(`no pane called ${name}`)
  requireFreeName(document, to)
  pane.name = to
  return `${name} renamed to ${to}`
}

/**
 * Moves a pane to a different parent.
 *
 * Refuses to move a pane into its own subtree, which would detach that subtree
 * from the tree entirely — it would still exist, still be reachable from itself,
 * and never be drawn again.
 */
export function reparentPane(
  document: LayoutDocument,
  name: string,
  parentName: string,
  at?: number
): string {
  const entry = flatten(document).find((candidate) => candidate.pane.name === name)
  if (!entry) throw new Error(`no pane called ${name}`)
  if (!entry.parent) throw new Error(`${name} is the root pane and cannot be moved`)

  const parent = findPaneByName(document, parentName)
  if (!parent) throw new Error(`no pane called ${parentName} to move it under`)
  if (contains(entry.pane, parent)) {
    throw new Error(
      `${parentName} is inside ${name}, so moving ${name} there would detach the whole subtree from the layout`
    )
  }

  entry.parent.children = entry.parent.children.filter((child) => child !== entry.pane)
  const index = at ?? parent.children.length
  parent.children.splice(Math.max(0, Math.min(index, parent.children.length)), 0, entry.pane)
  return `${name} moved under ${parentName}`
}

/** Reorders a pane among its siblings — which is draw order, so it is z-order. */
export function reorderPane(document: LayoutDocument, name: string, to: number): string {
  const entry = flatten(document).find((candidate) => candidate.pane.name === name)
  if (!entry) throw new Error(`no pane called ${name}`)
  if (!entry.parent) throw new Error(`${name} is the root pane and has no siblings`)

  const siblings = entry.parent.children
  const from = siblings.indexOf(entry.pane)
  const index = Math.max(0, Math.min(to, siblings.length - 1))
  siblings.splice(from, 1)
  siblings.splice(index, 0, entry.pane)
  return `${name} moved from position ${from} to ${index} among its siblings (later draws on top)`
}

// ---------------------------------------------------------------- materials

export interface MaterialEdit {
  readonly blackColor?: readonly [number, number, number, number]
  readonly whiteColor?: readonly [number, number, number, number]
  /** Texture list indices this material samples, in slot order. */
  readonly textureIndices?: readonly number[]
}

export function editMaterial(
  document: LayoutDocument,
  name: string,
  edit: MaterialEdit
): string[] {
  const material = document.materials.find((candidate) => candidate.name === name)
  if (!material) {
    throw new Error(
      `no material called ${name}. This layout has: ${document.materials.map((m) => m.name).join(', ') || 'none'}`
    )
  }

  const changed: string[] = []
  const channel = (values: readonly number[]): Rgba => {
    for (const value of values) {
      if (value < 0 || value > 255) throw new Error('colour channels run from 0 to 255')
    }
    return [values[0]!, values[1]!, values[2]!, values[3]!]
  }

  if (edit.blackColor) {
    material.blackColor = channel(edit.blackColor)
    changed.push(`black colour → ${edit.blackColor.join(', ')}`)
  }
  if (edit.whiteColor) {
    material.whiteColor = channel(edit.whiteColor)
    changed.push(`white colour → ${edit.whiteColor.join(', ')}`)
  }
  if (edit.textureIndices) {
    for (const index of edit.textureIndices) {
      if (index < 0 || index >= document.textures.length) {
        throw new Error(
          `texture index ${index} is outside this layout's texture list (${document.textures.length} entries: ${document.textures.join(', ')})`
        )
      }
    }
    material.textureMaps = edit.textureIndices.map((index, slot) => ({
      ...(material.textureMaps[slot] ?? { flag1: 0, flag2: 0 }),
      textureIndex: index
    }))
    changed.push(
      `textures → ${edit.textureIndices.map((index) => document.textures[index]).join(', ')}`
    )
  }

  if (changed.length === 0) throw new Error('nothing to change was given')
  /*
   * The dirty flag is what tells the writer to rebuild this material rather than
   * replay its original bytes. Forgetting it produces a save that reports success
   * and writes the old colours.
   */
  material.dirty = true
  return changed
}

/** Adds a texture to the layout's list, returning the index materials refer to it by. */
export function addTexture(document: LayoutDocument, name: string): number {
  const existing = document.textures.indexOf(name)
  if (existing >= 0) return existing
  document.textures.push(name)
  return document.textures.length - 1
}

export function addMaterialTo(document: LayoutDocument, name: string): number {
  if (document.materials.some((material) => material.name === name)) {
    throw new Error(`this layout already has a material called ${name}`)
  }
  document.materials.push(createMaterial(name))
  return document.materials.length - 1
}

// ----------------------------------------------------------------- groups

/**
 * Pane groups, and why they are not an optional extra.
 *
 * A BFLAN's `pat1` binds to a *group*, and that binding is what decides which
 * panes the animation applies to. An animation bound to a group the layout does
 * not have applies to nothing — it loads, its tracks are correct, and the screen
 * sits still. In a shipped romfs 2183 of 2187 animations bind to a group, so this
 * is the normal case rather than a corner of the format.
 *
 * Group trees in shipped layouts are flat: a root group, and one level of named
 * groups under it. Nothing here builds deeper, because nothing in the game does.
 */

/** The longest a name can be, given the fixed-width field it is written into. */
const groupNameLimit = (major: number): number => (major >= 5 ? 33 : 23)
const GROUP_PANE_LIMIT = 23

export interface GroupView {
  readonly name: string
  readonly panes: readonly string[]
}

export function groupList(document: LayoutDocument): GroupView[] {
  const out: GroupView[] = []
  const visit = (group: GroupPane): void => {
    // The root group is a container for the rest, not a binding target.
    if (group !== document.rootGroup) out.push({ name: group.name, panes: [...group.paneNames] })
    for (const child of group.children) visit(child)
  }
  if (document.rootGroup) visit(document.rootGroup)
  return out
}

function findGroup(document: LayoutDocument, name: string): GroupPane | null {
  const visit = (group: GroupPane): GroupPane | null => {
    if (group.name === name && group !== document.rootGroup) return group
    for (const child of group.children) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  return document.rootGroup ? visit(document.rootGroup) : null
}

function requireGroupablePanes(document: LayoutDocument, panes: readonly string[]): void {
  const present = new Set(paneNames(document))
  const missing = panes.filter((pane) => !present.has(pane))
  if (missing.length > 0) {
    throw new Error(
      `this layout has no pane called ${missing.join(', ')}. A group naming a pane that is not there binds to nothing, which is the failure groups exist to avoid.`
    )
  }
  const tooLong = panes.filter((pane) => pane.length > GROUP_PANE_LIMIT)
  if (tooLong.length > 0) {
    throw new Error(
      `a group stores pane names in ${GROUP_PANE_LIMIT + 1} bytes, so ${tooLong.join(', ')} would be truncated and stop matching`
    )
  }
}

export function addGroup(
  document: LayoutDocument,
  name: string,
  panes: readonly string[]
): string {
  if (name.trim() === '') throw new Error('a group needs a name')
  if (findGroup(document, name)) throw new Error(`this layout already has a group called ${name}`)

  const limit = groupNameLimit(document.version.major)
  if (name.length > limit) {
    throw new Error(
      `a group name is written into ${limit + 1} bytes at this layout version, so ${name} would be truncated and an animation binding to it would stop matching`
    )
  }
  requireGroupablePanes(document, panes)

  if (!document.rootGroup) document.rootGroup = createGroup()
  document.rootGroup.children.push({
    id: `group_new_${name}`,
    name,
    paneNames: [...panes],
    children: [],
    dirty: true
  })
  document.rootGroup.dirty = true
  return `group ${name} added with ${panes.length} pane(s)`
}

export function deleteGroup(document: LayoutDocument, name: string): string {
  const group = findGroup(document, name)
  if (!group) {
    const present = groupList(document).map((entry) => entry.name)
    throw new Error(
      present.length > 0
        ? `no group called ${name}. This layout has: ${present.join(', ')}.`
        : `this layout has no groups at all, so there is no ${name} to delete`
    )
  }

  const prune = (parent: GroupPane): void => {
    parent.children = parent.children.filter((child) => child !== group)
    for (const child of parent.children) prune(child)
  }
  prune(document.rootGroup!)
  document.rootGroup!.dirty = true
  return `group ${name} removed`
}

export function editGroup(
  document: LayoutDocument,
  name: string,
  edit: { set?: readonly string[]; add?: readonly string[]; remove?: readonly string[] }
): string[] {
  const group = findGroup(document, name)
  if (!group) {
    const present = groupList(document).map((entry) => entry.name)
    throw new Error(
      present.length > 0
        ? `no group called ${name}. This layout has: ${present.join(', ')}.`
        : `this layout has no groups at all`
    )
  }

  const changed: string[] = []
  if (edit.set) {
    requireGroupablePanes(document, edit.set)
    group.paneNames = [...edit.set]
    changed.push(`panes → ${edit.set.join(', ') || '(none)'}`)
  }
  if (edit.add) {
    requireGroupablePanes(document, edit.add)
    const fresh = edit.add.filter((pane) => !group.paneNames.includes(pane))
    group.paneNames.push(...fresh)
    if (fresh.length > 0) changed.push(`added ${fresh.join(', ')}`)
  }
  if (edit.remove) {
    const before = group.paneNames.length
    group.paneNames = group.paneNames.filter((pane) => !edit.remove!.includes(pane))
    if (group.paneNames.length !== before) changed.push(`removed ${edit.remove.join(', ')}`)
  }

  if (changed.length === 0) throw new Error('nothing to change was given')
  group.dirty = true
  return changed
}

// -------------------------------------------------------------- user data

export interface UserDataView {
  readonly name: string
  readonly kind: UserDataValueKind
  /** The decoded value: a string, a list of numbers, or a byte count for a struct. */
  readonly value: string | number[] | null
  readonly bytes?: number
  /** Set when this entry names panes, each with whether this layout has it. */
  readonly references?: readonly {
    readonly pane: string
    readonly present: boolean
    /** Set when the reference is not this layout's to resolve. */
    readonly note?: string
  }[]
}

function viewOf(entry: UserDataEntry, document: LayoutDocument): UserDataView {
  const base = {
    name: entry.name,
    kind: entry.kind,
    value:
      entry.kind === 'string'
        ? entry.stringValue
        : entry.kind === 'struct'
          ? null
          : entry.numberValues,
    ...(entry.kind === 'struct' ? { bytes: entry.structValue?.length ?? 0 } : {})
  }

  const references = referencedPanes(entry)
  if (references.length === 0) return base
  return {
    ...base,
    references: references.map((pane) => {
      const local = localSegment(pane)
      return local === null
        ? { pane, present: true, note: 'rooted at the layout that embeds this one' }
        : { pane, present: findPaneByName(document, local) !== null }
    })
  }
}

export function paneUserData(document: LayoutDocument, name: string): UserDataView[] {
  const pane = findPaneByName(document, name)
  if (!pane) throw new Error(`no pane called ${name}`)
  return (pane.userData?.entries ?? []).map((entry) => viewOf(entry, document))
}

export interface UserDataEdit {
  readonly name: string
  readonly value: string | number[]
  /** Defaults to `string` for a string value and `int` for numbers. */
  readonly kind?: 'string' | 'int' | 'float'
}

/**
 * Sets and removes user data entries on a pane.
 *
 * Editing any entry re-encodes the whole `usd1` section rather than replaying the
 * bytes it was read from — which is why this refuses to touch a struct entry. A
 * struct's payload is opaque and its stored item count does not describe its
 * length, so it survives only by being copied verbatim; rewriting the section
 * around one is fine, inventing one is not.
 */
export function editUserData(
  document: LayoutDocument,
  paneName: string,
  edit: { set?: readonly UserDataEdit[]; remove?: readonly string[] }
): string[] {
  const pane = findPaneByName(document, paneName)
  if (!pane) throw new Error(`no pane called ${paneName}`)

  const changed: string[] = []
  const userData = pane.userData ?? { entries: [], raw: [], dirty: false }

  for (const name of edit.remove ?? []) {
    const at = userData.entries.findIndex((entry) => entry.name === name)
    if (at < 0) {
      const present = userData.entries.map((entry) => entry.name)
      throw new Error(
        present.length > 0
          ? `${paneName} has no user data called ${name}. It has: ${present.join(', ')}.`
          : `${paneName} has no user data at all, so there is no ${name} to remove`
      )
    }
    userData.entries.splice(at, 1)
    changed.push(`removed ${name}`)
  }

  for (const set of edit.set ?? []) {
    const kind = set.kind ?? (typeof set.value === 'string' ? 'string' : 'int')
    if (typeof set.value === 'string' !== (kind === 'string')) {
      throw new Error(
        `${set.name} was given a ${typeof set.value === 'string' ? 'string' : 'number list'} but kind ${kind}`
      )
    }

    const existing = userData.entries.find((entry) => entry.name === set.name)
    if (existing?.kind === 'struct') {
      throw new Error(
        `${set.name} on ${paneName} is a struct entry, whose bytes this build preserves but cannot rebuild. Remove it or leave it as it is.`
      )
    }

    const numbers = typeof set.value === 'string' ? [] : [...set.value]
    const entry: UserDataEntry = {
      name: set.name,
      kind,
      stringValue: typeof set.value === 'string' ? set.value : null,
      numberValues: numbers,
      structValue: null,
      itemCount: typeof set.value === 'string' ? set.value.length + 1 : numbers.length,
      unknown: existing?.unknown ?? 0
    }

    if (existing) {
      Object.assign(existing, entry)
      changed.push(`${set.name} → ${describeValue(set.value)}`)
    } else {
      userData.entries.push(entry)
      changed.push(`added ${set.name} = ${describeValue(set.value)}`)
    }
  }

  if (changed.length === 0) throw new Error('nothing to set or remove was given')

  // See UserData.raw: the section is replayed byte for byte until this is set.
  userData.dirty = true
  pane.userData = userData.entries.length > 0 ? userData : null
  return changed
}

const describeValue = (value: string | readonly number[]): string =>
  typeof value === 'string' ? `"${value}"` : value.join(', ')

// -------------------------------------------------------------- animations

export interface ComponentView {
  readonly entry: string
  readonly target: 'pane' | 'material'
  readonly tag: string
  readonly tagName: string
  readonly index: number
  readonly targetByte: number
  readonly targetName: string
  readonly curve: CurveKind
  readonly keyframes: readonly Keyframe[]
}

/**
 * Every animated channel, flattened.
 *
 * The nesting in the file — entry, then tag, then component — is how it is
 * stored, not how anyone thinks about it. "Pane Foo's X translation" is one
 * track, and a flat list of tracks with their real names is what makes an
 * animation answerable without a diagram.
 */
export function animationTracks(document: AnimationDocument): ComponentView[] {
  const out: ComponentView[] = []
  for (const entry of document.info?.entries ?? []) {
    for (const tag of entry.tags) {
      for (const component of tag.components) {
        out.push({
          entry: entry.name,
          target: entry.target,
          tag: tag.signature,
          tagName: tagName(tag.signature),
          index: component.index,
          targetByte: component.target,
          targetName: targetName(tag.signature, component.target),
          curve: component.curve,
          keyframes: component.keyframes
        })
      }
    }
  }
  return out
}

function findComponent(
  document: AnimationDocument,
  selector: { entry: string; tag: string; target: number; index?: number }
): AnimationComponent {
  const entry = document.info?.entries.find((candidate) => candidate.name === selector.entry)
  if (!entry) {
    throw new Error(
      `this animation does not animate anything called ${selector.entry}. It drives: ${
        document.info?.entries.map((candidate) => candidate.name).join(', ') || 'nothing'
      }`
    )
  }

  const tag = entry.tags.find((candidate) => candidate.signature === selector.tag)
  if (!tag) {
    throw new Error(
      `${selector.entry} has no ${selector.tag} track. It has: ${entry.tags.map((t) => t.signature).join(', ')}`
    )
  }

  const component = tag.components.find(
    (candidate) =>
      candidate.target === selector.target &&
      (selector.index === undefined || candidate.index === selector.index)
  )
  if (!component) {
    throw new Error(
      `${selector.entry}'s ${selector.tag} track has no component for target ${selector.target} (${targetName(selector.tag, selector.target)}). It has: ${tag.components
        .map((c) => `${c.target} (${targetName(selector.tag, c.target)})`)
        .join(', ')}`
    )
  }
  return component
}

/** Keyframes must be in frame order; the evaluator walks them assuming it. */
function sortKeys(keyframes: Keyframe[]): Keyframe[] {
  return keyframes.slice().sort((a, b) => a.frame - b.frame)
}

export function setKeyframes(
  document: AnimationDocument,
  selector: { entry: string; tag: string; target: number; index?: number },
  keyframes: readonly Keyframe[],
  curve?: CurveKind
): string {
  if (keyframes.length === 0) {
    throw new Error(
      'a track needs at least one keyframe. Remove the whole track instead if that is what you meant.'
    )
  }
  const component = findComponent(document, selector)
  component.keyframes = sortKeys([...keyframes])
  if (curve) component.curve = curve
  return `${selector.entry} ${selector.tag} ${targetName(selector.tag, selector.target)}: ${keyframes.length} keyframe(s)`
}

export function putKeyframe(
  document: AnimationDocument,
  selector: { entry: string; tag: string; target: number; index?: number },
  key: Keyframe
): string {
  const component = findComponent(document, selector)
  // Setting a frame that already has a key replaces it, which is what "put"
  // means everywhere else and avoids two keys at one frame — which the evaluator
  // would resolve by whichever came first.
  const without = component.keyframes.filter((candidate) => candidate.frame !== key.frame)
  component.keyframes = sortKeys([...without, key])
  return `${selector.entry} ${selector.tag} ${targetName(selector.tag, selector.target)}: frame ${key.frame} = ${key.value}`
}

export function removeKeyframe(
  document: AnimationDocument,
  selector: { entry: string; tag: string; target: number; index?: number },
  frame: number
): string {
  const component = findComponent(document, selector)
  const before = component.keyframes.length
  component.keyframes = component.keyframes.filter((candidate) => candidate.frame !== frame)
  if (component.keyframes.length === before) {
    throw new Error(`there is no keyframe at frame ${frame} on that track`)
  }
  if (component.keyframes.length === 0) {
    throw new Error(
      'that was the track\'s only keyframe. A track with none has no value to evaluate; remove the track instead.'
    )
  }
  return `keyframe at frame ${frame} removed`
}

/**
 * Adds a track for something the animation does not yet drive.
 *
 * The common case for editing an animation is wanting to animate one more thing,
 * and every layer it needs — the entry for the pane, the tag for the kind of
 * property, the component for the specific channel — may or may not already
 * exist. Creating whichever are missing is the difference between an edit and a
 * hand-assembled file.
 */
export function addTrack(
  document: AnimationDocument,
  options: {
    entry: string
    target?: 'pane' | 'material'
    tag: string
    targetByte: number
    index?: number
    curve?: CurveKind
    keyframes: readonly Keyframe[]
  }
): string {
  if (!document.info) {
    throw new Error('this animation has no pai1 section, so there is nothing to add a track to')
  }
  if (options.keyframes.length === 0) throw new Error('a track needs at least one keyframe')

  let entry: AnimationEntry | undefined = document.info.entries.find(
    (candidate) => candidate.name === options.entry
  )
  const created: string[] = []

  if (!entry) {
    entry = {
      name: options.entry,
      target: options.target ?? 'pane',
      tags: [],
      userField: null
    }
    document.info.entries.push(entry)
    created.push('entry')
  }

  let tag: AnimationTag | undefined = entry.tags.find(
    (candidate) => candidate.signature === options.tag
  )
  if (!tag) {
    tag = { signature: options.tag, leading: null, components: [] }
    entry.tags.push(tag)
    created.push('tag')
  }

  const index = options.index ?? 0
  if (
    tag.components.some(
      (candidate) => candidate.target === options.targetByte && candidate.index === index
    )
  ) {
    throw new Error(
      `${options.entry} already has a ${options.tag} track for ${targetName(options.tag, options.targetByte)}. Use set_keyframes to change it.`
    )
  }

  tag.components.push({
    index,
    target: options.targetByte,
    curve: options.curve ?? 'hermite',
    keyframes: sortKeys([...options.keyframes])
  })

  return `${options.entry}: ${options.tag} ${targetName(options.tag, options.targetByte)} added${
    created.length > 0 ? ` (created its ${created.join(' and ')})` : ''
  }`
}

export function removeTrack(
  document: AnimationDocument,
  selector: { entry: string; tag: string; target: number; index?: number }
): string {
  const entry = document.info?.entries.find((candidate) => candidate.name === selector.entry)
  if (!entry) throw new Error(`this animation does not drive ${selector.entry}`)
  const tag = entry.tags.find((candidate) => candidate.signature === selector.tag)
  if (!tag) throw new Error(`${selector.entry} has no ${selector.tag} track`)

  const before = tag.components.length
  tag.components = tag.components.filter(
    (candidate) =>
      !(
        candidate.target === selector.target &&
        (selector.index === undefined || candidate.index === selector.index)
      )
  )
  if (tag.components.length === before) throw new Error('no such track')

  // An empty tag, and then an empty entry, are dropped rather than written out as
  // structures that animate nothing.
  if (tag.components.length === 0) {
    entry.tags = entry.tags.filter((candidate) => candidate !== tag)
  }
  if (entry.tags.length === 0 && document.info) {
    document.info.entries = document.info.entries.filter((candidate) => candidate !== entry)
  }
  return `${selector.entry} ${selector.tag} ${targetName(selector.tag, selector.target)} removed`
}

export interface AnimationEdit {
  readonly frameSize?: number
  readonly loop?: boolean
  readonly name?: string
  readonly startFrame?: number
  readonly endFrame?: number
}

export function editAnimation(document: AnimationDocument, edit: AnimationEdit): string[] {
  const changed: string[] = []

  if (edit.frameSize !== undefined) {
    if (!document.info) throw new Error('this animation has no pai1 section to set a length on')
    if (edit.frameSize < 0) throw new Error('a frame count cannot be negative')
    document.info.frameSize = edit.frameSize
    changed.push(`length → ${edit.frameSize} frames`)
  }
  if (edit.loop !== undefined) {
    if (!document.info) throw new Error('this animation has no pai1 section to set looping on')
    document.info.loop = edit.loop
    changed.push(edit.loop ? 'loops' : 'does not loop')
  }

  if (edit.name !== undefined || edit.startFrame !== undefined || edit.endFrame !== undefined) {
    if (!document.tag) {
      throw new Error('this animation has no pat1 section, so it has no name or frame range')
    }
    if (edit.name !== undefined) {
      document.tag.name = edit.name
      changed.push(`name → ${edit.name}`)
    }
    if (edit.startFrame !== undefined) {
      document.tag.startFrame = edit.startFrame
      changed.push(`starts at frame ${edit.startFrame}`)
    }
    if (edit.endFrame !== undefined) {
      document.tag.endFrame = edit.endFrame
      changed.push(`ends at frame ${edit.endFrame}`)
    }
  }

  if (changed.length === 0) throw new Error('nothing to change was given')
  return changed
}

// ------------------------------------------------------- copying between layouts

/**
 * Every material a pane subtree depends on, and how the pane refers to it.
 *
 * A pane does not reference a material, it references an *index* — and the same
 * goes for fonts, and for the textures a material samples. That is what makes
 * copying a pane between layouts a graph copy rather than a clone: paste the pane
 * alone and it points at whichever material happens to sit at that index in the
 * destination, which is not an error anywhere. It draws, with the wrong texture.
 */
function materialSlots(pane: Pane): { get: () => number; set: (index: number) => void }[] {
  const slots: { get: () => number; set: (index: number) => void }[] = []

  if (pane.kind === 'pic1' || pane.kind === 'txt1') {
    slots.push({
      get: () => pane.materialIndex,
      set: (index) => {
        pane.materialIndex = index
      }
    })
  }
  if (pane.kind === 'wnd1') {
    slots.push({
      get: () => pane.content.materialIndex,
      set: (index) => {
        pane.content.materialIndex = index
      }
    })
    for (const frame of pane.frames) {
      slots.push({
        get: () => frame.materialIndex,
        set: (index) => {
          frame.materialIndex = index
        }
      })
    }
  }
  return slots
}

export interface CopyReport {
  readonly panes: string[]
  readonly materials: string[]
  readonly textures: string[]
  readonly fonts: string[]
  /** Things that copied but will not work until something else is dealt with. */
  readonly warnings: string[]
}

export interface CopyOptions {
  /** Pane in the destination to put the copies under. Defaults to its root. */
  readonly into?: string
  /** Appended to any name already taken in the destination. */
  readonly suffix?: string
}

/**
 * Copies panes from one layout into another, bringing what they need with them.
 *
 * This is the operation behind "make me one like that". It carries the subtree,
 * the materials those panes draw with, the textures those materials sample and
 * the fonts the text uses, remapping every index as it goes — so the copy in the
 * destination means what it meant in the source.
 *
 * Deduplication is by name *and* content for materials, by name alone for
 * textures and fonts. A texture name is a file name, so two layouts naming the
 * same texture mean the same image; a material name is local and two layouts can
 * easily have different materials called `P_Base`, so one that does not match is
 * imported under its own name rather than silently reusing the destination's.
 */
export function copyPanes(
  source: LayoutDocument,
  destination: LayoutDocument,
  names: readonly string[],
  options: CopyOptions = {}
): CopyReport {
  const parent = options.into ? findPaneByName(destination, options.into) : destination.rootPane
  if (!parent) {
    throw new Error(
      options.into
        ? `the destination has no pane called ${options.into}`
        : 'the destination layout has no root pane to copy into'
    )
  }

  const suffix = options.suffix ?? '_copy'
  const taken = new Set(paneNames(destination))
  const report: CopyReport = {
    panes: [],
    materials: [],
    textures: [],
    fonts: [],
    warnings: []
  }

  /** Source index to destination index, resolved once per material. */
  const materialMap = new Map<number, number>()
  const fontMap = new Map<number, number>()

  const importTexture = (name: string): number => {
    const existing = destination.textures.indexOf(name)
    if (existing >= 0) return existing
    destination.textures.push(name)
    report.textures.push(name)
    return destination.textures.length - 1
  }

  const importFont = (index: number): number => {
    const cached = fontMap.get(index)
    if (cached !== undefined) return cached

    const name = source.fonts[index]
    if (name === undefined) {
      // An index the source itself cannot resolve; leaving it alone is closer to
      // the truth than pointing it at an unrelated font.
      fontMap.set(index, index)
      return index
    }
    const existing = destination.fonts.indexOf(name)
    const at = existing >= 0 ? existing : destination.fonts.push(name) - 1
    if (existing < 0) report.fonts.push(name)
    fontMap.set(index, at)
    return at
  }

  const sameMaterial = (a: Material, b: Material): boolean => {
    const strip = (material: Material): string => {
      const { dirty: _dirty, ...rest } = material
      return JSON.stringify(rest)
    }
    return strip(a) === strip(b)
  }

  const importMaterial = (index: number): number => {
    const cached = materialMap.get(index)
    if (cached !== undefined) return cached

    const original = source.materials[index]
    if (!original) {
      report.warnings.push(
        `a pane referred to material index ${index}, which the source layout does not have; it was left pointing there`
      )
      materialMap.set(index, index)
      return index
    }

    const clone = JSON.parse(JSON.stringify(original)) as Material
    // Remap before comparing: a material is only "the same" if it samples the
    // same textures once both are expressed in the destination's numbering.
    clone.textureMaps = clone.textureMaps.map((map) => {
      const name = source.textures[map.textureIndex]
      return name === undefined ? map : { ...map, textureIndex: importTexture(name) }
    })

    const existing = destination.materials.findIndex(
      (candidate) => candidate.name === clone.name
    )
    if (existing >= 0) {
      if (sameMaterial(destination.materials[existing]!, clone)) {
        materialMap.set(index, existing)
        return existing
      }
      /*
       * Same name, different material. Reusing the destination's would change how
       * the copied panes draw, for a reason nobody would find; so it comes in under
       * a name of its own and the caller is told, because two materials called
       * almost the same thing is worth knowing about.
       */
      let candidate = `${clone.name}${suffix}`
      let counter = 2
      const used = new Set(destination.materials.map((material) => material.name))
      while (used.has(candidate)) candidate = `${clone.name}${suffix}${counter++}`
      report.warnings.push(
        `the destination already had a different material called ${clone.name}; the copied one is ${candidate}`
      )
      clone.name = candidate
    }

    // Dirty, so the writer rebuilds it here rather than replaying bytes that
    // belonged to a different file.
    clone.dirty = true
    destination.materials.push(clone)
    report.materials.push(clone.name)
    const at = destination.materials.length - 1
    materialMap.set(index, at)
    return at
  }

  for (const name of names) {
    const original = findPaneByName(source, name)
    if (!original) throw new Error(`the source layout has no pane called ${name}`)

    const rename = (base: string): string => {
      if (!taken.has(base)) {
        taken.add(base)
        return base
      }
      let candidate = `${base}${suffix}`
      let counter = 2
      while (taken.has(candidate)) candidate = `${base}${suffix}${counter++}`
      taken.add(candidate)
      return candidate
    }

    const clone = (pane: Pane): Pane => {
      const copy = JSON.parse(JSON.stringify(pane)) as Pane
      copy.name = rename(pane.name)
      copy.children = pane.children.map(clone)

      for (const slot of materialSlots(copy)) slot.set(importMaterial(slot.get()))
      if (copy.kind === 'txt1') copy.fontIndex = importFont(copy.fontIndex)
      if (copy.kind === 'prt1' && copy.externalLayoutName !== '') {
        report.warnings.push(
          `${copy.name} is a part pane instantiating ${copy.externalLayoutName}; that layout has to exist alongside the destination or the part will draw nothing`
        )
      }
      return copy
    }

    const copied = clone(original)
    parent.children.push(copied)
    report.panes.push(copied.name)
  }

  return report
}
