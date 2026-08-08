import { useCallback, useEffect, useRef, type ReactNode } from 'react'

/**
 * A draggable divider between panels.
 *
 * Pointer capture is taken on the divider itself, so a fast drag that outruns the
 * element keeps resizing instead of stopping dead. The size is reported live during
 * the drag and committed once on release — the committed value is persisted, and
 * writing to sqlite on every pointer move would be absurd.
 */
export function Splitter({
  orientation,
  size,
  min,
  max,
  onPreview,
  onCommit,
  label
}: {
  orientation: 'vertical' | 'horizontal'
  /** Current size of the panel being resized, in CSS pixels. */
  size: number
  min: number
  max: number
  onPreview: (size: number) => void
  onCommit: (size: number) => void
  /** Which edge this divider moves, so the drag direction can be inverted. */
  label: 'left' | 'right' | 'top'
}): ReactNode {
  const start = useRef<{ pointer: number; size: number } | null>(null)
  const latest = useRef(size)

  useEffect(() => {
    latest.current = size
  }, [size])

  const clamp = useCallback(
    (value: number) => Math.max(min, Math.min(max, Math.round(value))),
    [min, max]
  )

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    start.current = {
      pointer: orientation === 'vertical' ? event.clientX : event.clientY,
      size
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = start.current
    if (!from) return
    const now = orientation === 'vertical' ? event.clientX : event.clientY
    // A right-hand or bottom panel grows as the pointer moves the other way.
    const sign = label === 'left' ? 1 : -1
    const next = clamp(from.size + (now - from.pointer) * sign)
    latest.current = next
    onPreview(next)
  }

  const end = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!start.current) return
    start.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onCommit(latest.current)
  }

  const vertical = orientation === 'vertical'

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onCommit(clamp(defaultFor(label)))}
      title="Drag to resize; double-click to reset"
      className={`group relative shrink-0 ${
        vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
      } bg-border`}
    >
      {/* A one-pixel divider is impossible to grab, so the hit area is wider than
          the line and sits on top of both neighbours. */}
      <span
        className={`absolute ${
          vertical ? '-left-1 -right-1 inset-y-0' : '-top-1 -bottom-1 inset-x-0'
        } group-hover:bg-primary/30`}
      />
    </div>
  )
}

function defaultFor(label: 'left' | 'right' | 'top'): number {
  switch (label) {
    case 'left':
      return 288
    case 'right':
      return 320
    default:
      return 220
  }
}
