import { evaluateComponent } from './curve'
import type { AnimationDocument } from './types'

/**
 * Turns an animation at a given frame into a set of per-pane and per-material
 * overrides.
 *
 * Playback **never mutates the layout document**. A frame produces a lookup that
 * the renderer consults as `override ?? static`, so scrubbing is free, stopping
 * playback restores the authored values exactly, and an animation can never
 * corrupt what gets saved. Switch Toolbox takes the same approach for the same
 * reason.
 *
 * Fields are stored sparsely — only what the animation actually keys — because a
 * typical animation touches a handful of properties on a handful of panes, and a
 * dense copy per frame would allocate far more than it needs to.
 */

export interface PaneOverride {
  translate?: [number | undefined, number | undefined, number | undefined]
  rotate?: [number | undefined, number | undefined, number | undefined]
  scale?: [number | undefined, number | undefined]
  width?: number
  height?: number
  visible?: boolean
  alpha?: number
  /** Vertex colours by corner, each channel optional. Order: TL, TR, BL, BR. */
  vertexColors?: (number | undefined)[][]
}

export interface MaterialOverride {
  /** Texture SRT: translate S/T, rotate, scale S/T. */
  textureTranslate?: [number | undefined, number | undefined]
  textureRotate?: number
  textureScale?: [number | undefined, number | undefined]
  blackColor?: (number | undefined)[]
  whiteColor?: (number | undefined)[]
  /** Texture-pattern animation: which entry of the animation's texture list. */
  texturePattern?: Map<number, number>
}

export interface AnimationOverrides {
  readonly frame: number
  readonly panes: Map<string, PaneOverride>
  readonly materials: Map<string, MaterialOverride>
  /** The animation's own texture-name table, for resolving FLTP results. */
  readonly textures: readonly string[]
}

const EMPTY: AnimationOverrides = {
  frame: 0,
  panes: new Map(),
  materials: new Map(),
  textures: []
}

/** Wraps a frame into the animation's range, honouring the loop flag. */
export function normalizeFrame(
  document: AnimationDocument,
  frame: number,
  looping?: boolean
): number {
  const size = document.info?.frameSize ?? 0
  if (size <= 0) return 0
  const loop = looping ?? document.info?.loop ?? false
  if (!loop) return Math.max(0, Math.min(size, frame))
  // Modulo can return a negative for a negative frame, hence the second add.
  return ((frame % size) + size) % size
}

function paneOf(overrides: Map<string, PaneOverride>, name: string): PaneOverride {
  const existing = overrides.get(name)
  if (existing) return existing
  const created: PaneOverride = {}
  overrides.set(name, created)
  return created
}

function materialOf(
  overrides: Map<string, MaterialOverride>,
  name: string
): MaterialOverride {
  const existing = overrides.get(name)
  if (existing) return existing
  const created: MaterialOverride = {}
  overrides.set(name, created)
  return created
}

export function buildOverrides(
  document: AnimationDocument | null,
  frame: number
): AnimationOverrides {
  if (!document?.info) return EMPTY

  const panes = new Map<string, PaneOverride>()
  const materials = new Map<string, MaterialOverride>()

  for (const entry of document.info.entries) {
    for (const tag of entry.tags) {
      for (const component of tag.components) {
        const value = evaluateComponent(component, frame)

        switch (tag.signature) {
          case 'FLPA':
            applyTransform(paneOf(panes, entry.name), component.target, value)
            break

          case 'FLVI': {
            // Visibility is keyed as 0 or 1 and must not be interpolated into a
            // fraction, so anything above zero counts as visible.
            const pane = paneOf(panes, entry.name)
            pane.visible = value > 0
            break
          }

          case 'FLVC':
            applyVertexColor(paneOf(panes, entry.name), component.target, value)
            break

          case 'FLTS':
            applyTextureSrt(materialOf(materials, entry.name), component.target, value)
            break

          case 'FLMC':
            applyMaterialColor(materialOf(materials, entry.name), component.target, value)
            break

          case 'FLTP': {
            const material = materialOf(materials, entry.name)
            const pattern = material.texturePattern ?? new Map<number, number>()
            // The keyed value is an index into the animation's texture table.
            pattern.set(component.target, Math.round(value))
            material.texturePattern = pattern
            break
          }

          default:
            // An unmodelled tag is skipped rather than guessed at; the document
            // still round-trips because writing replays the original bytes.
            break
        }
      }
    }
  }

  return { frame, panes, materials, textures: document.info.textures }
}

function applyTransform(pane: PaneOverride, target: number, value: number): void {
  switch (target) {
    case 0:
    case 1:
    case 2: {
      const translate = pane.translate ?? [undefined, undefined, undefined]
      translate[target] = value
      pane.translate = translate
      break
    }
    case 3:
    case 4:
    case 5: {
      const rotate = pane.rotate ?? [undefined, undefined, undefined]
      rotate[target - 3] = value
      pane.rotate = rotate
      break
    }
    case 6:
    case 7: {
      const scale = pane.scale ?? [undefined, undefined]
      scale[target - 6] = value
      pane.scale = scale
      break
    }
    case 8:
      pane.width = value
      break
    case 9:
      pane.height = value
      break
    default:
      break
  }
}

/** Targets 0-15 are four corners of four channels; 16 is the pane's own alpha. */
function applyVertexColor(pane: PaneOverride, target: number, value: number): void {
  if (target === 16) {
    pane.alpha = value
    return
  }
  if (target < 0 || target > 15) return

  const colors = pane.vertexColors ?? [[], [], [], []]
  const corner = target >> 2
  const channel = target & 0x3
  const existing = colors[corner] ?? []
  existing[channel] = value
  colors[corner] = existing
  pane.vertexColors = colors
}

function applyTextureSrt(material: MaterialOverride, target: number, value: number): void {
  switch (target) {
    case 0:
    case 1: {
      const translate = material.textureTranslate ?? [undefined, undefined]
      translate[target] = value
      material.textureTranslate = translate
      break
    }
    case 2:
      material.textureRotate = value
      break
    case 3:
    case 4: {
      const scale = material.textureScale ?? [undefined, undefined]
      scale[target - 3] = value
      material.textureScale = scale
      break
    }
    default:
      break
  }
}

/** Targets 0-3 are the black colour, 4-7 the white colour. */
function applyMaterialColor(material: MaterialOverride, target: number, value: number): void {
  if (target <= 3) {
    const black = material.blackColor ?? []
    black[target] = value
    material.blackColor = black
    return
  }
  if (target <= 7) {
    const white = material.whiteColor ?? []
    white[target - 4] = value
    material.whiteColor = white
  }
  // Higher targets are TEV registers, which this preview does not implement.
}
