import { describe, expect, it } from 'vitest'

import {
  createLayoutDocument,
  createPicturePane,
  createTextPane
} from '@shared/formats/bflyt/create'
import { renderLayout } from '@headless/render'
import { encodePng } from '@headless/png'

/**
 * The headless preview.
 *
 * Its whole value is that the positions are right — a diagram that puts a pane
 * somewhere it is not is worse than no diagram, because it will be believed. So
 * these check the geometry against the layout rather than checking that some
 * pixels came out.
 */

function sample(): ReturnType<typeof createLayoutDocument> {
  const document = createLayoutDocument({ name: 'Menu', width: 1280, height: 720 })

  const centred = createPicturePane('Centred', 0)
  centred.width = 400
  centred.height = 200
  centred.translate = [0, 0, 0]

  const offset = createTextPane('Offset', 0)
  offset.width = 100
  offset.height = 50
  offset.translate = [200, 100, 0]

  const hidden = createPicturePane('Hidden', 0)
  hidden.width = 50
  hidden.height = 50
  hidden.visible = false

  document.rootPane!.children.push(centred, offset, hidden)
  return document
}

const paneNamed = (
  result: ReturnType<typeof renderLayout>,
  name: string
): (typeof result.panes)[number] => {
  const found = result.panes.find((pane) => pane.name === name)
  if (!found) throw new Error(`no pane called ${name} in the render`)
  return found
}

describe('renderLayout', () => {
  it('puts a centred pane in the middle of the canvas', () => {
    const result = renderLayout(sample(), { maxSize: 1280 })
    const pane = paneNamed(result, 'Centred')

    // 1280×720 canvas, a 400×200 pane centred on it.
    expect(pane.x).toBeCloseTo((1280 - 400) / 2, 1)
    expect(pane.y).toBeCloseTo((720 - 200) / 2, 1)
    expect(pane.width).toBeCloseTo(400, 1)
    expect(pane.height).toBeCloseTo(200, 1)
  })

  /** Layout space has y up; the image has y down. Getting this backwards is the classic bug. */
  it('flips y, so a pane translated up is drawn higher', () => {
    const result = renderLayout(sample(), { maxSize: 1280 })
    const centred = paneNamed(result, 'Centred')
    const offset = paneNamed(result, 'Offset')

    expect(offset.x).toBeGreaterThan(centred.x)
    expect(offset.y).toBeLessThan(centred.y)
  })

  it('scales the whole picture, geometry included', () => {
    const full = renderLayout(sample(), { maxSize: 1280 })
    const half = renderLayout(sample(), { maxSize: 640 })

    expect(half.width).toBe(640)
    expect(half.height).toBe(360)
    expect(paneNamed(half, 'Centred').x).toBeCloseTo(paneNamed(full, 'Centred').x / 2, 1)
  })

  it('reports hidden panes without drawing them', () => {
    const result = renderLayout(sample())
    expect(paneNamed(result, 'Hidden').visible).toBe(false)
  })

  it('restricts the drawing to one subtree when asked', () => {
    const result = renderLayout(sample(), { only: 'Centred' })
    expect(result.panes.map((pane) => pane.name)).toEqual(['Centred'])
  })

  it('says what it is not showing', () => {
    const result = renderLayout(sample())
    expect(result.caveats.join(' ')).toMatch(/textures/)
  })

  it('emits a PNG with the right signature and size', () => {
    const result = renderLayout(sample(), { maxSize: 320 })
    expect([...result.png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // IHDR width and height are big-endian at a fixed offset.
    const view = new DataView(result.png.buffer, result.png.byteOffset, result.png.byteLength)
    expect(view.getUint32(16)).toBe(result.width)
    expect(view.getUint32(20)).toBe(result.height)
  })

  it('survives a layout with no panes at all', () => {
    const empty = createLayoutDocument({ name: 'Empty' })
    empty.rootPane = null
    const result = renderLayout(empty)
    expect(result.panes).toEqual([])
    expect(result.png.length).toBeGreaterThan(0)
  })
})

describe('encodePng', () => {
  it('encodes a one-pixel image', () => {
    const png = encodePng(Uint8Array.from([255, 0, 0, 255]), 1, 1)
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(view.getUint32(16)).toBe(1)
    expect(view.getUint32(20)).toBe(1)
    // Colour type 6 (RGBA), bit depth 8.
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(6)
  })
})
