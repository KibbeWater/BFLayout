/**
 * Parses every AAMP in a dump and reports what came out.
 *
 *     pnpm validate:aamp /path/to/romfs
 *     pnpm validate:aamp /path/to/romfs --tree baglenv    # also print one file's tree
 *
 * Same shape as `validate:msbt`: real files are the only thing that can tell you whether a parser
 * built from a hex dump is right. AAMP has no checksum and this build has no writer, so there is no
 * round-trip to compare against — the evidence is breadth plus *self-agreement*. Every AAMP header
 * declares its own list, object and parameter totals, and the walk is independent of them, so
 * "walked counts equal declared counts, on every file" is a real check rather than a tautology.
 *
 * The bar is every file. A parse failure, a count mismatch or an unmodelled value type is printed
 * with the file it came from, because a percentage with no names attached cannot be acted on.
 */
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { isSarc, parseSarc } from '@shared/formats/sarc'
import {
  AAMP_TYPES,
  AAMP_VERIFIED_TYPES,
  isAamp,
  parseAamp,
  walkAamp,
  type AampDocument,
  type AampList,
  type AampObject,
  type AampParameter
} from '@shared/formats/aamp'

async function* walk(dir: string): AsyncGenerator<string> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) yield* walk(path)
    else yield path
  }
}

/** Renders a value compactly, and never renders an `unknown` as if it had a value. */
function describe(parameter: AampParameter): string {
  const value = parameter.value
  switch (value.kind) {
    case 'bool':
      return `${value.value}${value.raw > 1 ? ` (raw ${value.raw})` : ''}`
    case 'int':
    case 'u32':
      return String(value.value)
    case 'f32':
      return value.value.toFixed(4)
    case 'floats':
      return `[${value.value.map((n) => n.toFixed(3)).join(', ')}]`
    case 'string':
      return `${JSON.stringify(value.value)}${value.truncated ? ' (cut)' : ''}`
    case 'curves':
      return `${value.value.length} curve(s), first ints [${value.value[0]?.ints.join(', ')}]`
    case 'buffer':
      return `${value.element}[${value.length}]`
    case 'unknown':
      return `UNKNOWN type ${value.typeByte}: ${value.reason}`
  }
}

function printTree(document: AampDocument): void {
  let printed = 0
  walkAamp(document.root, (node, kind, depth) => {
    if (printed++ > 60) return
    const pad = '  '.repeat(depth + 1)
    if (kind === 'parameter') {
      const parameter = node as AampParameter
      console.log(`${pad}${parameter.label}: ${parameter.typeName} = ${describe(parameter)}`)
    } else if (kind === 'object') {
      console.log(`${pad}object ${(node as AampObject).label}`)
    } else {
      console.log(`${pad}list ${(node as AampList).label}`)
    }
  })
  if (printed > 60) console.log(`  … ${printed - 60} more nodes`)
}

async function main(): Promise<void> {
  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  const root = process.argv[2]
  if (root === undefined) {
    console.error('usage: validate-aamp <romfs dir> [--tree <name substring>]')
    process.exit(2)
  }
  const treeIndex = process.argv.indexOf('--tree')
  const treeFilter = treeIndex === -1 ? null : process.argv[treeIndex + 1] ?? ''

  let files = 0
  let parsed = 0
  let countsAgree = 0
  const totals = { lists: 0, objects: 0, parameters: 0 }
  let hashes = 0
  let named = 0
  let unknownValues = 0
  const versions = new Map<number, number>()
  const flagWords = new Map<number, number>()
  const typeStrings = new Map<string, number>()
  const valueTypes = new Map<number, number>()
  const failures: string[] = []
  const mismatches: string[] = []
  const unknownReports: string[] = []
  const warned: string[] = []
  let treePrinted = false

  const inspect = (label: string, bytes: Uint8Array): void => {
    files++
    let document: AampDocument
    try {
      document = parseAamp(bytes)
    } catch (cause) {
      failures.push(`${label}: ${(cause as Error).message}`)
      return
    }
    parsed++

    versions.set(document.version, (versions.get(document.version) ?? 0) + 1)
    flagWords.set(document.flags, (flagWords.get(document.flags) ?? 0) + 1)
    typeStrings.set(document.typeName, (typeStrings.get(document.typeName) ?? 0) + 1)
    totals.lists += document.counts.lists
    totals.objects += document.counts.objects
    totals.parameters += document.counts.parameters

    const agrees =
      document.counts.lists === document.declared.lists &&
      document.counts.objects === document.declared.objects &&
      document.counts.parameters === document.declared.parameters
    if (agrees) countsAgree++
    else {
      mismatches.push(
        `${label}: declared ${document.declared.lists}/${document.declared.objects}/${document.declared.parameters} lists/objects/params, walked ${document.counts.lists}/${document.counts.objects}/${document.counts.parameters}`
      )
    }

    walkAamp(document.root, (node, kind) => {
      hashes++
      if ((node as AampList).name !== null) named++
      if (kind !== 'parameter') return
      const parameter = node as AampParameter
      valueTypes.set(parameter.typeByte, (valueTypes.get(parameter.typeByte) ?? 0) + 1)
      if (parameter.value.kind === 'unknown') {
        unknownValues++
        if (unknownReports.length < 10) {
          unknownReports.push(`${label}: ${parameter.label} — ${describe(parameter)}`)
        }
      }
    })

    if (document.warnings.length > 0 && warned.length < 10) {
      warned.push(`${label}: ${document.warnings.slice(0, 3).join('; ')}`)
    }

    if (treeFilter !== null && !treePrinted && label.includes(treeFilter)) {
      treePrinted = true
      console.log(`--- tree for ${label} (type "${document.typeName}") ---`)
      printTree(document)
      console.log('---')
    }
  }

  for await (const path of walk(root)) {
    const raw = new Uint8Array(readFileSync(path))
    const kind = detectCompression(raw)
    let data: Uint8Array
    try {
      data =
        kind === 'zstd'
          ? new Uint8Array(zstd.decompress(raw))
          : kind === 'yaz0'
            ? decompressYaz0(raw)
            : raw
    } catch {
      continue
    }

    // AAMP ships both loose and inside an archive, so both routes are followed.
    if (isAamp(data)) {
      inspect(path, data)
      continue
    }
    if (!isSarc(data)) continue
    let entries
    try {
      entries = parseSarc(data).entries
    } catch {
      continue
    }
    for (const entry of entries) {
      if (isAamp(entry.data)) inspect(`${path}::${entry.name}`, entry.data)
    }
  }

  const percent = (part: number, whole: number): string =>
    whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`

  console.log(`AAMP files found:      ${files}`)
  console.log(`parsed cleanly:        ${parsed}/${files} (${percent(parsed, files)})`)
  console.log(`counts match header:   ${countsAgree}/${parsed} (${percent(countsAgree, parsed)})`)
  console.log(`lists / objects / parameters: ${totals.lists} / ${totals.objects} / ${totals.parameters}`)
  console.log(`hashes resolved to a name: ${named}/${hashes} (${percent(named, hashes)})`)
  console.log(`values reported unknown:   ${unknownValues}`)
  console.log(`versions: ${[...versions].map(([v, n]) => `v${v} x${n}`).join(', ')}`)
  console.log(`flag words: ${[...flagWords].map(([f, n]) => `0x${f.toString(16)} x${n}`).join(', ')}`)

  console.log('value types seen:')
  for (const [byte, count] of [...valueTypes].sort((a, b) => a[0] - b[0])) {
    const entry = AAMP_TYPES[byte]
    const verified = AAMP_VERIFIED_TYPES.includes(byte) ? '' : '   [inferred, unverified]'
    console.log(`  ${String(byte).padStart(2)} ${(entry?.name ?? 'unmodelled').padEnd(13)} x${count}${verified}`)
  }

  console.log(`type strings: ${[...typeStrings].sort().map(([t, n]) => `${t} x${n}`).join(', ')}`)

  if (failures.length > 0) {
    console.log(`FAILURES (${failures.length}):`)
    for (const failure of failures) console.log(`  ${failure}`)
  }
  if (mismatches.length > 0) {
    console.log(`COUNT MISMATCHES (${mismatches.length}):`)
    for (const mismatch of mismatches) console.log(`  ${mismatch}`)
  }
  if (unknownReports.length > 0) {
    console.log('unmodelled values:')
    for (const report of unknownReports) console.log(`  ${report}`)
  }
  if (warned.length > 0) {
    console.log('warnings:')
    for (const warning of warned) console.log(`  ${warning}`)
  }
  if (failures.length === 0 && mismatches.length === 0 && unknownValues === 0) {
    console.log('every file parsed, every count agreed, every value type modelled.')
  }
}

void main()
