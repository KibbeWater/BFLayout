import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import {
  createBoundaryPane,
  createGroup,
  createLayoutDocument,
  createMaterial,
  createPartPane,
  createPicturePane,
  createTextPane,
  createWindowPane
} from '@shared/formats/bflyt/create'
import {
  decodeVersion,
  encodeVersion,
  isBflyt,
  isDocumentDirty,
  parseBflyt,
  writeBflyt,
  walkPanes,
  type LayoutDocument,
  type PartPane,
  type PicturePane,
  type TextPane,
  type WindowPane
} from '@shared/formats/bflyt'

/** A layout exercising every pane kind, nesting, materials and user data. */
function buildSampleDocument(): LayoutDocument {
  const document = createLayoutDocument({ name: 'MainMenu', width: 1280, height: 720 })

  document.textures = ['Header.bntx', 'Button.bntx']
  document.fonts = ['Common.bffnt']

  const opaque = createMaterial('P_Base')
  opaque.textureMaps = [{ textureIndex: 0, flag1: 0x06, flag2: 0x06 }]
  opaque.textureTransforms = [{ translate: [0, 0], rotate: 0, scale: [1, 1] }]
  opaque.texCoordGens = [{ matrix: 0, source: 0, unknown: [] }]
  opaque.tevStages = [{ colorFlags: 0x11, alphaFlags: 0x22, padding: [0, 0] }]
  opaque.blendMode = { blendOp: 1, sourceFactor: 4, destFactor: 5, logicOp: 0 }
  opaque.alphaCompare = { compareMode: 6, padding: [0, 0, 0], value: 0.5 }

  const text = createMaterial('T_Base')
  text.fontShadowParameter = {
    blackColor: [0, 0, 0, 255],
    whiteColor: [255, 255, 255, 255]
  }

  document.materials = [opaque, text]

  const picture = createPicturePane('Pic_Background', 0)
  picture.width = 1280
  picture.height = 720
  picture.colorTopLeft = [255, 0, 0, 255]
  picture.colorBottomRight = [0, 0, 255, 128]

  const label = createTextPane('Txt_Title', 1)
  label.text = 'Main Menu'
  label.textBoxName = 'TitleBox'
  label.translate = [10, -20, 0]
  label.flags = 0x01

  const window = createWindowPane('Wnd_Frame', 0)
  window.frames = [
    { materialIndex: 0, textureFlip: 0 },
    { materialIndex: 1, textureFlip: 1 }
  ]
  window.stretchLeft = 8
  window.stretchRight = 8

  const boundary = createBoundaryPane('Bnd_Touch')

  // Nesting: root -> picture -> [label, window -> boundary]
  window.children.push(boundary)
  picture.children.push(label, window)
  document.rootPane!.children.push(picture)

  document.rootPane!.userData = {
    dirty: true,
    raw: [],
    entries: [
      {
        name: 'author',
        kind: 'string',
        itemCount: 0,
        stringValue: 'bflayout',
        numberValues: [],
        structValue: null,
        unknown: 0
      },
      {
        name: 'counts',
        kind: 'int',
        itemCount: 0,
        stringValue: null,
        numberValues: [1, 2, 3],
        structValue: null,
        unknown: 0
      },
      {
        name: 'ratios',
        kind: 'float',
        itemCount: 0,
        stringValue: null,
        numberValues: [0.5, 1.5],
        structValue: null,
        unknown: 0
      }
    ]
  }

  const group = createGroup('RootGroup')
  const child = createGroup('Buttons')
  child.paneNames = ['Txt_Title', 'Wnd_Frame']
  group.children.push(child)
  document.rootGroup = group

  return document
}

describe('BFLYT version encoding', () => {
  it('round-trips the packed version word', () => {
    const version = { major: 8, minor: 1, micro: 2, micro2: 3 }
    expect(decodeVersion(encodeVersion(version))).toEqual(version)
  })

  it('decodes the shipping Switch revision', () => {
    expect(decodeVersion(0x08000000)).toEqual({ major: 8, minor: 0, micro: 0, micro2: 0 })
  })
})

describe('BFLYT round-trip', () => {
  const bytes = writeBflyt(buildSampleDocument())

  it('produces a recognisable file with a sane header', () => {
    expect(isBflyt(bytes)).toBe(true)
    // Byte-order mark is little-endian for Switch layouts.
    expect(bytes[4]).toBe(0xff)
    expect(bytes[5]).toBe(0xfe)
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    expect(view.getUint16(6, true)).toBe(0x14)
    expect(view.getUint32(12, true)).toBe(bytes.length)
    expect(view.getUint16(16, true)).toBeGreaterThan(5)
  })

  it('recovers the layout header and string lists', () => {
    const { document } = parseBflyt(bytes)
    expect(document.info.name).toBe('MainMenu')
    expect(document.info.width).toBe(1280)
    expect(document.info.height).toBe(720)
    expect(document.textures).toEqual(['Header.bntx', 'Button.bntx'])
    expect(document.fonts).toEqual(['Common.bffnt'])
    expect(document.version.major).toBe(8)
    expect(document.platform).toBe('switch')
  })

  it('rebuilds the pane hierarchy from the push/pop markers', () => {
    const { document } = parseBflyt(bytes)
    const names: string[] = []
    walkPanes(document.rootPane, (pane) => names.push(pane.name))
    expect(names).toEqual([
      'RootPane',
      'Pic_Background',
      'Txt_Title',
      'Wnd_Frame',
      'Bnd_Touch'
    ])

    const root = document.rootPane!
    expect(root.children).toHaveLength(1)
    const picture = root.children[0]!
    expect(picture.children.map((p) => p.name)).toEqual(['Txt_Title', 'Wnd_Frame'])
    expect(picture.children[1]!.children.map((p) => p.name)).toEqual(['Bnd_Touch'])
  })

  it('recovers picture pane vertex colours and UVs', () => {
    const { document } = parseBflyt(bytes)
    const picture = document.rootPane!.children[0] as PicturePane
    expect(picture.kind).toBe('pic1')
    expect(picture.colorTopLeft).toEqual([255, 0, 0, 255])
    expect(picture.colorBottomRight).toEqual([0, 0, 255, 128])
    expect(picture.texCoords).toHaveLength(1)
    expect(picture.texCoords[0]!.bottomRight).toEqual([1, 1])
    expect(picture.materialIndex).toBe(0)
  })

  it('recovers text pane strings, which live at an offset past the fields', () => {
    const { document } = parseBflyt(bytes)
    const label = document.rootPane!.children[0]!.children[0] as TextPane
    expect(label.kind).toBe('txt1')
    expect(label.text).toBe('Main Menu')
    expect(label.textBoxName).toBe('TitleBox')
    expect(label.translate).toEqual([10, -20, 0])
    expect(label.fontIndex).toBe(0)
    expect(label.materialIndex).toBe(1)
  })

  it('recovers window pane content and its frame table', () => {
    const { document } = parseBflyt(bytes)
    const window = document.rootPane!.children[0]!.children[1] as WindowPane
    expect(window.kind).toBe('wnd1')
    expect(window.stretchLeft).toBe(8)
    expect(window.frames).toEqual([
      { materialIndex: 0, textureFlip: 0 },
      { materialIndex: 1, textureFlip: 1 }
    ])
    expect(window.content.materialIndex).toBe(0)
  })

  it('recovers materials including optional blocks', () => {
    const { document } = parseBflyt(bytes)
    expect(document.materials).toHaveLength(2)

    const first = document.materials[0]!
    expect(first.name).toBe('P_Base')
    expect(first.textureMaps).toEqual([{ textureIndex: 0, flag1: 0x06, flag2: 0x06 }])
    expect(first.textureTransforms).toHaveLength(1)
    expect(first.tevStages).toEqual([{ colorFlags: 0x11, alphaFlags: 0x22, padding: [0, 0] }])
    expect(first.blendMode).toEqual({ blendOp: 1, sourceFactor: 4, destFactor: 5, logicOp: 0 })
    expect(first.alphaCompare).toEqual({ compareMode: 6, padding: [0, 0, 0], value: 0.5 })

    const second = document.materials[1]!
    expect(second.name).toBe('T_Base')
    expect(second.fontShadowParameter?.blackColor).toEqual([0, 0, 0, 255])
    expect(second.blendMode).toBeNull()
  })

  it('recovers user data of every value kind', () => {
    const { document } = parseBflyt(bytes)
    const userData = document.rootPane!.userData
    expect(userData).not.toBeNull()
    expect(userData!.entries.map((e) => e.name)).toEqual(['author', 'counts', 'ratios'])
    expect(userData!.entries[0]!.stringValue).toBe('bflayout')
    expect(userData!.entries[1]!.numberValues).toEqual([1, 2, 3])
    expect(userData!.entries[2]!.numberValues).toEqual([0.5, 1.5])
  })

  it('recovers the group tree, which nests independently of panes', () => {
    const { document } = parseBflyt(bytes)
    expect(document.rootGroup?.name).toBe('RootGroup')
    expect(document.rootGroup?.children).toHaveLength(1)
    const child = document.rootGroup!.children[0]!
    expect(child.name).toBe('Buttons')
    expect(child.paneNames).toEqual(['Txt_Title', 'Wnd_Frame'])
  })
})

describe('BFLYT byte fidelity', () => {
  it('rewrites an untouched file byte-for-byte', () => {
    const original = writeBflyt(buildSampleDocument())
    const parsed = parseBflyt(original)
    expect(isDocumentDirty(parsed.document)).toBe(false)
    expect([...writeBflyt(parsed.document, parsed.sources)]).toEqual([...original])
  })

  it('stays byte-identical across repeated parse/write cycles', () => {
    let bytes = writeBflyt(buildSampleDocument())
    for (let i = 0; i < 3; i++) {
      const parsed = parseBflyt(bytes)
      const next = writeBflyt(parsed.document, parsed.sources)
      expect([...next]).toEqual([...bytes])
      bytes = next
    }
  })

  it('re-encodes only the edited pane and keeps the rest verbatim', () => {
    const original = writeBflyt(buildSampleDocument())
    const parsed = parseBflyt(original)

    const label = parsed.document.rootPane!.children[0]!.children[0] as TextPane
    label.text = 'Edited Title'
    label.dirty = true

    expect(isDocumentDirty(parsed.document)).toBe(true)

    const edited = writeBflyt(parsed.document, parsed.sources)
    const reparsed = parseBflyt(edited)
    const reLabel = reparsed.document.rootPane!.children[0]!.children[0] as TextPane

    expect(reLabel.text).toBe('Edited Title')
    // Everything untouched survives the partial rewrite unchanged.
    const picture = reparsed.document.rootPane!.children[0] as PicturePane
    expect(picture.colorTopLeft).toEqual([255, 0, 0, 255])
    expect(reparsed.document.materials[0]!.name).toBe('P_Base')
    expect(reparsed.document.textures).toEqual(['Header.bntx', 'Button.bntx'])
  })

  it('preserves clean materials byte-wise when another material is edited', () => {
    const original = writeBflyt(buildSampleDocument())
    const parsed = parseBflyt(original)

    parsed.document.materials[1]!.name = 'T_Renamed'
    parsed.document.materials[1]!.dirty = true

    const reparsed = parseBflyt(writeBflyt(parsed.document, parsed.sources))
    expect(reparsed.document.materials[1]!.name).toBe('T_Renamed')
    expect(reparsed.document.materials[0]!.tevStages).toEqual([
      { colorFlags: 0x11, alphaFlags: 0x22, padding: [0, 0] }
    ])
    expect(reparsed.document.materials[0]!.alphaCompare).toEqual({
      compareMode: 6,
      padding: [0, 0, 0],
      value: 0.5
    })
  })

  it('keeps unrecognised sections and replays them on save', () => {
    const original = writeBflyt(buildSampleDocument())

    // Splice in a section this build does not know, before the group tree.
    const injected = new Uint8Array(16)
    injected.set([0x78, 0x78, 0x78, 0x31], 0) // "xxx1"
    new DataView(injected.buffer).setUint32(4, 16, true)
    injected[8] = 0xab

    const view = new DataView(original.buffer, original.byteOffset)
    const sectionCount = view.getUint16(16, true)

    const spliced = new Uint8Array(original.length + injected.length)
    spliced.set(original, 0)
    spliced.set(injected, original.length)
    const splicedView = new DataView(spliced.buffer)
    splicedView.setUint16(16, sectionCount + 1, true)
    splicedView.setUint32(12, spliced.length, true)

    const parsed = parseBflyt(spliced)
    expect(parsed.document.unknownSections.map((s) => s.signature)).toEqual(['xxx1'])
    expect([...writeBflyt(parsed.document, parsed.sources)]).toEqual([...spliced])
  })
})

describe('part panes', () => {
  /**
   * Each of a part's properties can carry its own `usd1` section, reached through the
   * middle of its three offsets.
   *
   * That slot was documented as becoming an opaque value at version 8 and was written
   * straight back, so the offset survived a save while the block it named did not — the
   * pointer dangled and the section came back short by exactly the block's size. It was
   * the last thing keeping four shipped layouts from round-tripping, and every one of
   * them declares a single entry called `PartsVariationFrame`.
   */
  const partsVariationFrame = (): number[] => [
    // A minimal real usd1: signature, size, one entry, then the entry's name.
    0x75, 0x73, 0x64, 0x31, 0x30, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00,
    0x00, 0x0c, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x50, 0x61,
    0x72, 0x74, 0x73, 0x56, 0x61, 0x72, 0x69, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x46, 0x72, 0x61,
    0x6d, 0x65, 0x00
  ]

  const documentWithProperty = (userDataBytes: number[] | null): LayoutDocument => {
    const document = createLayoutDocument({ name: 'Parts', width: 1280, height: 720 })
    const part = createPartPane('L_UgcList_00', 'UGCEditor_UGCList_00')
    part.properties = [
      {
        name: 'L_BtnList00_00',
        usageFlag: 0,
        basicUsageFlag: 0,
        materialUsageFlag: 0,
        overrideSection: null,
        panelInfo: null,
        userDataBytes,
        unknown: 0
      }
    ]
    document.rootPane!.children.push(part)
    return document
  }

  const firstPart = (document: LayoutDocument): PartPane => {
    let found: PartPane | null = null
    walkPanes(document.rootPane, (pane) => {
      if (pane.kind === 'prt1' && !found) found = pane
    })
    if (!found) throw new Error('no part pane in the document')
    return found
  }

  it('round-trips a property user-data block', () => {
    const bytes = writeBflyt(documentWithProperty(partsVariationFrame()))
    const property = firstPart(parseBflyt(bytes).document).properties[0]!
    expect(property.userDataBytes).toEqual(partsVariationFrame())
  })

  it('re-encodes to identical bytes, so the offset cannot dangle', () => {
    const once = writeBflyt(documentWithProperty(partsVariationFrame()))
    const twice = writeBflyt(parseBflyt(once).document)
    expect([...twice]).toEqual([...once])
  })

  it('accounts for the whole block in the section size', () => {
    // The failure this guards was a section short by exactly the block's length.
    const without = writeBflyt(documentWithProperty(null))
    const withBlock = writeBflyt(documentWithProperty(partsVariationFrame()))
    expect(withBlock.length - without.length).toBe(partsVariationFrame().length)
  })

  it('keeps a middle offset that does not name a section', () => {
    // If some other build really does put an opaque value there, it must survive.
    const document = documentWithProperty(null)
    firstPart(document).properties[0]!.unknown = 0x1234
    const property = firstPart(parseBflyt(writeBflyt(document)).document).properties[0]!
    expect(property.unknown).toBe(0x1234)
    expect(property.userDataBytes).toBeNull()
  })
})

describe('BFLYT validation', () => {
  it('rejects a buffer without the signature', () => {
    expect(() => parseBflyt(new Uint8Array(0x20))).toThrow(FormatParseError)
  })

  it('rejects an unrecognised byte-order mark', () => {
    const bytes = writeBflyt(buildSampleDocument())
    bytes[4] = 0x12
    bytes[5] = 0x34
    expect(() => parseBflyt(bytes)).toThrow(/byte-order mark/)
  })

  it('rejects a header claiming more bytes than exist', () => {
    const bytes = writeBflyt(buildSampleDocument())
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(12, 0x00ff_ffff, true)
    expect(() => parseBflyt(bytes)).toThrow(/only .* are present/)
  })

  it('names the offending section when a size runs past the end', () => {
    const bytes = writeBflyt(buildSampleDocument())
    // First section starts at the 0x14 header boundary; corrupt its size.
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(0x14 + 4, 0x00ff_ffff, true)
    expect(() => parseBflyt(bytes)).toThrow(/lyt1/)
  })
})
