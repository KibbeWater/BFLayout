import { writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { nativeImage } from 'electron'
import { Effect } from 'effect'

import { FormatParseError, UnsupportedFormatError } from '@shared/binary/errors'
import {
  decodeTexture,
  formatName,
  isBntx,
  isFormatSupported,
  parseBntx,
  type BntxContainer,
  type BntxTexture
} from '@shared/formats/bntx'
import type { DecodedTexture, LayoutSource, TextureInfo, TextureList } from '@shared/contract'
import { FileNotFoundError, IoError, NotFoundError } from '@main/errors'
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
              providers.push({ label: path, fromDisk: true, load: files.read(path) })
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
              load: archives.readEntry(archiveId, entry.key)
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

        const bgra = new Uint8Array(rgba.length)
        for (let i = 0; i < rgba.length; i += 4) {
          bgra[i] = rgba[i + 2]!
          bgra[i + 1] = rgba[i + 1]!
          bgra[i + 2] = rgba[i]!
          bgra[i + 3] = rgba[i + 3]!
        }

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

    return { list, get, exportPng } as const
  })
}) {}
