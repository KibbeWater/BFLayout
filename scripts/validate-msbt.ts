/**
 * Parses every MSBT in a dump and reports what came out.
 *
 *     pnpm validate:msbt /path/to/romfs
 *
 * The same shape as `validate:romfs`: real files are the only thing that can tell you whether a
 * parser built from a hex dump is right. A message table has no checksum and no round-trip to
 * compare against, so the evidence is breadth — every file parsing, every string carrying a label,
 * and the text reading as text rather than as mojibake.
 */
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { isSarc, parseSarc } from '@shared/formats/sarc'
import { isMsbt, parseMsbt } from '@shared/formats/msbt'

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
  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  let files = 0
  let parsed = 0
  let messages = 0
  let labelled = 0
  let withPlaceholders = 0
  let empty = 0
  const sections = new Map<string, number>()
  const failures: string[] = []
  const samples: string[] = []

  for await (const path of walk(process.argv[2]!)) {
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
      if (!isMsbt(entry.data)) continue
      files++
      try {
        const document = parseMsbt(entry.data)
        parsed++
        messages += document.messages.length
        for (const signature of document.sections) {
          sections.set(signature, (sections.get(signature) ?? 0) + 1)
        }
        for (const message of document.messages) {
          if (message.label) labelled++
          if (message.text.includes('{n:')) withPlaceholders++
          if (message.text === '') empty++
          if (samples.length < 6 && message.label && message.text.length > 4) {
            samples.push(`${message.label} = ${JSON.stringify(message.text.slice(0, 70))}`)
          }
        }
      } catch (cause) {
        if (failures.length < 5) {
          failures.push(`${entry.name}: ${(cause as Error).message}`)
        }
      }
    }
  }

  console.log(`MSBT files found:  ${files}`)
  console.log(`parsed cleanly:    ${parsed}`)
  console.log(`messages:          ${messages}`)
  console.log(`with a label:      ${labelled}`)
  console.log(`with placeholders: ${withPlaceholders}`)
  console.log(`empty strings:     ${empty}`)
  console.log('sections seen:')
  for (const [signature, count] of [...sections].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${signature}: ${count}`)
  }
  if (failures.length > 0) {
    console.log('failures:')
    for (const failure of failures) console.log(`  ${failure}`)
  }
  console.log('samples:')
  for (const sample of samples) console.log(`  ${sample}`)
}

void main()
