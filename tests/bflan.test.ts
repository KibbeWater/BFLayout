import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import {
  buildOverrides,
  createAnimation,
  evaluate,
  hermite,
  isBflan,
  lastKeyedFrame,
  normalizeFrame,
  parseBflan,
  tagName,
  targetName,
  writeBflan,
  type AnimationDocument,
  type AnimationEntry
} from '@shared/formats/bflan'

/**
 * The codec tests are self-consistency: they prove this parser and this writer
 * agree, and that the offset bases (which differ per structure and are the easy
 * thing to get wrong) are handled consistently. They do NOT prove agreement with
 * Nintendo's files — tests/fixtures.test.ts is where that would happen.
 *
 * The curve and override tests are different: those expectations are derived
 * from the Hermite basis functions and the target tables by hand.
 */

function entry(overrides: Partial<AnimationEntry> = {}): AnimationEntry {
  return {
    name: 'Pic_Thing',
    target: 'pane',
    tags: [
      {
        signature: 'FLPA',
        leading: null,
        components: [
          {
            index: 0,
            target: 0,
            curve: 'hermite',
            keyframes: [
              { frame: 0, value: 0, slope: 0 },
              { frame: 30, value: 100, slope: 0 }
            ]
          }
        ]
      }
    ],
    ...overrides
  }
}

function roundTrip(document: AnimationDocument): AnimationDocument {
  return parseBflan(writeBflan(document)).document
}

describe('bflan detection', () => {
  it('recognises the FLAN signature', () => {
    expect(isBflan(writeBflan(createAnimation('Test')))).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isBflan(new Uint8Array([0x46, 0x4c, 0x59, 0x54]))).toBe(false)
    expect(isBflan(new Uint8Array(4))).toBe(false)
  })
})

describe('bflan round-trip', () => {
  it('preserves the animation tag', () => {
    const source = createAnimation('MainMenu_In', 45)
    source.tag!.order = 1
    source.tag!.startFrame = 2
    source.tag!.endFrame = 44
    source.tag!.childBinding = true
    source.tag!.groups = ['Buttons', 'Icons']

    const result = roundTrip(source)
    expect(result.tag?.name).toBe('MainMenu_In')
    expect(result.tag?.order).toBe(1)
    expect(result.tag?.startFrame).toBe(2)
    expect(result.tag?.endFrame).toBe(44)
    expect(result.tag?.childBinding).toBe(true)
    expect(result.tag?.groups).toEqual(['Buttons', 'Icons'])
  })

  it('preserves frame size and the loop flag', () => {
    const source = createAnimation('Loop', 120)
    source.info!.loop = true
    const result = roundTrip(source)
    expect(result.info?.frameSize).toBe(120)
    expect(result.info?.loop).toBe(true)
  })

  it('preserves the texture table, whose offsets use a different base', () => {
    const source = createAnimation('Pattern')
    source.info!.textures = ['Icon_A.bntx', 'Icon_B.bntx', 'Icon_C.bntx']
    expect(roundTrip(source).info?.textures).toEqual([
      'Icon_A.bntx',
      'Icon_B.bntx',
      'Icon_C.bntx'
    ])
  })

  it('preserves hermite keyframes exactly', () => {
    const source = createAnimation('Move')
    source.info!.entries = [entry()]

    const component = roundTrip(source).info!.entries[0]!.tags[0]!.components[0]!
    expect(component.curve).toBe('hermite')
    expect(component.keyframes).toEqual([
      { frame: 0, value: 0, slope: 0 },
      { frame: 30, value: 100, slope: 0 }
    ])
  })

  it('preserves hermite slopes, which only that curve kind stores', () => {
    const source = createAnimation('Move')
    source.info!.entries = [
      entry({
        tags: [
          {
            signature: 'FLPA',
            leading: null,
            components: [
              {
                index: 0,
                target: 1,
                curve: 'hermite',
                keyframes: [
                  { frame: 0, value: -12.5, slope: 2.5 },
                  { frame: 10, value: 37.25, slope: -1.75 }
                ]
              }
            ]
          }
        ]
      })
    ]

    const keys = roundTrip(source).info!.entries[0]!.tags[0]!.components[0]!.keyframes
    expect(keys[0]!.slope).toBeCloseTo(2.5)
    expect(keys[1]!.slope).toBeCloseTo(-1.75)
    expect(keys[1]!.value).toBeCloseTo(37.25)
  })

  it('stores step keyframe values as integers', () => {
    const source = createAnimation('Blink')
    source.info!.entries = [
      entry({
        tags: [
          {
            signature: 'FLVI',
            leading: null,
            components: [
              {
                index: 0,
                target: 0,
                curve: 'step',
                keyframes: [
                  { frame: 0, value: 1, slope: 0 },
                  { frame: 5, value: 0, slope: 0 },
                  { frame: 10, value: 1, slope: 0 }
                ]
              }
            ]
          }
        ]
      })
    ]

    const component = roundTrip(source).info!.entries[0]!.tags[0]!.components[0]!
    expect(component.curve).toBe('step')
    expect(component.keyframes.map((key) => key.value)).toEqual([1, 0, 1])
    expect(component.keyframes.map((key) => key.frame)).toEqual([0, 5, 10])
  })

  it('preserves several entries, tags and components together', () => {
    const source = createAnimation('Complex')
    source.info!.entries = [
      entry({ name: 'Pane_A' }),
      {
        name: 'Mat_B',
        target: 'material',
        tags: [
          {
            signature: 'FLTS',
            leading: null,
            components: [
              {
                index: 0,
                target: 2,
                curve: 'hermite',
                keyframes: [{ frame: 0, value: 45, slope: 0 }]
              }
            ]
          },
          {
            signature: 'FLMC',
            leading: null,
            components: [
              {
                index: 0,
                target: 3,
                curve: 'hermite',
                keyframes: [{ frame: 0, value: 255, slope: 0 }]
              },
              {
                index: 0,
                target: 7,
                curve: 'hermite',
                keyframes: [{ frame: 0, value: 128, slope: 0 }]
              }
            ]
          }
        ]
      }
    ]

    const result = roundTrip(source)
    expect(result.info?.entries).toHaveLength(2)
    expect(result.info?.entries[0]!.name).toBe('Pane_A')
    expect(result.info?.entries[1]!.name).toBe('Mat_B')
    expect(result.info?.entries[1]!.target).toBe('material')
    expect(result.info?.entries[1]!.tags.map((tag) => tag.signature)).toEqual(['FLTS', 'FLMC'])
    expect(result.info?.entries[1]!.tags[1]!.components).toHaveLength(2)
  })

  it('survives repeated encode and decode cycles unchanged', () => {
    const source = createAnimation('Stable', 90)
    source.info!.textures = ['A.bntx']
    source.info!.entries = [entry()]

    const once = writeBflan(roundTrip(source))
    const twice = writeBflan(parseBflan(once).document)
    expect([...twice]).toEqual([...once])
  })

  it('rewrites an untouched file byte for byte', () => {
    const source = createAnimation('Untouched')
    source.info!.entries = [entry()]
    const bytes = writeBflan(source)

    const parsed = parseBflan(bytes)
    expect([...writeBflan(parsed.document, parsed.original)]).toEqual([...bytes])
  })
})

describe('bflan validation', () => {
  it('rejects a file without the signature', () => {
    expect(() => parseBflan(new Uint8Array(0x20))).toThrow(FormatParseError)
  })

  it('rejects an unrecognised byte-order mark', () => {
    const bytes = writeBflan(createAnimation('Test'))
    bytes[4] = 0x12
    bytes[5] = 0x34
    expect(() => parseBflan(bytes)).toThrow(/byte-order mark/)
  })

  it('rejects a declared file size larger than the data', () => {
    const bytes = writeBflan(createAnimation('Test'))
    new DataView(bytes.buffer).setUint32(0x0c, 0xffff, true)
    expect(() => parseBflan(bytes)).toThrow(/only \d+ are present/)
  })

  it('names the section whose size runs past the end', () => {
    const bytes = writeBflan(createAnimation('Test'))
    // The first section starts at the header size, 0x14.
    new DataView(bytes.buffer).setUint32(0x18, 0xffff, true)
    expect(() => parseBflan(bytes)).toThrow(/pat1/)
  })
})

describe('curve evaluation', () => {
  it('matches the hermite basis at the ends and midpoint', () => {
    // With zero tangents the basis reduces to smoothstep, whose midpoint is 0.5.
    expect(hermite(0, 0, 1, 0, 0)).toBeCloseTo(0)
    expect(hermite(0, 0, 1, 0, 1)).toBeCloseTo(1)
    expect(hermite(0, 0, 1, 0, 0.5)).toBeCloseTo(0.5)
  })

  it('honours tangents', () => {
    // p0=0, m0=1, p1=0, m1=0 at t=0.5: (t^3-2t^2+t)*1 = 0.125-0.5+0.5 = 0.125
    expect(hermite(0, 1, 0, 0, 0.5)).toBeCloseTo(0.125)
  })

  it('returns the fallback for an empty curve', () => {
    expect(evaluate([], 'hermite', 5, 42)).toBe(42)
  })

  it('holds a constant curve at the first value', () => {
    const keys = [
      { frame: 0, value: 7, slope: 0 },
      { frame: 10, value: 99, slope: 0 }
    ]
    expect(evaluate(keys, 'constant', 0)).toBe(7)
    expect(evaluate(keys, 'constant', 10)).toBe(7)
  })

  it('holds a step curve until the next key', () => {
    const keys = [
      { frame: 0, value: 1, slope: 0 },
      { frame: 5, value: 0, slope: 0 },
      { frame: 10, value: 1, slope: 0 }
    ]
    expect(evaluate(keys, 'step', 0)).toBe(1)
    expect(evaluate(keys, 'step', 4.9)).toBe(1)
    expect(evaluate(keys, 'step', 5)).toBe(0)
    expect(evaluate(keys, 'step', 9.9)).toBe(0)
    expect(evaluate(keys, 'step', 10)).toBe(1)
  })

  it('interpolates a hermite curve between keys', () => {
    const keys = [
      { frame: 0, value: 0, slope: 0 },
      { frame: 10, value: 100, slope: 0 }
    ]
    expect(evaluate(keys, 'hermite', 0)).toBeCloseTo(0)
    expect(evaluate(keys, 'hermite', 5)).toBeCloseTo(50)
    expect(evaluate(keys, 'hermite', 10)).toBeCloseTo(100)
    // Smoothstep is symmetric about the midpoint.
    expect(evaluate(keys, 'hermite', 2.5) + evaluate(keys, 'hermite', 7.5)).toBeCloseTo(100)
  })

  it('holds rather than extrapolates outside the keyed range', () => {
    const keys = [
      { frame: 10, value: 5, slope: 100 },
      { frame: 20, value: 15, slope: 100 }
    ]
    expect(evaluate(keys, 'hermite', -50)).toBe(5)
    expect(evaluate(keys, 'hermite', 500)).toBe(15)
  })

  it('does not divide by zero for coincident keys', () => {
    const keys = [
      { frame: 4, value: 1, slope: 0 },
      { frame: 4, value: 9, slope: 0 }
    ]
    expect(evaluate(keys, 'hermite', 4)).toBe(9)
    expect(Number.isFinite(evaluate(keys, 'hermite', 4))).toBe(true)
  })

  it('picks the right segment across many keys', () => {
    const keys = Array.from({ length: 20 }, (_, i) => ({
      frame: i * 10,
      value: i,
      slope: 0
    }))
    expect(evaluate(keys, 'step', 95)).toBe(9)
    expect(evaluate(keys, 'step', 100)).toBe(10)
    expect(evaluate(keys, 'step', 191)).toBe(19)
  })

  it('reports the last keyed frame', () => {
    expect(
      lastKeyedFrame([
        { index: 0, target: 0, curve: 'step', keyframes: [{ frame: 3, value: 0, slope: 0 }] },
        { index: 0, target: 1, curve: 'step', keyframes: [{ frame: 17, value: 0, slope: 0 }] }
      ])
    ).toBe(17)
  })
})

describe('frame normalisation', () => {
  const document = createAnimation('Loop', 60)

  it('clamps when not looping', () => {
    expect(normalizeFrame(document, -5)).toBe(0)
    expect(normalizeFrame(document, 80)).toBe(60)
    expect(normalizeFrame(document, 30)).toBe(30)
  })

  it('wraps when looping, including negatives', () => {
    expect(normalizeFrame(document, 70, true)).toBe(10)
    expect(normalizeFrame(document, -10, true)).toBe(50)
    expect(normalizeFrame(document, 60, true)).toBe(0)
  })

  it('returns zero for a zero-length animation', () => {
    const empty = createAnimation('Empty', 0)
    expect(normalizeFrame(empty, 10)).toBe(0)
  })
})

describe('overrides', () => {
  function withTag(
    signature: string,
    target: number,
    value: number,
    name = 'Thing',
    entryTarget: 'pane' | 'material' = 'pane'
  ): AnimationDocument {
    const document = createAnimation('Test')
    document.info!.entries = [
      {
        name,
        target: entryTarget,
        tags: [
          {
            signature,
            leading: null,
            components: [
              {
                index: 0,
                target,
                curve: 'constant',
                keyframes: [{ frame: 0, value, slope: 0 }]
              }
            ]
          }
        ]
      }
    ]
    return document
  }

  it('is empty for a null document', () => {
    const overrides = buildOverrides(null, 0)
    expect(overrides.panes.size).toBe(0)
    expect(overrides.materials.size).toBe(0)
  })

  it('maps FLPA targets onto transform components', () => {
    expect(buildOverrides(withTag('FLPA', 0, 12), 0).panes.get('Thing')?.translate?.[0]).toBe(12)
    expect(buildOverrides(withTag('FLPA', 1, 12), 0).panes.get('Thing')?.translate?.[1]).toBe(12)
    expect(buildOverrides(withTag('FLPA', 5, 90), 0).panes.get('Thing')?.rotate?.[2]).toBe(90)
    expect(buildOverrides(withTag('FLPA', 6, 2), 0).panes.get('Thing')?.scale?.[0]).toBe(2)
    expect(buildOverrides(withTag('FLPA', 8, 64), 0).panes.get('Thing')?.width).toBe(64)
    expect(buildOverrides(withTag('FLPA', 9, 32), 0).panes.get('Thing')?.height).toBe(32)
  })

  it('leaves unkeyed components undefined rather than zero', () => {
    const pane = buildOverrides(withTag('FLPA', 1, 12), 0).panes.get('Thing')
    expect(pane?.translate?.[0]).toBeUndefined()
    expect(pane?.translate?.[1]).toBe(12)
    expect(pane?.scale).toBeUndefined()
  })

  it('treats FLVI as a boolean rather than interpolating it', () => {
    expect(buildOverrides(withTag('FLVI', 0, 1), 0).panes.get('Thing')?.visible).toBe(true)
    expect(buildOverrides(withTag('FLVI', 0, 0), 0).panes.get('Thing')?.visible).toBe(false)
  })

  it('maps FLVC target 16 to pane alpha and the rest to corners', () => {
    expect(buildOverrides(withTag('FLVC', 16, 128), 0).panes.get('Thing')?.alpha).toBe(128)
    // Target 5 is corner 1 (right top), channel 1 (green).
    const colors = buildOverrides(withTag('FLVC', 5, 200), 0).panes.get('Thing')?.vertexColors
    expect(colors?.[1]?.[1]).toBe(200)
    expect(colors?.[0]?.[0]).toBeUndefined()
  })

  it('maps FLTS onto the material texture SRT', () => {
    const material = buildOverrides(withTag('FLTS', 2, 45, 'Mat', 'material'), 0).materials.get(
      'Mat'
    )
    expect(material?.textureRotate).toBe(45)
  })

  it('splits FLMC targets between the black and white colours', () => {
    const black = buildOverrides(withTag('FLMC', 1, 64, 'Mat', 'material'), 0).materials.get('Mat')
    expect(black?.blackColor?.[1]).toBe(64)
    const white = buildOverrides(withTag('FLMC', 6, 32, 'Mat', 'material'), 0).materials.get('Mat')
    expect(white?.whiteColor?.[2]).toBe(32)
  })

  it('rounds FLTP to a texture index', () => {
    const material = buildOverrides(withTag('FLTP', 0, 1.6, 'Mat', 'material'), 0).materials.get(
      'Mat'
    )
    expect(material?.texturePattern?.get(0)).toBe(2)
  })

  it('skips tags it does not model instead of guessing', () => {
    const overrides = buildOverrides(withTag('FLXX', 0, 5), 0)
    // No entry at all, not an empty one: the renderer's `override ?? static`
    // lookup then takes the static path with no allocation and no special case.
    expect(overrides.panes.has('Thing')).toBe(false)
  })

  it('changes with the frame', () => {
    const document = createAnimation('Move')
    document.info!.entries = [entry()]
    expect(buildOverrides(document, 0).panes.get('Pic_Thing')?.translate?.[0]).toBeCloseTo(0)
    expect(buildOverrides(document, 15).panes.get('Pic_Thing')?.translate?.[0]).toBeCloseTo(50)
    expect(buildOverrides(document, 30).panes.get('Pic_Thing')?.translate?.[0]).toBeCloseTo(100)
  })

  it('never mutates the animation document', () => {
    const document = createAnimation('Move')
    document.info!.entries = [entry()]
    const before = JSON.stringify(document)
    buildOverrides(document, 12)
    buildOverrides(document, 24)
    expect(JSON.stringify(document)).toBe(before)
  })
})

describe('track naming', () => {
  it('names the tags', () => {
    expect(tagName('FLPA')).toBe('Transform')
    expect(tagName('FLVI')).toBe('Visibility')
    expect(tagName('FLZZ')).toBe('FLZZ')
  })

  it('names the targets per tag', () => {
    expect(targetName('FLPA', 0)).toBe('Translate X')
    expect(targetName('FLPA', 9)).toBe('Size Y')
    expect(targetName('FLTS', 2)).toBe('Rotate')
    expect(targetName('FLVC', 16)).toBe('Pane alpha')
    expect(targetName('FLMC', 0)).toBe('Black red')
    expect(targetName('FLTP', 0)).toBe('Texture map 1')
    expect(targetName('FLPA', 99)).toBe('Target 99')
  })
})
