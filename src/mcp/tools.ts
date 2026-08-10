import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { isBflan, parseBflan } from '@shared/formats/bflan'
import type { AnimationDocument, CurveKind, Keyframe } from '@shared/formats/bflan/types'
import { isBflyt, parseBflyt } from '@shared/formats/bflyt'
import type { LayoutDocument } from '@shared/formats/bflyt/types'
import {
  checkFile,
  compare,
  editPane,
  findPane,
  identify,
  listAnimations,
  cloneArchive,
  copyAnimationBetween,
  copyPanesBetween,
  createAnimationFile,
  createArchive,
  createLayoutFile,
  editArchiveEntries,
  duplicateLayoutFile,
  listArchive,
  readAnimation,
  readLayout,
  renderAtFrame,
  renderWithTextures,
  resolveTarget,
  searchTree,
  summarizePane,
  text,
  writeAnimation,
  writeLayout,
  type PaneEdit
} from '@headless/engine'
import {
  addGroup,
  addMaterialTo,
  addPane,
  addTexture,
  addTrack,
  animationTracks,
  deleteGroup,
  deletePane,
  duplicatePane,
  editAnimation,
  editMaterial,
  editGroup,
  editUserData,
  groupList,
  paneNames,
  paneUserData,
  putKeyframe,
  removeKeyframe,
  removeTrack,
  renamePane,
  reorderPane,
  reparentPane,
  setKeyframes,
  PANE_KINDS,
  type UserDataEdit
} from '@headless/edit'

/**
 * The tools themselves, independent of how they are spoken.
 *
 * There are two transports — a stdio server Claude Code launches, and an HTTP one
 * the running app hosts — and they must expose the *same* tools or the two will
 * drift into subtly different capabilities. So the definitions live here and take
 * a context: what the caller can see about the world beyond the file it was
 * handed.
 *
 * That context is the difference between the two. The stdio server reads the mod
 * project out of the app's database and knows nothing else; the app's own server
 * also knows which files are open, which is what lets a tool call leave out the
 * path and mean "the thing on screen".
 */

/** What a transport can tell the tools about the world around them. */
export interface ToolContext {
  /** Human-readable state, returned by `current_context`. */
  readonly describe: () => Promise<Record<string, unknown>>
  /**
   * The file a tool means when it is not told one.
   *
   * Returns nothing when there is no such thing, in which case the tools ask for
   * a path as they always did.
   */
  readonly defaults: () => Promise<{ path?: string; entry?: string }>
  /** Called after a write, so a host with the file open can react. */
  readonly edited?: (path: string) => void
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly run: (input: Record<string, unknown>) => Promise<ToolResult>
}

export interface ToolResult {
  readonly content: (
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  )[]
  readonly isError?: boolean
}

const str = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

const num = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key]
  return typeof value === 'number' ? value : undefined
}

const required = (input: Record<string, unknown>, key: string): string => {
  const value = str(input, key)
  if (value === undefined || value === '') throw new Error(`${key} is required`)
  return value
}

const asText = (value: unknown): ToolResult => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
  ]
})

export function createTools(context: ToolContext): ToolDefinition[] {
  const bool = (input: Record<string, unknown>, key: string): boolean | undefined =>
  typeof input[key] === 'boolean' ? (input[key] as boolean) : undefined

const numberList = (input: Record<string, unknown>, key: string): number[] | undefined => {
  const value = input[key]
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    if (typeof item !== 'number') throw new Error(`${key} must be an array of numbers`)
    return item
  })
}

/**
 * The keyframes a tool call carries, checked before anything is written.
 *
 * A malformed keyframe does not fail loudly later — it produces an animation that
 * parses, loads, and moves something to the wrong place at the wrong time.
 */
const keyframeList = (input: Record<string, unknown>, key: string): Keyframe[] => {
  const value = input[key]
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of keyframes`)
  return value.map((item, at) => {
    const record = item as Record<string, unknown>
    const frame = record['frame']
    const amount = record['value']
    if (typeof frame !== 'number' || typeof amount !== 'number') {
      throw new Error(`${key}[${at}] needs a numeric frame and value`)
    }
    return {
      frame,
      value: amount,
      // The Hermite tangent. Zero is flat, which is right for step and constant
      // curves and a reasonable default for an ease that was not specified.
      slope: typeof record['slope'] === 'number' ? record['slope'] : 0
    }
  })
}

/** The four fields that name one animated channel. */
const selectorOf = (input: Record<string, unknown>): {
  entry: string
  tag: string
  target: number
  index?: number
} => {
  const target = num(input, 'target')
  if (target === undefined) throw new Error('target is required (the target byte of the channel)')
  return {
    /*
     * `animates`, not `entry`. Every tool here already uses `entry` for the file
     * inside the archive, and an animation lives inside one — so reusing it for
     * the animated pane made it impossible to address an animation in an archive
     * at all, which is where every animation in a game dump lives.
     */
    entry: required(input, 'animates'),
    tag: required(input, 'tag'),
    target,
    ...(num(input, 'index') === undefined ? {} : { index: num(input, 'index')! })
  }
}

/**
 * The file a call refers to, falling back to whatever the host has open.
 *
 * This is what makes the app-hosted server worth having: an assistant working
 * alongside someone does not have to be told, or guess, which of 544 layouts is
 * being looked at — it is the one on screen.
 */
async function fileOf(
  input: Record<string, unknown>
): Promise<{ path: string; entry: string | undefined }> {
  const given = str(input, 'path')
  if (given) return { path: given, entry: str(input, 'entry') }

  const fallback = await context.defaults()
  if (!fallback.path) {
    throw new Error(
      'path is required — nothing is open in BFLayout for this to default to. Call current_context to see what is available.'
    )
  }
  // The entry only defaults alongside the path: naming a path and inheriting an
  // entry from an unrelated open file would address something nobody asked for.
  return { path: fallback.path, entry: str(input, 'entry') ?? fallback.entry }
}

/**
 * Opens a layout, hands it to an edit, and writes it back.
 *
 * Every structural tool has the same shape, and the write is the part worth doing
 * once: it goes through the mod layer, so an edit to a file that came out of a
 * pristine dump produces a copy in the mod folder rather than damaging the dump.
 */
/** What an edit reports back: what changed, plus anything worth saying alongside. */
type EditOutcome = string | string[] | { changed: string | string[]; also: Record<string, unknown> }

/** User data edits as they arrive over the wire, where a value is untyped JSON. */
function userDataEdits(raw: unknown): UserDataEdit[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map((item) => {
    const record = item as Record<string, unknown>
    const value = record.value
    if (typeof value !== 'string' && !Array.isArray(value)) {
      throw new Error(
        `user data ${String(record.name)} needs a string value or a list of numbers, not ${typeof value}`
      )
    }
    return {
      name: String(record.name),
      value: typeof value === 'string' ? value : value.map(Number),
      ...(typeof record.kind === 'string'
        ? { kind: record.kind as 'string' | 'int' | 'float' }
        : {})
    }
  })
}

async function withLayout(
  input: Record<string, unknown>,
  edit: (document: LayoutDocument) => EditOutcome
): Promise<ToolResult> {
  const where = await fileOf(input)
  const target = await resolveTarget(where.path, where.entry)
  if (!isBflyt(target.bytes)) throw new Error('that is not a BFLYT layout')

  const { document } = parseBflyt(target.bytes)
  const outcome = edit(document)
  const structured = typeof outcome === 'object' && !Array.isArray(outcome)
  const changed = structured ? outcome.changed : outcome
  const written = await writeLayout(target, document, str(input, 'output_path'))
  context.edited?.(written.path)

  return asText({
    changed: Array.isArray(changed) ? changed : [changed],
    ...(structured ? outcome.also : {}),
    writtenTo: written.path,
    bytes: written.bytes,
    ...(written.redirected
      ? { note: 'This came from the pristine dump, so it was written into your mod folder instead.' }
      : {}),
    panes: paneNames(document)
  })
}

/** The same, for animations. */
async function withAnimation(
  input: Record<string, unknown>,
  edit: (document: AnimationDocument) => string | string[]
): Promise<ToolResult> {
  const where = await fileOf(input)
  const target = await resolveTarget(where.path, where.entry)
  if (!isBflan(target.bytes)) throw new Error('that is not a BFLAN animation')

  const { document } = parseBflan(target.bytes)
  const changed = edit(document)
  const written = await writeAnimation(target, document, str(input, 'output_path'))
  context.edited?.(written.path)

  return asText({
    changed: Array.isArray(changed) ? changed : [changed],
    writtenTo: written.path,
    bytes: written.bytes,
    ...(written.redirected
      ? { note: 'This came from the pristine dump, so it was written into your mod folder instead.' }
      : {}),
    frames: document.info?.frameSize ?? 0,
    tracks: animationTracks(document).length
  })
}

/** Fields every file-targeting tool takes. */
const FILE_INPUT = {
  path: {
    type: 'string',
    description: 'Omit to use the file currently open in BFLayout, when one is'
  },
  entry: { type: 'string', description: 'Entry name inside the archive' },
  output_path: {
    type: 'string',
    description: 'Write here instead of overwriting the file that was read'
  }
} as const

const TOOLS: ToolDefinition[] = [
  {
    name: 'current_context',
    description:
      'What BFLayout currently has open: the active mod project, the folder being browsed, open archives and open layout tabs. Call this FIRST. It tells you which file the person is looking at — most tools then take no path at all and mean that file — and whether your writes are protected by the project (dump read-only, edits copied into the mod folder).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => asText(await context.describe())
  },
  {
    name: 'create_archive',
    description:
      'Create a new, empty SARC archive. Compression comes from the extension — .zs is ZSTD, .szs is Yaz0, anything else uncompressed — because a .zs that is not ZSTD is a file the game will not read. This is the starting point for a custom screen: in these titles each screen needs its own Layout/<name>.Nin_NX_NVN.blarc.zs. Refuses to overwrite an archive that already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Archive to create, e.g. .../Layout/My_Screen.Nin_NX_NVN.blarc.zs' }
      },
      required: ['path']
    },
    run: async (input) => {
      const created = await createArchive({ path: required(input, 'path') })
      context.edited?.(created.path)
      return asText({
        ...created,
        next: 'Add a layout with create_layout or duplicate_layout, or copy a whole screen with clone_archive.'
      })
    }
  },
  {
    name: 'clone_archive',
    description:
      "Copy a whole archive, renaming every entry that carries a stem. This is how a screen is cloned: the game resolves a screen's animations BY LAYOUT NAME — anim/<layout>_In.bflan, _Out, _Loop — so serving Common_Text_00's archive as Common_CantTouch_00 means renaming the layout and every sibling animation together. A renamed layout also has its internal name updated. Entries are aligned by kind, so GPU resources land on 0x1000.",
    inputSchema: {
      type: 'object',
      properties: {
        from_path: { type: 'string', description: 'The donor archive' },
        to_path: { type: 'string', description: 'The new archive; created, not merged into' },
        rename_from: { type: 'string', description: "The stem to replace, e.g. 'Common_Text_00'" },
        rename_to: { type: 'string', description: "What to replace it with, e.g. 'Common_CantTouch_00'" }
      },
      required: ['from_path', 'to_path']
    },
    run: async (input) => {
      const result = await cloneArchive({
        fromPath: required(input, 'from_path'),
        toPath: required(input, 'to_path'),
        ...(str(input, 'rename_from') ? { renameFrom: str(input, 'rename_from')! } : {}),
        ...(str(input, 'rename_to') ? { renameTo: str(input, 'rename_to')! } : {})
      })
      context.edited?.(result.path)
      return asText(result)
    }
  },
  {
    name: 'rename_entry',
    description:
      "Rename one entry inside an archive. This is a rehash, not a relabel: SARC finds files by the hash of their name. Anything referring to the old name stops finding it — which for a layout means the game's animation lookup, so rename the anim/ siblings too (or use clone_archive, which does the whole set at once).",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The archive; defaults to the open file' },
        from: { type: 'string' },
        to: { type: 'string' }
      },
      required: ['from', 'to']
    },
    run: async (input) => {
      const where = await fileOf(input)
      const result = await editArchiveEntries({
        path: where.path,
        rename: { from: required(input, 'from'), to: required(input, 'to') }
      })
      context.edited?.(result.path)
      return asText(result)
    }
  },
  {
    name: 'delete_entry',
    description:
      'Remove an entry from an archive. Gone once written — extract it first if you might want it back.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The archive; defaults to the open file' },
        entry_name: { type: 'string', description: 'Full entry name, e.g. blyt/Old.bflyt' }
      },
      required: ['entry_name']
    },
    run: async (input) => {
      const where = await fileOf(input)
      const result = await editArchiveEntries({
        path: where.path,
        remove: required(input, 'entry_name')
      })
      context.edited?.(result.path)
      return asText(result)
    }
  },
  {
    name: 'add_entry',
    description:
      'Add a file from disk into an archive under a given entry name. Alignment is set from the kind, so a .bntx or .bnsh lands on a 0x1000 boundary — the driver maps those rather than reading them, and one off a page boundary crashes inside the reader with nothing pointing at the packing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The archive; defaults to the open file' },
        entry_name: { type: 'string', description: 'Name inside the archive, e.g. timg/My.bntx' },
        from_file: { type: 'string', description: 'File on disk to add' }
      },
      required: ['entry_name', 'from_file']
    },
    run: async (input) => {
      const where = await fileOf(input)
      const result = await editArchiveEntries({
        path: where.path,
        add: { name: required(input, 'entry_name'), fromFile: required(input, 'from_file') }
      })
      context.edited?.(result.path)
      return asText(result)
    }
  },
  {
    name: 'create_animation',
    description:
      'Create a new, empty BFLAN — a named tag with a frame count and nothing animated yet. Write it loose, or into an archive with entry set. Use this when a custom screen needs an animation the donor does not ship (an _In where it only has a _Loop), then give it tracks with add_animation_track.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to write, or the archive to add to' },
        entry: { type: 'string', description: 'Entry name, e.g. anim/My_Screen_In.bflan' },
        name: { type: 'string', description: "The animation's tag name, e.g. In" },
        frame_size: { type: 'number', description: 'Length in frames, default 60' },
        loop: { type: 'boolean' }
      },
      required: ['path', 'name']
    },
    run: async (input) => {
      const created = await createAnimationFile({
        path: required(input, 'path'),
        name: required(input, 'name'),
        ...(str(input, 'entry') ? { entry: str(input, 'entry')! } : {}),
        ...(num(input, 'frame_size') === undefined ? {} : { frameSize: num(input, 'frame_size')! }),
        ...(bool(input, 'loop') === undefined ? {} : { loop: bool(input, 'loop')! })
      })
      context.edited?.(created.path)
      return asText(created)
    }
  },
  {
    name: 'create_layout',
    description:
      'Create a new, empty layout — a root pane on a canvas of the size you give, and nothing else. Write it as a loose .bflyt, or into an archive with entry set (the archive must already exist; the entry is added). This is the starting point for a custom screen; use copy_panes to bring pieces in from an existing one.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to write, or the archive to add to' },
        entry: { type: 'string', description: 'Entry name inside the archive, e.g. blyt/MyMenu.bflyt' },
        name: { type: 'string', description: "The layout's internal name" },
        width: { type: 'number', description: 'Canvas width, default 1280' },
        height: { type: 'number', description: 'Canvas height, default 720' }
      },
      required: ['path', 'name']
    },
    run: async (input) => {
      const written = await createLayoutFile({
        path: required(input, 'path'),
        name: required(input, 'name'),
        ...(str(input, 'entry') ? { entry: str(input, 'entry')! } : {}),
        ...(num(input, 'width') === undefined ? {} : { width: num(input, 'width')! }),
        ...(num(input, 'height') === undefined ? {} : { height: num(input, 'height')! })
      })
      context.edited?.(written.path)
      return asText(written)
    }
  },
  {
    name: 'copy_panes',
    description:
      'Copy panes from one layout into another, bringing everything they need. A pane refers to its material by INDEX, and materials refer to textures by index, so a naive copy points at whatever sits at that index in the destination — it still draws, with the wrong texture. This carries the subtree, its materials, their textures and any fonts, remapping every index. Across archives it also copies the texture CONTAINERS, so the copied panes are not left naming textures the destination does not have.',
    inputSchema: {
      type: 'object',
      properties: {
        from_path: { type: 'string', description: 'Source file or archive' },
        from_entry: { type: 'string', description: 'Source entry, e.g. blyt/MainMenu.bflyt' },
        panes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pane names to copy; each brings its subtree'
        },
        path: { type: 'string', description: 'Destination; defaults to the open file' },
        entry: { type: 'string', description: 'Destination entry' },
        into: {
          type: 'string',
          description: 'Pane in the destination to put them under; defaults to its root'
        },
        suffix: { type: 'string', description: 'Appended to names already taken, default "_copy"' },
        carry_textures: {
          type: 'boolean',
          description:
            'Copy the BNTX containers holding any texture the destination lacks. Default true — turning it off leaves the copied panes untextured in game.'
        },
        output_path: { type: 'string' }
      },
      required: ['from_path', 'panes']
    },
    run: async (input) => {
      const names = input['panes']
      if (!Array.isArray(names) || names.length === 0) {
        throw new Error('panes must be a non-empty array of pane names')
      }

      const where = await fileOf(input)
      const result = await copyPanesBetween({
        fromPath: required(input, 'from_path'),
        ...(str(input, 'from_entry') ? { fromEntry: str(input, 'from_entry')! } : {}),
        toPath: where.path,
        ...(where.entry ? { toEntry: where.entry } : {}),
        panes: names.map((name) => String(name)),
        ...(str(input, 'into') ? { into: str(input, 'into')! } : {}),
        ...(str(input, 'suffix') ? { suffix: str(input, 'suffix')! } : {}),
        ...(str(input, 'output_path') ? { outputPath: str(input, 'output_path')! } : {}),
        ...(bool(input, 'create_groups') === undefined
          ? {}
          : { createGroups: bool(input, 'create_groups')! }),
        ...(bool(input, 'carry_textures') === undefined
          ? {}
          : { carryTextures: bool(input, 'carry_textures')! })
      })
      context.edited?.(result.path)

      return asText({
        copied: result.report.panes,
        materials: result.report.materials,
        textures: result.report.textures,
        fonts: result.report.fonts,
        textureContainersCopied: result.carried,
        writtenTo: result.path,
        bytes: result.bytes,
        ...(result.redirected
          ? {
              note: 'The destination came from the pristine dump, so it was written into your mod folder instead.'
            }
          : {}),
        ...(result.report.warnings.length > 0 ? { warnings: result.report.warnings } : {})
      })
    }
  },
  {
    name: 'duplicate_layout',
    description:
      'Copy a whole layout: to a new entry in the same archive, to a loose .bflyt file, or into a DIFFERENT archive (give both to_path and to_entry) — which carries its textures across too, since a layout without them loads and draws nothing. Optionally renames the layout internally. The quickest way to start from an existing screen.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        entry: { type: 'string', description: 'The layout to copy' },
        to_entry: { type: 'string', description: 'New entry name in the same archive' },
        to_path: { type: 'string', description: 'Or a new file to write instead' },
        name: { type: 'string', description: "The copy's internal layout name" }
      },
      required: ['path']
    },
    run: async (input) => {
      const where = await fileOf(input)
      const written = await duplicateLayoutFile({
        path: where.path,
        ...(where.entry ? { entry: where.entry } : {}),
        ...(str(input, 'to_entry') ? { toEntry: str(input, 'to_entry')! } : {}),
        ...(str(input, 'to_path') ? { toPath: str(input, 'to_path')! } : {}),
        ...(str(input, 'name') ? { name: str(input, 'name')! } : {})
      })
      context.edited?.(written.path)
      return asText(written)
    }
  },
  {
    name: 'add_pane',
    description:
      'Add a new pane to a layout, under a named parent (the root by default). Kinds: pan1 (null/group), pic1 (picture), txt1 (text), wnd1 (nine-slice window), bnd1 (boundary), prt1 (part — instantiates another layout).',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        kind: { type: 'string', enum: [...PANE_KINDS] },
        name: { type: 'string', description: 'Must be unique in this layout' },
        parent: { type: 'string', description: 'Pane to add it under; defaults to the root' },
        translate: { type: 'array', items: { type: 'number' }, description: '[x, y, z]' },
        size: { type: 'array', items: { type: 'number' }, description: '[width, height]' },
        text: { type: 'string', description: 'txt1 only' },
        part: { type: 'string', description: 'prt1 only: the layout it instantiates' },
        at: { type: 'number', description: 'Index among siblings; later draws on top' }
      },
      required: ['path', 'kind', 'name']
    },
    run: (input) =>
      withLayout(input, (document) =>
        addPane(document, {
          kind: required(input, 'kind'),
          name: required(input, 'name'),
          ...(str(input, 'parent') ? { parent: str(input, 'parent')! } : {}),
          ...(numberList(input, 'translate')
            ? { translate: numberList(input, 'translate') as [number, number, number] }
            : {}),
          ...(numberList(input, 'size')
            ? { size: numberList(input, 'size') as [number, number] }
            : {}),
          ...(str(input, 'text') !== undefined ? { text: str(input, 'text')! } : {}),
          ...(str(input, 'part') !== undefined ? { part: str(input, 'part')! } : {}),
          ...(num(input, 'at') === undefined ? {} : { at: num(input, 'at')! })
        })
      )
  },
  {
    name: 'delete_pane',
    description:
      'Remove a pane and everything under it. The root pane cannot be deleted — delete its children instead.',
    inputSchema: {
      type: 'object',
      properties: { ...FILE_INPUT, pane: { type: 'string' } },
      required: ['path', 'pane']
    },
    run: (input) => withLayout(input, (document) => deletePane(document, required(input, 'pane')))
  },
  {
    name: 'duplicate_pane',
    description:
      'Copy a pane and its subtree in beside itself. Every name in the copy is suffixed, because panes are addressed by name here and a duplicate that reused them would make later edits ambiguous. User data that names other panes (AdjustToTextOn and friends) is repointed at the copy\'s own panes where those were copied too; anything still naming a pane outside the copy is returned in "warnings", because the copy is then driving itself from the original\'s collaborator.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        pane: { type: 'string' },
        suffix: { type: 'string', description: 'Default "_copy"' }
      },
      required: ['path', 'pane']
    },
    run: (input) =>
      withLayout(input, (document) => {
        const report = duplicatePane(
          document,
          required(input, 'pane'),
          str(input, 'suffix') ?? '_copy'
        )
        return {
          changed: report.message,
          also: {
            copy: report.name,
            ...(report.remapped.length > 0 ? { remapped: report.remapped } : {}),
            ...(report.warnings.length > 0 ? { warnings: report.warnings } : {})
          }
        }
      })
  },
  {
    name: 'read_pane_userdata',
    description:
      "A pane's user data: the key/value bag the runtime reads to wire panes together. This is where behaviour that is not in the pane's own fields lives — AdjustToTextOn makes a pane resize itself every frame to fit the text panes it names, so a copied pane that kept the original's value is driving itself from something else. Entries that name panes come back with whether this layout actually has them.",
    inputSchema: {
      type: 'object',
      properties: { ...FILE_INPUT, pane: { type: 'string' } },
      required: ['path', 'pane']
    },
    run: async (input) => {
      const where = await fileOf(input)
      const document = await readLayout(where.path, where.entry)
      return asText({ pane: required(input, 'pane'), userData: paneUserData(document, required(input, 'pane')) })
    }
  },
  {
    name: 'edit_pane_userdata',
    description:
      'Set or remove user data entries on a pane. Use this to clear behavioural keys a duplicate inherited — removing AdjustToTextOn stops a copied pane resizing itself to a pane it does not own — or to repoint one at the right pane. Editing rebuilds the whole section rather than replaying its original bytes, so a struct entry cannot be created or overwritten; it can be removed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        pane: { type: 'string' },
        set: {
          type: 'array',
          description: 'Entries to add or overwrite',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: {
                description: 'A string, or a list of numbers. AdjustToTextOn takes newline-separated pane names.'
              },
              kind: { type: 'string', enum: ['string', 'int', 'float'], description: 'Inferred from the value if omitted' }
            },
            required: ['name', 'value']
          }
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Entry names to delete' }
      },
      required: ['path', 'pane']
    },
    run: (input) =>
      withLayout(input, (document) =>
        editUserData(document, required(input, 'pane'), {
          set: userDataEdits(input.set),
          remove: Array.isArray(input.remove) ? input.remove.map(String) : undefined
        })
      )
  },
  {
    name: 'list_groups',
    description:
      "The layout's pane groups and what is in each. A BFLAN's pat1 binds to a group, and that binding decides which panes the animation applies to — so an animation bound to a group this layout does not have applies to nothing at all, however correct its tracks are. Nearly every shipped animation binds to a group.",
    inputSchema: { type: 'object', properties: { ...FILE_INPUT }, required: ['path'] },
    run: async (input) => {
      const where = await fileOf(input)
      const document = await readLayout(where.path, where.entry)
      return asText({ groups: groupList(document) })
    }
  },
  {
    name: 'add_group',
    description:
      'Add a pane group. This is what an animation binds to: create the group a copied animation expects, holding the panes it drives, and the animation starts applying to them.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        name: { type: 'string', description: 'Group name, e.g. G_InOut_00' },
        panes: { type: 'array', items: { type: 'string' }, description: 'Panes to put in it' }
      },
      required: ['path', 'name', 'panes']
    },
    run: (input) =>
      withLayout(input, (document) =>
        addGroup(
          document,
          required(input, 'name'),
          Array.isArray(input.panes) ? input.panes.map(String) : []
        )
      )
  },
  {
    name: 'edit_group',
    description: "Change which panes a group holds. `set` replaces the list; `add` and `remove` adjust it.",
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        name: { type: 'string' },
        set: { type: 'array', items: { type: 'string' } },
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } }
      },
      required: ['path', 'name']
    },
    run: (input) =>
      withLayout(input, (document) =>
        editGroup(document, required(input, 'name'), {
          ...(Array.isArray(input.set) ? { set: input.set.map(String) } : {}),
          ...(Array.isArray(input.add) ? { add: input.add.map(String) } : {}),
          ...(Array.isArray(input.remove) ? { remove: input.remove.map(String) } : {})
        })
      )
  },
  {
    name: 'delete_group',
    description:
      'Remove a pane group. Any animation whose pat1 binds to it will then apply to nothing, so check with list_animations first.',
    inputSchema: {
      type: 'object',
      properties: { ...FILE_INPUT, name: { type: 'string' } },
      required: ['path', 'name']
    },
    run: (input) => withLayout(input, (document) => deleteGroup(document, required(input, 'name')))
  },
  {
    name: 'rename_pane',
    description:
      'Rename a pane. Anything referring to the old name — an animation track, a group — will stop finding it, so check with search_dump first if you are unsure.',
    inputSchema: {
      type: 'object',
      properties: { ...FILE_INPUT, pane: { type: 'string' }, to: { type: 'string' } },
      required: ['path', 'pane', 'to']
    },
    run: (input) =>
      withLayout(input, (document) =>
        renamePane(document, required(input, 'pane'), required(input, 'to'))
      )
  },
  {
    name: 'reparent_pane',
    description:
      'Move a pane under a different parent. Position is inherited from the parent, so this changes where it draws. Refused if the new parent is inside the pane being moved.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        pane: { type: 'string' },
        parent: { type: 'string' },
        at: { type: 'number', description: 'Index among the new siblings' }
      },
      required: ['path', 'pane', 'parent']
    },
    run: (input) =>
      withLayout(input, (document) =>
        reparentPane(
          document,
          required(input, 'pane'),
          required(input, 'parent'),
          num(input, 'at')
        )
      )
  },
  {
    name: 'reorder_pane',
    description:
      'Move a pane among its siblings. Siblings draw in order, so this is z-order: a later index draws on top.',
    inputSchema: {
      type: 'object',
      properties: { ...FILE_INPUT, pane: { type: 'string' }, to: { type: 'number' } },
      required: ['path', 'pane', 'to']
    },
    run: (input) =>
      withLayout(input, (document) =>
        reorderPane(document, required(input, 'pane'), num(input, 'to') ?? 0)
      )
  },
  {
    name: 'edit_material',
    description:
      "Change a material's colours or which textures it samples. Colours are [r, g, b, a] 0-255. Texture indices point into the layout's own texture list, which read_layout returns.",
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        material: { type: 'string' },
        black_color: { type: 'array', items: { type: 'number' } },
        white_color: { type: 'array', items: { type: 'number' } },
        texture_indices: { type: 'array', items: { type: 'number' } }
      },
      required: ['path', 'material']
    },
    run: (input) =>
      withLayout(input, (document) =>
        editMaterial(document, required(input, 'material'), {
          ...(numberList(input, 'black_color')
            ? { blackColor: numberList(input, 'black_color') as [number, number, number, number] }
            : {}),
          ...(numberList(input, 'white_color')
            ? { whiteColor: numberList(input, 'white_color') as [number, number, number, number] }
            : {}),
          ...(numberList(input, 'texture_indices')
            ? { textureIndices: numberList(input, 'texture_indices')! }
            : {})
        })
      )
  },
  {
    name: 'add_material',
    description:
      "Add a material, or add a texture name to the layout's texture list. Materials are what panes draw with; the texture list is what materials index into.",
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        material: { type: 'string', description: 'Name of the new material' },
        texture: { type: 'string', description: 'Texture file name to add to the list' }
      },
      required: ['path']
    },
    run: (input) =>
      withLayout(input, (document) => {
        const changed: string[] = []
        const texture = str(input, 'texture')
        if (texture) {
          changed.push(`texture ${texture} is index ${addTexture(document, texture)}`)
        }
        const material = str(input, 'material')
        if (material) {
          changed.push(`material ${material} is index ${addMaterialTo(document, material)}`)
        }
        if (changed.length === 0) throw new Error('give a material name, a texture name, or both')
        return changed
      })
  },
  {
    name: 'copy_animation',
    description:
      "Copy a BFLAN into another archive and report what it will not find there. A BFLAN binds to panes and materials by NAME, not by index, so nothing needs remapping — but a track naming a pane the destination lacks is not an error anywhere: the file parses, the game loads it, and that track silently animates nothing. Every unmatched target comes back in the result. Use `rename` to point the animation's targets at the destination's own pane and material names. Pattern textures are merged into the destination's container.",
    inputSchema: {
      type: 'object',
      properties: {
        from_path: { type: 'string' },
        from_entry: { type: 'string', description: 'The BFLAN inside the source archive' },
        to_path: { type: 'string', description: 'Destination archive' },
        to_entry: {
          type: 'string',
          description:
            "Entry name to write, e.g. anim/My_Screen_In.bflan. The game finds a layout's animations by the layout's name, so this should start with the destination layout's name."
        },
        layout_entry: {
          type: 'string',
          description: 'The layout it drives; inferred when the archive holds only one'
        },
        rename: {
          type: 'object',
          description: 'Old target name to new, applied to animated entries and to pat1 groups',
          additionalProperties: { type: 'string' }
        },
        create_groups: {
          type: 'boolean',
          description:
            "Build any group the pat1 binds to that the destination lacks, from the panes this animation drives. Off by default because it rewrites the layout too — but without it, a copy whose group is missing does nothing at all."
        },
        carry_textures: { type: 'boolean', description: 'Default true' }
      },
      required: ['from_path', 'to_path']
    },
    run: async (input) => {
      const result = await copyAnimationBetween({
        fromPath: required(input, 'from_path'),
        ...(str(input, 'from_entry') === undefined ? {} : { fromEntry: str(input, 'from_entry')! }),
        toPath: required(input, 'to_path'),
        ...(str(input, 'to_entry') === undefined ? {} : { toEntry: str(input, 'to_entry')! }),
        ...(str(input, 'layout_entry') === undefined
          ? {}
          : { layoutEntry: str(input, 'layout_entry')! }),
        ...(typeof input.rename === 'object' && input.rename !== null
          ? { rename: input.rename as Record<string, string> }
          : {}),
        ...(bool(input, 'create_groups') === undefined
          ? {}
          : { createGroups: bool(input, 'create_groups')! }),
        ...(bool(input, 'carry_textures') === undefined
          ? {}
          : { carryTextures: bool(input, 'carry_textures')! })
      })
      context.edited?.(result.path)
      return asText(result)
    }
  },
  {
    name: 'list_animations',
    description:
      'List the BFLAN animations in an archive, with their length, loop flag and how many tracks each has. Animations sit alongside the layout they drive, usually in anim/.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } }
    },
    run: async (input) => asText(await listAnimations((await fileOf(input)).path))
  },
  {
    name: 'read_animation',
    description:
      'Read a BFLAN and return every animated channel flattened into tracks: which pane or material, what property (with its human name), the curve kind and every keyframe. The file nests these three deep; this is the view you can actually reason about.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, entry: { type: 'string' } }
    },
    run: async (input) => {
      const where = await fileOf(input)
      const document = await readAnimation(where.path, where.entry)
      return asText({
        name: document.tag?.name ?? null,
        frames: document.info?.frameSize ?? 0,
        loop: document.info?.loop ?? false,
        range: document.tag ? [document.tag.startFrame, document.tag.endFrame] : null,
        groups: document.tag?.groups ?? [],
        patternTextures: document.info?.textures ?? [],
        tracks: animationTracks(document)
      })
    }
  },
  {
    name: 'render_animation_frame',
    description:
      'Render a layout as an animation leaves it at one frame, as a PNG. This is how you check what an animation actually does — the curves are just numbers until you can see them applied. Give the layout and the animation; they are usually two entries in the same archive.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Archive or loose layout' },
        entry: { type: 'string', description: 'The layout entry, e.g. blyt/MainMenu.bflyt' },
        animation_path: { type: 'string', description: 'Defaults to the same file' },
        animation_entry: { type: 'string', description: 'The BFLAN entry, e.g. anim/MainMenu_In.bflan' },
        frame: { type: 'number' },
        max_size: { type: 'number' },
        save_to: { type: 'string' }
      },
      required: ['frame']
    },
    run: async (input) => {
      const where = await fileOf(input)
      const layout = await readLayout(where.path, where.entry)
      const animation = await readAnimation(
        str(input, 'animation_path') ?? where.path,
        str(input, 'animation_entry')
      )

      const frame = num(input, 'frame') ?? 0
      const maxSize = num(input, 'max_size')
      const result = await renderAtFrame(where.path, layout, animation, frame, {
        ...(maxSize ? { maxSize } : {})
      })

      const saveTo = str(input, 'save_to')
      if (saveTo) await writeFile(resolve(saveTo), result.png)

      return {
        content: [
          { type: 'image', data: Buffer.from(result.png).toString('base64'), mimeType: 'image/png' },
          {
            type: 'text',
            text: JSON.stringify(
              {
                frame,
                of: animation.info?.frameSize ?? 0,
                caveats: result.caveats,
                ...(saveTo ? { savedTo: resolve(saveTo) } : {}),
                panes: result.panes
              },
              null,
              2
            )
          }
        ]
      }
    }
  },
  {
    name: 'edit_animation',
    description:
      "Change an animation's length, loop flag, name or frame range. Length is the pai1 frame count; the range is the pat1 tag's start and end.",
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        frame_size: { type: 'number' },
        loop: { type: 'boolean' },
        name: { type: 'string' },
        start_frame: { type: 'number' },
        end_frame: { type: 'number' }
      },
      required: ['path']
    },
    run: (input) =>
      withAnimation(input, (document) =>
        editAnimation(document, {
          ...(num(input, 'frame_size') === undefined ? {} : { frameSize: num(input, 'frame_size')! }),
          ...(bool(input, 'loop') === undefined ? {} : { loop: bool(input, 'loop')! }),
          ...(str(input, 'name') === undefined ? {} : { name: str(input, 'name')! }),
          ...(num(input, 'start_frame') === undefined
            ? {}
            : { startFrame: num(input, 'start_frame')! }),
          ...(num(input, 'end_frame') === undefined ? {} : { endFrame: num(input, 'end_frame')! })
        })
      )
  },
  {
    name: 'set_keyframes',
    description:
      'Replace every keyframe on one animation track. Identify the track by entry (pane or material name), tag and target byte — read_animation lists all three for every track. Keyframes are {frame, value, slope}; slope is the Hermite tangent and 0 is flat.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        animates: { type: 'string', description: 'The animated pane or material' },
        tag: { type: 'string', description: 'FLPA, FLVI, FLTS, FLVC, FLMC or FLTP' },
        target: { type: 'number', description: 'Target byte within the tag' },
        index: { type: 'number', description: 'Sub-index; 0 for most tags' },
        curve: { type: 'string', enum: ['constant', 'step', 'hermite'] },
        keyframes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              frame: { type: 'number' },
              value: { type: 'number' },
              slope: { type: 'number' }
            },
            required: ['frame', 'value']
          }
        }
      },
      required: ['path', 'animates', 'tag', 'target', 'keyframes']
    },
    run: (input) =>
      withAnimation(input, (document) =>
        setKeyframes(
          document,
          selectorOf(input),
          keyframeList(input, 'keyframes'),
          str(input, 'curve') as CurveKind | undefined
        )
      )
  },
  {
    name: 'put_keyframe',
    description:
      'Set one keyframe on a track, replacing any key already at that frame. Use this for a single adjustment; set_keyframes replaces the whole curve.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        animates: { type: 'string', description: 'The animated pane or material' },
        tag: { type: 'string' },
        target: { type: 'number' },
        index: { type: 'number' },
        frame: { type: 'number' },
        value: { type: 'number' },
        slope: { type: 'number' }
      },
      required: ['path', 'animates', 'tag', 'target', 'frame', 'value']
    },
    run: (input) =>
      withAnimation(input, (document) =>
        putKeyframe(document, selectorOf(input), {
          frame: num(input, 'frame') ?? 0,
          value: num(input, 'value') ?? 0,
          slope: num(input, 'slope') ?? 0
        })
      )
  },
  {
    name: 'remove_keyframe',
    description:
      'Remove the keyframe at one frame. Refused if it is the track\'s only key — a track with none has no value to evaluate, so remove the track instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        animates: { type: 'string', description: 'The animated pane or material' },
        tag: { type: 'string' },
        target: { type: 'number' },
        index: { type: 'number' },
        frame: { type: 'number' }
      },
      required: ['path', 'animates', 'tag', 'target', 'frame']
    },
    run: (input) =>
      withAnimation(input, (document) =>
        removeKeyframe(document, selectorOf(input), num(input, 'frame') ?? 0)
      )
  },
  {
    name: 'add_animation_track',
    description:
      'Animate something the animation does not yet drive. Creates the entry and tag if they are missing, so this is how you start animating a pane that has no tracks at all. FLPA targets: 0-2 translate XYZ, 3-5 rotate XYZ, 6-7 scale XY, 8-9 size XY. FLVI target 0 is visibility. FLVC target 16 is pane alpha.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        animates: { type: 'string', description: 'Pane or material name to animate' },
        target_kind: { type: 'string', enum: ['pane', 'material'], description: 'Default pane' },
        tag: { type: 'string', description: 'FLPA, FLVI, FLTS, FLVC, FLMC or FLTP' },
        target: { type: 'number', description: 'Target byte within the tag' },
        index: { type: 'number' },
        curve: { type: 'string', enum: ['constant', 'step', 'hermite'] },
        keyframes: { type: 'array', items: { type: 'object' } }
      },
      required: ['path', 'animates', 'tag', 'target', 'keyframes']
    },
    run: (input) =>
      withAnimation(input, (document) =>
        addTrack(document, {
          entry: required(input, 'animates'),
          ...(str(input, 'target_kind')
            ? { target: str(input, 'target_kind') as 'pane' | 'material' }
            : {}),
          tag: required(input, 'tag'),
          targetByte: num(input, 'target') ?? 0,
          ...(num(input, 'index') === undefined ? {} : { index: num(input, 'index')! }),
          ...(str(input, 'curve') ? { curve: str(input, 'curve') as CurveKind } : {}),
          keyframes: keyframeList(input, 'keyframes')
        })
      )
  },
  {
    name: 'remove_animation_track',
    description:
      'Stop animating one channel. The tag and entry are dropped too if that was their last track, rather than left as structures that animate nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        animates: { type: 'string', description: 'The animated pane or material' },
        tag: { type: 'string' },
        target: { type: 'number' },
        index: { type: 'number' }
      },
      required: ['path', 'animates', 'tag', 'target']
    },
    run: (input) => withAnimation(input, (document) => removeTrack(document, selectorOf(input)))
  },
  {
    name: 'identify_file',
    description:
      'Say what a file actually is, by reading its magic rather than trusting its extension. In a romfs the extension is only a hint — Foo.Nin_NX_NVN.blarc.zs is a compressed SARC. Start here when you do not know what you are looking at.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file' } }
    },
    run: async (input) => asText(await identify((await fileOf(input)).path))
  },
  {
    name: 'list_archive',
    description:
      'List the entries inside a SARC/SZS archive, with each entry\'s real format. Layouts in a game dump are entries inside archives rather than loose files, so this is usually the second step after identify_file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } }
    },
    run: async (input) => {
      const target = await resolveTarget((await fileOf(input)).path)
      if (!target.archive) throw new Error(`${basename(target.path)} is not an archive`)
      return asText(listArchive(target.archive))
    }
  },
  {
    name: 'read_layout',
    description:
      'Read a BFLYT layout and return its pane tree: names, kinds, positions, sizes, visibility, text content and part references, plus its materials and pane groups. This is the structural view — use render_layout to see where things actually sit. Groups matter more than they look: an animation binds to one, so a layout with no groups cannot be animated by a stock animation at all.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        entry: {
          type: 'string',
          description: 'Entry name inside the archive, e.g. blyt/MainMenu.bflyt'
        }
      }
    },
    run: async (input) => {
      const where = await fileOf(input)
      const document = await readLayout(where.path, where.entry)
      return asText({
        name: document.info.name,
        canvas: { width: document.info.width, height: document.info.height },
        textures: document.textures,
        fonts: document.fonts,
        materials: document.materials.map((material) => material.name),
        // Animations bind to groups, so a layout with none can only be animated
        // by an animation that binds to nothing — which almost none of them do.
        groups: groupList(document),
        root: document.rootPane ? summarizePane(document.rootPane) : null
      })
    }
  },
  {
    name: 'render_layout',
    description:
      'Render a layout to a PNG and return it as an image, plus the canvas-space rectangle of every pane. Draws the real textures where they can be decoded, including nine-slice window frames, falling back to flat colour by pane kind for anything else. Text is never drawn. Positions are exact: it uses the same transform code as the editor canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        entry: { type: 'string' },
        max_size: { type: 'number', description: 'Longest edge in pixels, default 1024' },
        only: { type: 'string', description: 'Draw only this pane and its children' },
        show_invisible: { type: 'boolean', description: 'Include panes the game hides' },
        save_to: { type: 'string', description: 'Also write the PNG to this path' }
      }
    },
    run: async (input) => {
      const where = await fileOf(input)
      const document = await readLayout(where.path, where.entry)
      const maxSize = num(input, 'max_size')
      const only = str(input, 'only')
      const result = await renderWithTextures(where.path, document, {
        ...(maxSize ? { maxSize } : {}),
        ...(only ? { only } : {}),
        showInvisible: input['show_invisible'] === true
      })

      const saveTo = str(input, 'save_to')
      if (saveTo) await writeFile(resolve(saveTo), result.png)

      return {
        content: [
          {
            type: 'image',
            data: Buffer.from(result.png).toString('base64'),
            mimeType: 'image/png'
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                size: { width: result.width, height: result.height },
                caveats: result.caveats,
                ...(saveTo ? { savedTo: resolve(saveTo) } : {}),
                panes: result.panes
              },
              null,
              2
            )
          }
        ]
      }
    }
  },
  {
    name: 'edit_pane',
    description:
      'Change one pane and write the file back. Only layout properties can be set: translate, size, scale, rotate, alpha, visible, and text (text panes only). Editing an entry inside an archive rebuilds the archive around it, keeping its compression. Pass output_path to write a copy instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_INPUT,
        pane: { type: 'string', description: 'Pane name, as shown by read_layout' },
        translate: { type: 'array', items: { type: 'number' }, description: '[x, y, z]' },
        size: { type: 'array', items: { type: 'number' }, description: '[width, height]' },
        scale: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
        rotate: { type: 'array', items: { type: 'number' }, description: '[x, y, z] degrees' },
        alpha: { type: 'number', description: '0-255' },
        visible: { type: 'boolean' },
        text: { type: 'string', description: 'Text panes only' }
      },
      required: ['pane']
    },
    run: (input) =>
      withLayout(input, (document) => {
        const paneName = required(input, 'pane')
        const pane = findPane(document, paneName)
        if (!pane) {
          throw new Error(
            `no pane called ${paneName}. Call read_layout on this file to see the names.`
          )
        }

        const edit: PaneEdit = {
          ...(numberList(input, 'translate')
            ? { translate: numberList(input, 'translate') as [number, number, number] }
            : {}),
          ...(numberList(input, 'size')
            ? { size: numberList(input, 'size') as [number, number] }
            : {}),
          ...(numberList(input, 'scale')
            ? { scale: numberList(input, 'scale') as [number, number] }
            : {}),
          ...(numberList(input, 'rotate')
            ? { rotate: numberList(input, 'rotate') as [number, number, number] }
            : {}),
          ...(num(input, 'alpha') === undefined ? {} : { alpha: num(input, 'alpha')! }),
          ...(typeof input['visible'] === 'boolean' ? { visible: input['visible'] } : {}),
          ...(str(input, 'text') !== undefined ? { text: str(input, 'text')! } : {})
        }
        return editPane(pane, edit).map((change) => `${paneName}: ${change}`)
      })
  },
  {
    name: 'search_dump',
    description:
      'Search a folder tree for a name inside its files: pane names, texture names, material names, part references, animation targets, BYML keys and the game\'s own text. This reaches inside archives and binary containers, which is what grep cannot do — it is the fastest way to find which layout draws something.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Directory to search, e.g. a romfs dump' },
        query: { type: 'string' },
        kind: {
          type: 'string',
          description:
            'Restrict to one kind: pane, texture, material, font, part, animation, animationTarget, message, bymlKey'
        },
        limit: { type: 'number', description: 'Default 200' }
      },
      required: ['folder', 'query']
    },
    run: async (input) => {
      const kind = str(input, 'kind')
      const limit = num(input, 'limit')
      const hits = await searchTree(required(input, 'folder'), required(input, 'query'), {
        ...(kind ? { kinds: [kind] } : {}),
        ...(limit ? { limit } : {})
      })
      return asText(
        hits.length === 0 ? 'nothing matched' : hits
      )
    }
  },
  {
    name: 'diff_layouts',
    description:
      'Compare two layouts structurally and describe what changed — "BtnOk moved to (12, -30), the header material changed". Use this to confirm an edit did what you intended, or to describe what a mod does.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string' },
        after: { type: 'string' },
        entry: { type: 'string', description: 'Entry name, used for both files' }
      },
      required: ['before', 'after']
    },
    run: async (input) => {
      const entry = str(input, 'entry')
      const before = await readLayout(required(input, 'before'), entry)
      const after = await readLayout(required(input, 'after'), entry)
      const changes = compare.diffLayouts(before, after)
      return asText({ summary: compare.summarizeChanges(changes), changes })
    }
  },
  {
    name: 'check_file',
    description:
      'Parse a file and everything inside it, reporting anything that would stop the game loading it. Run this after edits and before shipping. Errors mean the file is very likely broken; warnings are worth a look; info is context.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } }
    },
    run: async (input) => asText(await checkFile((await fileOf(input)).path))
  },
  {
    name: 'layout_to_text',
    description:
      'Convert a layout to a reviewable YAML document — the whole model, diffable and mergeable in git. Round-trips exactly: apply_layout_text writes it back to the same bytes. Use it to review a change, or to make a broad edit as a text transformation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        entry: { type: 'string' },
        save_to: { type: 'string' }
      }
    },
    run: async (input) => {
      const where = await fileOf(input)
      const document = await readLayout(where.path, where.entry)
      const yaml = text.layoutToText(document)
      const saveTo = str(input, 'save_to')
      if (saveTo) {
        await writeFile(resolve(saveTo), yaml)
        return asText(`written to ${resolve(saveTo)} (${yaml.length} bytes)`)
      }
      return asText(yaml)
    }
  },
  {
    name: 'apply_layout_text',
    description:
      'Write a YAML layout document (from layout_to_text) back into a binary layout, rebuilding the archive around it if needed. This is how a broad or scripted edit gets applied.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The binary file to write into' },
        text_path: { type: 'string', description: 'The YAML document to read' },
        entry: { type: 'string' },
        output_path: { type: 'string' }
      },
      required: ['path', 'text_path']
    },
    run: async (input) => {
      const where = await fileOf(input)
      const target = await resolveTarget(where.path, where.entry)
      const document = text.layoutFromText(
        await readFile(resolve(required(input, 'text_path')), 'utf8')
      )
      const written = await writeLayout(target, document, str(input, 'output_path'))
      return asText({ writtenTo: written.path, bytes: written.bytes })
    }
  }
]


  return TOOLS
}
