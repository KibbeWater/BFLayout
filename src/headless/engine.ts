import { readdir, readFile, stat, writeFile, mkdir, rename } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { createAnimation, isBflan, parseBflan, writeBflan } from '@shared/formats/bflan'
import type { AnimationDocument } from '@shared/formats/bflan/types'
import { buildOverrides } from '@shared/formats/bflan/overrides'
import { isBflyt, parseBflyt, referencedPanes, walkPanes, writeBflyt } from '@shared/formats/bflyt'
import type { GroupPane, LayoutDocument, Pane } from '@shared/formats/bflyt/types'
import { isBntx, mergeBntx, parseBntx, writeBntx } from '@shared/formats/bntx'
import { isMsbt, parseMsbt, writeMsbt } from '@shared/formats/msbt'
import { replaceInDocument, setMessageText } from '@shared/formats/msbt/editing'
import { createLayoutDocument } from '@shared/formats/bflyt/create'
import {
  findSarcEntry,
  isSarc,
  sarcAlignmentFor,
  sarcHash,
  parseSarc,
  replaceSarcEntry,
  writeSarc,
  type SarcArchive
} from '@shared/formats/sarc'
import { diffLayouts, summarizeChanges } from '@shared/mod/diff'
import { checkBytes } from '@shared/mod/check'
import { addGroup, copyPanes, type CopyReport } from './edit'
import { extractFile } from '@shared/mod/symbols'
import { layoutFromText, layoutToText } from '@shared/text/layout-text'
import { refuseWrite, resolveWrite } from '@main/mod-layer'
import { compress, decompress, type Compression } from './compression'
import { renderLayout, type RenderOptions, type RenderResult } from './render'
import { TextureLibrary, type DecodedTexture } from './textures'

/**
 * Everything the CLI and the MCP server do, without an editor.
 *
 * This is the dividend the `shared` purity gate was built for and which, until
 * now, only the tests collected: every codec here runs unchanged outside Electron,
 * so batch work, scripts, CI and an agent can all reach the same document model
 * the editor edits — rather than a second, weaker implementation that drifts.
 *
 * Deliberately plain promises rather than Effect. Nothing here composes with the
 * app's service graph, the failure mode is "print why and exit", and a CLI that
 * needs a runtime to say a file is missing has bought nothing.
 */

export interface ResolvedTarget {
  /** The file on disk. */
  readonly path: string
  /** Entry name, when the target is inside an archive. */
  readonly entry: string | null
  readonly bytes: Uint8Array
  readonly archive: SarcArchive | null
  /** How the container was compressed, so a save can put it back the same way. */
  readonly compression: 'none' | 'yaz0' | 'zstd'
}

/**
 * Finds what a path points at, following it into an archive when asked.
 *
 * `path` may name a loose file or an archive; `entry` selects a member. An archive
 * holding exactly one layout resolves to that layout when no entry is named, which
 * is the same convenience the app's file browser offers and for the same reason:
 * that is what a `.szs` in `Layout/` almost always is.
 */
export async function resolveTarget(path: string, entry?: string): Promise<ResolvedTarget> {
  const full = resolve(path)
  const raw = new Uint8Array(await readFile(full))
  const { data, compression } = await decompress(raw)

  if (!isSarc(data)) {
    if (entry !== undefined) {
      throw new Error(`${basename(full)} is not an archive, so it has no entry called ${entry}`)
    }
    return { path: full, entry: null, bytes: data, archive: null, compression }
  }

  const archive = parseSarc(data)
  if (entry === undefined) {
    const layouts = archive.entries.filter(
      (candidate) => candidate.name !== null && isBflyt(candidate.data)
    )
    if (layouts.length === 1) {
      return {
        path: full,
        entry: layouts[0]!.name,
        bytes: layouts[0]!.data,
        archive,
        compression
      }
    }
    return { path: full, entry: null, bytes: data, archive, compression }
  }

  const found = findSarcEntry(archive, entry)
  if (!found) {
    throw new Error(
      `${basename(full)} has no entry called ${entry}. It holds: ${archive.entries
        .map((candidate) => candidate.name)
        .filter(Boolean)
        .slice(0, 20)
        .join(', ')}`
    )
  }
  return { path: full, entry, bytes: found.data, archive, compression }
}

export async function readLayout(path: string, entry?: string): Promise<LayoutDocument> {
  const target = await resolveTarget(path, entry)
  if (!isBflyt(target.bytes)) {
    throw new Error(
      target.entry === null && target.archive
        ? `${basename(target.path)} holds several layouts — name one with --entry`
        : `${target.entry ?? basename(target.path)} is not a BFLYT layout`
    )
  }
  return parseBflyt(target.bytes).document
}

/**
 * Writes a layout back where it came from, rebuilding the archive around it.
 *
 * The document is re-encoded whole rather than against preserved section bytes.
 * The app keeps those to make an untouched save byte-exact; here there is no
 * session to keep them in, and a full re-encode is exact anyway — every layout in
 * the dump reproduces byte for byte from the model alone, which is precisely what
 * `validate:romfs` forces.
 */
export async function writeLayout(
  target: ResolvedTarget,
  document: LayoutDocument,
  outputPath?: string
): Promise<{ path: string; bytes: number; redirected: boolean }> {
  return writeInto(target, writeBflyt(document, new Map()), outputPath)
}

export async function writeAnimation(
  target: ResolvedTarget,
  document: AnimationDocument,
  outputPath?: string
): Promise<{ path: string; bytes: number; redirected: boolean }> {
  // No original bytes passed: handing them over returns a copy of the input, which
  // would silently discard every edit.
  return writeInto(target, writeBflan(document), outputPath)
}

/**
 * Puts encoded bytes back where they came from, through the mod layer.
 *
 * The redirect is the same one the app performs: with a project active, writing a
 * file that came out of the pristine dump produces a copy in the mod folder and
 * leaves the dump alone. Without it these tools would be a way to edit a dump by
 * accident, and the accident would look like a successful save.
 *
 * An explicit output path is *also* routed through it. Someone naming a
 * destination inside the dump is still someone about to damage the dump, and the
 * guard is not something to step around by being specific.
 */
async function writeInto(
  target: ResolvedTarget,
  encoded: Uint8Array,
  outputPath?: string
): Promise<{ path: string; bytes: number; redirected: boolean }> {
  const requested = resolve(outputPath ?? target.path)
  const { path: destination, redirected } = resolveWrite(requested)

  const refusal = refuseWrite(destination)
  if (refusal !== null) throw new Error(refusal)

  await mkdir(dirname(destination), { recursive: true })

  if (target.archive === null || target.entry === null) {
    await writeAtomic(destination, encoded)
    return { path: destination, bytes: encoded.length, redirected }
  }

  const rebuilt = writeSarc(replaceSarcEntry(target.archive, target.entry, encoded))
  /*
   * Back into whatever the container arrived as. Writing a `.zs` archive
   * uncompressed produces a file the game's loader will not read — and one that
   * still opens perfectly here, which is the worst way for it to be wrong.
   */
  const packed = await compress(rebuilt, target.compression)
  await writeAtomic(destination, packed)
  return { path: destination, bytes: packed.length, redirected }
}

/**
 * Writes through a temporary file in the same directory, then renames.
 *
 * The app's `FilesService` does the same, for the same reason: an interrupted
 * write must not leave a half-written archive where a whole one was. It matters
 * more here, because anything else reading the file mid-write sees a truncated
 * SARC and concludes it is not an archive — a failure that points nowhere near
 * its cause.
 */
async function writeAtomic(path: string, data: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${Date.now().toString(36)}.bflayout.tmp`)
  await writeFile(temporary, data)
  await rename(temporary, path)
}

export async function readAnimation(path: string, entry?: string): Promise<AnimationDocument> {
  const target = await resolveTarget(path, entry)
  if (!isBflan(target.bytes)) {
    throw new Error(`${target.entry ?? basename(target.path)} is not a BFLAN animation`)
  }
  return parseBflan(target.bytes).document
}

/** Every animation in an archive, by entry name. */
export async function listAnimations(
  path: string
): Promise<{ entry: string; name: string; frames: number; loop: boolean; tracks: number }[]> {
  const target = await resolveTarget(path)
  if (!target.archive) throw new Error(`${basename(target.path)} is not an archive`)

  const found: { entry: string; name: string; frames: number; loop: boolean; tracks: number }[] = []
  for (const item of target.archive.entries) {
    if (item.name === null || !isBflan(item.data)) continue
    try {
      const { document } = parseBflan(item.data)
      found.push({
        entry: item.name,
        name: document.tag?.name ?? item.name,
        frames: document.info?.frameSize ?? 0,
        loop: document.info?.loop ?? false,
        tracks: (document.info?.entries ?? []).reduce(
          (sum, animated) =>
            sum + animated.tags.reduce((count, tag) => count + tag.components.length, 0),
          0
        )
      })
    } catch {
      // An animation that will not parse is still worth listing by name.
      found.push({ entry: item.name, name: item.name, frames: 0, loop: false, tracks: -1 })
    }
  }
  return found
}

/**
 * Renders a layout as an animation would leave it at one frame.
 *
 * The single most useful thing an animation tool can do, and the reason the
 * renderer takes a value lookup at all: an animation is a list of numbers until
 * you can see what it does to the layout. `buildOverrides` resolves every curve at
 * the frame and the renderer applies them exactly as the editor's canvas does.
 */
export async function renderAtFrame(
  sourcePath: string,
  layout: LayoutDocument,
  animation: AnimationDocument | null,
  frame: number,
  options?: RenderOptions
): Promise<RenderResult> {
  const overrides = buildOverrides(animation, frame)
  return renderLayout(layout, {
    ...options,
    textures: await loadTextures(sourcePath, layout),
    parts: await loadParts(sourcePath, layout),
    lookup: (pane) => overrides.panes.get(pane.name)
  })
}

export interface PaneSummary {
  readonly name: string
  readonly kind: string
  readonly visible: boolean
  readonly translate: readonly number[]
  readonly size: readonly [number, number]
  readonly alpha: number
  readonly children: PaneSummary[]
  /** Present for a text pane, because it is usually the thing being looked for. */
  readonly text?: string
  /** Present for a part pane: the layout it instantiates. */
  readonly part?: string
  /**
   * User data naming other panes, when this pane has any.
   *
   * Wiring that is invisible in the pane's own fields: a pane with
   * `AdjustToTextOn` resizes itself every frame to fit the panes it names. Left
   * out of the tree, the commonest way to break a layout — duplicating such a
   * pane, so the copy keeps driving itself from the original's text — is
   * unreadable from the structural view that everyone looks at first.
   */
  readonly references?: Record<string, string[]>
}

export function summarizePane(pane: Pane): PaneSummary {
  const references: Record<string, string[]> = {}
  for (const entry of pane.userData?.entries ?? []) {
    const named = referencedPanes(entry)
    if (named.length > 0) references[entry.name] = named
  }

  return {
    name: pane.name,
    kind: pane.kind,
    visible: pane.visible,
    translate: pane.translate,
    size: [pane.width, pane.height],
    alpha: pane.alpha,
    ...(pane.kind === 'txt1' ? { text: pane.text } : {}),
    ...(pane.kind === 'prt1' ? { part: pane.externalLayoutName } : {}),
    ...(Object.keys(references).length > 0 ? { references } : {}),
    children: pane.children.map(summarizePane)
  }
}

export function findPane(document: LayoutDocument, name: string): Pane | null {
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

/** Properties an outside caller is allowed to set, and how they are validated. */
export interface PaneEdit {
  readonly translate?: readonly [number, number, number]
  readonly size?: readonly [number, number]
  readonly scale?: readonly [number, number]
  readonly rotate?: readonly [number, number, number]
  readonly visible?: boolean
  readonly alpha?: number
  readonly text?: string
}

/**
 * Applies an edit to a pane, in place.
 *
 * Restricted on purpose. The document model has hundreds of fields, most of which
 * are only meaningful in combination, and an interface that let anything be set to
 * anything would mostly be a way to produce files that parse and do not draw.
 * These are the properties an edit is actually about.
 */
export function editPane(pane: Pane, edit: PaneEdit): string[] {
  const changed: string[] = []

  if (edit.translate) {
    pane.translate = [...edit.translate]
    changed.push(`translate → ${edit.translate.join(', ')}`)
  }
  if (edit.size) {
    if (edit.size[0] < 0 || edit.size[1] < 0) throw new Error('size cannot be negative')
    pane.width = edit.size[0]
    pane.height = edit.size[1]
    changed.push(`size → ${edit.size[0]}×${edit.size[1]}`)
  }
  if (edit.scale) {
    pane.scale = [...edit.scale]
    changed.push(`scale → ${edit.scale.join(', ')}`)
  }
  if (edit.rotate) {
    pane.rotate = [...edit.rotate]
    changed.push(`rotate → ${edit.rotate.join(', ')}`)
  }
  if (edit.visible !== undefined) {
    pane.visible = edit.visible
    changed.push(edit.visible ? 'shown' : 'hidden')
  }
  if (edit.alpha !== undefined) {
    if (edit.alpha < 0 || edit.alpha > 255) throw new Error('alpha must be between 0 and 255')
    pane.alpha = edit.alpha
    changed.push(`alpha → ${edit.alpha}`)
  }
  if (edit.text !== undefined) {
    if (pane.kind !== 'txt1') {
      throw new Error(`${pane.name} is a ${pane.kind} pane, so it has no text to set`)
    }
    pane.text = edit.text
    changed.push('text changed')
  }

  if (changed.length === 0) throw new Error('nothing to change was given')
  return changed
}

export function render(document: LayoutDocument, options?: RenderOptions): RenderResult {
  return renderLayout(document, options)
}

/**
 * The layouts a document's part panes instantiate, with their own textures.
 *
 * Resolved the way the app resolves them: a part names a bare `Foo.bflyt` and it
 * is found in the archive's `blyt/` folder, case-insensitively and with the
 * extension optional, because layouts and archives disagree about both.
 */
export async function loadParts(
  sourcePath: string,
  document: LayoutDocument
): Promise<Map<string, { document: LayoutDocument; textures: Map<string, DecodedTexture> }>> {
  const out = new Map<
    string,
    { document: LayoutDocument; textures: Map<string, DecodedTexture> }
  >()

  const wanted = new Set<string>()
  const visit = (pane: Pane): void => {
    if (pane.kind === 'prt1' && pane.externalLayoutName !== '') {
      wanted.add(pane.externalLayoutName)
    }
    for (const child of pane.children) visit(child)
  }
  if (document.rootPane) visit(document.rootPane)
  if (wanted.size === 0) return out

  const key = (name: string): string =>
    (name.split(/[\\/]/).pop() ?? name).toLowerCase().replace(/\.bflyt$/, '')

  /**
   * The archives to look in: the layout's own, then its neighbours.
   *
   * A part almost never lives in the archive that uses it — this game keeps each
   * one in its own `Button_MainMenu_00.blarc.zs` beside the screen that
   * instantiates it. Stopping at the host archive finds nothing and draws the
   * whole menu as empty boxes.
   */
  const candidates: string[] = [sourcePath]
  const folder = dirname(resolve(sourcePath))
  const siblings = await readdir(folder).catch(() => [] as string[])
  for (const entry of siblings) {
    if (!/\.(szs|sarc|arc|zs|blarc|lyarc)$/i.test(entry)) continue
    const path = join(folder, entry)
    if (path === resolve(sourcePath)) continue
    // Only archives whose name looks like a part someone asked for: a romfs folder
    // holds hundreds, and opening all of them to find one is not worth it.
    if (![...wanted].some((name) => key(entry.split('.')[0] ?? entry) === key(name))) continue
    candidates.push(path)
  }

  for (const path of candidates) {
    if (out.size === wanted.size) break

    const archive = await resolveTarget(path).catch(() => null)
    if (!archive?.archive) continue

    for (const name of wanted) {
      if (out.has(name.toLowerCase())) continue
      const match = archive.archive.entries.find(
        (entry) => entry.name !== null && isBflyt(entry.data) && key(entry.name) === key(name)
      )
      if (!match) continue

      try {
        const parsed = parseBflyt(match.data).document
        out.set(name.toLowerCase(), {
          document: parsed,
          // Textures resolve against the archive the part came from, not the host.
          textures: await loadTextures(path, parsed)
        })
      } catch {
        // A part that will not parse simply is not drawn; the pane stays a box.
      }
    }
  }
  return out
}

/**
 * Decodes every texture a layout names, from the archive it lives in and its
 * neighbours.
 *
 * Separate from rendering because it is filesystem work: the renderer does
 * arithmetic and takes what it is given. A texture that cannot be found or cannot
 * be decoded is simply absent, and that pane falls back to a flat box — a partial
 * picture is far more useful than none.
 */
export async function loadTextures(
  sourcePath: string,
  document: LayoutDocument
): Promise<Map<string, DecodedTexture>> {
  const library = new TextureLibrary(resolve(sourcePath))
  const out = new Map<string, DecodedTexture>()

  for (const name of document.textures) {
    const decoded = await library.get(name)
    if (decoded) out.set(name.toLowerCase().replace(/\.bntx$/, ''), decoded)
  }
  return out
}

/** A layout rendered with its real textures where they can be found. */
export async function renderWithTextures(
  sourcePath: string,
  document: LayoutDocument,
  options?: RenderOptions
): Promise<RenderResult> {
  return renderLayout(document, {
    ...options,
    textures: await loadTextures(sourcePath, document),
    parts: await loadParts(sourcePath, document)
  })
}

export interface FileSummary {
  readonly path: string
  readonly format: string
  readonly size: number
  readonly detail: string
}

/** What a file is, by magic rather than by extension. */
export async function identify(path: string): Promise<FileSummary> {
  const full = resolve(path)
  const raw = new Uint8Array(await readFile(full))
  const size = raw.length

  let data: Uint8Array = raw
  let compression: string = 'none'
  try {
    const result = await decompress(raw)
    data = result.data
    compression = result.compression
  } catch (cause) {
    // A file whose compression will not expand can still be named and sized, and
    // saying why beats reporting it as an unrecognised format.
    return {
      path: full,
      format: 'unreadable',
      size,
      detail: cause instanceof Error ? cause.message : String(cause)
    }
  }

  const suffix = compression === 'none' ? '' : ` (${compression})`
  if (isSarc(data)) {
    const archive = parseSarc(data)
    return {
      path: full,
      format: 'SARC',
      size,
      detail: `${archive.entries.length} entries${suffix}`
    }
  }
  if (isBflyt(data)) {
    const { document } = parseBflyt(data)
    return {
      path: full,
      format: 'BFLYT',
      size,
      detail: `${document.info.width}×${document.info.height}${suffix}`
    }
  }
  if (isBflan(data)) {
    const { document } = parseBflan(data)
    return {
      path: full,
      format: 'BFLAN',
      size,
      detail: `${document.info?.frameSize ?? 0} frames${suffix}`
    }
  }
  if (isBntx(data)) {
    const container = parseBntx(data)
    return {
      path: full,
      format: 'BNTX',
      size,
      detail: `${container.textures.length} textures${suffix}`
    }
  }
  if (isMsbt(data)) {
    const document = parseMsbt(data)
    return {
      path: full,
      format: 'MSBT',
      size,
      detail: `${document.messages.length} messages${suffix}`
    }
  }
  return { path: full, format: 'unknown', size, detail: `not a format BFLayout reads${suffix}` }
}

export function listArchive(archive: SarcArchive): { name: string; size: number; format: string }[] {
  return archive.entries.map((entry) => ({
    name: entry.name ?? `#${entry.nameHash.toString(16)}`,
    size: entry.data.length,
    format: checkBytes(entry.name ?? 'entry', entry.data).format
  }))
}

export interface SearchHit {
  readonly path: string
  readonly entry: string | null
  readonly kind: string
  readonly name: string
  readonly detail: string | null
}

/**
 * Searches a directory tree for a name, reading every file.
 *
 * No index and no persistence: the app keeps one in sqlite because it searches
 * the same dump over and over, while a command runs once and a server can afford
 * to walk. It is slower and it is always current, which is the right trade for a
 * tool invoked from a script.
 */
export async function searchTree(
  root: string,
  query: string,
  options: { limit?: number; kinds?: readonly string[] } = {}
): Promise<SearchHit[]> {
  const needle = query.toLowerCase()
  const limit = options.limit ?? 200
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null
  const hits: SearchHit[] = []

  for await (const file of walk(resolve(root))) {
    if (hits.length >= limit) break

    let data: Uint8Array
    try {
      // A file that cannot be read or decompressed is skipped rather than
      // aborting the sweep: one bad file in a dump of sixty thousand must not
      // mean no results at all.
      data = (await decompress(new Uint8Array(await readFile(file)))).data
    } catch {
      continue
    }

    for (const extracted of extractFile(basename(file), data)) {
      for (const symbol of extracted.symbols) {
        if (hits.length >= limit) break
        if (kinds && !kinds.has(symbol.kind)) continue
        if (
          !symbol.name.toLowerCase().includes(needle) &&
          !(symbol.detail ?? '').toLowerCase().includes(needle)
        ) {
          continue
        }
        hits.push({
          path: file,
          entry: extracted.entryName ?? null,
          kind: symbol.kind,
          name: symbol.name,
          detail: symbol.detail ?? null
        })
      }
    }
  }

  return hits
}

async function* walk(root: string): AsyncGenerator<string> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

/**
 * Reads a file and hands its *decompressed* bytes to the checker.
 *
 * The compression in a `.szs` wraps the whole archive, so checking the raw bytes
 * would report every layout archive in the game as an unrecognised format — which
 * is exactly what it did before this existed.
 */
export async function checkFile(
  path: string
): Promise<{ path: string; format: string; notes: ReturnType<typeof checkBytes>['notes'] }> {
  const full = resolve(path)
  const raw = new Uint8Array(await readFile(full))

  let data: Uint8Array = raw
  try {
    data = (await decompress(raw)).data
  } catch (cause) {
    return {
      path: full,
      format: 'unreadable',
      notes: [
        {
          level: 'error',
          message: cause instanceof Error ? cause.message : String(cause)
        }
      ]
    }
  }

  const result = checkBytes(basename(full), data)
  return { path: full, format: result.format, notes: result.notes }
}

export const text = { layoutToText, layoutFromText }
export const compare = { diffLayouts, summarizeChanges }
export const validate = { checkBytes }
export const messages = { parseMsbt, writeMsbt, setMessageText, replaceInDocument, isMsbt }

/**
 * Creates a layout that did not exist.
 *
 * Either a loose `.bflyt` or a new entry inside an archive that already exists.
 * Creating the archive too is deliberately not offered: an archive is a container
 * the game looks for by name and path, and inventing one is a decision about the
 * game's own file tree rather than about a layout.
 */
export async function createLayoutFile(options: {
  path: string
  name: string
  entry?: string
  width?: number
  height?: number
}): Promise<{ path: string; entry: string | null; bytes: number; redirected: boolean }> {
  const document = createLayoutDocument({
    name: options.name,
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height })
  })
  const encoded = writeBflyt(document, new Map())

  if (options.entry === undefined) {
    const { path: destination, redirected } = resolveWrite(resolve(options.path))
    const refusal = refuseWrite(destination)
    if (refusal !== null) throw new Error(refusal)

    await mkdir(dirname(destination), { recursive: true })
    await writeAtomic(destination, encoded)
    return { path: destination, entry: null, bytes: encoded.length, redirected }
  }

  const target = await resolveTarget(options.path)
  if (!target.archive) {
    throw new Error(
      `${basename(target.path)} is not an archive, so it has no entries to add to. Leave entry out to write a loose .bflyt instead.`
    )
  }
  if (findSarcEntry(target.archive, options.entry)) {
    throw new Error(
      `${basename(target.path)} already has an entry called ${options.entry}. Pick another name, or edit that one.`
    )
  }

  const grown: SarcArchive = {
    ...target.archive,
    entries: [
      ...target.archive.entries,
      {
        nameHash: sarcHash(options.entry, target.archive.hashKey),
        name: options.entry,
        data: encoded,
        originalOffset: 0,
        originalLength: -1,
        alignment: sarcAlignmentFor(options.entry)
      }
    ]
  }

  const written = await writeInto(
    { ...target, archive: grown, entry: options.entry },
    encoded
  )
  return { ...written, entry: options.entry }
}

/**
 * Copies a whole layout to a new name.
 *
 * The quickest honest way to start from an existing screen. The internal layout
 * name is renamed alongside the entry when asked, because the two disagreeing is
 * a small confusion that outlives the copy.
 */
export async function duplicateLayoutFile(options: {
  path: string
  entry?: string
  toEntry?: string
  toPath?: string
  name?: string
}): Promise<{ path: string; entry: string | null; bytes: number; redirected: boolean }> {
  const target = await resolveTarget(options.path, options.entry)
  if (!isBflyt(target.bytes)) {
    throw new Error(`${options.entry ?? basename(target.path)} is not a BFLYT layout`)
  }

  const { document } = parseBflyt(target.bytes)
  if (options.name) document.info.name = options.name

  if (options.toEntry && !options.toPath) {
    // Same archive: the textures and fonts are already beside it.
    return createFromDocument(target, document, options.toEntry)
  }
  if (!options.toPath) {
    throw new Error('give to_entry to copy it inside the archive, or to_path to write a new file')
  }

  /*
   * Into a different archive, with the assets.
   *
   * A layout on its own is a set of names — its textures live in the archive it
   * came from. Copying it to another archive without them produces a layout that
   * parses, loads and draws nothing, so this reuses the same carrying the
   * cross-archive pane copy does.
   */
  if (options.toEntry) {
    const created = await createLayoutFile({
      path: options.toPath,
      name: document.info.name,
      entry: options.toEntry,
      width: document.info.width,
      height: document.info.height
    })

    const copied = await copyPanesBetween({
      fromPath: options.path,
      ...(options.entry === undefined ? {} : { fromEntry: options.entry }),
      toPath: options.toPath,
      toEntry: options.toEntry,
      panes: document.rootPane ? document.rootPane.children.map((child) => child.name) : []
    })

    return {
      path: copied.path,
      entry: options.toEntry,
      bytes: copied.bytes,
      redirected: copied.redirected || created.redirected
    }
  }

  const encoded = writeBflyt(document, new Map())
  const { path: destination, redirected } = resolveWrite(resolve(options.toPath))
  const refusal = refuseWrite(destination)
  if (refusal !== null) throw new Error(refusal)

  await mkdir(dirname(destination), { recursive: true })
  await writeAtomic(destination, encoded)
  return { path: destination, entry: null, bytes: encoded.length, redirected }
}

async function createFromDocument(
  target: ResolvedTarget,
  document: LayoutDocument,
  entry: string
): Promise<{ path: string; entry: string; bytes: number; redirected: boolean }> {
  if (!target.archive) {
    throw new Error('to_entry only makes sense for a layout inside an archive')
  }
  if (findSarcEntry(target.archive, entry)) {
    throw new Error(`that archive already has an entry called ${entry}`)
  }

  const encoded = writeBflyt(document, new Map())
  const grown: SarcArchive = {
    ...target.archive,
    entries: [
      ...target.archive.entries,
      {
        nameHash: sarcHash(entry, target.archive.hashKey),
        name: entry,
        data: encoded,
        originalOffset: 0,
        originalLength: -1,
        alignment: sarcAlignmentFor(entry)
      }
    ]
  }

  const written = await writeInto({ ...target, archive: grown, entry }, encoded)
  return { ...written, entry }
}

/**
 * Copies panes between layouts, carrying the textures they need with them.
 *
 * `copyPanes` handles the document: the subtree, its materials, and the texture
 * and font *names*, with every index remapped. That is enough when both layouts
 * live in the same archive, because the texture data is already there.
 *
 * Across archives it is not. The destination ends up naming textures its archive
 * does not contain, and nothing fails — the layout parses, the panes draw, and
 * they draw untextured. So the container holding those textures is copied too.
 *
 * The container, singular. A layout archive can have exactly ONE, because
 * nn::ui2d resolves textures through the hardcoded path `timg/__Combined.bntx`
 * and looks it up by exact path — it never enumerates an archive's entries. A
 * second container is dead weight the engine cannot see, and any pane depending
 * on it faults inside nn::ui2d::ResourceTextureInfo when the layout is built.
 *
 * So this carries a container only into a destination that has none, and refuses
 * otherwise. Merging two containers needs a BNTX *writer* and there isn't one —
 * see the texture-import notes. Until there is, copying textured panes into an
 * already-textured archive is not something this can do, and saying so beats
 * emitting a file that previews perfectly and will not boot.
 */
export async function copyPanesBetween(options: {
  fromPath: string
  fromEntry?: string
  toPath: string
  toEntry?: string
  panes: readonly string[]
  into?: string
  suffix?: string
  outputPath?: string
  carryTextures?: boolean
}): Promise<{
  report: CopyReport
  carried: string[]
  path: string
  bytes: number
  redirected: boolean
}> {
  const source = await resolveTarget(options.fromPath, options.fromEntry)
  if (!isBflyt(source.bytes)) throw new Error('the source is not a BFLYT layout')

  const destination = await resolveTarget(options.toPath, options.toEntry)
  if (!isBflyt(destination.bytes)) throw new Error('the destination is not a BFLYT layout')

  const sourceDocument = parseBflyt(source.bytes).document
  const destinationDocument = parseBflyt(destination.bytes).document

  const before = new Set(destinationDocument.textures.map((name) => name.toLowerCase()))
  const report = copyPanes(sourceDocument, destinationDocument, options.panes, {
    ...(options.into === undefined ? {} : { into: options.into }),
    ...(options.suffix === undefined ? {} : { suffix: options.suffix })
  })

  const carried: string[] = []
  let archive = destination.archive

  if (options.carryTextures !== false && archive && source.archive) {
    // Only the names this copy introduced; anything the destination already
    // referenced was already its own problem.
    const added = destinationDocument.textures.filter(
      (name) => !before.has(name.toLowerCase())
    )

    const present = new Set<string>()
    for (const entry of archive.entries) {
      if (entry.name === null || !isBntx(entry.data)) continue
      try {
        for (const texture of parseBntx(entry.data).textures) {
          present.add(textureKey(texture.name))
        }
      } catch {
        // An unreadable container tells us nothing about what it holds.
      }
    }

    const missing = added.filter((name) => !present.has(textureKey(name)))
    const wanted = new Set(missing.map(textureKey))

    for (const entry of source.archive.entries) {
      if (wanted.size === 0) break
      if (entry.name === null || !isBntx(entry.data)) continue

      let holds = false
      try {
        holds = parseBntx(entry.data).textures.some((texture) => wanted.has(textureKey(texture.name)))
      } catch {
        continue
      }
      if (!holds) continue

      /*
       * The destination can only ever have ONE texture container, so a second one
       * is merged into it rather than added beside it.
       *
       * Adding a sibling was the original bug, and an expensive one: nn::ui2d
       * resolves textures through the single hardcoded path
       * `timg/__Combined.bntx`, by exact path, and never enumerates an archive's
       * entries — so the second container was never opened, its textures stayed
       * unresolved, and the game died dereferencing null inside
       * nn::ui2d::ResourceTextureInfo while building the layout. It preview-tested
       * clean the whole time, because the previewer searched every container.
       */
      const name = entry.name
      const existing = archive.entries.find(
        (candidate) => candidate.name !== null && isBntx(candidate.data)
      )

      if (existing) {
        const merged = mergeBntx(parseBntx(existing.data), parseBntx(entry.data))
        if (merged.added.length === 0) {
          try {
            for (const texture of parseBntx(entry.data).textures) {
              wanted.delete(textureKey(texture.name))
            }
          } catch {
            /* unreadable containers were skipped above */
          }
          continue
        }

        archive = replaceSarcEntry(archive, existing.name!, writeBntx(merged.container))
        carried.push(`${merged.added.length} texture(s) merged into ${existing.name}`)
        for (const texture of merged.added) wanted.delete(textureKey(texture))
        continue
      }

      // Nothing to merge into: the container comes across whole.
      archive = {
        ...archive,
        entries: [
          ...archive.entries,
          {
            nameHash: sarcHash(name, archive.hashKey),
            name,
            data: entry.data,
            originalOffset: 0,
            originalLength: -1,
            // The greater of what it had and what its kind requires: a container
            // copied out of an archive that packed it loosely must not carry that
            // mistake into a new one.
            alignment: Math.max(entry.alignment, sarcAlignmentFor(name))
          }
        ]
      }
      carried.push(name)

      try {
        for (const texture of parseBntx(entry.data).textures) wanted.delete(textureKey(texture.name))
      } catch {
        /* already counted as carried */
      }
    }
  }

  const encoded = writeBflyt(destinationDocument, new Map())
  const written = await writeInto(
    { ...destination, archive },
    encoded,
    options.outputPath
  )
  return { report, carried, ...written }
}

/** Case-insensitive, extension-optional: layouts and containers agree on neither. */
function textureKey(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).toLowerCase().replace(/\.bntx$/, '')
}

/** The compression a path's extension implies, so a `.zs` is written as one. */
function compressionForPath(path: string): Compression {
  const lower = path.toLowerCase()
  if (lower.endsWith('.zs') || lower.endsWith('.zst')) return 'zstd'
  if (lower.endsWith('.szs')) return 'yaz0'
  return 'none'
}

/**
 * Creates an empty archive.
 *
 * The gap that blocked everything else: every other entry point resolved its
 * destination archive first, so there was no way to go from nothing to a new
 * `.blarc.zs` — and in this game each custom screen needs its own, because a
 * screen's layout is looked up as `Layout/<name>.Nin_NX_NVN.blarc`.
 *
 * Compression comes from the extension rather than an argument. A `.zs` that is
 * not ZSTD is a file the game will not read, and asking twice for something the
 * name already says is how the two end up disagreeing.
 */
export async function createArchive(options: {
  path: string
  littleEndian?: boolean
}): Promise<{ path: string; compression: Compression; redirected: boolean }> {
  const requested = resolve(options.path)
  const { path: destination, redirected } = resolveWrite(requested)

  const refusal = refuseWrite(destination)
  if (refusal !== null) throw new Error(refusal)

  // Refused rather than emptied: an archive already there is someone's work, and
  // "create" is not a word anyone expects to mean "replace".
  if (await stat(destination).then(() => true, () => false)) {
    throw new Error(
      `${basename(destination)} already exists. Delete it first, or add entries to it with add_entry.`
    )
  }

  const archive: SarcArchive = {
    littleEndian: options.littleEndian ?? true,
    version: 0x0100,
    hashKey: 0x65,
    hasNames: true,
    originalDataOffset: 0,
    entries: []
  }

  const compression = compressionForPath(destination)
  const packed = await compress(writeSarc(archive), compression)
  await mkdir(dirname(destination), { recursive: true })
  await writeAtomic(destination, packed)

  return { path: destination, compression, redirected }
}

/**
 * Copies a whole archive, optionally renaming every entry that carries a stem.
 *
 * This is how a screen is cloned. The game resolves a screen's animations *by
 * layout name* — it asks for `anim/<layout>_In.bflan`, `_Out`, `_Loop` — so
 * serving `Common_Text_00`'s archive as `Common_CantTouch_00` means renaming the
 * layout **and every sibling animation**. Doing that entry by entry is a dozen
 * calls to get exactly right, and getting one wrong produces a screen that loads
 * and then has no animations, which looks like anything but a naming problem.
 *
 * A renamed BFLYT also has its *internal* name updated, because an entry and the
 * layout inside it disagreeing is a confusion that outlives the copy.
 */
export async function cloneArchive(options: {
  fromPath: string
  toPath: string
  renameFrom?: string
  renameTo?: string
}): Promise<{
  path: string
  entries: number
  renamed: { from: string; to: string }[]
  redirected: boolean
}> {
  const source = await resolveTarget(options.fromPath)
  if (!source.archive) throw new Error(`${basename(options.fromPath)} is not an archive`)

  const unnamed = source.archive.entries.filter((entry) => entry.name === null).length
  if (unnamed > 0) {
    throw new Error(
      `${basename(options.fromPath)} has ${unnamed} entries with no stored name, so it cannot be written back at all. Recover its names first.`
    )
  }

  const renamed: { from: string; to: string }[] = []
  const from = options.renameFrom
  const to = options.renameTo

  const entries = source.archive.entries.map((entry) => {
    const name = entry.name!
    if (from === undefined || to === undefined || from === '' || !name.includes(from)) {
      return { ...entry, originalLength: -1 }
    }

    const next = name.split(from).join(to)
    renamed.push({ from: name, to: next })

    /*
     * The layout's own name follows its entry. `info.name` is what the editor and
     * the tooling show, and a copy called `Common_CantTouch_00.bflyt` that still
     * calls itself `Common_Text_00` inside is a trap for whoever opens it next.
     */
    let data = entry.data
    if (isBflyt(entry.data)) {
      try {
        const document = parseBflyt(entry.data).document
        document.info.name = document.info.name.split(from).join(to)
        data = writeBflyt(document, new Map())
      } catch {
        // Unreadable here means unreadable everywhere; copy it verbatim and let
        // `check` report it against the new archive.
      }
    }

    return {
      ...entry,
      name: next,
      nameHash: sarcHash(next, source.archive!.hashKey),
      data,
      originalLength: -1,
      alignment: Math.max(entry.alignment, sarcAlignmentFor(next))
    }
  })

  const requested = resolve(options.toPath)
  const { path: destination, redirected } = resolveWrite(requested)
  const refusal = refuseWrite(destination)
  if (refusal !== null) throw new Error(refusal)

  const packed = await compress(
    writeSarc({ ...source.archive, originalDataOffset: 0, entries }),
    compressionForPath(destination)
  )
  await mkdir(dirname(destination), { recursive: true })
  await writeAtomic(destination, packed)

  return { path: destination, entries: entries.length, renamed, redirected }
}

/**
 * Creates a BFLAN that did not exist.
 *
 * A custom screen needs animations the donor does not have — an `_In` when the
 * donor only ships `_Loop` — and `add_animation_track` cannot help, because it
 * starts by resolving a file. This produces the empty animation for it to write
 * into.
 */
export async function createAnimationFile(options: {
  path: string
  name: string
  entry?: string
  frameSize?: number
  loop?: boolean
}): Promise<{ path: string; entry: string | null; bytes: number; redirected: boolean }> {
  const document = createAnimation(options.name, options.frameSize ?? 60)
  if (options.loop !== undefined && document.info) document.info.loop = options.loop
  const encoded = writeBflan(document)

  if (options.entry === undefined) {
    const { path: destination, redirected } = resolveWrite(resolve(options.path))
    const refusal = refuseWrite(destination)
    if (refusal !== null) throw new Error(refusal)

    await mkdir(dirname(destination), { recursive: true })
    await writeAtomic(destination, encoded)
    return { path: destination, entry: null, bytes: encoded.length, redirected }
  }

  const target = await resolveTarget(options.path)
  if (!target.archive) {
    throw new Error(
      `${basename(target.path)} is not an archive. Leave entry out to write a loose .bflan, or create the archive first with create_archive.`
    )
  }
  if (findSarcEntry(target.archive, options.entry)) {
    throw new Error(`${basename(target.path)} already has an entry called ${options.entry}`)
  }

  const grown: SarcArchive = {
    ...target.archive,
    entries: [
      ...target.archive.entries,
      {
        nameHash: sarcHash(options.entry, target.archive.hashKey),
        name: options.entry,
        data: encoded,
        originalOffset: 0,
        originalLength: -1,
        alignment: sarcAlignmentFor(options.entry)
      }
    ]
  }

  const written = await writeInto({ ...target, archive: grown, entry: options.entry }, encoded)
  return { ...written, entry: options.entry }
}

export interface AnimationCopyReport {
  /** Where it landed in the destination archive. */
  readonly entry: string
  readonly tracks: number
  /** Targets rewritten by the rename map, as `old → new`. */
  readonly renamed: string[]
  /** Targets naming a pane the destination layout does not have. */
  readonly missingPanes: string[]
  /** Targets naming a material the destination layout does not have. */
  readonly missingMaterials: string[]
  /** Groups the pat1 binds to that the destination layout does not have. */
  readonly missingGroups: string[]
  /** Groups created in the destination layout, with the panes put in them. */
  readonly createdGroups: string[]
  /** Texture containers merged in for the pattern table. */
  readonly carried: string[]
  /** Pattern textures still not present in the destination archive. */
  readonly missingTextures: string[]
  readonly warnings: string[]
}

/**
 * Copies an animation into another archive, and says what it will not find there.
 *
 * The counterpart to `copyPanesBetween`, and deliberately not a copy of it: a
 * BFLAN binds to panes and materials **by name**, not by index, so there is no
 * index to remap and no silent wrong-target failure of the kind that made
 * `copy_panes` remap. What replaces it is worse-behaved and needs saying out loud
 * — a track naming a pane the destination lacks is not an error anywhere. The file
 * parses, the archive builds, the game loads it, and that track simply never
 * animates anything. Nothing in the pipeline notices, which is why every unmatched
 * target comes back in the report rather than being left to be discovered in game.
 *
 * The one thing that *is* index-like travels with the file: FLTP keyframe values
 * index the animation's own texture table, which is inside the BFLAN. What that
 * table names still has to exist in the destination archive's container, so those
 * are merged across the same way panes' textures are.
 */
export async function copyAnimationBetween(options: {
  fromPath: string
  fromEntry?: string
  toPath: string
  toEntry?: string
  /** The layout in the destination this drives; inferred when it is unambiguous. */
  layoutEntry?: string
  /** Old target name to new, applied to entries and to pat1 groups. */
  rename?: Readonly<Record<string, string>>
  /**
   * Create any group the pat1 binds to that the destination lacks, holding the
   * panes this animation actually drives.
   *
   * Off by default because it rewrites the destination *layout*, not just the
   * animation entry — but without it, or a group that already exists, the copy is
   * a guaranteed no-op.
   */
  createGroups?: boolean
  carryTextures?: boolean
  outputPath?: string
}): Promise<AnimationCopyReport & { path: string; bytes: number; redirected: boolean }> {
  const source = await resolveTarget(options.fromPath, options.fromEntry)
  if (!isBflan(source.bytes)) throw new Error('the source is not a BFLAN animation')

  const destination = await resolveTarget(options.toPath)
  if (!destination.archive) {
    throw new Error(
      `${basename(destination.path)} is not an archive, so there is nothing to copy an animation into. Create one with create_archive.`
    )
  }

  const document = parseBflan(source.bytes).document
  const entryName =
    options.toEntry ?? source.entry ?? `anim/${basename(source.path).replace(/\.bflan$/i, '')}.bflan`

  // ------------------------------------------------------------- retargeting

  const renamed: string[] = []
  const rename = (name: string): string => {
    const to = options.rename?.[name]
    if (to === undefined || to === name) return name
    renamed.push(`${name} → ${to}`)
    return to
  }

  for (const entry of document.info?.entries ?? []) entry.name = rename(entry.name)
  if (document.tag) document.tag.groups = document.tag.groups.map(rename)

  // ------------------------------------------------ what the destination has

  const layoutEntry =
    options.layoutEntry ??
    destination.archive.entries.find(
      (entry) => entry.name !== null && isBflyt(entry.data)
    )?.name ??
    undefined

  const warnings: string[] = []
  const missingPanes: string[] = []
  const missingMaterials: string[] = []
  const missingGroups: string[] = []
  const createdGroups: string[] = []
  let archive: SarcArchive = destination.archive

  if (layoutEntry === undefined) {
    warnings.push(
      'the destination archive holds no layout, so nothing here could be checked against one — every target in this animation is unverified'
    )
  } else {
    const found = findSarcEntry(destination.archive, layoutEntry)
    if (!found || !isBflyt(found.data)) {
      throw new Error(
        `${layoutEntry} is not a layout in ${basename(destination.path)}. Name the one this animation drives with layout_entry.`
      )
    }
    const layout = parseBflyt(found.data).document

    const panes = new Set<string>()
    walkPanes(layout.rootPane, (pane) => void panes.add(pane.name))
    const materials = new Set(layout.materials.map((material) => material.name))

    const groups = new Set<string>()
    const collect = (group: GroupPane): void => {
      groups.add(group.name)
      for (const child of group.children) collect(child)
    }
    if (layout.rootGroup) collect(layout.rootGroup)

    for (const entry of document.info?.entries ?? []) {
      if (entry.target === 'material') {
        if (!materials.has(entry.name)) missingMaterials.push(entry.name)
      } else if (!panes.has(entry.name)) missingPanes.push(entry.name)
    }
    for (const group of document.tag?.groups ?? []) {
      if (group !== '' && !groups.has(group)) missingGroups.push(group)
    }

    /*
     * Creating the binding rather than only reporting it.
     *
     * The group gets the panes this animation drives *and this layout has* —
     * which is what a group is for. Targets that did not resolve are left out on
     * purpose: putting a name in a group does not conjure the pane, and a group
     * listing a pane that is not there is the same silent nothing one level down.
     */
    if (options.createGroups === true && missingGroups.length > 0) {
      const drives = [...new Set(
        (document.info?.entries ?? [])
          .filter((entry) => entry.target !== 'material' && panes.has(entry.name))
          .map((entry) => entry.name)
      )]

      if (drives.length === 0) {
        warnings.push(
          `create_groups was asked for, but not one pane this animation drives exists in ${layoutEntry} — a group built from nothing binds to nothing, so none was created`
        )
      } else {
        for (const group of missingGroups) {
          addGroup(layout, group, drives)
          createdGroups.push(`${group} (${drives.join(', ')})`)
        }
        missingGroups.length = 0
        archive = replaceSarcEntry(archive, layoutEntry, writeBflyt(layout, new Map()))
      }
    }

    /*
     * The game finds a layout's animations by the layout's own name, so an entry
     * called anything else is loaded by nobody. This is the same trap that makes
     * clone_archive rename every sibling animation together.
     */
    const stem = basename(layoutEntry).replace(/\.bflyt$/i, '')
    const animStem = basename(entryName).replace(/\.bflan$/i, '')
    if (!animStem.startsWith(stem)) {
      warnings.push(
        `this is going in as ${entryName}, but ${layoutEntry} is ${stem} — the game resolves a layout's animations by the layout's name, so an animation not called ${stem}_* is never loaded`
      )
    }
  }

  // ------------------------------------------------------ pattern textures

  const carried: string[] = []
  const missingTextures: string[] = []

  const wantedTextures = document.info?.textures ?? []
  if (wantedTextures.length > 0) {
    const present = new Set<string>()
    for (const entry of archive.entries) {
      if (entry.name === null || !isBntx(entry.data)) continue
      try {
        for (const texture of parseBntx(entry.data).textures) present.add(textureKey(texture.name))
      } catch {
        // An unreadable container vouches for nothing.
      }
    }

    const absent = wantedTextures.filter((name) => !present.has(textureKey(name)))
    if (absent.length > 0 && options.carryTextures !== false && source.archive) {
      const wanted = new Set(absent.map(textureKey))
      const existing = archive.entries.find(
        (entry) => entry.name !== null && isBntx(entry.data)
      )

      for (const entry of source.archive.entries) {
        if (wanted.size === 0) break
        if (entry.name === null || !isBntx(entry.data)) continue

        let container
        try {
          container = parseBntx(entry.data)
        } catch {
          continue
        }
        if (!container.textures.some((texture) => wanted.has(textureKey(texture.name)))) continue

        if (existing) {
          const merged = mergeBntx(parseBntx(existing.data), container)
          if (merged.added.length > 0) {
            archive = replaceSarcEntry(archive, existing.name!, writeBntx(merged.container))
            carried.push(`${merged.added.length} texture(s) merged into ${existing.name}`)
          }
        } else {
          archive = {
            ...archive,
            entries: [
              ...archive.entries,
              {
                nameHash: sarcHash(entry.name, archive.hashKey),
                name: entry.name,
                data: entry.data,
                originalOffset: 0,
                originalLength: -1,
                alignment: Math.max(entry.alignment, sarcAlignmentFor(entry.name))
              }
            ]
          }
          carried.push(entry.name)
        }
        for (const texture of container.textures) wanted.delete(textureKey(texture.name))
      }
      missingTextures.push(...absent.filter((name) => wanted.has(textureKey(name))))
    } else {
      missingTextures.push(...absent)
    }
  }

  if (missingPanes.length > 0 || missingMaterials.length > 0) {
    warnings.push(
      'a target the destination layout does not have is not an error anywhere — the animation loads and that track drives nothing. Rename the targets, or add the panes first.'
    )
  }
  if (missingGroups.length > 0) {
    warnings.push(
      `the pat1 binds to ${missingGroups.join(', ')}, which this layout has no group for — binding is what decides *which* panes an animation applies to, so this animation applies to none of them and does nothing at all. Pass create_groups: true to build it from the panes this animation drives, rename it onto a group the layout already has, or make it yourself with add_group.`
    )
  }
  if (missingTextures.length > 0) {
    warnings.push(
      `the pattern table names ${missingTextures.length} texture(s) this archive does not hold, so those frames sample nothing`
    )
  }

  // ------------------------------------------------------------------ write

  const encoded = writeBflan(document)
  const existingEntry = findSarcEntry(archive, entryName)
  archive = existingEntry
    ? replaceSarcEntry(archive, entryName, encoded)
    : {
        ...archive,
        entries: [
          ...archive.entries,
          {
            nameHash: sarcHash(entryName, archive.hashKey),
            name: entryName,
            data: encoded,
            originalOffset: 0,
            originalLength: -1,
            alignment: sarcAlignmentFor(entryName)
          }
        ]
      }

  const written = await writeInto(
    { ...destination, archive, entry: entryName },
    encoded,
    options.outputPath
  )

  const tracks = (document.info?.entries ?? []).reduce(
    (sum, entry) => sum + entry.tags.reduce((count, tag) => count + tag.components.length, 0),
    0
  )

  return {
    entry: entryName,
    tracks,
    renamed,
    missingPanes,
    missingMaterials,
    missingGroups,
    createdGroups,
    carried,
    missingTextures,
    warnings,
    ...written
  }
}

/** Renames, deletes or adds one entry, rebuilding the archive around it. */
export async function editArchiveEntries(options: {
  path: string
  rename?: { from: string; to: string }
  remove?: string
  add?: { name: string; fromFile: string }
}): Promise<{ path: string; entries: string[]; redirected: boolean }> {
  const target = await resolveTarget(options.path)
  if (!target.archive) throw new Error(`${basename(options.path)} is not an archive`)

  let entries = target.archive.entries
  const hashKey = target.archive.hashKey

  if (options.rename) {
    const found = entries.find((entry) => entry.name === options.rename!.from)
    if (!found) {
      throw new Error(
        `no entry called ${options.rename.from}. It holds: ${entries.map((entry) => entry.name).filter(Boolean).slice(0, 20).join(', ')}`
      )
    }
    if (entries.some((entry) => entry.name === options.rename!.to)) {
      throw new Error(`this archive already has an entry called ${options.rename.to}`)
    }

    entries = entries.map((entry) =>
      entry === found
        ? {
            ...entry,
            name: options.rename!.to,
            // A rehash, not a relabel: SARC finds files by the hash of their name.
            nameHash: sarcHash(options.rename!.to, hashKey),
            originalLength: -1,
            alignment: Math.max(entry.alignment, sarcAlignmentFor(options.rename!.to))
          }
        : entry
    )
  }

  if (options.remove) {
    const before = entries.length
    entries = entries.filter((entry) => entry.name !== options.remove)
    if (entries.length === before) throw new Error(`no entry called ${options.remove}`)
  }

  if (options.add) {
    if (entries.some((entry) => entry.name === options.add!.name)) {
      throw new Error(`this archive already has an entry called ${options.add.name}`)
    }
    const data = new Uint8Array(await readFile(resolve(options.add.fromFile)))
    entries = [
      ...entries,
      {
        nameHash: sarcHash(options.add.name, hashKey),
        name: options.add.name,
        data,
        originalOffset: 0,
        originalLength: -1,
        alignment: sarcAlignmentFor(options.add.name)
      }
    ]
  }

  const requested = resolve(options.path)
  const { path: destination, redirected } = resolveWrite(requested)
  const refusal = refuseWrite(destination)
  if (refusal !== null) throw new Error(refusal)

  const packed = await compress(
    writeSarc({ ...target.archive, originalDataOffset: 0, entries }),
    target.compression
  )
  await mkdir(dirname(destination), { recursive: true })
  await writeAtomic(destination, packed)

  return {
    path: destination,
    entries: entries.map((entry) => entry.name ?? '(unnamed)').sort(),
    redirected
  }
}
