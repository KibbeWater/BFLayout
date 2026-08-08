import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Renders only the rows currently on screen.
 *
 * A romfs dump is not a gentle input: this game's `Tex/` holds 29,342 files and
 * `Icon/` another 11,425, and the folder browser rendered a DOM node for every one.
 * Opening either meant building tens of thousands of elements before anything
 * appeared, then paying for them again on every keystroke of the filter.
 *
 * Hand-rolled rather than pulling in a virtualiser, because the requirement here is
 * narrow: rows are a fixed height and there is one flat list. That makes the visible
 * slice pure arithmetic, and the whole thing small enough to read.
 *
 * The scroll container is this component's own element, so a caller must give it a
 * bounded height — inside a flex column that means `min-h-0`.
 */
export function WindowedList<T>({
  items,
  rowHeight,
  renderRow,
  keyOf,
  overscan = 8,
  className,
  header
}: {
  items: readonly T[]
  /** Must match the rendered row height, or the spacers drift out of step. */
  rowHeight: number
  renderRow: (item: T, index: number) => ReactNode
  keyOf: (item: T, index: number) => string
  /** Extra rows above and below, so a fast scroll does not show blank space. */
  overscan?: number
  className?: string
  /** Rendered above the rows and outside the scrolled area. */
  header?: ReactNode
}): ReactNode {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const ref = useRef<HTMLDivElement | null>(null)

  /**
   * Measured rather than assumed, and re-measured on resize: the panel is behind a
   * splitter, so its height changes while the list is open.
   */
  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node
    if (node) setViewport(node.clientHeight)
  }, [])

  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewport(node.clientHeight))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const total = items.length
  // A viewport of zero would render nothing at all before the first measurement, so
  // fall back to a screenful.
  const height = viewport > 0 ? viewport : 600
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visible = Math.ceil(height / rowHeight) + overscan * 2
  const last = Math.min(total, first + visible)

  return (
    <div
      ref={attach}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className={className}
    >
      {header}
      {/*
        Spacers stand in for the rows that are not rendered, so the scrollbar
        reflects the whole list rather than just the visible slice.
      */}
      <div style={{ height: first * rowHeight }} />
      {items.slice(first, last).map((item, offset) => (
        <div key={keyOf(item, first + offset)} style={{ height: rowHeight }}>
          {renderRow(item, first + offset)}
        </div>
      ))}
      <div style={{ height: Math.max(0, (total - last) * rowHeight) }} />
    </div>
  )
}
