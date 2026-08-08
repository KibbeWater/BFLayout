/**
 * Builds the font test fixture from a real font archive.
 *
 *     pnpm fixture:font /path/to/romfs/Font/Font.Nin_NX_NVN.bfarc.zs
 *
 * The BFTTF tests need real files: the question they answer is whether the XOR key is right,
 * and a synthesised wrapper can only prove the decoder agrees with itself. But those are game
 * files, so the fixture is deliberately **not committed** — `tests/font.test.ts` skips without
 * it, and this is how to produce it.
 *
 * The smallest face and the smallest descriptor are chosen on purpose: they are a couple of
 * kilobytes together, enough to exercise every invariant, and small enough that nobody is
 * tempted to commit them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { detectCompression } from '@shared/formats/compression'
import { decodeBfttf, isBfcpx, isBfttf } from '@shared/formats/font'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { parseSarc } from '@shared/formats/sarc'

async function main(): Promise<void> {
  const source = process.argv[2]
  if (!source) {
    console.error('usage: pnpm fixture:font <font-archive>')
    process.exit(1)
  }

  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  const raw = new Uint8Array(readFileSync(source))
  const kind = detectCompression(raw)
  const data =
    kind === 'zstd'
      ? new Uint8Array(zstd.decompress(raw))
      : kind === 'yaz0'
        ? decompressYaz0(raw)
        : raw

  const entries = parseSarc(data).entries
  const faces = entries.filter((entry) => isBfttf(entry.data))
  const complexes = entries.filter((entry) => isBfcpx(entry.data))

  if (faces.length === 0 || complexes.length === 0) {
    console.error(
      `found ${faces.length} face(s) and ${complexes.length} descriptor(s); need at least one of each`
    )
    process.exit(1)
  }

  const smallest = <T extends { data: Uint8Array }>(list: T[]): T =>
    [...list].sort((a, b) => a.data.length - b.data.length)[0]!

  const face = smallest(faces)
  const complex = smallest(complexes)

  // Decoded here as well as in the test, so a fixture that cannot possibly pass is rejected
  // now rather than looking like a decoder regression later.
  const decoded = decodeBfttf(face.data)

  const out = join(process.cwd(), 'tests', 'fixtures', 'font-vectors.json')
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        face: { name: face.name, base64: Buffer.from(face.data).toString('base64') },
        complex: { name: complex.name, base64: Buffer.from(complex.data).toString('base64') }
      },
      null,
      2
    )}\n`
  )

  console.log(`face:       ${face.name} (${face.data.length} bytes -> ${decoded.kind})`)
  console.log(`descriptor: ${complex.name} (${complex.data.length} bytes)`)
  console.log(`wrote ${out}`)
  console.log(`${faces.length} faces and ${complexes.length} descriptors were available`)
}

void main()
