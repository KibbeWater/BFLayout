/**
 * Builds a synthetic Yaz0-compressed SARC archive for development and the
 * automated self-test. Real game archives cannot be committed, so this stands
 * in for the shape of one: the conventional blyt/ anim/ timg/ folders and a
 * per-file alignment that differs between entries.
 *
 *   pnpm fixture:archive <output.szs> [yaz0|zstd|none]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { sarcHash, writeSarc, type SarcArchive } from '../src/shared/formats/sarc/index.ts'
import { yaz0Compress } from '../src/shared/formats/yaz0/index.ts'
import { writeBflyt } from '../src/shared/formats/bflyt/index.ts'
import {
  createBoundaryPane,
  createGroup,
  createPartPane,
  createLayoutDocument,
  createMaterial,
  createPicturePane,
  createTextPane,
  createWindowPane
} from '../src/shared/formats/bflyt/create.ts'
import { buildBntx, framePattern, testPattern } from '../tests/helpers/bntx-fixture.ts'
import { createAnimation, writeBflan } from '../src/shared/formats/bflan/index.ts'

const encoder = new TextEncoder()

function filler(seed: string, length: number): Uint8Array {
  const out = new Uint8Array(length)
  const seedBytes = encoder.encode(seed)
  for (let i = 0; i < length; i++) out[i] = seedBytes[i % seedBytes.length]!
  return out
}

/** A real BFLYT built through the codec, so the app has something to open. */
function buildLayout(name: string): Uint8Array {
  const document = createLayoutDocument({ name, width: 1280, height: 720 })
  document.textures = ['MainMenu.bntx', 'MainMenu_Frame.bntx']
  document.fonts = ['Common.bffnt']

  const base = createMaterial('P_Base')
  base.textureMaps = [{ textureIndex: 0, flag1: 0x06, flag2: 0x06 }]
  base.textureTransforms = [{ translate: [0, 0], rotate: 0, scale: [1, 1] }]
  base.texCoordGens = [{ matrix: 0, source: 0, unknown: [] }]
  base.blendMode = { blendOp: 1, sourceFactor: 4, destFactor: 5, logicOp: 0 }
  // A dedicated frame material, so the window pane exercises nine-slice with a
  // small corner texture rather than stretching the background across the ring.
  const frame = createMaterial('W_Frame')
  frame.textureMaps = [{ textureIndex: 1, flag1: 0x06, flag2: 0x06 }]
  frame.textureTransforms = [{ translate: [0, 0], rotate: 0, scale: [1, 1] }]
  frame.texCoordGens = [{ matrix: 0, source: 0, unknown: [] }]
  frame.blendMode = { blendOp: 1, sourceFactor: 4, destFactor: 5, logicOp: 0 }
  document.materials = [base, createMaterial('T_Label'), frame]

  const background = createPicturePane('Pic_Background', 0)
  background.width = 1280
  background.height = 720
  background.colorTopLeft = [40, 60, 120, 255]
  background.colorTopRight = [40, 60, 120, 255]
  background.colorBottomLeft = [12, 18, 40, 255]
  background.colorBottomRight = [12, 18, 40, 255]

  const title = createTextPane('Txt_Title', 1)
  title.text = 'MAIN MENU'
  title.width = 480
  title.height = 72
  title.translate = [0, 240, 0]
  title.fontSize = [48, 48]

  const panel = createWindowPane('Wnd_Panel', 0)
  panel.width = 640
  panel.height = 320
  panel.translate = [0, -40, 0]
  panel.stretchLeft = 16
  panel.stretchRight = 16
  panel.stretchTop = 16
  panel.stretchBottom = 16
  // Four frames means a pinwheel ring; the flips orient one corner texture.
  panel.frames = [
    { materialIndex: 2, textureFlip: 0 },
    { materialIndex: 2, textureFlip: 1 },
    { materialIndex: 2, textureFlip: 2 },
    { materialIndex: 2, textureFlip: 3 }
  ]

  for (const [index, label] of ['Start', 'Options', 'Quit'].entries()) {
    const button = createPicturePane(`Pic_Button_${label}`, 0)
    button.width = 400
    button.height = 64
    button.translate = [0, 90 - index * 80, 0]
    button.colorTopLeft = [200, 200, 210, 255]
    button.colorTopRight = [200, 200, 210, 255]
    button.colorBottomLeft = [150, 150, 165, 255]
    button.colorBottomRight = [150, 150, 165, 255]

    const caption = createTextPane(`Txt_${label}`, 1)
    caption.text = label
    caption.width = 380
    caption.height = 48
    caption.fontSize = [32, 32]
    button.children.push(caption)

    const touch = createBoundaryPane(`Bnd_${label}`)
    touch.width = 400
    touch.height = 64
    button.children.push(touch)

    panel.children.push(button)
  }

  // A part pane instantiating the other layout in the archive, so prt1 resolution
  // has something real to resolve.
  const part = createPartPane('Prt_Badge', 'MainMenu_Part.bflyt')
  part.width = 200
  part.height = 100
  part.translate = [-460, 260, 0]

  document.rootPane!.children.push(background, title, panel)
  if (name === 'MainMenu') document.rootPane!.children.push(part)

  const group = createGroup('RootGroup')
  const buttons = createGroup('Buttons')
  buttons.paneNames = ['Pic_Button_Start', 'Pic_Button_Options', 'Pic_Button_Quit']
  group.children.push(buttons)
  document.rootGroup = group

  return writeBflyt(document)
}

/**
 * A real BFLAN built through the codec: the panel slides in and fades up while
 * the buttons' vertex colours brighten, so the timeline has several tracks with
 * different curve kinds to show.
 */
function buildIntroAnimation(): Uint8Array {
  const animation = createAnimation('MainMenu_In', 30)
  animation.info!.entries = [
    {
      name: 'Wnd_Panel',
      target: 'pane',
      tags: [
        {
          signature: 'FLPA',
          leading: null,
          components: [
            {
              index: 0,
              target: 1, // translate Y
              curve: 'hermite',
              keyframes: [
                { frame: 0, value: -400, slope: 0 },
                { frame: 20, value: -40, slope: 0 }
              ]
            },
            {
              index: 0,
              target: 6, // scale X
              curve: 'hermite',
              keyframes: [
                { frame: 0, value: 0.8, slope: 0 },
                { frame: 20, value: 1, slope: 0 }
              ]
            }
          ]
        },
        {
          signature: 'FLVC',
          leading: null,
          components: [
            {
              index: 0,
              target: 16, // pane alpha
              curve: 'hermite',
              keyframes: [
                { frame: 0, value: 0, slope: 0 },
                { frame: 15, value: 255, slope: 0 }
              ]
            }
          ]
        }
      ]
    },
    {
      name: 'Txt_Title',
      target: 'pane',
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
                { frame: 0, value: 0, slope: 0 },
                { frame: 10, value: 1, slope: 0 }
              ]
            }
          ]
        }
      ]
    }
  ]
  return writeBflan(animation)
}

/** A looping animation, so the loop flag has something to act on. */
function buildLoopAnimation(): Uint8Array {
  const animation = createAnimation('MainMenu_Loop', 60)
  animation.info!.loop = true
  animation.info!.entries = [
    {
      name: 'Pic_Button_Start',
      target: 'pane',
      tags: [
        {
          signature: 'FLVC',
          leading: null,
          components: [
            {
              index: 0,
              // Left-top green, so the pulse is visible against the base colour.
              target: 1,
              curve: 'hermite',
              keyframes: [
                { frame: 0, value: 200, slope: 0 },
                { frame: 30, value: 255, slope: 0 },
                { frame: 60, value: 200, slope: 0 }
              ]
            }
          ]
        }
      ]
    }
  ]
  return writeBflan(animation)
}

const files = [
  { name: 'blyt/MainMenu.bflyt', data: buildLayout('MainMenu'), alignment: 4 },
  { name: 'blyt/MainMenu_Part.bflyt', data: buildLayout('MainMenu_Part'), alignment: 4 },
  { name: 'anim/MainMenu_Loop.bflan', data: buildLoopAnimation(), alignment: 4 },
  { name: 'anim/MainMenu_In.bflan', data: buildIntroAnimation(), alignment: 4 },
  {
    name: 'timg/MainMenu.bntx',
    data: buildBntx({
      containerName: 'MainMenu',
      textureName: 'MainMenu',
      width: 256,
      height: 128,
      rgba: testPattern(256, 128)
    }),
    alignment: 0x1000
  },
  {
    name: 'timg/MainMenu_Frame.bntx',
    data: buildBntx({
      containerName: 'MainMenu_Frame',
      textureName: 'MainMenu_Frame',
      width: 32,
      height: 32,
      rgba: framePattern(32)
    }),
    alignment: 0x1000
  },
  { name: 'font/Common.bffnt', data: filler('FFNT-font-', 4096), alignment: 0x80 }
]

const archive: SarcArchive = {
  littleEndian: true,
  version: 0x0100,
  hashKey: 0x65,
  hasNames: true,
  originalDataOffset: 0,
  entries: files.map((file) => ({
    nameHash: sarcHash(file.name, 0x65),
    name: file.name,
    data: file.data,
    originalOffset: 0,
    originalLength: -1,
    alignment: file.alignment
  }))
}

const target = process.argv[2]
const mode = process.argv[3] ?? 'yaz0'
if (!target) {
  console.error('usage: make-fixture-archive.ts <output.szs> [yaz0|zstd|none]')
  process.exit(1)
}

async function compressFor(mode: string, packed: Uint8Array): Promise<Uint8Array> {
  switch (mode) {
    case 'none':
      return packed
    case 'yaz0':
      return yaz0Compress(packed)
    case 'zstd': {
      const zstd = await import('@bokuweb/zstd-wasm')
      await zstd.init()
      return new Uint8Array(zstd.compress(packed, 17))
    }
    default:
      console.error(`unknown compression "${mode}"`)
      return process.exit(1)
  }
}

async function main(): Promise<void> {
  const packed = writeSarc(archive)
  const compressed = await compressFor(mode, packed)

  mkdirSync(dirname(target!), { recursive: true })
  writeFileSync(target!, compressed)

  console.log(
    `wrote ${target}: ${files.length} entries, ${packed.length} bytes packed, ` +
      `${compressed.length} bytes ${mode} (${((compressed.length / packed.length) * 100).toFixed(1)}%)`
  )
}

void main()
