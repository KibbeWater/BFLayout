/**
 * BFLYT document model.
 *
 * Two design rules run through this file:
 *
 * 1. Nothing here holds raw bytes. Original section bytes live in a side table
 *    (PreservedSources) keyed by node id, so a document can cross the IPC
 *    boundary cheaply and the renderer never carries buffers it cannot use.
 *
 * 2. Structures the editor does not model field-by-field are kept as opaque
 *    byte arrays rather than dropped. That is what makes saving a file we only
 *    partly understand non-destructive.
 */

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
/** Red, green, blue, alpha, each 0-255. */
export type Rgba = [number, number, number, number]

export interface LayoutVersion {
  major: number
  minor: number
  micro: number
  micro2: number
}

export type LayoutPlatform = 'switch' | 'wiiu' | 'ctr'

// ---------------------------------------------------------------- materials

export interface TextureRef {
  /** Index into the layout's texture list; -1 when unbound. */
  textureIndex: number
  /** Bits 0-1 wrap U, bits 2-3 min filter. */
  flag1: number
  /** Bits 0-1 wrap V, bits 2-3 max filter. */
  flag2: number
}

export interface TextureTransform {
  translate: Vec2
  rotate: number
  scale: Vec2
}

export interface TexCoordGen {
  matrix: number
  source: number
  /** 6 bytes, or 14 from version 8. Not interpreted. */
  unknown: number[]
}

export interface TevStage {
  colorFlags: number
  alphaFlags: number
  /** The two bytes after the flags; nominally padding, not always zero. */
  padding: [number, number]
}

export interface AlphaCompare {
  compareMode: number
  /**
   * The three bytes after the mode.
   *
   * Nominally padding, but shipped materials put 0xff in them, so writing zeros
   * changed bytes that were never ours to change.
   */
  padding: [number, number, number]
  value: number
}

export interface BlendMode {
  blendOp: number
  sourceFactor: number
  destFactor: number
  logicOp: number
}

export interface IndirectParameter {
  rotation: number
  scaleX: number
  scaleY: number
}

export interface ProjectionTexGenParam {
  posX: number
  posY: number
  scaleX: number
  scaleY: number
  flags: number
  /**
   * The three bytes after the flags. Shipped materials fill them with 0xff, so
   * writing zeros here changed bytes this editor does not own.
   */
  padding: [number, number, number]
}

export interface FontShadowParameter {
  blackColor: Rgba
  whiteColor: Rgba
}

export interface Material {
  name: string
  blackColor: Rgba
  whiteColor: Rgba
  /** Present from version 8; meaning unknown, round-tripped as-is. */
  unknown: number
  textureMaps: TextureRef[]
  textureTransforms: TextureTransform[]
  texCoordGens: TexCoordGen[]
  tevStages: TevStage[]
  alphaCompare: AlphaCompare | null
  blendMode: BlendMode | null
  blendModeLogic: BlendMode | null
  indirectParameter: IndirectParameter | null
  projectionTexGenParams: ProjectionTexGenParam[]
  fontShadowParameter: FontShadowParameter | null
  useTextureOnly: boolean
  alphaInterpolation: boolean
  /**
   * The flags word as read. Replayed verbatim while the material is clean;
   * rebuilt from the arrays above once it is edited. Switch-Toolbox always
   * rebuilds, which is why its saves differ byte-wise from the originals.
   */
  originalFlags: number
  /**
   * Bytes after the blocks this build models, replayed verbatim on write.
   *
   * Version 9 materials set flag bits past the ones documented for version 8 —
   * bit 19 in every shipped material here — and carry a further 44 bytes whose
   * layout is not published anywhere. Those bytes are per-material settings this
   * editor does not expose, so they are independent of the fields it does model and
   * safe to replay even after an edit.
   */
  trailing: number[]
  dirty: boolean
}

// ---------------------------------------------------------------- user data

export type UserDataValueKind = 'string' | 'int' | 'float' | 'struct'

export interface UserDataEntry {
  name: string
  kind: UserDataValueKind
  /** Decoded for string/int/float; struct keeps its bytes. */
  stringValue: string | null
  numberValues: number[]
  structValue: number[] | null
  /**
   * The count field as stored, which is *not* a byte length.
   *
   * For string/int/float it counts items and can be derived from the value. For a
   * struct real files store 1 regardless of how many bytes follow, so the raw
   * value is kept and written back verbatim — deriving it from `structValue.length`
   * produced a different byte in every shipped file.
   */
  itemCount: number
  unknown: number
}

export interface UserData {
  entries: UserDataEntry[]
  /**
   * The section payload as read, replayed verbatim while `dirty` is false.
   *
   * Shipped files interleave the name and value blocks in an order this writer
   * does not reproduce — numeric values are packed first, then each entry's string
   * value and name follow together — and the arrangement is only inferable from a
   * handful of examples. Replaying the bytes is exact; re-encoding is reserved for
   * user data that was actually edited, where a structurally valid layout is the
   * most that can be promised. Switch Toolbox keeps these bytes for the same
   * reason.
   */
  raw: number[]
  dirty: boolean
}

// ---------------------------------------------------------------- panes

export type PaneKind = 'pan1' | 'pic1' | 'txt1' | 'wnd1' | 'bnd1' | 'prt1' | 'scr1' | 'ali1'

/** Origin codes: 0 = left/top, 1 = center, 2 = right/bottom. */
export interface PaneOrigin {
  x: number
  y: number
  parentX: number
  parentY: number
}

export interface PaneBase {
  /** Editor-assigned, stable for the document's lifetime. Not stored in the file. */
  id: string
  name: string
  userDataInfo: string
  visible: boolean
  influenceAlpha: boolean
  /**
   * The raw flags byte as read, so bits this build does not model survive a save.
   *
   * Only bits 0 (visible) and 1 (influence alpha) are interpreted; real panes also
   * set bit 2, and rebuilding the byte from the two booleans quietly cleared it.
   */
  baseFlags: number
  alpha: number
  origin: PaneOrigin
  paneMagFlags: number
  translate: Vec3
  rotate: Vec3
  scale: Vec2
  width: number
  height: number
  userData: UserData | null
  children: Pane[]
  /**
   * Bytes after the fields this build models, replayed verbatim on write.
   *
   * Only populated for pane kinds whose body is read straight through — pan1,
   * bnd1, scr1 and ali1. Kinds that address their payload through offsets (txt1,
   * wnd1, prt1) cannot use this: there the unconsumed remainder *is* the payload,
   * and replaying it would emit everything twice.
   *
   * Real ali1 panes carry 12 bytes past the common header that no public
   * documentation covers, and keeping them is what makes those layouts round-trip.
   */
  trailing: number[]
  /** Set by any edit; a clean pane is written from its original bytes. */
  dirty: boolean
}

export interface NullPane extends PaneBase {
  kind: 'pan1'
}
export interface BoundaryPane extends PaneBase {
  kind: 'bnd1'
}
export interface ScissorPane extends PaneBase {
  kind: 'scr1'
}
export interface AlignmentPane extends PaneBase {
  kind: 'ali1'
}

/** Four UVs per texture map, in TL, TR, BL, BR order. */
export interface TexCoordSet {
  topLeft: Vec2
  topRight: Vec2
  bottomLeft: Vec2
  bottomRight: Vec2
}

export interface PicturePane extends PaneBase {
  kind: 'pic1'
  colorTopLeft: Rgba
  colorTopRight: Rgba
  colorBottomLeft: Rgba
  colorBottomRight: Rgba
  materialIndex: number
  texCoords: TexCoordSet[]
}

export interface TextPane extends PaneBase {
  kind: 'txt1'
  text: string
  /**
   * Bytes the game reserves for this pane's text at runtime.
   *
   * This is *not* how much the file stores. Layouts routinely reserve far more
   * than the authored string needs so a longer one can be swapped in — one shipped
   * pane declares 1002 bytes of capacity while storing a 12-byte string, and
   * reading the text at this length runs off the end of the section. Kept verbatim
   * and only grown when a longer string is typed in.
   */
  textCapacityBytes: number
  /**
   * Bytes the string actually occupies in the file, including its terminator.
   * Derived from `text` on write.
   */
  maxTextLength: number
  materialIndex: number
  fontIndex: number
  /** Bits 0-1 horizontal, bits 2-3 vertical. */
  textAlignment: number
  lineAlignment: number
  /** Bit 0 shadow enabled, bit 1 restricted length, bit 4 per-character transform. */
  flags: number
  unknown: number
  italicTilt: number
  fontTopColor: Rgba
  fontBottomColor: Rgba
  fontSize: Vec2
  charSpace: number
  lineSpace: number
  shadowPosition: Vec2
  shadowSize: Vec2
  shadowForeColor: Rgba
  shadowBackColor: Rgba
  shadowItalic: number
  /** Secondary name field stored alongside the text. */
  textBoxName: string
  /** Per-character transform block, kept opaque. */
  perCharTransform: number[] | null
  /** Trailing float present from version 8. */
  extra: number | null
  /**
   * Bytes after the text, name and per-character blocks, replayed verbatim.
   *
   * Version 9 text panes carry a further block — 32 bytes in the simplest shipped
   * case — that no public documentation describes. It sits past everything this
   * build addresses, so appending it back after the modelled regions reproduces the
   * section exactly.
   */
  trailingData: number[]
}

export interface WindowContent {
  colorTopLeft: Rgba
  colorTopRight: Rgba
  colorBottomLeft: Rgba
  colorBottomRight: Rgba
  materialIndex: number
  texCoords: TexCoordSet[]
}

export interface WindowFrame {
  materialIndex: number
  textureFlip: number
}

export interface WindowPane extends PaneBase {
  kind: 'wnd1'
  stretchLeft: number
  stretchRight: number
  stretchTop: number
  stretchBottom: number
  frameElemLeft: number
  frameElemRight: number
  frameElemTop: number
  frameElemBottom: number
  /** Bit 0 one material for all, bit 1 vertex colour for all, bits 2-3 kind. */
  flag: number
  content: WindowContent
  /** Legal counts are 1, 2, 4 and 8, mapping to nine-slice corners and edges. */
  frames: WindowFrame[]
}

export interface PartProperty {
  name: string
  usageFlag: number
  basicUsageFlag: number
  materialUsageFlag: number
  /**
   * A complete embedded pane section overriding the referenced part's own.
   * Kept as bytes: re-encoding it needs the external layout, and preserving it
   * exactly is what keeps part panes intact on save.
   */
  overrideSection: number[] | null
  /** 52-byte block, uninterpreted. */
  panelInfo: number[] | null
  userDataBytes: number[] | null
  /** Replaces the user-data offset from version 8. */
  unknown: number
}

export interface PartPane extends PaneBase {
  kind: 'prt1'
  magnify: Vec2
  properties: PartProperty[]
  /** Layout this part instantiates, resolved against blyt/ in the archive. */
  externalLayoutName: string
  /** Unmodelled bytes after the part's own blocks; see TextPane.trailingData. */
  trailingData: number[]
}

export type Pane =
  | NullPane
  | PicturePane
  | TextPane
  | WindowPane
  | BoundaryPane
  | PartPane
  | ScissorPane
  | AlignmentPane

// ---------------------------------------------------------------- groups

export interface GroupPane {
  id: string
  name: string
  paneNames: string[]
  children: GroupPane[]
  dirty: boolean
}

// ---------------------------------------------------------------- document

export interface LayoutInfo {
  drawFromCenter: boolean
  width: number
  height: number
  maxPartsWidth: number
  maxPartsHeight: number
  name: string
}

/** A section this build does not know; replayed byte-for-byte on save. */
export interface UnknownSection {
  signature: string
  /** Position in the original section stream, so ordering survives. */
  index: number
  /**
   * The section's payload, excluding the 8-byte signature and size header.
   *
   * Held in the document rather than only in the preserved-sources side table, so
   * a re-encode from the model alone is still lossless. These sections are small
   * (a few hundred bytes) and this matches how usd1 struct payloads and prt1
   * panelInfo are already carried.
   *
   * Switch Toolbox treats cnt1 the same way — its parser is commented out and the
   * bytes are replayed, so there is no better model available to copy.
   */
  data: number[]
}

export interface LayoutDocument {
  version: LayoutVersion
  littleEndian: boolean
  platform: LayoutPlatform
  info: LayoutInfo
  /** Texture file names; TextureRef.textureIndex indexes this. */
  textures: string[]
  fonts: string[]
  materials: Material[]
  rootPane: Pane | null
  rootGroup: GroupPane | null
  layoutUserData: UserData | null
  unknownSections: UnknownSection[]
}

/**
 * Original bytes for everything written back verbatim while clean.
 *
 * Keys: pane id for pane sections, `usd1:<paneId>` for a pane's user data,
 * `mat:<index>` for a material, `grp:<groupId>` for a group, `unknown:<index>`
 * for an unrecognised section, and `layoutUserData` for the root block.
 */
export type PreservedSources = Map<string, Uint8Array>

export interface ParsedLayout {
  document: LayoutDocument
  sources: PreservedSources
}

export const PANE_KINDS: readonly PaneKind[] = [
  'pan1',
  'pic1',
  'txt1',
  'wnd1',
  'bnd1',
  'prt1',
  'scr1',
  'ali1'
]

export function isPaneKind(signature: string): signature is PaneKind {
  return (PANE_KINDS as readonly string[]).includes(signature)
}

/** Depth-first walk over the pane tree, parents before children. */
export function walkPanes(root: Pane | null, visit: (pane: Pane, parent: Pane | null) => void): void {
  const step = (pane: Pane, parent: Pane | null): void => {
    visit(pane, parent)
    for (const child of pane.children) step(child, pane)
  }
  if (root) step(root, null)
}

export function findPane(root: Pane | null, predicate: (pane: Pane) => boolean): Pane | null {
  let found: Pane | null = null
  walkPanes(root, (pane) => {
    if (!found && predicate(pane)) found = pane
  })
  return found
}
