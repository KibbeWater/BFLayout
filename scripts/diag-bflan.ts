/**
 * Hex-dumps one section of a BFLAN inside an archive, original beside rewritten, so
 * a size mismatch can be traced to a field instead of guessed at.
 *
 *     pnpm diag:bflan <archive> <entry-substring> [section]
 *
 * This is how the nested `usd1` inside `pat1` was found: `validate:romfs` said eight
 * animations were 52 to 76 bytes short, which named the section but not the field —
 * and reading the bytes showed a whole sub-section that the parser was skipping over
 * as padding.
 */
import { readFileSync } from 'node:fs'

import { parseSarc } from '@shared/formats/sarc'
import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { parseBflan, writeBflan } from '@shared/formats/bflan'

async function main(): Promise<void> {
  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  const raw = new Uint8Array(readFileSync(process.argv[2]!))
  const kind = detectCompression(raw)
  const data =
    kind === 'zstd'
      ? new Uint8Array(zstd.decompress(raw))
      : kind === 'yaz0'
        ? decompressYaz0(raw)
        : raw

  const archive = parseSarc(data)
  const entry = archive.entries.find((candidate) =>
    (candidate.name ?? '').includes(process.argv[3]!)
  )
  if (!entry) {
    console.error('no matching entry')
    process.exit(1)
  }

  console.log(`entry: ${entry.name} (${entry.data.length} bytes)`)

  const parsed = parseBflan(entry.data)
  const rewritten = writeBflan(parsed.document)

  const tag = parsed.document.tag
  console.log('parsed tag:', {
    name: tag?.name,
    order: tag?.order,
    groups: tag?.groups,
    groupCount: tag?.groups.length,
    startFrame: tag?.startFrame,
    endFrame: tag?.endFrame,
    childBinding: tag?.childBinding,
    trailingLength: tag?.trailing.length
  })
  console.log('version:', parsed.document.version)
  console.log('unknownSections:', parsed.document.unknownSections.map((s) => s.signature))

  const want = process.argv[4] ?? 'pat1'

  const dump = (label: string, bytes: Uint8Array): void => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // Walk the section chain from the header size to find the requested one.
    let start = view.getUint16(6, true)
    let size = 0
    for (let i = 0; i < view.getUint16(16, true); i++) {
      const signature = String.fromCharCode(
        bytes[start]!,
        bytes[start + 1]!,
        bytes[start + 2]!,
        bytes[start + 3]!
      )
      size = view.getUint32(start + 4, true)
      if (signature === want) break
      start += size
    }
    console.log(`\n${label} ${want} size=${size}`)
    const section = bytes.subarray(start, start + size)
    for (let i = 0; i < section.length; i += 16) {
      const row = [...section.subarray(i, i + 16)]
      console.log(
        `  ${(i).toString(16).padStart(4, '0')}  ` +
          row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(48) +
          '  ' +
          row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
      )
    }
  }

  dump('ORIGINAL', entry.data)
  dump('REWRITTEN', rewritten)
}

void main()
