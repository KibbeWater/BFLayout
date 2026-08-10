import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import { parseBflyt, writeBflyt } from '@shared/formats/bflyt'
import {
  createLayoutDocument,
  createMaterial,
  createPicturePane,
  createTextPane
} from '@shared/formats/bflyt/create'
import { layoutFromText, layoutToText } from '@shared/text/layout-text'

/**
 * Layouts as reviewable text.
 *
 * The test that matters is not that the text parses — it is that the *binary*
 * survives the detour. Text that reads back into a document which then re-encodes
 * to different bytes is worse than no text form at all: it would let a
 * round trip through version control silently change a file.
 */

function sample(): ReturnType<typeof createLayoutDocument> {
  const document = createLayoutDocument({ name: 'MenuMain', width: 1280, height: 720 })
  document.textures = ['Header.bntx', 'Btn.bntx']
  document.fonts = ['Standard.bfcpx']
  document.materials = [createMaterial('BtnMaterial'), createMaterial('TextMaterial')]

  const button = createPicturePane('BtnOk', 0)
  button.translate = [12.5, -30, 0]
  button.width = 200
  button.height = 64

  const text = createTextPane('LabelOk', 1)
  text.visible = false

  document.rootPane!.children.push(button, text)
  return document
}

describe('layout text form', () => {
  it('round-trips to the same bytes', () => {
    const original = sample()
    const binary = writeBflyt(original, new Map())

    const text = layoutToText(parseBflyt(binary).document)
    const recovered = layoutFromText(text)

    expect([...writeBflyt(recovered, new Map())]).toEqual([...binary])
  })

  it('keeps the structure legible rather than encoded', () => {
    const text = layoutToText(sample())
    // The point of the format: a reviewer can see what changed.
    expect(text).toContain('name: BtnOk')
    expect(text).toContain('textures:')
    expect(text).toContain('- Header.bntx')
  })

  /**
   * Pane ids come from a counter that never resets and mean nothing outside the
   * process that minted them. Writing them out would put a meaningless value in
   * the file *and* produce a diff every time a layout was exported without being
   * changed — which would make the text form useless for exactly the job it exists
   * to do.
   */
  it('leaves editor-only ids out, so an unchanged layout has an empty diff', () => {
    const document = sample()
    expect(layoutToText(document)).not.toContain('id:')
    expect(layoutToText(document)).toBe(layoutToText(document))

    // Two separate parses of the same bytes mint different ids and must still
    // produce identical text.
    const binary = writeBflyt(document, new Map())
    expect(layoutToText(parseBflyt(binary).document)).toBe(
      layoutToText(parseBflyt(binary).document)
    )
  })

  it('mints fresh ids on the way back in, and never repeats one', () => {
    const recovered = layoutFromText(layoutToText(sample()))
    const ids: string[] = []
    const visit = (pane: { id: string; children: { id: string; children: unknown[] }[] }): void => {
      ids.push(pane.id)
      for (const child of pane.children) visit(child as never)
    }
    visit(recovered.rootPane as never)

    expect(ids.every((id) => id !== '' && id !== undefined)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('refuses an animation document with a message that says which it got', () => {
    const text = layoutToText(sample()).replace('kind: bflyt', 'kind: bflan')
    expect(() => layoutFromText(text)).toThrow(FormatParseError)
    expect(() => layoutFromText(text)).toThrow(/animation, not a layout/)
  })

  it('refuses a file that is not a text document at all', () => {
    expect(() => layoutFromText('hello: world\n')).toThrow(FormatParseError)
  })

  /** A pane name that would break naive quoting has to survive the detour too. */
  it('survives an awkward pane name', () => {
    const document = sample()
    document.rootPane!.children[0]!.name = 'Btn: "OK"'

    const binary = writeBflyt(document, new Map())
    const recovered = layoutFromText(layoutToText(parseBflyt(binary).document))
    expect([...writeBflyt(recovered, new Map())]).toEqual([...binary])
  })
})
