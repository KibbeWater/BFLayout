import {
  apply,
  flattenPanes,
  localBounds,
  multiply,
  type Affine,
  type PaneTransform
} from '@shared/formats/bflyt/transform'
import {
  usesVertexColorForAll,
  windowFrameSizes,
  windowPieces,
  type WindowPiece
} from '@shared/formats/bflyt/window'
import type {
  LayoutDocument,
  Material,
  PartPane,
  PicturePane,
  Rgba,
  TexCoordSet,
  TextPane,
  Vec2,
  WindowPane
} from '@shared/formats/bflyt'

import type { AnimationOverrides, MaterialOverride } from '@shared/formats/bflan'

import { TextRasterizer } from './text-raster'
import { TextureStore } from './texture-store'

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec2 a_uv;
uniform mat3 u_view;
out vec4 v_color;
out vec2 v_uv;
void main() {
  vec3 clip = u_view * vec3(a_position, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  v_color = a_color;
  v_uv = a_uv;
}`

/**
 * One program serves both textured and flat geometry: flat draws bind a 1x1
 * white texture, so the multiply is a no-op and there is no branch or second
 * program to keep in sync. This stands in for the real TEV pipeline, which
 * combines several stages per material — see the note in render().
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
in vec4 v_color;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = v_color * texture(u_texture, v_uv);
  if (outColor.a < 0.002) discard;
}`

/**
 * How deeply parts may nest before drawing stops.
 *
 * Parts reference layouts by name and nothing stops two from referencing each
 * other, so a depth cap is the difference between a deep hierarchy and a hang.
 */
const MAX_PART_DEPTH = 6

/** pos(2) + color(4) + uv(2) */
const FLOATS_PER_VERTEX = 8
const STRIDE = FLOATS_PER_VERTEX * 4

export interface Camera {
  /** Layout-space point at the centre of the viewport. */
  x: number
  y: number
  zoom: number
}

export interface RenderOptions {
  readonly showGrid: boolean
  readonly gridSize: number
  readonly showInvisiblePanes: boolean
  readonly showTextures: boolean
  readonly selectedIds: readonly string[]
  /**
   * Animation overrides for the current frame, or null when nothing is playing.
   * Panes and materials are looked up by *name*, which is how BFLAN addresses
   * them — an animation has no knowledge of pane ids.
   */
  readonly overrides: AnimationOverrides | null
  /**
   * Layouts that prt1 part panes instantiate, keyed by the part's name. Missing
   * entries draw as an outline, which is what an unresolved part looked like
   * before parts were resolved at all.
   */
  readonly parts: ReadonlyMap<string, LayoutDocument>
}

/** A run of vertices sharing one texture binding. */
interface Batch {
  texture: WebGLTexture
  first: number
  count: number
}

const FULL_QUAD_UV: TexCoordSet = {
  topLeft: [0, 0],
  topRight: [1, 0],
  bottomLeft: [0, 1],
  bottomRight: [1, 1]
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('could not create shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error'
    gl.deleteShader(shader)
    throw new Error(`shader failed to compile: ${log}`)
  }
  return shader
}

/**
 * Immediate-mode style 2D renderer for the layout canvas.
 *
 * Geometry is rebuilt every frame into one interleaved buffer, then drawn as a
 * sequence of batches split wherever the texture binding changes. Layouts hold
 * hundreds of panes, not millions, so rebuilding is cheaper than tracking
 * per-pane GPU state — and it keeps the renderer stateless with respect to the
 * document, which is what lets the editor mutate panes freely without
 * invalidating caches.
 */
export class LayoutRenderer {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly vao: WebGLVertexArrayObject
  private readonly viewLocation: WebGLUniformLocation

  readonly textures: TextureStore
  private readonly text: TextRasterizer

  private vertices: number[] = []
  private triangleBatches: Batch[] = []
  /** Lines are always flat, so they need only their vertex range. */
  private lineFirst = 0
  private lineCount = 0

  /** Most recent flattened tree, reused for hit-testing without re-walking. */
  private lastFlattened: PaneTransform[] = []

  constructor(canvas: HTMLCanvasElement, onTexturesChanged: () => void) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: false
    })
    if (!gl) {
      throw new Error(
        'WebGL2 is not available in this window, so the layout canvas cannot be drawn.'
      )
    }
    this.gl = gl

    const program = gl.createProgram()
    if (!program) throw new Error('could not create WebGL program')
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL program failed to link: ${gl.getProgramInfoLog(program) ?? ''}`)
    }
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    this.program = program

    const viewLocation = gl.getUniformLocation(program, 'u_view')
    if (!viewLocation) throw new Error('u_view uniform missing from shader')
    this.viewLocation = viewLocation

    const buffer = gl.createBuffer()
    const vao = gl.createVertexArray()
    if (!buffer || !vao) throw new Error('could not allocate WebGL buffers')
    this.buffer = buffer
    this.vao = vao

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 2 * 4)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 6 * 4)
    gl.bindVertexArray(null)

    gl.useProgram(program)
    const textureLocation = gl.getUniformLocation(program, 'u_texture')
    if (textureLocation) gl.uniform1i(textureLocation, 0)

    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    this.textures = new TextureStore(gl, onTexturesChanged)
    this.text = new TextRasterizer(gl)
  }

  get flattened(): readonly PaneTransform[] {
    return this.lastFlattened
  }

  dispose(): void {
    const { gl } = this
    this.textures.dispose()
    this.text.dispose()
    gl.deleteBuffer(this.buffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.program)
  }

  private get vertexCount(): number {
    return this.vertices.length / FLOATS_PER_VERTEX
  }

  private vertex(
    x: number,
    y: number,
    color: readonly number[],
    u: number,
    v: number
  ): void {
    this.vertices.push(x, y, color[0]!, color[1]!, color[2]!, color[3]!, u, v)
  }

  /** Opens a batch, or extends the current one when the texture is unchanged. */
  private useTexture(texture: WebGLTexture): void {
    const current = this.triangleBatches[this.triangleBatches.length - 1]
    if (current && current.texture === texture) return
    this.triangleBatches.push({ texture, first: this.vertexCount, count: 0 })
  }

  private closeBatch(): void {
    const current = this.triangleBatches[this.triangleBatches.length - 1]
    if (current) current.count = this.vertexCount - current.first
  }

  /**
   * Corners are BL, BR, TR, TL; colours and UVs follow the same order, so the
   * caller decides how a texture maps onto the quad.
   */
  private quad(
    corners: readonly (readonly [number, number])[],
    colors: readonly (readonly number[])[],
    uvs: readonly (readonly [number, number])[]
  ): void {
    const emit = (i: number): void =>
      this.vertex(corners[i]![0], corners[i]![1], colors[i]!, uvs[i]![0], uvs[i]![1])
    // Two triangles: BL-BR-TR and BL-TR-TL.
    emit(0)
    emit(1)
    emit(2)
    emit(0)
    emit(2)
    emit(3)
    this.closeBatch()
  }

  private line(
    a: readonly [number, number],
    b: readonly [number, number],
    color: readonly number[]
  ): void {
    this.vertex(a[0], a[1], color, 0, 0)
    this.vertex(b[0], b[1], color, 0, 0)
  }

  private outline(
    corners: readonly (readonly [number, number])[],
    color: readonly number[]
  ): void {
    for (let i = 0; i < corners.length; i++) {
      this.line(corners[i]!, corners[(i + 1) % corners.length]!, color)
    }
  }

  /**
   * Resolves the texture a material samples, or null for an untextured material.
   *
   * Only the first texture map is used. Real materials combine up to three
   * through TEV stages, which this preview does not implement — the first map is
   * the base colour in every layout I have looked at, so it is the closest
   * single-texture approximation.
   */
  private materialTexture(
    document: LayoutDocument,
    materialIndex: number,
    enabled: boolean,
    overrides: AnimationOverrides | null
  ): { texture: WebGLTexture; material: Material; override?: MaterialOverride } | null {
    if (!enabled) return null
    const material = document.materials[materialIndex]
    if (!material) return null
    const map = material.textureMaps[0]
    if (!map || map.textureIndex < 0) return null

    const override = overrides?.materials.get(material.name)

    // A texture-pattern animation replaces which texture the map samples, taking
    // the name from the *animation's* table rather than the layout's.
    const patterned = override?.texturePattern?.get(0)
    const name =
      patterned !== undefined
        ? (overrides?.textures[patterned] ?? document.textures[map.textureIndex])
        : document.textures[map.textureIndex]
    if (!name) return null

    const texture = this.textures.lookup(name)
    if (!texture) return null
    return override ? { texture, material, override } : { texture, material }
  }

  render(
    document: LayoutDocument,
    camera: Camera,
    options: RenderOptions,
    size: { width: number; height: number; dpr: number }
  ): void {
    const { gl } = this
    const pixelWidth = Math.max(1, Math.round(size.width * size.dpr))
    const pixelHeight = Math.max(1, Math.round(size.height * size.dpr))

    if (gl.canvas.width !== pixelWidth || gl.canvas.height !== pixelHeight) {
      gl.canvas.width = pixelWidth
      gl.canvas.height = pixelHeight
    }
    gl.viewport(0, 0, pixelWidth, pixelHeight)

    gl.clearColor(0.11, 0.11, 0.12, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    this.vertices = []
    this.triangleBatches = []

    const halfWidth = size.width / 2 / camera.zoom
    const halfHeight = size.height / 2 / camera.zoom

    // Panes first, so every textured batch is emitted before the flat overlay
    // geometry that has to sit on top of it.
    this.buildPanes(document, options)

    this.lineFirst = this.vertexCount
    if (options.showGrid && options.gridSize > 0) {
      this.buildGrid(camera, halfWidth, halfHeight, options.gridSize)
    }
    // Layout bounds: the authored canvas the game will show.
    const lw = document.info.width / 2
    const lh = document.info.height / 2
    this.outline(
      [
        [-lw, -lh],
        [lw, -lh],
        [lw, lh],
        [-lw, lh]
      ],
      [0.45, 0.45, 0.5, 1]
    )
    this.buildPaneOutlines(camera, options)
    this.lineCount = this.vertexCount - this.lineFirst

    const view = viewMatrix(camera, halfWidth, halfHeight)
    gl.useProgram(this.program)
    gl.uniformMatrix3fv(this.viewLocation, false, view)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.vertices), gl.DYNAMIC_DRAW)
    gl.activeTexture(gl.TEXTURE0)

    for (const batch of this.triangleBatches) {
      if (batch.count === 0) continue
      gl.bindTexture(gl.TEXTURE_2D, batch.texture)
      gl.drawArrays(gl.TRIANGLES, batch.first, batch.count)
    }

    if (this.lineCount > 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures.white)
      gl.drawArrays(gl.LINES, this.lineFirst, this.lineCount)
    }

    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindVertexArray(null)
  }

  private buildPanes(document: LayoutDocument, options: RenderOptions): void {
    const overrides = options.overrides
    const flattened = flattenPanes(
      document.rootPane,
      overrides ? (pane) => overrides.panes.get(pane.name) : undefined
    )
    this.lastFlattened = flattened
    // Free rasters for panes that have since been deleted.
    this.text.retain(new Set(flattened.map((entry) => entry.pane.id)))

    for (const entry of flattened) {
      if (!entry.visible && !options.showInvisiblePanes) continue

      const corners = cornersOf(entry)
      const alpha = entry.visible ? entry.effectiveAlpha : entry.effectiveAlpha * 0.25

      if (entry.pane.kind === 'pic1') {
        const picture = entry.pane as PicturePane
        const bound = this.materialTexture(
          document,
          picture.materialIndex,
          options.showTextures,
          overrides
        )
        this.useTexture(bound?.texture ?? this.textures.white)
        // FLVC keys corners in TL, TR, BL, BR order; the quad wants BL, BR, TR, TL.
        const vertex = entry.values ? overrides?.panes.get(entry.pane.name)?.vertexColors : undefined
        this.quad(
          corners,
          [
            toColor(picture.colorBottomLeft, alpha, vertex?.[2]),
            toColor(picture.colorBottomRight, alpha, vertex?.[3]),
            toColor(picture.colorTopRight, alpha, vertex?.[1]),
            toColor(picture.colorTopLeft, alpha, vertex?.[0])
          ],
          bound
            ? uvCorners(picture.texCoords[0] ?? FULL_QUAD_UV, bound.material, bound.override)
            : FLAT_UV
        )
      } else if (entry.pane.kind === 'wnd1') {
        this.buildWindow(document, entry, entry.pane as WindowPane, alpha, options, overrides)
      } else if (entry.pane.kind === 'prt1') {
        this.buildPart(entry, entry.pane as PartPane, alpha, options)
      } else if (entry.pane.kind === 'txt1') {
        const raster = options.showTextures ? this.text.lookup(entry.pane as TextPane) : null
        if (raster) {
          // The gradient and shadow are baked into the raster, so the vertex
          // colour only carries the inherited alpha.
          const tint = [1, 1, 1, alpha]
          this.useTexture(raster)
          this.quad(corners, [tint, tint, tint, tint], FULL_QUAD_UV_CORNERS)
        } else {
          // Empty text, or textures switched off: a tinted box still shows the
          // pane's extent and stays clickable.
          const fill = [0.2, 0.5, 0.35, 0.3 * alpha]
          this.useTexture(this.textures.white)
          this.quad(corners, [fill, fill, fill, fill], FLAT_UV)
        }
      }
    }
  }

  /**
   * Draws a window pane as its content quad plus a frame ring.
   *
   * Frame thickness comes from the frame textures' own dimensions where they are
   * loaded, falling back to the pane's frameElem fields — which is the right way
   * round, because shipped layouts leave frameElem at zero and let the art decide.
   * While a texture is still in flight the ring uses the fallback and gets
   * rebuilt when the texture lands.
   */
  private buildWindow(
    document: LayoutDocument,
    entry: PaneTransform,
    pane: WindowPane,
    alpha: number,
    options: RenderOptions,
    overrides: AnimationOverrides | null
  ): void {
    const textureNameFor = (materialIndex: number): string | null => {
      const material = document.materials[materialIndex]
      const map = material?.textureMaps[0]
      if (!map || map.textureIndex < 0) return null
      return document.textures[map.textureIndex] ?? null
    }

    const sizes = windowFrameSizes(pane, (materialIndex) => {
      const name = textureNameFor(materialIndex)
      return name ? this.textures.sizeOf(name) : undefined
    })

    const geometry = windowPieces(pane, localBounds(pane), sizes)

    const contentColors = [
      toColor(pane.content.colorBottomLeft, alpha),
      toColor(pane.content.colorBottomRight, alpha),
      toColor(pane.content.colorTopRight, alpha),
      toColor(pane.content.colorTopLeft, alpha)
    ]
    // Frames are drawn white unless the pane opts into sharing the content's
    // vertex colours, which is what the flag bit means.
    const white = [1, 1, 1, alpha]
    const frameColors = usesVertexColorForAll(pane.flag)
      ? contentColors
      : [white, white, white, white]

    const draw = (piece: WindowPiece, colors: readonly (readonly number[])[]): void => {
      const bound = this.materialTexture(
        document,
        piece.materialIndex,
        options.showTextures,
        overrides
      )
      // An untextured window still needs to be visible, so it falls back to the
      // amber wash the editor used before nine-slice existed.
      const untextured = [0.55, 0.42, 0.15, 0.35 * alpha]
      this.useTexture(bound?.texture ?? this.textures.white)
      this.quad(
        rectCorners(entry, piece.rect),
        bound ? colors : [untextured, untextured, untextured, untextured],
        bound ? piece.uv.map(([u, v]) => [u, v] as [number, number]) : FLAT_UV
      )
    }

    if (geometry.content) draw(geometry.content, contentColors)
    for (const frame of geometry.frames) draw(frame, frameColors)
  }

  /**
   * Draws a part pane by drawing the layout it instantiates inside it.
   *
   * The part's own transform is already in `entry.world`, so the sub-layout only
   * needs its magnify factor applied on top. Nesting is bounded by `depth`: parts
   * can reference each other, and a cycle would otherwise recurse forever.
   */
  private buildPart(
    entry: PaneTransform,
    pane: PartPane,
    alpha: number,
    options: RenderOptions,
    depth = 0
  ): void {
    const document = options.parts.get(pane.externalLayoutName)
    if (!document || depth >= MAX_PART_DEPTH) return

    const [magX, magY] = pane.magnify
    const magnify: Affine = [magX || 1, 0, 0, magY || 1, 0, 0]
    const base = multiply(entry.world, magnify)

    for (const inner of flattenPanes(document.rootPane)) {
      if (!inner.visible && !options.showInvisiblePanes) continue

      const world = multiply(base, inner.world)
      // The part's own alpha multiplies through, so fading a part fades its whole
      // contents rather than only its outline.
      const combined: PaneTransform = {
        ...inner,
        world,
        effectiveAlpha: inner.effectiveAlpha * alpha
      }
      const innerAlpha = combined.effectiveAlpha

      if (inner.pane.kind === 'pic1') {
        const picture = inner.pane as PicturePane
        const bound = this.materialTexture(
          document,
          picture.materialIndex,
          options.showTextures,
          null
        )
        this.useTexture(bound?.texture ?? this.textures.white)
        this.quad(
          cornersOf(combined),
          [
            toColor(picture.colorBottomLeft, innerAlpha),
            toColor(picture.colorBottomRight, innerAlpha),
            toColor(picture.colorTopRight, innerAlpha),
            toColor(picture.colorTopLeft, innerAlpha)
          ],
          bound ? uvCorners(picture.texCoords[0] ?? FULL_QUAD_UV, bound.material) : FLAT_UV
        )
      } else if (inner.pane.kind === 'wnd1') {
        this.buildWindow(document, combined, inner.pane as WindowPane, innerAlpha, options, null)
      } else if (inner.pane.kind === 'txt1') {
        const raster = options.showTextures ? this.text.lookup(inner.pane as TextPane) : null
        const tint = [1, 1, 1, innerAlpha]
        if (raster) {
          this.useTexture(raster)
          this.quad(cornersOf(combined), [tint, tint, tint, tint], FULL_QUAD_UV_CORNERS)
        }
      } else if (inner.pane.kind === 'prt1') {
        this.buildPart(combined, inner.pane as PartPane, innerAlpha, options, depth + 1)
      }
    }
  }

  private buildPaneOutlines(camera: Camera, options: RenderOptions): void {
    const selected = new Set(options.selectedIds)

    for (const entry of this.lastFlattened) {
      if (!entry.visible && !options.showInvisiblePanes) continue

      const corners = cornersOf(entry)
      const isSelected = selected.has(entry.pane.id)
      const outlineColor = isSelected
        ? [0.4, 0.7, 1, 1]
        : entry.pane.kind === 'bnd1'
          ? [0.3, 0.6, 0.8, 0.5]
          : [0.5, 0.5, 0.55, 0.35]
      this.outline(corners, outlineColor)

      if (isSelected) {
        // A second, slightly inset outline reads as a thicker highlight without
        // needing a line-width setting WebGL does not reliably support.
        const [left, bottom, right, top] = localBounds(entry.pane, entry.values)
        const inset = 1 / camera.zoom
        this.outline(
          [
            apply(entry.world, left + inset, bottom + inset),
            apply(entry.world, right - inset, bottom + inset),
            apply(entry.world, right - inset, top - inset),
            apply(entry.world, left + inset, top - inset)
          ] as [number, number][],
          outlineColor
        )
      }
    }
  }

  private buildGrid(
    camera: Camera,
    halfWidth: number,
    halfHeight: number,
    gridSize: number
  ): void {
    const left = camera.x - halfWidth
    const right = camera.x + halfWidth
    const bottom = camera.y - halfHeight
    const top = camera.y + halfHeight

    // Skip drawing when the grid would be denser than a few pixels per line.
    if ((right - left) / gridSize > 400) return

    const color = [1, 1, 1, 0.05]
    const axisColor = [1, 1, 1, 0.16]

    const startX = Math.floor(left / gridSize) * gridSize
    for (let x = startX; x <= right; x += gridSize) {
      this.line([x, bottom], [x, top], x === 0 ? axisColor : color)
    }
    const startY = Math.floor(bottom / gridSize) * gridSize
    for (let y = startY; y <= top; y += gridSize) {
      this.line([left, y], [right, y], y === 0 ? axisColor : color)
    }
  }
}

/** Local-space rect [left, bottom, right, top] to world corners BL, BR, TR, TL. */
function rectCorners(
  entry: PaneTransform,
  rect: readonly [number, number, number, number]
): [number, number][] {
  const [left, bottom, right, top] = rect
  return [
    apply(entry.world, left, bottom),
    apply(entry.world, right, bottom),
    apply(entry.world, right, top),
    apply(entry.world, left, top)
  ]
}

/** BL, BR, TR, TL in world space. */
function cornersOf(entry: PaneTransform): [number, number][] {
  const [left, bottom, right, top] = localBounds(entry.pane, entry.values)
  return [
    apply(entry.world, left, bottom),
    apply(entry.world, right, bottom),
    apply(entry.world, right, top),
    apply(entry.world, left, top)
  ]
}

/** BL, BR, TR, TL for a texture that covers the whole quad, v down. */
const FULL_QUAD_UV_CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0]
]

/** UVs for an untextured quad: any constant works, since the texture is 1x1. */
const FLAT_UV: readonly [number, number][] = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0]
]

/**
 * Pane UVs in BL, BR, TR, TL order, with the material's texture transform
 * applied.
 *
 * The transform interpretation — scale and rotate about the centre of UV space,
 * then translate — is the common reading of these fields and matches what
 * Switch Toolbox's preview does. It is **not** verified against real game
 * output, and almost every shipped material leaves it at identity, so treat a
 * non-identity result as approximate.
 */
function uvCorners(
  coords: TexCoordSet,
  material: Material,
  override?: MaterialOverride
): [number, number][] {
  const raw: [number, number][] = [
    [coords.bottomLeft[0], coords.bottomLeft[1]],
    [coords.bottomRight[0], coords.bottomRight[1]],
    [coords.topRight[0], coords.topRight[1]],
    [coords.topLeft[0], coords.topLeft[1]]
  ]

  const stored = material.textureTransforms[0]
  // FLTS animates the texture SRT, so the effective transform can be non-identity
  // even when the stored one is not.
  const transform = stored
    ? {
        translate: [
          override?.textureTranslate?.[0] ?? stored.translate[0],
          override?.textureTranslate?.[1] ?? stored.translate[1]
        ] as Vec2,
        rotate: override?.textureRotate ?? stored.rotate,
        scale: [
          override?.textureScale?.[0] ?? stored.scale[0],
          override?.textureScale?.[1] ?? stored.scale[1]
        ] as Vec2
      }
    : null
  if (!transform || isIdentityTransform(transform)) return raw

  const radians = (transform.rotate * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  return raw.map(([u, v]): [number, number] => {
    const cu = (u - 0.5) * transform.scale[0]
    const cv = (v - 0.5) * transform.scale[1]
    return [
      cu * cos - cv * sin + 0.5 + transform.translate[0],
      cu * sin + cv * cos + 0.5 + transform.translate[1]
    ]
  })
}

function isIdentityTransform(transform: {
  translate: Vec2
  rotate: number
  scale: Vec2
}): boolean {
  return (
    transform.translate[0] === 0 &&
    transform.translate[1] === 0 &&
    transform.rotate === 0 &&
    transform.scale[0] === 1 &&
    transform.scale[1] === 1
  )
}

/**
 * Converts a stored colour to a normalised vertex colour, letting an animation
 * replace individual channels. `override` is a sparse [r, g, b, a] in 0..255.
 */
function toColor(
  rgba: Rgba,
  alpha: number,
  override?: readonly (number | undefined)[]
): number[] {
  const channel = (index: number): number => (override?.[index] ?? rgba[index]!) / 255
  return [channel(0), channel(1), channel(2), channel(3) * alpha]
}

/** Column-major mat3 mapping layout space to clip space. */
function viewMatrix(camera: Camera, halfWidth: number, halfHeight: number): Float32Array {
  const sx = 1 / halfWidth
  const sy = 1 / halfHeight
  return new Float32Array([sx, 0, 0, 0, sy, 0, -camera.x * sx, -camera.y * sy, 1])
}
