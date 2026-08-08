import { basename } from 'node:path'
import { Effect } from 'effect'

import { detectCompression, isSupportedCompression } from '@shared/formats/compression'
import { decodeBfttf, isBfcpx, isBfttf, parseBfcpx } from '@shared/formats/font'
import { countNodes, isByml, parseByml, toBymlView } from '@shared/formats/byml'
import { isBntx, formatName, isFormatSupported, parseBntx } from '@shared/formats/bntx'
import {
  isAamp,
  parseAamp,
  walkAamp,
  type AampParameter,
  type AampValue
} from '@shared/formats/aamp'
import { isAinb, parseAinb, type AinbValueCounts } from '@shared/formats/ainb'
import { isBfres, parseBfres } from '@shared/formats/bfres'
import {
  bwavChannelCount,
  bwavHeaderSize,
  describeBwavCodec,
  isBwav,
  parseBwav
} from '@shared/formats/bwav'
import { isMsbt, parseMsbt } from '@shared/formats/msbt'
import { isSarc, parseSarc } from '@shared/formats/sarc'
import { classifyEntry } from '@shared/formats/entry-kind'
import type { LayoutSource, Preview, PreviewContent } from '@shared/contract'
import { FileNotFoundError, IoError, NotFoundError } from '@main/errors'
import { ArchiveService } from './archive'
import { CompressionService } from './compression'
import { FilesService } from './files'

/**
 * Works out what can be shown for a file that is not a layout.
 *
 * Most of a romfs is not a layout, and until now everything else was a dead end: the file tree
 * and the archive browser would classify a font, a texture container or a data tree and then
 * report "cannot open" for files this build reads perfectly well. A font *archive* was the worst
 * case — it opened as an archive whose every entry did nothing, which looks like the app being
 * broken rather than a feature being absent.
 *
 * One entry point for both sources, because "open the thing I clicked" should not depend on
 * whether the thing is loose on disk or inside a SARC.
 *
 * Sniffed rather than trusted by extension. A romfs stacks suffixes (`Foo.Nin_NX_NVN.bfarc.zs`)
 * and misnames things often enough that the bytes are the only reliable answer; the extension is
 * used only to choose between equally valid readings.
 */

/**
 * How many messages one preview carries.
 *
 * Generous enough that most tables arrive whole, small enough that one click cannot pull a 61 MB
 * text corpus across the RPC boundary.
 */
const MESSAGE_LIMIT = 2000

/** Same reasoning for parameter nodes: one archive can hold thousands. */
const PARAMETER_LIMIT = 3000

/** And for logic nodes: the largest graph in the dump holds a few thousand. */
const NODE_LIMIT = 2000

/** Faces and complexes found in a font archive, or a single loose face. */
interface FontContent {
  readonly faces: { name: string; kind: 'otf' | 'ttf' | 'ttc'; bytes: number; sfnt: Blob }[]
  readonly complexes: { name: string; faces: string[] }[]
  readonly missing: string[]
}

export class PreviewService extends Effect.Service<PreviewService>()('PreviewService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const archives = yield* ArchiveService
    const compression = yield* CompressionService

    const bytesOf = (
      source: LayoutSource
    ): Effect.Effect<Uint8Array, FileNotFoundError | IoError | NotFoundError> =>
      source.kind === 'file'
        ? files.read(source.path)
        : archives.readEntry(source.archiveId, source.entryKey)

    const nameOf = (source: LayoutSource): string =>
      source.kind === 'file' ? basename(source.path) : source.entryKey

    const open = (
      source: LayoutSource
    ): Effect.Effect<Preview, FileNotFoundError | IoError | NotFoundError> =>
      Effect.gen(function* () {
        const raw = yield* bytesOf(source)
        const name = nameOf(source)
        // Only the three the contract models; anything else is reported as uncompressed, which
        // is true of the bytes actually being previewed.
        const sniffed = detectCompression(raw)
        const outer = isSupportedCompression(sniffed) ? sniffed : ('none' as const)

        // A file that is not compressed is not an error, so a failed decompress falls back to
        // the original bytes rather than failing the preview.
        const decompressed = yield* Effect.orElseSucceed(compression.decompress(raw), () => ({
          data: raw,
          kind: 'none' as const
        }))
        const data = decompressed.data

        const describe = (format: string, content: PreviewContent): Preview => ({
          name,
          format,
          compression: decompressed.kind === 'none' ? outer : decompressed.kind,
          bytes: data.length,
          content
        })

        /*
         * A SARC is only interesting here when it is a *font* archive. Anything else already has
         * a home in the archive browser, and duplicating that here would be a worse version of
         * it — but a font archive's entries are precisely what has nowhere to go.
         */
        if (isSarc(data)) {
          const font = yield* Effect.orElseSucceed(
            Effect.sync(() => readFontArchive(data)),
            () => null
          )
          if (font && (font.faces.length > 0 || font.complexes.length > 0)) {
            return describe('font archive', { kind: 'font', ...font })
          }
          return describe('SARC', {
            kind: 'unsupported',
            reason: 'This is an archive; open it in the Archive tab to see its entries.'
          })
        }

        if (isBfttf(data)) {
          const decoded = yield* Effect.orElseSucceed(
            Effect.sync(() => decodeBfttf(data)),
            () => null
          )
          if (!decoded) {
            return describe('BFTTF', {
              kind: 'unsupported',
              reason: 'This font is wrapped in a way this build does not recognise.'
            })
          }
          return describe(decoded.kind === 'otf' ? 'BFOTF' : 'BFTTF', {
            kind: 'font',
            faces: [
              {
                name: stem(name),
                kind: decoded.kind,
                bytes: decoded.sfnt.length,
                sfnt: new Blob([decoded.sfnt])
              }
            ],
            complexes: [],
            missing: []
          })
        }

        if (isBfcpx(data)) {
          const parsed = yield* Effect.orElseSucceed(
            Effect.sync(() => parseBfcpx(data)),
            () => null
          )
          return describe('BFCPX', {
            kind: 'font',
            faces: [],
            complexes: parsed ? [{ name: stem(name), faces: [...parsed.faces] }] : [],
            // Every face a lone descriptor names is elsewhere, which is the point of saying so.
            missing: parsed ? [...parsed.faces] : []
          })
        }

        if (isBntx(data)) {
          const container = yield* Effect.orElseSucceed(
            Effect.sync(() => parseBntx(data)),
            () => null
          )
          if (!container) {
            return describe('BNTX', {
              kind: 'unsupported',
              reason: 'This texture container could not be parsed.'
            })
          }
          return describe('BNTX', {
            kind: 'textures',
            textures: container.textures.map((texture) => ({
              name: texture.name,
              container: name,
              width: texture.width,
              height: texture.height,
              mipCount: texture.mipCount,
              format: formatName(texture.format, texture.formatVariant),
              decodable: isFormatSupported(texture.format, texture.formatVariant)
            }))
          })
        }

        if (isBfres(data)) {
          const model = yield* Effect.orElseSucceed(
            Effect.sync(() => parseBfres(data)),
            () => null
          )
          if (!model) {
            return describe('BFRES', {
              kind: 'unsupported',
              reason: 'This model container could not be parsed.'
            })
          }
          const kinds = new Map<string, number>()
          for (const subfile of model.subfiles) {
            kinds.set(subfile.kind, (kinds.get(subfile.kind) ?? 0) + 1)
          }
          return describe('BFRES', {
            kind: 'model',
            version: model.version,
            name: model.name,
            modelCount: model.modelCount,
            subfileCount: model.subfileCount,
            models: model.models.map((entry) => ({
              name: entry.name,
              shapeCount: entry.shapeCount,
              materialCount: entry.materialCount,
              boneCount: entry.boneCount,
              vertexCount: entry.vertexCount,
              materials: entry.materials.map((material) => ({
                name: material.name,
                textures: [...material.textures],
                textureCount: material.textureCount
              }))
            })),
            subfileKinds: [...kinds]
              .sort((a, b) => b[1] - a[1])
              .map(([subfileKind, count]) => ({ kind: subfileKind, count }))
          })
        }

        if (isAamp(data)) {
          const parsed = yield* Effect.orElseSucceed(
            Effect.sync(() => parseAamp(data)),
            () => null
          )
          if (!parsed) {
            return describe('AAMP', {
              kind: 'unsupported',
              reason: 'This parameter archive could not be parsed.'
            })
          }
          /*
           * Flattened for display. A tree renderer would be a second BYML viewer for a structure
           * that is only ever a few levels deep, and depth plus indentation says the same thing.
           */
          const nodes: {
            depth: number
            kind: 'list' | 'object' | 'parameter'
            label: string
            type: string
            value: string
            verified: boolean
          }[] = []
          let total = 0
          walkAamp(parsed.root, (node, nodeKind, depth) => {
            total++
            if (nodes.length >= PARAMETER_LIMIT) return
            // The visitor is not discriminated by its `kind` argument, so the narrowing is explicit.
            const parameter = nodeKind === 'parameter' ? (node as AampParameter) : null
            nodes.push({
              depth,
              kind: nodeKind,
              label: node.label,
              type: parameter ? parameter.typeName : nodeKind,
              value: parameter ? renderAampValue(parameter.value) : '',
              verified: parameter ? parameter.verified : true
            })
          })

          return describe('AAMP', {
            kind: 'parameters',
            typeName: parsed.typeName,
            version: parsed.version,
            counts: parsed.counts,
            unresolvedNames: parsed.unresolvedNames,
            nodes,
            total
          })
        }

        if (isBwav(data)) {
          /*
           * Only the header region is parsed, which is the whole point of the API taking a prefix:
           * these run to tens of megabytes and there are 946 of them.
           */
          const header = yield* Effect.orElseSucceed(
            Effect.sync(() => {
              const channels = bwavChannelCount(data)
              return parseBwav(data.subarray(0, bwavHeaderSize(channels)), {
                fileSize: data.length
              })
            }),
            () => null
          )
          if (!header) {
            return describe('BWAV', {
              kind: 'unsupported',
              reason: 'This audio header could not be parsed.'
            })
          }
          return describe('BWAV', {
            kind: 'audio',
            channelCount: header.channelCount,
            sampleRate: header.sampleRate,
            codec: describeBwavCodec(header.channels[0]?.codec ?? -1),
            durationSeconds: header.durationSeconds,
            looping: header.looping,
            decodable: header.decodable,
            undecodableReason: header.undecodableReason
          })
        }

        if (isAinb(data)) {
          const logic = yield* Effect.orElseSucceed(
            Effect.sync(() => parseAinb(data)),
            () => null
          )
          if (!logic) {
            return describe('AINB', {
              kind: 'unsupported',
              reason: 'This logic graph could not be parsed — see the version it declares.'
            })
          }

          /*
           * Module references, deduplicated. A node whose name ends in `.module` names another AINB
           * file, which is the one relationship the format gives up without decoding node bodies —
           * so it is worth surfacing as something the user can follow.
           */
          const modules = [
            ...new Set(
              logic.nodes
                .filter((node) => node.name.endsWith('.module'))
                .map((node) => node.name)
            )
          ].sort()

          return describe('AINB', {
            kind: 'logic',
            name: logic.name,
            category: logic.category,
            version: logic.versionText,
            commands: logic.commands.map((command) => ({
              name: command.name,
              entryNodeIndex: command.entryNodeIndex
            })),
            nodeCount: logic.nodeCount,
            nodes: logic.nodes.slice(0, NODE_LIMIT).map((node) => ({
              index: node.index,
              type: node.type,
              userDefined: node.userDefined,
              name: node.name
            })),
            nodeTypeCounts: logic.nodeTypeCounts.map((entry) => ({ ...entry })),
            modules,
            globalParameterCount: logic.globalParameterCount,
            parameterCounts: {
              immediate: sumCounts(logic.immediateParameterCounts),
              input: sumCounts(logic.inputParameterCounts),
              output: sumCounts(logic.outputParameterCounts)
            },
            problems: [...logic.problems]
          })
        }

        if (isMsbt(data)) {
          const document = yield* Effect.orElseSucceed(
            Effect.sync(() => parseMsbt(data)),
            () => null
          )
          if (!document) {
            return describe('MSBT', {
              kind: 'unsupported',
              reason: 'This message table could not be parsed.'
            })
          }
          return describe('MSBT', {
            kind: 'messages',
            encoding: document.encoding,
            total: document.messages.length,
            messages: document.messages.slice(0, MESSAGE_LIMIT)
          })
        }

        if (isByml(data)) {
          const document = yield* Effect.orElseSucceed(
            Effect.sync(() => {
              const parsed = parseByml(data)
              return toBymlView(parsed, parsed.root === null ? 0 : countNodes(parsed.root))
            }),
            () => null
          )
          if (!document) {
            return describe('BYML', {
              kind: 'unsupported',
              reason: 'This document could not be parsed.'
            })
          }
          return describe('BYML', { kind: 'data', document })
        }

        /*
         * Nothing recognised. The magic is reported rather than swallowed, because "BFRES, which
         * this build does not decode yet" is a useful thing to be told and "cannot open" is not.
         */
        const magic = printableMagic(data)
        const kind = classifyEntry(name)
        return describe(magic ?? 'unknown', {
          kind: 'unsupported',
          reason: magic
            ? `${magic} is ${kind === 'other' ? 'not a format' : `a ${kind} format`} this build does not read yet.`
            : `Starts with ${hexMagic(data)}, which this build does not recognise.`
        })
      })

    return { open } as const
  })
}) {}

/**
 * Reads a font archive's complexes and faces.
 *
 * Entries are matched by their contents, not their folder: `fcpx/` and `scft/` are the convention
 * but nothing depends on it, and a face that fails to decode is skipped rather than failing the
 * whole archive — one bad entry should not make the other twenty unviewable.
 */
function readFontArchive(data: Uint8Array): FontContent {
  const archive = parseSarc(data)
  const faces: FontContent['faces'] = []
  const complexes: FontContent['complexes'] = []
  const present = new Set<string>()

  for (const entry of archive.entries) {
    const name = stem(entry.name ?? '')
    if (isBfcpx(entry.data)) {
      try {
        complexes.push({ name, faces: [...parseBfcpx(entry.data).faces] })
      } catch {
        // A descriptor that will not parse is simply not listed.
      }
      continue
    }
    if (!isBfttf(entry.data)) continue
    try {
      const decoded = decodeBfttf(entry.data)
      faces.push({
        name,
        kind: decoded.kind,
        bytes: decoded.sfnt.length,
        sfnt: new Blob([decoded.sfnt])
      })
      present.add(name.toLowerCase())
    } catch {
      // Same: a face this build cannot unwrap is omitted, not fatal.
    }
  }

  // Faces a chain asks for that this archive does not hold — a real situation, and one worth
  // showing rather than quietly rendering a shorter chain.
  const missing = [
    ...new Set(
      complexes
        .flatMap((complex) => complex.faces)
        .filter((face) => !present.has(stem(face).toLowerCase()))
    )
  ]

  return { faces, complexes, missing }
}

function stem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.replace(/\.[^.]*$/, '')
}

function printableMagic(data: Uint8Array): string | null {
  if (data.length < 4) return null
  const magic = String.fromCharCode(...data.subarray(0, 4))
  return /^[\x20-\x7e]{4}$/.test(magic) ? magic.trim() : null
}

function hexMagic(data: Uint8Array): string {
  return [...data.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

/**
 * One AAMP value as display text.
 *
 * `unknown` keeps its type byte rather than showing something plausible: the parser deliberately
 * refuses to interpret types it has never seen in real files, and hiding that would undo the point.
 */
function renderAampValue(value: AampValue): string {
  switch (value.kind) {
    case 'bool':
      return value.value ? 'true' : 'false'
    case 'int':
    case 'u32':
      return String(value.value)
    case 'f32':
      return formatFloat(value.value)
    case 'floats':
      return `[${value.value.map(formatFloat).join(', ')}]`
    case 'string':
      return JSON.stringify(value.value) + (value.truncated ? ' (truncated)' : '')
    case 'curves':
      return `${value.value.length} curve${value.value.length === 1 ? '' : 's'}`
    case 'buffer':
      return `${value.value.length} values`
    case 'unknown':
      return `unknown type ${value.typeByte} — ${value.reason}`
    default: {
      const exhaustive: never = value
      return String(exhaustive)
    }
  }
}

/** Trims the float noise that makes a parameter list unreadable, without rounding meaning away. */
function formatFloat(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

/** Total parameters across the six value types, for a per-file summary. */
function sumCounts(counts: AinbValueCounts): number {
  return counts.int + counts.bool + counts.float + counts.string + counts.vec3f + counts.pointer
}
