/**
 * Counts pai1 animation entries by target byte across a romfs dump.
 *
 * The codec has a special case for target byte 2 — an extra word ahead of the tag that
 * the offset table does not account for — and two files re-encode 24 bytes short. Before
 * changing that case it is worth knowing how many entries actually reach it: a rule
 * inferred from two files is a guess, a rule that holds across every target-2 entry in
 * 2,187 animations is a finding.
 *
 *     pnpm diag:pai1 <romfs-dir>
 */
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { isBflan, parseBflan } from '@shared/formats/bflan'
import { parseSarc } from '@shared/formats/sarc'

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
    console.error('usage: pnpm diag:pai1 <romfs-dir>')
    process.exit(1)
  }

  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  const byTarget = new Map<number, number>()
  /** Files holding at least one entry per target byte, so the spread is visible. */
  const examples = new Map<number, string>()
  const signatures = new Map<string, number>()
  let animations = 0

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

    let entries: { name: string | null; data: Uint8Array }[]
    if (isBflan(data)) {
      entries = [{ name: path, data }]
    } else {
      try {
        entries = parseSarc(data).entries.map((entry) => ({
          name: `${path}:${entry.name ?? '?'}`,
          data: entry.data
        }))
      } catch {
        continue
      }
    }

    for (const entry of entries) {
      if (!isBflan(entry.data)) continue
      let parsed
      try {
        parsed = parseBflan(entry.data)
      } catch {
        continue
      }
      animations++
      for (const animEntry of parsed.document.info?.entries ?? []) {
        // `target` is already decoded to a label, so the raw byte is inferred from it.
        const targetByte = animEntry.target === 'material' ? 1 : 0
        const key = animEntry.tags.some((tag) => tag.leading !== null) ? 2 : targetByte
        byTarget.set(key, (byTarget.get(key) ?? 0) + 1)
        if (!examples.has(key)) examples.set(key, entry.name ?? path)
        for (const tag of animEntry.tags) {
          signatures.set(tag.signature, (signatures.get(tag.signature) ?? 0) + 1)
        }
      }
    }
  }

  console.log(`${animations} animations parsed`)
  for (const [target, count] of [...byTarget].sort((a, b) => a[0] - b[0])) {
    console.log(`  target ${target}: ${count} entries   e.g. ${examples.get(target)}`)
  }
  console.log('tag signatures:')
  for (const [signature, count] of [...signatures].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${signature}: ${count}`)
  }
}

void main()
