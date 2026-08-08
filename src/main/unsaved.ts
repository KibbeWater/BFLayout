/**
 * How many open tabs hold unsaved edits.
 *
 * The renderer owns the documents, so only it knows this; it pushes the count
 * through `app.setUnsavedCount` whenever the number changes. Main needs the answer
 * to guard window close and application quit, and it needs it *synchronously* —
 * `BrowserWindow.on('close')` decides whether to prevent the close during the
 * event, and cannot await a round trip to the renderer.
 *
 * Kept as a module-level value rather than an Effect service because it is
 * process-wide, has no dependencies, and is read from Electron event handlers that
 * sit outside the runtime.
 */
let unsavedCount = 0

export function setUnsavedCount(count: number): void {
  unsavedCount = Math.max(0, Math.trunc(count))
}

export function getUnsavedCount(): number {
  return unsavedCount
}

export function hasUnsavedWork(): boolean {
  return unsavedCount > 0
}
