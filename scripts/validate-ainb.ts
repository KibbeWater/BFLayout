/**
 * Parses every AINB in a dump and reports what came out.
 *
 *     tsx --tsconfig tsconfig.node.json scripts/validate-ainb.ts /path/to/romfs
 *
 * The same shape as `validate:msbt`, and for the same reason: a behaviour graph has no checksum and
 * this build has no writer, so there is no round-trip to compare against. The evidence is breadth —
 * every file parsing, every node carrying a name or a type that fits the small set the format uses,
 * and no file reporting a region that did not add up.
 *
 * The bar is every file. `parsed cleanly` is printed as a ratio so a regression shows up as a number
 * rather than as an absence, and `problems` is printed separately because a file that parses while
 * telling you one of its lists is the wrong length is not a pass.
 *
 * AINB in this title lives inside one ZSTD-compressed SARC (`Pack/AI.Product.100.pack.zs`), so the
 * walk decompresses and opens archives rather than reading loose files, and sniffs each entry's
 * magic rather than trusting its name.
 */
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { isSarc, parseSarc } from '@shared/formats/sarc'
import { isAinb, parseAinb } from '@shared/formats/ainb'

async function* walk(dir: string): AsyncGenerator<string> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) yield* walk(path)
    else yield path
  }
}

async function main(): Promise<void> {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: validate-ainb.ts /path/to/romfs')
    process.exit(2)
  }

  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  let files = 0
  let parsed = 0
  let nodes = 0
  let namedNodes = 0
  let moduleReferences = 0
  let commands = 0
  let globals = 0
  let strings = 0
  let truncated = 0
  let totalBytes = 0
  let unreadBytes = 0
  const versions = new Map<number, number>()
  const nodeTypes = new Map<number, number>()
  const categories = new Map<string, number>()
  const globalsByType = new Map<string, number>()
  const immediate = new Map<string, number>()
  const inputs = new Map<string, number>()
  const outputs = new Map<string, number>()
  const unreadSections = new Map<string, number>()
  const failures: string[] = []
  const problems: string[] = []
  const samples: string[] = []

  const bump = (into: Map<string, number>, key: string, by: number): void => {
    if (by > 0) into.set(key, (into.get(key) ?? 0) + by)
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
    if (!isSarc(data)) continue
    let entries
    try {
      entries = parseSarc(data).entries
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!isAinb(entry.data)) continue
      files++
      try {
        const document = parseAinb(entry.data)
        parsed++
        versions.set(document.version, (versions.get(document.version) ?? 0) + 1)
        categories.set(document.category, (categories.get(document.category) ?? 0) + 1)
        nodes += document.nodeCount
        commands += document.commands.length
        globals += document.globalParameterCount
        strings += document.stringCount
        if (document.nodesTruncated || document.stringsTruncated || document.globalParametersTruncated) {
          truncated++
        }

        for (const { type, count } of document.nodeTypeCounts) {
          nodeTypes.set(type, (nodeTypes.get(type) ?? 0) + count)
        }
        for (const node of document.nodes) {
          if (node.name === '') continue
          namedNodes++
          if (node.name.endsWith('.module')) moduleReferences++
        }
        for (const parameter of document.globalParameters) {
          bump(globalsByType, parameter.type, 1)
        }
        for (const [type, count] of Object.entries(document.immediateParameterCounts)) {
          bump(immediate, type, count)
        }
        for (const [type, count] of Object.entries(document.inputParameterCounts)) {
          bump(inputs, type, count)
        }
        for (const [type, count] of Object.entries(document.outputParameterCounts)) {
          bump(outputs, type, count)
        }
        totalBytes += entry.data.length
        for (const section of document.sections) {
          if (section.read || section.size === 0) continue
          unreadBytes += section.size
          bump(unreadSections, section.fields.map((at) => `0x${at.toString(16)}`).join('|'), 1)
        }

        if (document.problems.length > 0 && problems.length < 10) {
          problems.push(`${entry.name}: ${document.problems.join('; ')}`)
        }
        if (samples.length < 4 && document.nodeCount > 2 && document.globalParameterCount > 0) {
          const first = document.nodes
            .slice(0, 3)
            .map((node) => `${node.type}:${node.name || '(unnamed)'}`)
            .join(', ')
          samples.push(
            `${document.name} [${document.category} v${document.versionText}] ` +
              `${document.nodeCount} nodes (${first}...) ` +
              `commands ${document.commands.map((command) => command.name).join('/')} ` +
              `globals ${document.globalParameters
                .slice(0, 3)
                .map((parameter) => `${parameter.type} ${parameter.name}`)
                .join(', ')}`
          )
        }
      } catch (cause) {
        failures.push(`${entry.name}: ${(cause as Error).message}`)
      }
    }
  }

  const percent = files === 0 ? 0 : (parsed / files) * 100
  console.log(`AINB files found:   ${files}`)
  console.log(`parsed cleanly:     ${parsed} / ${files} (${percent.toFixed(2)}%)`)
  console.log(`versions:           ${[...versions].map(([v, c]) => `0x${v.toString(16)}: ${c}`).join(', ')}`)
  console.log(`categories:         ${[...categories].map(([v, c]) => `${v || '(none)'}: ${c}`).join(', ')}`)
  console.log(`nodes:              ${nodes}`)
  console.log(`  with a name:      ${namedNodes} (${moduleReferences} naming another AINB module)`)
  console.log(`commands:           ${commands}`)
  console.log(`global parameters:  ${globals}`)
  console.log(`pool strings:       ${strings}`)
  console.log(`files hitting a cap: ${truncated}`)
  console.log(
    `bytes in regions read as nothing at all: ${unreadBytes} of ${totalBytes} ` +
      `(${totalBytes === 0 ? 0 : ((unreadBytes / totalBytes) * 100).toFixed(1)}%)`
  )

  console.log(`distinct node types: ${nodeTypes.size}`)
  for (const [type, count] of [...nodeTypes].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  type ${String(type).padStart(3)}: ${count}`)
  }

  const line = (label: string, counts: Map<string, number>): void => {
    console.log(
      `${label.padEnd(20)}${[...counts].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(', ')}`
    )
  }
  line('immediate params:', immediate)
  line('input params:', inputs)
  line('output params:', outputs)
  line('globals by type:', globalsByType)
  line('unread sections:', unreadSections)

  if (problems.length > 0) {
    console.log('files reporting problems:')
    for (const problem of problems) console.log(`  ${problem}`)
  } else {
    console.log('files reporting problems: none')
  }

  if (failures.length > 0) {
    console.log(`failures (${failures.length}):`)
    for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`)
  }

  console.log('samples:')
  for (const sample of samples) console.log(`  ${sample}`)

  if (failures.length > 0) process.exitCode = 1
}

void main()
