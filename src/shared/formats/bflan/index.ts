/**
 * BFLAN animation: parsing, curve evaluation and the override layer the renderer
 * consults during playback.
 */
export * from './types'
export { createAnimation, isBflan, parseBflan, writeBflan } from './codec'
export { evaluate, evaluateComponent, hermite, lastKeyedFrame } from './curve'
export type { AnimationOverrides, MaterialOverride, PaneOverride } from './overrides'
export { buildOverrides, normalizeFrame } from './overrides'
