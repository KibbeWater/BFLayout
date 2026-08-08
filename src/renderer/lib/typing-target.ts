/**
 * Whether the user is typing into something right now.
 *
 * Shared by the canvas key handler and the native menu commands, because both can reach
 * undo and they have to agree. The canvas has always guarded this — arrow keys would
 * otherwise become pane nudges and Backspace a deletion while someone edits a name — but
 * the menu forwards `Cmd+Z` as a command with no target at all, so undo went to the
 * *document* while the caret sat in a text field. Typing a name and pressing Cmd+Z reverted
 * the last canvas edit instead of the typing, which is the kind of thing that costs someone
 * an edit they believed they had made.
 *
 * `isContentEditable` matters as much as the tag list: a contenteditable is not an `INPUT`
 * and would otherwise be treated as canvas focus.
 */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return TYPING_TAGS.has(target.tagName) || target.isContentEditable
}

/**
 * The same question for a command with no event behind it.
 *
 * A native menu accelerator arrives over IPC, so there is no target to inspect — the focused
 * element is the only thing that says where the command should go.
 */
export function isTypingFocused(): boolean {
  return isTypingTarget(document.activeElement)
}
