import { writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { nativeImage } from 'electron'
import { Effect } from 'effect'

import { FormatParseError, FormatWriteError, UnsupportedFormatError } from '@shared/binary/errors'
import {
  decodeTexture,
  encodeSurface,
  formatInfo,
  formatName,
  halveRgba,
  isBntx,
  isFormatSupported,
  mipBlockHeightLog2,
  parseBntx,
  swizzle,
  whyNotEncodable,
  divRoundUp,
  type BntxContainer,
  type BntxTexture
} from '@shared/formats/bntx'
import type { DecodedTexture, LayoutSource, TextureInfo, TextureList } from '@shared/contract'
import { FileNotFoundError, IoError, NotFoundError, ReadOnlyError } from '@main/errors'
import { resolveWrite } from '@main/mod-layer'
import { ArchiveService } from './archive'
import { FilesService } from './files'

/**
 * Where a BNTX container was found. `label` is what the UI shows and what error
 * messages name, so it has to be recognisable to someone looking at the archive.
 */
interface Provider {
  readonly label: string
  /**
   * True for loose files on disk. Their bytes are re-read on every access, so the
   * parsed container has to be cached by label; archive entries are cached by
   * their byte array instead, which invalidates itself when an entry is replaced.
   */
  readonly fromDisk: boolean
  readonly load: Effect.Effect<Uint8Array, FileNotFoundError | IoError | NotFoundError>
  /**
   * Where a rewritten container goes back to.
   *
   * Carried on the provider because that is the only place that still knows
   * whether these bytes came off disk or out of an archive — by the time a texture
   * has been resolved, all that survives is a label.
   */
  readonly write: (
    bytes: Uint8Array
  ) => Effect.Effect<
    { path: string | null; redirected: boolean },
    IoError | ReadOnlyError | NotFoundError | FormatWriteError
  >
}

/** A resolved texture: which container holds it and where inside it. */
interface Resolved {
  readonly provider: string
  readonly container: BntxContainer
  readonly texture: BntxTexture
}

const TEXTURE_EXTENSION = '.bntx'

/**
 * Folder Nintendo puts textures in inside a layout archive. Entries elsewhere in
 * the archive are still searched — some titles flatten the structure — but this
 * one is searched first so a name that exists in both resolves the usual way.
 */
const TEXTURE_FOLDER = 'timg/'

/**
 * Decoded RGBA is large: a 1024×1024 texture is 4 MB. The cache is bounded by
 * total bytes rather than entry count, because entry count says nothing about
 * how much memory is actually held.
 */
const CACHE_BUDGET_BYTES = 96 * 1024 * 1024

interface CacheKey {
  readonly texture: BntxTexture
  readonly mip: number
}

/**
 * Names in a layout's texture list do not reliably match the name inside the
 * BNTX: some titles list "Foo.bntx", others "Foo", and case varies between the
 * layout and the container. Everything is matched on this normal form.
 */
function normalizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const withoutExtension = base.toLowerCase().endsWith(TEXTURE_EXTENSION)
    ? base.slice(0, -TEXTURE_EXTENSION.length)
    : base
  return withoutExtension.toLowerCase()
}

function describeLoadFailure(error: FileNotFoundError | IoError | NotFoundError): string {
  switch (error._tag) {
    case 'FileNotFoundError':
      return 'file no longer exists'
    case 'NotFoundError':
      return 'archive entry no longer exists'
    default:
      return error.detail
  }
}

export class TextureService extends Effect.Service<TextureService>()('TextureService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const archives = yield* ArchiveService

    /**
     * Parsed containers, keyed by the byte array they came from. A WeakMap makes
     * invalidation automatic and exact: replacing an archive entry produces a new
     * Uint8Array, so the stale container becomes unreachable instead of being
     * served from a key that looks unchanged.
     */
    const parsed = new WeakMap<Uint8Array, BntxContainer>()

    /** Containers whose bytes are not parseable, so we stop retrying them. */
    const unparseable = new WeakMap<Uint8Array, string>()

    /** Sibling files are read fresh each time, so they are cached by path. */
    const byPath = new Map<string, BntxContainer | { error: string }>()

    const decoded = new WeakMap<BntxTexture, Map<number, DecodedTexture>>()
    const lru: CacheKey[] = []
    let cachedBytes = 0

    const providersFor = (
      source: LayoutSource
    ): Effect.Effect<Provider[], IoError | NotFoundError> =>
      Effect.gen(function* () {
        const providers: Provider[] = []

        if (source.kind === 'file') {
          // A loose layout has no archive, so its textures live beside it —
          // either in the same folder or in a timg/ subfolder.
          const directory = dirname(source.path)
          for (const folder of [directory, join(directory, 'timg')]) {
            const names = yield* files.listDir(folder)
            for (const name of names) {
              if (!name.toLowerCase().endsWith(TEXTURE_EXTENSION)) continue
              const path = join(folder, name)
              providers.push({
                label: path,
                fromDisk: true,
                load: files.read(path),
                write: (bytes) =>
                  Effect.gen(function* () {
                    // Through the mod layer like every other write, so importing a
                    // texture into a dump's container produces a copy in the mod.
                    const resolved = resolveWrite(path)
                    yield* files.writeAtomic(resolved.path, bytes)
                    byPath.delete(path)
                    return { path: resolved.path, redirected: resolved.redirected }
                  })
              })
            }
          }
          return providers
        }

        // Own archive first, texture folder before anything else in it, then
        // every other open archive — layouts routinely reference a shared
        // texture archive the user has opened separately.
        const ordered = [
          source.archiveId,
          ...(yield* archives.list)
            .map((archive) => archive.archiveId)
            .filter((id) => id !== source.archiveId)
        ]

        for (const archiveId of ordered) {
          const descriptor = yield* archives.describeOne(archiveId)
          const candidates = descriptor.entries.filter((entry) =>
            entry.displayName.toLowerCase().endsWith(TEXTURE_EXTENSION)
          )
          const inFolder = candidates.filter((entry) =>
            entry.displayName.toLowerCase().startsWith(TEXTURE_FOLDER)
          )
          const elsewhere = candidates.filter(
            (entry) => !entry.displayName.toLowerCase().startsWith(TEXTURE_FOLDER)
          )
          for (const entry of [...inFolder, ...elsewhere]) {
            providers.push({
              label:
                archiveId === source.archiveId
                  ? entry.displayName
                  : `${descriptor.displayName}:${entry.displayName}`,
              fromDisk: false,
              load: archives.readEntry(archiveId, entry.key),
              write: (bytes) =>
                Effect.gen(function* () {
                  /*
                   * Into the in-memory archive. The bytes reach disk when the
                   * archive is saved, which is also what routes them through the
                   * mod layer — the same two-step a layout save takes.
                   */
                  yield* archives.replaceEntry(archiveId, entry.key, bytes)
                  return { path: null, redirected: false }
                })
            })
          }
        }

        return providers
      })

    /**
     * Parses a provider's bytes, remembering both successes and failures.
     *
     * Never fails: a container that cannot be read or parsed is reported as a
     * reason string. One unreadable BNTX must not take down the whole texture
     * list — the user needs to see the other textures *and* be told what broke.
     */
    const containerOf = (
      provider: Provider
    ): Effect.Effect<BntxContainer | { error: string }> =>
      Effect.gen(function* () {
        if (provider.fromDisk) {
          const cached = byPath.get(provider.label)
          if (cached) return cached
        }

        const loaded = yield* Effect.either(provider.load)
        if (loaded._tag === 'Left') {
          return { error: describeLoadFailure(loaded.left) }
        }
        const bytes = loaded.right

        const hit = parsed.get(bytes)
        if (hit) return hit
        const failed = unparseable.get(bytes)
        if (failed !== undefined) return { error: failed }

        const result: BntxContainer | { error: string } = isBntx(bytes)
          ? yield* Effect.try({
              try: (): BntxContainer | { error: string } => parseBntx(bytes),
              catch: (cause): { error: string } => ({
                error: cause instanceof Error ? cause.message : String(cause)
              })
            }).pipe(Effect.merge)
          : { error: 'not a BNTX container' }

        if ('error' in result) unparseable.set(bytes, result.error)
        else parsed.set(bytes, result)
        if (provider.fromDisk) byPath.set(provider.label, result)
        return result
      })

    const list = (source: LayoutSource): Effect.Effect<TextureList, IoError | NotFoundError> =>
      Effect.gen(function* () {
        const providers = yield* providersFor(source)
        const textures: TextureInfo[] = []
        const unreadable: { container: string; detail: string }[] = []
        const seen = new Set<string>()

        for (const provider of providers) {
          const container = yield* containerOf(provider)
          if ('error' in container) {
            unreadable.push({ container: provider.label, detail: container.error })
            continue
          }
          for (const texture of container.textures) {
            // First provider wins, matching how resolution works, so the list
            // never advertises a texture the editor would not actually load.
            const key = normalizeName(texture.name)
            if (seen.has(key)) continue
            seen.add(key)
            textures.push({
              name: texture.name,
              container: provider.label,
              width: texture.width,
              height: texture.height,
              mipCount: texture.mipCount,
              format: formatName(texture.format, texture.formatVariant),
              decodable: isFormatSupported(texture.format, texture.formatVariant)
            })
          }
        }

        textures.sort((a, b) => a.name.localeCompare(b.name))
        return { textures, containerCount: providers.length, unreadable }
      })

    const resolve = (
      source: LayoutSource,
      name: string
    ): Effect.Effect<Resolved, IoError | NotFoundError> =>
      Effect.gen(function* () {
        const wanted = normalizeName(name)
        const providers = yield* providersFor(source)

        for (const provider of providers) {
          const container = yield* containerOf(provider)
          if ('error' in container) continue
          const texture = container.textures.find((entry) => normalizeName(entry.name) === wanted)
          if (texture) return { provider: provider.label, container, texture }
        }

        // A single-texture container named after the file is common enough that
        // matching the container name is worth a second pass.
        for (const provider of providers) {
          if (normalizeName(basename(provider.label)) !== wanted) continue
          const container = yield* containerOf(provider)
          if ('error' in container) continue
          const texture = container.textures[0]
          if (texture) return { provider: provider.label, container, texture }
        }

        return yield* Effect.fail(new NotFoundError({ kind: 'texture', id: name }))
      })

    const evictTo = (budget: number): void => {
      while (cachedBytes > budget) {
        const oldest = lru.shift()
        if (!oldest) break
        const levels = decoded.get(oldest.texture)
        const image = levels?.get(oldest.mip)
        if (image) {
          cachedBytes -= image.width * image.height * 4
          levels?.delete(oldest.mip)
        }
      }
    }

    const get = (
      source: LayoutSource,
      name: string,
      mip = 0
    ): Effect.Effect<
      DecodedTexture,
      IoError | NotFoundError | UnsupportedFormatError | FormatParseError
    > =>
      Effect.gen(function* () {
        const { texture } = yield* resolve(source, name)

        const levels = decoded.get(texture)
        const hit = levels?.get(mip)
        if (hit) {
          const at = lru.findIndex((entry) => entry.texture === texture && entry.mip === mip)
          if (at >= 0) lru.push(lru.splice(at, 1)[0]!)
          return hit
        }

        const image = yield* Effect.try({
          try: () => decodeTexture(texture, mip),
          catch: (cause) => {
            if (cause instanceof UnsupportedFormatError || cause instanceof FormatParseError) {
              return cause
            }
            return new FormatParseError({
              format: 'bntx',
              offset: 0,
              section: texture.name,
              message: cause instanceof Error ? cause.message : String(cause)
            })
          }
        })

        const result: DecodedTexture = {
          name: texture.name,
          width: image.width,
          height: image.height,
          format: formatName(texture.format, texture.formatVariant),
          // A Blob is the only binary form oRPC transports without expanding it
          // into JSON; see BinaryPayload in the contract.
          rgba: new Blob([image.rgba])
        }

        const store = levels ?? new Map<number, DecodedTexture>()
        store.set(mip, result)
        decoded.set(texture, store)
        lru.push({ texture, mip })
        cachedBytes += image.width * image.height * 4
        evictTo(CACHE_BUDGET_BYTES)

        return result
      })

    /** Reads a Blob's bytes; the cache stores them that way for the RPC boundary. */
    const blobBytes = (blob: DecodedTexture['rgba']): Effect.Effect<ArrayBuffer, IoError> =>
      Effect.tryPromise({
        try: () => blob.arrayBuffer(),
        catch: (cause) =>
          new IoError({
            detail: `could not read decoded pixels: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          })
      })

    /**
     * Writes a decoded texture to a PNG on disk.
     *
     * Textures are otherwise read-only, and getting one *out* of a game archive is
     * the first thing anyone wants: the archives ship BNTX with Tegra swizzling and
     * BCn or ASTC compression, which no image editor opens.
     *
     * Encoded with Electron's `nativeImage` rather than a PNG library, because it is
     * already here and this is the only place a real image format is needed. It wants
     * BGRA, so the channels are swapped on the way in.
     */
    const exportPng = (
      source: LayoutSource,
      name: string,
      path: string,
      mip = 0
    ): Effect.Effect<
      { path: string; width: number; height: number; bytes: number },
      IoError | NotFoundError | UnsupportedFormatError | FormatParseError
    > =>
      Effect.gen(function* () {
        const decodedTexture = yield* get(source, name, mip)
        const rgba = new Uint8Array(yield* blobBytes(decodedTexture.rgba))

        const bgra = premultipliedBgra(rgba)

        const png = yield* Effect.try({
          try: () => {
            const image = nativeImage.createFromBitmap(Buffer.from(bgra), {
              width: decodedTexture.width,
              height: decodedTexture.height
            })
            const encoded = image.toPNG()
            if (encoded.length === 0) throw new Error('the PNG encoder produced no bytes')
            return encoded
          },
          catch: (cause) =>
            new IoError({
              path,
              detail: `could not encode ${name} as PNG: ${
                cause instanceof Error ? cause.message : String(cause)
              }`
            })
        })

        yield* Effect.tryPromise({
          try: () => writeFile(path, png),
          catch: (cause) =>
            new IoError({
              path,
              detail: `could not write ${path}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`
            })
        })

        return {
          path,
          width: decodedTexture.width,
          height: decodedTexture.height,
          bytes: png.length
        }
      })

    /**
     * Replaces one texture's pixels from a PNG, in place.
     *
     * "In place" is the whole design. The container's structure — every offset, the
     * BRTI blocks, and the relocation table `nn::gfx` uses to fix up pointers at
     * load — is left exactly as it was, and only the pixel bytes change. Rebuilding
     * a BNTX would mean reproducing that relocation table, and getting it subtly
     * wrong produces a file this app reads back perfectly and the game refuses:
     * precisely the failure nobody would attribute to the tool.
     *
     * The cost of that safety is the two refusals below. The replacement has to
     * match the original's dimensions, and the original has to be in a format there
     * is an encoder for — which means uncompressed, because compressing to BCn or
     * ASTC well is a search, not a conversion. Both are reported as what to do
     * instead rather than as a failure.
     */
    const importPng = (
      source: LayoutSource,
      name: string,
      pngPath: string
    ): Effect.Effect<
      {
        container: string
        width: number
        height: number
        mipsWritten: number
        path: string | null
        redirected: boolean
      },
      | FileNotFoundError
      | IoError
      | ReadOnlyError
      | NotFoundError
      | UnsupportedFormatError
      | FormatParseError
      | FormatWriteError
    > =>
      Effect.gen(function* () {
        const providers = yield* providersFor(source)
        const wanted = normalizeName(name)

        let found: { provider: Provider; container: BntxContainer; texture: BntxTexture } | null =
          null
        for (const provider of providers) {
          const container = yield* containerOf(provider)
          if ('error' in container) continue
          const texture = container.textures.find((entry) => normalizeName(entry.name) === wanted)
          if (texture) {
            found = { provider, container, texture }
            break
          }
        }
        if (!found) {
          return yield* Effect.fail(new NotFoundError({ kind: 'texture', id: name }))
        }

        const { provider, texture } = found

        const refusal = whyNotEncodable(texture.format, texture.formatVariant)
        if (refusal !== null) {
          return yield* Effect.fail(new FormatWriteError({ format: 'bntx', section: name, message: refusal }))
        }
        const info = formatInfo(texture.format)
        if (!info) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'bntx',
              section: name,
              message: `${formatName(texture.format, texture.formatVariant)} has no known memory layout`
            })
          )
        }

        // Electron's decoder, rather than a hand-rolled one. It reads PNG, JPEG and
        // the platform's own formats, and it is already the encoder used by export.
        const image = yield* Effect.try({
          try: () => {
            const decodedImage = nativeImage.createFromPath(pngPath)
            if (decodedImage.isEmpty()) {
              throw new Error('the file could not be decoded as an image')
            }
            return decodedImage
          },
          catch: (cause) =>
            new IoError({
              path: pngPath,
              detail: `could not read ${basename(pngPath)} as an image: ${
                cause instanceof Error ? cause.message : String(cause)
              }`
            })
        })

        const size = image.getSize()
        if (size.width !== texture.width || size.height !== texture.height) {
          return yield* Effect.fail(
            new FormatWriteError({
              format: 'bntx',
              section: name,
              message: `${basename(pngPath)} is ${size.width}x${size.height} but ${name} is ${texture.width}x${texture.height}. Writing in place cannot change a texture's size — every offset in the container is built around it. Resize the image, or build a replacement .bntx and use Replace on the archive entry.`
            })
          )
        }

        // toBitmap gives premultiplied BGRA; the encoders want straight RGBA.
        let level = straightRgba(new Uint8Array(image.toBitmap()))
        let levelWidth = texture.width
        let levelHeight = texture.height

        const original = yield* provider.load
        const rewritten = new Uint8Array(original)
        let mipsWritten = 0

        for (let mip = 0; mip < texture.mipCount; mip++) {
          const offset = texture.dataOffset + (texture.mipOffsets[mip] ?? 0)
          const blockHeightLog2 = mipBlockHeightLog2(
            divRoundUp(levelHeight, info.blockHeight),
            texture.blockHeightLog2
          )

          const surface = swizzle(
            levelWidth,
            levelHeight,
            info.blockWidth,
            info.blockHeight,
            info.bytesPerBlock,
            texture.tileMode,
            blockHeightLog2,
            encodeSurface(level, levelWidth, levelHeight, texture.format, texture.formatVariant)
          )

          /*
           * A mip whose tiled size does not match what the file reserved for it is
           * where an in-place write stops being safe: writing it would run into the
           * next level, or the next texture. Everything written so far is discarded
           * — nothing has touched disk yet — and the refusal names the level.
           */
          const available =
            mip + 1 < texture.mipCount
              ? (texture.mipOffsets[mip + 1] ?? texture.imageData.length) -
                (texture.mipOffsets[mip] ?? 0)
              : texture.imageData.length - (texture.mipOffsets[mip] ?? 0)

          if (surface.length > available || offset + surface.length > rewritten.length) {
            return yield* Effect.fail(
              new FormatWriteError({
                format: 'bntx',
                section: name,
                message: `mip level ${mip} re-encodes to ${surface.length} bytes but the container reserved ${available}. Nothing has been written. This is a layout BFLayout does not reproduce exactly — please report the texture.`
              })
            )
          }

          rewritten.set(surface, offset)
          mipsWritten += 1

          if (mip + 1 < texture.mipCount) {
            const halved = halveRgba(level, levelWidth, levelHeight)
            level = halved.data
            levelWidth = halved.width
            levelHeight = halved.height
          }
        }

        const written = yield* provider.write(rewritten)

        // The decoded cache is keyed by the parsed texture object, which is about to
        // be replaced; dropping the parse forces both to be rebuilt from new bytes.
        parsed.delete(original)
        byPath.delete(provider.label)

        return {
          container: provider.label,
          width: texture.width,
          height: texture.height,
          mipsWritten,
          path: written.path,
          redirected: written.redirected
        }
      })

    return { list, get, exportPng, importPng } as const
  })
}) {}

/**
 * Straight-alpha RGBA to the premultiplied BGRA `nativeImage.createFromBitmap` wants.
 *
 * Both halves of that are needed and neither is obvious. The channel order is Chromium's
 * native N32 bitmap layout on little-endian; the premultiplication is because that layout
 * is premultiplied, while every decoder here produces straight alpha.
 *
 * Measured, not assumed: handing `createFromBitmap` a straight-alpha grey 128 at alpha 128
 * and inflating the PNG it produced gave 255,255,255,128 — the encoder's unpremultiply
 * pass divided by the alpha and clamped. Fully opaque textures came out right, which is
 * why a signature-and-size check never noticed, but anything translucent — most UI art —
 * was exported with its colours pushed toward white.
 */
/**
 * Premultiplied BGRA — what Electron's bitmaps carry — back to straight RGBA.
 *
 * Undoing the multiply is lossy where alpha is low, which is unavoidable: the
 * precision was thrown away when the image was premultiplied. Fully transparent
 * pixels keep their colour at zero rather than dividing by it.
 */
export function straightRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length)
  for (let at = 0; at < bgra.length; at += 4) {
    const alpha = bgra[at + 3]!
    if (alpha === 255 || alpha === 0) {
      out[at] = bgra[at + 2]!
      out[at + 1] = bgra[at + 1]!
      out[at + 2] = bgra[at]!
      out[at + 3] = alpha
      continue
    }
    out[at] = Math.min(255, Math.round((bgra[at + 2]! * 255) / alpha))
    out[at + 1] = Math.min(255, Math.round((bgra[at + 1]! * 255) / alpha))
    out[at + 2] = Math.min(255, Math.round((bgra[at]! * 255) / alpha))
    out[at + 3] = alpha
  }
  return out
}

export function premultipliedBgra(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3]!
    // The opaque case is exact and by far the most common, so it skips the arithmetic.
    if (alpha === 255) {
      out[i] = rgba[i + 2]!
      out[i + 1] = rgba[i + 1]!
      out[i + 2] = rgba[i]!
      out[i + 3] = 255
      continue
    }
    out[i] = Math.round((rgba[i + 2]! * alpha) / 255)
    out[i + 1] = Math.round((rgba[i + 1]! * alpha) / 255)
    out[i + 2] = Math.round((rgba[i]! * alpha) / 255)
    out[i + 3] = alpha
  }
  return out
}
