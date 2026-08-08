/**
 * Validates the codecs against real game files.
 *
 * This is the check the unit tests cannot do: they only prove the parser and
 * writer agree with each other. Here every layout, animation and texture in a
 * romfs dump is parsed, rewritten, and compared byte for byte against what
 * shipped. A mismatch means we are wrong, not the file.
 *
 *   pnpm validate:romfs <romfs-dir> [--limit N] [--verbose] [--only kinds]
 *
 * `--only` takes a comma-separated list of `archives`, `layouts`, `animations` and
 * `textures`. Decoding every texture in a dump takes tens of minutes, so narrowing
 * to what you are actually working on turns the feedback loop from a coffee break
 * into a few seconds.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { isSarc, parseSarc, writeSarc } from '../src/shared/formats/sarc/index.ts'
import { detectCompression } from '../src/shared/formats/compression.ts'
import { yaz0Decompress } from '../src/shared/formats/yaz0/index.ts'
import { isBflyt, parseBflyt, writeBflyt } from '../src/shared/formats/bflyt/index.ts'
import { isBflan, parseBflan, writeBflan } from '../src/shared/formats/bflan/index.ts'
import {
  decodeTexture,
  formatName,
  isBntx,
  isFormatSupported,
  parseBntx
} from '../src/shared/formats/bntx/index.ts'

interface Tally {
  ok: number
  mismatch: number
  failed: number
  /** First few problems, so output stays readable on a 60k-file dump. */
  problems: string[]
}

const newTally = (): Tally => ({ ok: 0, mismatch: 0, failed: 0, problems: [] })

const archives = newTally()
const layouts = newTally()
const animations = newTally()
const textures = newTally()
const unsupportedFormats = new Map<string, number>()
const sectionsSeen = new Map<string, number>()

const MAX_PROBLEMS = 12

function note(tally: Tally, message: string): void {
  if (tally.problems.length < MAX_PROBLEMS) tally.problems.push(message)
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -1
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i
  return -2
}

async function main(): Promise<void> {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: validate-romfs.ts <romfs-dir> [--limit N] [--verbose]')
    process.exit(1)
  }

  const limitFlag = process.argv.indexOf('--limit')
  const limit = limitFlag > 0 ? Number(process.argv[limitFlag + 1]) : Infinity
  const verbose = process.argv.includes('--verbose')

  const onlyFlag = process.argv.indexOf('--only')
  const only =
    onlyFlag > 0
      ? new Set((process.argv[onlyFlag + 1] ?? '').split(',').map((part) => part.trim()))
      : null
  enabled = only

  const known = ['archives', 'layouts', 'animations', 'textures']
  if (only) {
    const unknown = [...only].filter((kind) => !known.includes(kind))
    if (unknown.length > 0) {
      console.error(`unknown --only kind(s): ${unknown.join(', ')}; expected ${known.join(', ')}`)
      process.exit(2)
    }
  }

  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  const decompress = (data: Uint8Array): Uint8Array => {
    switch (detectCompression(data)) {
      case 'zstd':
        return new Uint8Array(zstd.decompress(data))
      case 'yaz0':
        return yaz0Decompress(data)
      default:
        return data
    }
  }

  const all: string[] = []
  walk(root, all)

  // Layout archives are what this validates; everything else in a romfs is
  // someone else's format.
  const candidates = all
    .filter((path) => /\.(blarc|szs|sarc|arc|bflyt|bflan|bntx)(\.zs)?$/i.test(path))
    .slice(0, limit)

  console.log(`scanning ${candidates.length} candidate files under ${root}\n`)

  for (const path of candidates) {
    if (statSync(path).size === 0) continue
    let data: Uint8Array
    try {
      data = decompress(new Uint8Array(readFileSync(path)))
    } catch (cause) {
      note(archives, `${basename(path)}: decompress failed: ${String(cause)}`)
      archives.failed++
      continue
    }

    if (isSarc(data)) {
      checkArchive(path, data, verbose)
    } else if (isBflyt(data)) {
      checkLayout(basename(path), data, verbose)
    } else if (isBflan(data)) {
      checkAnimation(basename(path), data, verbose)
    } else if (isBntx(data)) {
      checkTexture(basename(path), data, verbose)
    }
  }

  report()
}

function checkArchive(path: string, data: Uint8Array, verbose: boolean): void {
  // Archives are still walked when excluded, because the layouts and animations
  // worth checking live inside them; only the byte-comparison is skipped.
  let parsed
  try {
    parsed = parseSarc(data)
  } catch (cause) {
    archives.failed++
    note(archives, `${basename(path)}: ${describe(cause)}`)
    return
  }

  if (wanted('archives')) {
    try {
      const rewritten = writeSarc(parsed)
      const at = sameBytes(data, rewritten)
      if (at === -2) archives.ok++
      else {
        archives.mismatch++
        note(
          archives,
          `${basename(path)}: rewrite differs (${at === -1 ? `length ${data.length} vs ${rewritten.length}` : `first at 0x${at.toString(16)}`})`
        )
      }
    } catch (cause) {
      archives.failed++
      note(archives, `${basename(path)}: rewrite threw: ${describe(cause)}`)
    }
  }

  for (const entry of parsed.entries) {
    const name = `${basename(path)}:${entry.name ?? '#unnamed'}`
    if (isBflyt(entry.data)) checkLayout(name, entry.data, verbose)
    else if (isBflan(entry.data)) checkAnimation(name, entry.data, verbose)
    else if (isBntx(entry.data)) checkTexture(name, entry.data, verbose)
  }
}

function checkLayout(name: string, data: Uint8Array, verbose: boolean): void {
  if (!wanted('layouts')) return
  let parsed
  try {
    parsed = parseBflyt(data)
  } catch (cause) {
    layouts.failed++
    note(layouts, `${name}: ${describe(cause)}`)
    return
  }

  for (const section of parsed.document.unknownSections) {
    sectionsSeen.set(section.signature, (sectionsSeen.get(section.signature) ?? 0) + 1)
  }

  try {
    // No preserved sources: this forces a full re-encode from the model, which is
    // the strict test. Replaying the original bytes would prove nothing.
    const rewritten = writeBflyt(parsed.document)
    const at = sameBytes(data, rewritten)
    if (at === -2) layouts.ok++
    else {
      layouts.mismatch++
      note(
        layouts,
        `${name}: ${at === -1 ? `length ${data.length} vs ${rewritten.length}` : `differs at 0x${at.toString(16)}`}`
      )
    }
  } catch (cause) {
    layouts.failed++
    note(layouts, `${name}: rewrite threw: ${describe(cause)}`)
  }

  if (verbose) console.log(`  layout ${name}: v${parsed.document.version.major}`)
}

function checkAnimation(name: string, data: Uint8Array, verbose: boolean): void {
  if (!wanted('animations')) return
  let parsed
  try {
    parsed = parseBflan(data)
  } catch (cause) {
    animations.failed++
    note(animations, `${name}: ${describe(cause)}`)
    return
  }

  try {
    const rewritten = writeBflan(parsed.document)
    const at = sameBytes(data, rewritten)
    if (at === -2) animations.ok++
    else {
      animations.mismatch++
      // Per-section sizes, because "56 bytes short" says nothing about where. Both
      // streams carry a section table, so the sizes can be compared directly and
      // the culprit named.
      note(
        animations,
        `${name}: ${at === -1 ? `length ${data.length} vs ${rewritten.length}` : `differs at 0x${at.toString(16)}`}` +
          ` | original ${sectionSizes(data)} vs rewritten ${sectionSizes(rewritten)}`
      )
    }
  } catch (cause) {
    animations.failed++
    note(animations, `${name}: rewrite threw: ${describe(cause)}`)
  }

  if (verbose) console.log(`  anim ${name}: ${parsed.document.info?.entries.length ?? 0} entries`)
}

function checkTexture(name: string, data: Uint8Array, verbose: boolean): void {
  if (!wanted('textures')) return
  let container
  try {
    container = parseBntx(data)
  } catch (cause) {
    textures.failed++
    note(textures, `${name}: ${describe(cause)}`)
    return
  }

  // BNTX has no writer, so "ok" here means the container parsed and every
  // supported texture decoded to the right number of pixels.
  for (const texture of container.textures) {
    const format = formatName(texture.format, texture.formatVariant)
    if (!isFormatSupported(texture.format, texture.formatVariant)) {
      unsupportedFormats.set(format, (unsupportedFormats.get(format) ?? 0) + 1)
      continue
    }
    try {
      const decoded = decodeTexture(texture)
      if (decoded.rgba.length !== decoded.width * decoded.height * 4) {
        textures.mismatch++
        note(textures, `${name}:${texture.name}: decoded ${decoded.rgba.length} bytes`)
      } else {
        textures.ok++
      }
    } catch (cause) {
      textures.failed++
      note(textures, `${name}:${texture.name} (${format}): ${describe(cause)}`)
    }
  }

  if (verbose) console.log(`  bntx ${name}: ${container.textures.length} textures`)
}

/**
 * Which checks are enabled, set from `--only`. A module-level value rather than a
 * parameter threaded through five call sites, which would be all noise.
 */
let enabled: ReadonlySet<string> | null = null
function wanted(kind: string): boolean {
  return enabled === null || enabled.has(kind)
}

/**
 * The section signatures and sizes of a BFLYT/BFLAN stream, as `sig:size` pairs.
 *
 * Both formats share the same shell: magic[4], a byte-order mark, the header size,
 * the version, the file size, then the section count — so sections begin at the
 * header size and each is a `sig`+`size` block.
 */
function sectionSizes(data: Uint8Array): string {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    // 0xfffe at offset 4 marks little-endian, which every Switch file is.
    const little = view.getUint16(4, false) === 0xfffe
    let at = view.getUint16(6, little)
    const count = view.getUint16(16, little)
    const parts: string[] = []
    for (let i = 0; i < count && at + 8 <= data.length; i++) {
      const signature = String.fromCharCode(data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!)
      const size = view.getUint32(at + 4, little)
      parts.push(`${signature}:${size}`)
      if (size < 8) break
      at += size
    }
    return `[${parts.join(' ')}]`
  } catch {
    return '[unreadable]'
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function line(label: string, tally: Tally): void {
  const total = tally.ok + tally.mismatch + tally.failed
  if (total === 0) return
  const pct = total > 0 ? ((tally.ok / total) * 100).toFixed(1) : '0'
  console.log(
    `${label.padEnd(11)} ${String(tally.ok).padStart(6)} ok  ` +
      `${String(tally.mismatch).padStart(5)} byte-mismatch  ` +
      `${String(tally.failed).padStart(5)} error   (${pct}% exact)`
  )
  for (const problem of tally.problems) console.log(`              - ${problem}`)
}

function report(): void {
  console.log('\n=== results ===')
  line('archives', archives)
  line('layouts', layouts)
  line('animations', animations)
  line('textures', textures)

  if (sectionsSeen.size > 0) {
    console.log('\nunmodelled bflyt sections encountered:')
    for (const [signature, count] of [...sectionsSeen].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${signature}  x${count}`)
    }
  }

  if (unsupportedFormats.size > 0) {
    console.log('\ntexture formats with no decoder:')
    for (const [format, count] of [...unsupportedFormats].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${format}  x${count}`)
    }
  }

  const broken =
    archives.failed + layouts.failed + animations.failed + textures.failed +
    archives.mismatch + layouts.mismatch + animations.mismatch + textures.mismatch
  console.log(`\n${broken === 0 ? 'PASS' : 'FAIL'}: ${broken} problem(s)`)
  process.exit(broken === 0 ? 0 : 1)
}

void main()
