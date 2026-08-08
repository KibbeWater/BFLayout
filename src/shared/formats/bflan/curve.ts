import type { AnimationComponent, Keyframe } from './types'

/**
 * Keyframe curve evaluation.
 *
 * Three curve kinds appear in layout animations:
 *
 *   constant  one value for the whole animation; keyframes past the first are
 *             ignored
 *   step      hold the last key's value until the next key, no interpolation
 *   hermite   cubic Hermite between neighbouring keys, using each key's stored
 *             tangent
 *
 * Outside the keyed range the first and last values are held rather than
 * extrapolated, which is what the runtime does — extrapolating a Hermite tangent
 * past the end would send a pane flying off screen.
 */

/**
 * Cubic Hermite on a unit interval.
 *
 * `m0` and `m1` are tangents expressed per unit of `t`, so a caller with keys
 * `duration` frames apart must scale the stored per-frame slopes by `duration`.
 */
export function hermite(p0: number, m0: number, p1: number, m1: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + t) * m0 +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * m1
  )
}

/** Index of the last keyframe at or before `frame`, or -1 before the first. */
function lastKeyAtOrBefore(keyframes: readonly Keyframe[], frame: number): number {
  let low = 0
  let high = keyframes.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (keyframes[middle]!.frame <= frame) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * Value of a curve at `frame`.
 *
 * Keyframes are assumed sorted by frame, which is how they are stored. Returns
 * `fallback` for an empty curve so callers can pass the document's static value
 * and get "unanimated" behaviour for free.
 */
export function evaluate(
  keyframes: readonly Keyframe[],
  curve: 'constant' | 'step' | 'hermite',
  frame: number,
  fallback = 0
): number {
  if (keyframes.length === 0) return fallback
  const first = keyframes[0]!
  if (curve === 'constant' || keyframes.length === 1) return first.value

  const at = lastKeyAtOrBefore(keyframes, frame)
  if (at < 0) return first.value
  if (at >= keyframes.length - 1) return keyframes[keyframes.length - 1]!.value

  const start = keyframes[at]!
  const end = keyframes[at + 1]!
  if (curve === 'step') return start.value

  const duration = end.frame - start.frame
  // Coincident keys would divide by zero; the later value wins, matching a step.
  if (duration <= 0) return end.value

  const t = (frame - start.frame) / duration
  // Slopes are stored per frame, so they scale into the unit interval.
  return hermite(start.value, start.slope * duration, end.value, end.slope * duration, t)
}

export function evaluateComponent(
  component: AnimationComponent,
  frame: number,
  fallback = 0
): number {
  return evaluate(component.keyframes, component.curve, frame, fallback)
}

/** Last keyed frame across every component, used to sanity-check frameSize. */
export function lastKeyedFrame(components: readonly AnimationComponent[]): number {
  let last = 0
  for (const component of components) {
    const key = component.keyframes[component.keyframes.length - 1]
    if (key && key.frame > last) last = key.frame
  }
  return last
}
