import type { LayoutVersion } from '../bflyt/types'

/**
 * BFLAN — the animation file that drives a BFLYT.
 *
 * Structure mirrors BFLYT: a header then size-prefixed sections. There are only
 * two that matter.
 *
 *   pat1  which animation this is: its name, frame range, and the pane groups it
 *         binds to
 *   pai1  the animation data: a frame count, a loop flag, a texture-name table
 *         for pattern animations, and one entry per animated pane or material
 *
 * Each pai1 entry holds *tags*, four-character codes naming what is animated:
 *
 *   FLPA  pane transform (translate, rotate, scale, size)
 *   FLVI  visibility
 *   FLTS  texture SRT on a material
 *   FLVC  vertex colours, plus pane alpha
 *   FLMC  material colours (black, white, TEV registers)
 *   FLTP  texture pattern — swaps which texture a material samples
 *
 * A tag holds one entry per animated component, identified by a target byte. So
 * "pane Foo's X translation" is entry(Foo) -> tag(FLPA) -> component(target 0),
 * and that component owns the keyframes.
 */

export type CurveKind = 'constant' | 'step' | 'hermite'

export interface Keyframe {
  frame: number
  value: number
  /** Hermite tangent at this key; zero for step and constant curves. */
  slope: number
}

/** Which target byte an animated component refers to, per tag. */
export type AnimationTargetKind = 'pane' | 'material'

export interface AnimationComponent {
  /**
   * Sub-index within the target. For most tags this is 0; FLTP uses it to pick
   * a texture map, FLMC to pick a colour register.
   */
  index: number
  /** Target byte — meaning depends on the tag; see targetName(). */
  target: number
  curve: CurveKind
  keyframes: Keyframe[]
}

export interface AnimationTag {
  /** Four-character code: FLPA, FLVI, FLTS, FLVC, FLMC, FLTP, ... */
  signature: string
  /**
   * A material-target entry carries an extra word before the tag that is not
   * covered by the offset table. Preserved rather than dropped.
   */
  leading: number | null
  components: AnimationComponent[]
}

export interface AnimationEntry {
  /** Pane or material name, up to 28 bytes in the file. */
  name: string
  target: AnimationTargetKind
  tags: AnimationTag[]
}

export interface AnimationInfo {
  /** Length in frames. Playback runs 0..frameSize. */
  frameSize: number
  loop: boolean
  /** Texture names referenced by FLTP pattern animations. */
  textures: string[]
  entries: AnimationEntry[]
}

export interface AnimationTagInfo {
  name: string
  order: number
  startFrame: number
  endFrame: number
  childBinding: boolean
  /** Pane groups this animation binds to. */
  groups: string[]
  /**
   * Bytes between the fixed fields and the name, whose layout varies by version
   * and is not modelled. Round-tripped verbatim.
   */
  trailing: number[]
  /**
   * A `usd1` user-data block nested inside the pat1 section, kept verbatim.
   *
   * Version 8 added a u32 after the groups offset which points at it; this build
   * treated that field as padding and wrote zero, dropping the block. Eight shipped
   * animations came back 52 to 76 bytes short as a result — exactly the size of
   * their nested usd1.
   *
   * `number[]` rather than `Uint8Array` because the animation document crosses the
   * RPC boundary and oRPC's serialiser has no case for typed arrays; it would
   * expand one into an object of numeric keys.
   */
  userData: number[]
}

export interface AnimationDocument {
  version: LayoutVersion
  littleEndian: boolean
  tag: AnimationTagInfo | null
  info: AnimationInfo | null
  /** Sections this build does not model, kept so a save cannot lose them. */
  /**
   * Sections this build does not model, kept verbatim.
   *
   * `data` is the section body, i.e. everything after the eight-byte signature and
   * size header, so re-emitting it through the same section writer reproduces the
   * original bytes exactly. Recording only the signature and position — which is
   * what this used to do — silently dropped the section on save.
   *
   * `number[]` rather than `Uint8Array`: this document crosses the RPC boundary and
   * oRPC's serialiser has no case for typed arrays.
   */
  unknownSections: { signature: string; index: number; data: number[] }[]
}

export interface ParsedAnimation {
  document: AnimationDocument
  /** Original bytes, so an untouched file rewrites byte for byte. */
  original: Uint8Array
}

const LPA_TARGETS = [
  'Translate X',
  'Translate Y',
  'Translate Z',
  'Rotate X',
  'Rotate Y',
  'Rotate Z',
  'Scale X',
  'Scale Y',
  'Size X',
  'Size Y'
]

const LTS_TARGETS = ['Translate S', 'Translate T', 'Rotate', 'Scale S', 'Scale T']

const CHANNELS = ['Red', 'Green', 'Blue', 'Alpha']
const CORNERS = ['Left top', 'Right top', 'Left bottom', 'Right bottom']

const LVC_TARGETS = [
  ...CORNERS.flatMap((corner) => CHANNELS.map((channel) => `${corner} ${channel.toLowerCase()}`)),
  'Pane alpha'
]

const LMC_TARGETS = [
  ...CHANNELS.map((channel) => `Black ${channel.toLowerCase()}`),
  ...CHANNELS.map((channel) => `White ${channel.toLowerCase()}`),
  'Texture blend ratio'
]

/** Human-readable name for a tag's target byte, for the timeline's track rows. */
export function targetName(signature: string, target: number): string {
  switch (signature) {
    case 'FLPA':
      return LPA_TARGETS[target] ?? `Target ${target}`
    case 'FLTS':
      return LTS_TARGETS[target] ?? `Target ${target}`
    case 'FLVI':
      return target === 0 ? 'Visibility' : `Target ${target}`
    case 'FLVC':
      return LVC_TARGETS[target] ?? `Target ${target}`
    case 'FLMC':
      return LMC_TARGETS[target] ?? `Colour ${target}`
    case 'FLTP':
      return `Texture map ${target + 1}`
    default:
      return `Target ${target}`
  }
}

/** Short description of what a tag animates, for the timeline's group headers. */
export function tagName(signature: string): string {
  switch (signature) {
    case 'FLPA':
      return 'Transform'
    case 'FLVI':
      return 'Visibility'
    case 'FLTS':
      return 'Texture SRT'
    case 'FLVC':
      return 'Vertex colour'
    case 'FLMC':
      return 'Material colour'
    case 'FLTP':
      return 'Texture pattern'
    default:
      return signature
  }
}
