import { isBflan, parseBflan, writeBflan } from '@shared/formats/bflan'
import {
  isBflyt,
  localSegment,
  parseBflyt,
  referencedPanes,
  walkPanes,
  writeBflyt
} from '@shared/formats/bflyt'
import type { LayoutDocument } from '@shared/formats/bflyt/types'
import { isBntx, parseBntx } from '@shared/formats/bntx'
import { isByml, parseByml } from '@shared/formats/byml'
import { isMsbt, parseMsbt } from '@shared/formats/msbt'
import {
  GPU_ALIGNMENT,
  isSarc,
  needsPageAlignment,
  parseSarc,
  type SarcArchive
} from '@shared/formats/sarc'

/**
 * What a mod's files are checked for before they are deployed.
 *
 * The premise is that a broken mod does not announce itself: the emulator loads a
 * malformed layout and the game crashes, or silently draws nothing, and the mod
 * is blamed for a bug that is really a corrupt file. Everything here is answerable
 * offline from the bytes, and everything it finds is phrased as something to do.
 *
 * Pure by design — no filesystem, no Node — so the same checks run in the app, in
 * the CLI and in tests. The caller decompresses first; compression wraps a whole
 * archive rather than its entries, so it is not this module's problem.
 */

export type CheckLevel = 'error' | 'warning' | 'info'

export interface CheckNote {
  readonly level: CheckLevel
  readonly message: string
}

export interface FileCheck {
  /** What the bytes turned out to be, by magic rather than by extension. */
  readonly format: string
  readonly notes: readonly CheckNote[]
}

const note = (level: CheckLevel, message: string): CheckNote => ({ level, message })

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The one texture container nn::ui2d will open, as a literal in the game binary.
 *
 * `timg/__Combined.bntx` is the only occurrence of that string in the executable, and the
 * accessor's lookup is by exact path rather than by scanning an archive's entries. The name is
 * not a convention these archives happen to follow — it is the whole interface.
 */
export const CANONICAL_TEXTURE_CONTAINER = 'timg/__Combined.bntx'

/** Lowercased once, since entry names are compared case-insensitively. */
const CANONICAL_TEXTURE_CONTAINER_KEY = CANONICAL_TEXTURE_CONTAINER.toLowerCase()

/** Case-insensitive, extension-optional comparison, as layouts and containers disagree about both. */
function textureKey(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.toLowerCase().replace(/\.bntx$/, '')
}

/**
 * One file, checked as deeply as its format allows.
 *
 * An unrecognised file is *not* an error. A romfs holds plenty this build has
 * never modelled, and a mod is entitled to ship one — refusing would be the tool
 * overreaching. It is reported as information so that "I replaced a file and
 * nothing checked it" is never a silent state.
 */
export function checkBytes(name: string, data: Uint8Array): FileCheck {
  if (data.length === 0) {
    return { format: 'empty', notes: [note('error', `${name} is empty (0 bytes)`)] }
  }

  if (isSarc(data)) return checkArchive(name, data)
  if (isBflyt(data)) return { format: 'BFLYT', notes: checkLayout(name, data) }
  if (isBflan(data)) return { format: 'BFLAN', notes: checkAnimation(name, data) }
  if (isBntx(data)) return { format: 'BNTX', notes: checkSimple(name, 'BNTX', () => parseBntx(data)) }
  if (isMsbt(data)) return { format: 'MSBT', notes: checkSimple(name, 'MSBT', () => parseMsbt(data)) }
  if (isByml(data)) return { format: 'BYML', notes: checkSimple(name, 'BYML', () => parseByml(data)) }

  return {
    format: 'unknown',
    notes: [
      note(
        'info',
        `${name} is not a format BFLayout reads, so it is shipped as-is and nothing here can vouch for it`
      )
    ]
  }
}

function checkSimple(name: string, format: string, parse: () => unknown): CheckNote[] {
  try {
    parse()
    return []
  } catch (cause) {
    return [
      note(
        'error',
        `${name} claims to be ${format} but cannot be read: ${describe(cause)}. The game is likely to reject it too.`
      )
    ]
  }
}

/**
 * A layout is parsed, then re-encoded from its model and parsed again.
 *
 * The first pass is the one that matters — a layout the parser cannot read is
 * one the game probably cannot either. The round trip is a weaker signal about
 * this build rather than about the file: if a layout parses but will not
 * re-encode, editing it further is lossy, and it is much better to know that
 * before building on top of it than at the save that drops a section.
 */
function checkLayout(name: string, data: Uint8Array): CheckNote[] {
  let parsed
  try {
    parsed = parseBflyt(data)
  } catch (cause) {
    return [note('error', `${name} is not a readable BFLYT: ${describe(cause)}`)]
  }

  const notes: CheckNote[] = []
  try {
    const rewritten = writeBflyt(parsed.document, new Map())
    parseBflyt(rewritten)
  } catch (cause) {
    notes.push(
      note(
        'warning',
        `${name} reads but does not survive a re-encode (${describe(cause)}). It will deploy as it is, but editing it further may lose a section.`
      )
    )
  }

  if (parsed.document.rootPane === null) {
    notes.push(note('warning', `${name} has no root pane, so it draws nothing`))
  }
  notes.push(...checkPaneReferences(name, parsed.document))
  return notes
}

/**
 * User data that names a pane the layout does not have.
 *
 * This is what a stale copy looks like from the outside. `AdjustToTextOn` makes a
 * pane resize itself every frame to fit the text panes it names, so duplicating
 * one and renaming its text pane — or copying it into a layout that never had the
 * target — leaves a pane driving itself from something that is not there. It
 * parses, it deploys, and it goes wrong at runtime with nothing to point at.
 *
 * Checked against a whole shipped romfs: 66,344 files, 268 references, zero
 * warnings. Getting there took two corrections, both encoded in `localSegment` —
 * a reference may be a path into a part pane, whose far half lives in another
 * file, and it may be rooted at the layout that embeds this one.
 */
function checkPaneReferences(name: string, document: LayoutDocument): CheckNote[] {
  const present = new Set<string>()
  walkPanes(document.rootPane, (pane) => void present.add(pane.name))

  const notes: CheckNote[] = []
  walkPanes(document.rootPane, (pane) => {
    for (const entry of pane.userData?.entries ?? []) {
      for (const reference of referencedPanes(entry)) {
        const local = localSegment(reference)
        // Rooted references belong to whichever layout embeds this one.
        if (local === null || present.has(local)) continue
        notes.push(
          note(
            'warning',
            `${name}: ${pane.name} has ${entry.name} naming ${reference}, which is not a pane in this layout. That is what a copied pane looks like when its target was left behind — the runtime wires these by name, so this one drives itself from nothing.`
          )
        )
      }
    }
  })
  return notes
}

function checkAnimation(name: string, data: Uint8Array): CheckNote[] {
  let parsed
  try {
    parsed = parseBflan(data)
  } catch (cause) {
    return [note('error', `${name} is not a readable BFLAN: ${describe(cause)}`)]
  }

  try {
    // No original bytes passed on purpose: handing them over would return a copy
    // of the input and the round trip would prove nothing.
    parseBflan(writeBflan(parsed.document))
  } catch (cause) {
    return [
      note(
        'warning',
        `${name} reads but does not survive a re-encode (${describe(cause)}); editing it further may lose a section`
      )
    ]
  }
  return []
}

/**
 * An archive is checked as a container *and* as a set of files.
 *
 * The container check is the one with teeth: a SARC needs every entry's name to
 * be written back, so a single unnamed entry makes the whole archive unwritable —
 * and that is not visible until someone tries to save it, by which point they
 * have done the work.
 */
function checkArchive(name: string, data: Uint8Array): FileCheck {
  let archive: SarcArchive
  try {
    archive = parseSarc(data)
  } catch (cause) {
    return { format: 'SARC', notes: [note('error', `${name} is not a readable SARC: ${describe(cause)}`)] }
  }

  const notes: CheckNote[] = []
  const unnamed = archive.entries.filter((entry) => entry.name === null).length
  if (unnamed > 0) {
    notes.push(
      note(
        'warning',
        `${name} has ${unnamed} of ${archive.entries.length} entries with no stored name, so BFLayout cannot write it back at all. The game reads it fine; you just cannot edit anything inside it until the names are recovered.`
      )
    )
  }

  /*
   * The texture *names inside* each container, not the container filenames.
   *
   * These games ship one `timg/__Combined.bntx` holding dozens of named textures,
   * and a layout names those, never the container. Comparing against entry names
   * meant every layout in such an archive was reported as missing every texture it
   * used — a warning that was wrong every time it fired, which is worse than none:
   * it trains you to ignore the one occasion it is right.
   */
  /*
   * Where the GPU resources landed.
   *
   * A shader or texture container off a page boundary does not fail to load — it
   * crashes inside the reader, as a null dereference with nothing pointing back at
   * how the archive was packed. It is the least discoverable failure in this
   * format and the cheapest to check.
   */
  for (const entry of archive.entries) {
    if (entry.name === null || !needsPageAlignment(entry.name)) continue
    const absolute = archive.originalDataOffset + entry.originalOffset
    if (absolute % GPU_ALIGNMENT === 0) continue

    notes.push(
      note(
        'error',
        `${name}:${entry.name} starts at 0x${absolute.toString(16)}, which is not a 0x${GPU_ALIGNMENT.toString(16)} boundary. The driver maps shaders and texture containers rather than reading them, so this crashes inside the reader with nothing to connect it to the packing. Rebuild the archive with BFLayout, which aligns these by kind.`
      )
    )
  }

  /*
   * Which container the textures are in, because the engine only reads one.
   *
   * nn::ui2d resolves a layout's textures through the single hardcoded path
   * `timg/__Combined.bntx` -- ArcResourceAccessor::FindResourceByName is an
   * exact-path lookup across ATTACHED ARCHIVES and never enumerates the entries
   * inside one. A container under any other name is simply never opened.
   *
   * So the two sets are not interchangeable and must not be merged: a texture
   * that exists only in a stray container is, at runtime, a texture that does
   * not exist.
   */
  const canonical = new Set<string>()
  const stray = new Set<string>()
  const strayContainers: string[] = []

  for (const entry of archive.entries) {
    if (entry.name === null || !isBntx(entry.data)) continue
    const target =
      entry.name.toLowerCase() === CANONICAL_TEXTURE_CONTAINER_KEY ? canonical : stray
    if (target === stray) strayContainers.push(entry.name)
    try {
      for (const texture of parseBntx(entry.data).textures) {
        target.add(textureKey(texture.name))
      }
    } catch {
      // An unreadable container is reported separately; here it simply cannot
      // vouch for anything, so its textures stay unknown.
    }
  }

  /*
   * Flagged even when nothing references it yet, because the cost is asymmetric:
   * an unused stray container wastes space, while a referenced one is a boot
   * crash inside the texture reader with nothing pointing back at the packing.
   */
  if (strayContainers.length > 0) {
    notes.push(
      note(
        'error',
        `${name} holds ${strayContainers.length} texture container${strayContainers.length === 1 ? '' : 's'} the game will never open (${strayContainers.join(', ')}). nn::ui2d resolves textures through the single hardcoded path \`${CANONICAL_TEXTURE_CONTAINER}\` and does not search other entries, so anything only in there is unreachable at runtime. Merge those textures into \`${CANONICAL_TEXTURE_CONTAINER}\` or drop the panes that use them.`
      )
    )
  }

  for (const entry of archive.entries) {
    const label = `${name}:${entry.name ?? 'unnamed entry'}`
    const inner = checkBytes(label, entry.data)
    // An unrecognised *entry* inside an archive is normal — a romfs archive holds
    // shaders, models and formats nothing here models. Reporting each one would
    // bury the findings that matter.
    notes.push(...inner.notes.filter((found) => found.level !== 'info'))

    if (entry.name !== null && isBflyt(entry.data)) {
      notes.push(...checkTextureRefs(label, entry.data, canonical, stray))
    }
  }

  return { format: 'SARC', notes }
}

/**
 * Every texture a layout names, against the containers its own archive holds.
 *
 * A miss is a warning rather than an error because it is routinely fine: layouts
 * reference shared texture archives that live elsewhere in the romfs, and this
 * check cannot see them. It is still worth saying — a texture that resolved
 * before an edit and does not after is exactly the mistake that shows up in-game
 * as an untextured pane and nowhere else.
 */
function checkTextureRefs(
  label: string,
  data: Uint8Array,
  canonical: ReadonlySet<string>,
  stray: ReadonlySet<string>
): CheckNote[] {
  let document
  try {
    document = parseBflyt(data).document
  } catch {
    // Already reported by the layout check; nothing to add.
    return []
  }

  const notes: CheckNote[] = []
  const absent = document.textures.filter((texture) => !canonical.has(textureKey(texture)))

  /*
   * Present in the archive, unreachable at runtime — the worst of the three states, and the
   * only one that is definitely a bug rather than possibly fine.
   *
   * This is what a cross-archive pane copy produces when the textures it carried landed in a
   * second container: the file looks complete, previews correctly, and kills the game inside
   * nn::ui2d::ResourceTextureInfo the moment the layout is built.
   */
  const unreachable = absent.filter((texture) => stray.has(textureKey(texture)))
  if (unreachable.length > 0) {
    notes.push(
      note(
        'error',
        `${label} uses ${unreachable.length} texture${unreachable.length === 1 ? '' : 's'} that ${unreachable.length === 1 ? 'is' : 'are'} in this archive but not in \`${CANONICAL_TEXTURE_CONTAINER}\` (${unreachable.join(', ')}). The engine opens only that container, so ${unreachable.length === 1 ? 'it stays' : 'they stay'} unresolved and the game faults in the texture reader while building the layout.`
      )
    )
  }

  const missing = absent.filter((texture) => !stray.has(textureKey(texture)))
  if (missing.length > 0) {
    notes.push(
      note(
        'warning',
        `${label} references ${missing.length} texture${missing.length === 1 ? '' : 's'} not in this archive (${missing.join(', ')}). That is normal if they live in a shared texture archive — worth checking if you did not expect it.`
      )
    )
  }

  return notes
}
