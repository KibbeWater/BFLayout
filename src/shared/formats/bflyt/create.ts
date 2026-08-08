import { DEFAULT_VERSION } from './layout'
import { nextPaneId } from './panes'
import type {
  GroupPane,
  LayoutDocument,
  LayoutVersion,
  Material,
  Pane,
  PaneBase,
  PaneKind,
  PartPane,
  PicturePane,
  Rgba,
  TextPane,
  WindowPane
} from './types'

const WHITE: Rgba = [255, 255, 255, 255]

function baseDefaults(name: string, kind: PaneKind): PaneBase {
  return {
    id: nextPaneId(kind),
    name,
    userDataInfo: '',
    visible: true,
    baseFlags: 0x01,
    influenceAlpha: false,
    alpha: 255,
    origin: { x: 1, y: 1, parentX: 1, parentY: 1 },
    paneMagFlags: 0,
    translate: [0, 0, 0],
    rotate: [0, 0, 0],
    scale: [1, 1],
    width: 100,
    height: 100,
    userData: null,
    children: [],
    // New panes have no original bytes, so they must always be encoded.
    trailing: [],
    dirty: true
  }
}

export function createNullPane(name = 'NullPane'): Pane {
  return { kind: 'pan1', ...baseDefaults(name, 'pan1') }
}

export function createBoundaryPane(name = 'Boundary'): Pane {
  return { kind: 'bnd1', ...baseDefaults(name, 'bnd1') }
}

/**
 * A part pane instantiating an external layout.
 *
 * `externalLayoutName` is a bare filename as prt1 stores it; the editor resolves
 * it against blyt/ in the archive (or the folder beside a loose layout).
 */
export function createPartPane(name = 'Part', externalLayoutName = ''): PartPane {
  return {
    kind: 'prt1',
    ...baseDefaults(name, 'prt1'),
    magnify: [1, 1],
    properties: [],
    trailingData: [],
    externalLayoutName
  }
}

export function createPicturePane(name = 'Picture', materialIndex = 0): PicturePane {
  return {
    kind: 'pic1',
    ...baseDefaults(name, 'pic1'),
    colorTopLeft: [...WHITE] as Rgba,
    colorTopRight: [...WHITE] as Rgba,
    colorBottomLeft: [...WHITE] as Rgba,
    colorBottomRight: [...WHITE] as Rgba,
    materialIndex,
    texCoords: [
      {
        topLeft: [0, 0],
        topRight: [1, 0],
        bottomLeft: [0, 1],
        bottomRight: [1, 1]
      }
    ]
  }
}

export function createTextPane(name = 'Text', materialIndex = 0): TextPane {
  return {
    kind: 'txt1',
    textCapacityBytes: 0,
    ...baseDefaults(name, 'txt1'),
    text: 'Text',
    maxTextLength: 32,
    materialIndex,
    fontIndex: 0,
    textAlignment: 0,
    lineAlignment: 0,
    flags: 0,
    unknown: 0,
    italicTilt: 0,
    fontTopColor: [...WHITE] as Rgba,
    fontBottomColor: [...WHITE] as Rgba,
    fontSize: [24, 24],
    charSpace: 0,
    lineSpace: 0,
    shadowPosition: [0, 0],
    shadowSize: [1, 1],
    shadowForeColor: [...WHITE] as Rgba,
    shadowBackColor: [0, 0, 0, 255],
    shadowItalic: 0,
    textBoxName: '',
    perCharTransform: null,
    trailingData: [],
    extra: 0
  }
}

export function createWindowPane(name = 'Window', materialIndex = 0): WindowPane {
  return {
    kind: 'wnd1',
    ...baseDefaults(name, 'wnd1'),
    stretchLeft: 0,
    stretchRight: 0,
    stretchTop: 0,
    stretchBottom: 0,
    frameElemLeft: 0,
    frameElemRight: 0,
    frameElemTop: 0,
    frameElemBottom: 0,
    flag: 0,
    content: {
      colorTopLeft: [...WHITE] as Rgba,
      colorTopRight: [...WHITE] as Rgba,
      colorBottomLeft: [...WHITE] as Rgba,
      colorBottomRight: [...WHITE] as Rgba,
      materialIndex,
      texCoords: [
        { topLeft: [0, 0], topRight: [1, 0], bottomLeft: [0, 1], bottomRight: [1, 1] }
      ]
    },
    frames: [{ materialIndex, textureFlip: 0 }]
  }
}

export function createMaterial(name = 'Material'): Material {
  return {
    name,
    blackColor: [0, 0, 0, 0],
    whiteColor: [...WHITE] as Rgba,
    unknown: 0,
    textureMaps: [],
    textureTransforms: [],
    texCoordGens: [],
    tevStages: [],
    alphaCompare: null,
    blendMode: null,
    blendModeLogic: null,
    indirectParameter: null,
    projectionTexGenParams: [],
    fontShadowParameter: null,
    useTextureOnly: false,
    alphaInterpolation: false,
    originalFlags: 0,
    trailing: [],
    dirty: true
  }
}

export function createGroup(name = 'RootGroup'): GroupPane {
  return { id: `group_new_${name}`, name, paneNames: [], children: [], dirty: true }
}

export function createLayoutDocument(options?: {
  name?: string
  width?: number
  height?: number
  version?: LayoutVersion
}): LayoutDocument {
  const width = options?.width ?? 1280
  const height = options?.height ?? 720

  const root = createNullPane('RootPane')
  root.width = width
  root.height = height

  return {
    version: options?.version ?? DEFAULT_VERSION,
    littleEndian: true,
    platform: 'switch',
    info: {
      drawFromCenter: false,
      width,
      height,
      maxPartsWidth: 0,
      maxPartsHeight: 0,
      name: options?.name ?? 'layout'
    },
    textures: [],
    fonts: [],
    materials: [],
    rootPane: root,
    rootGroup: createGroup(),
    layoutUserData: null,
    unknownSections: []
  }
}
