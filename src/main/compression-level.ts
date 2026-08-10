/**
 * The ZSTD level this app compresses at.
 *
 * Module-level, like the read-only layer and the excluded names, and for the same
 * reason: `CompressionService` is a leaf that everything writing an archive goes
 * through, and threading a project into it would either invert the dependency
 * graph or mean passing a level through every caller. `ProjectService` publishes
 * it whenever the active project changes.
 *
 * 17 is what these files ship at, and what the app used before this was
 * configurable.
 */
const DEFAULT_LEVEL = 17

let level = DEFAULT_LEVEL

export function setZstdLevel(value: number): void {
  // Clamped rather than trusted: the setting is validated on the way in, but a
  // level outside what the encoder accepts would fail at the point of writing
  // someone's mod, which is the worst possible moment to find out.
  level = Number.isFinite(value) ? Math.max(1, Math.min(22, Math.trunc(value))) : DEFAULT_LEVEL
}

export function zstdLevel(): number {
  return level
}
