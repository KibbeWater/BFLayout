/**
 * Parses every BFRES in a dump and reports what came out.
 *
 *     tsx --tsconfig tsconfig.node.json scripts/validate-bfres.ts /path/to/romfs
 *
 * The same shape as `validate:msbt`: a structural summary has no round trip to check itself against,
 * so the evidence is breadth — every file in the dump parsing, and the counts it yields agreeing
 * with the independent statements the format makes about itself (the parser cross-checks each group
 * count against its dictionary and each vertex count against buffer size over stride, so a clean
 * parse here is a stronger claim than "it did not throw").
 *
 * The bar is the one the other codecs hold: 100% of files parsed. Anything less is named, with the
 * file and the message, rather than smoothed over.
 */
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { isBfres, parseBfres } from '@shared/formats/bfres'

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
    console.error('usage: validate-bfres.ts <romfs dir> [--limit n]')
    process.exit(2)
  }
  const limitFlag = process.argv.indexOf('--limit')
  const limit = limitFlag > 0 ? Number(process.argv[limitFlag + 1]) : Infinity

  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  let files = 0
  let parsed = 0
  let models = 0
  let materials = 0
  let shapes = 0
  let vertexBuffers = 0
  let vertices = 0
  let bones = 0
  let textureRefs = 0
  let capped = 0
  const versions = new Map<string, number>()
  const alignments = new Map<number, number>()
  const kinds = new Map<string, number>()
  const externalMagics = new Map<string, number>()
  const externalNames = new Map<string, number>()
  const failures: string[] = []
  const samples: string[] = []

  for await (const path of walk(root)) {
    if (files >= limit) break
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
    if (!isBfres(data)) continue
    files++

    try {
      const document = parseBfres(data)
      parsed++
      versions.set(document.version, (versions.get(document.version) ?? 0) + 1)
      alignments.set(document.alignment, (alignments.get(document.alignment) ?? 0) + 1)
      models += document.modelCount
      kinds.set('FMDL', (kinds.get('FMDL') ?? 0) + document.modelCount)
      for (const subfile of document.subfiles) {
        kinds.set(subfile.kind, (kinds.get(subfile.kind) ?? 0) + 1)
      }
      if (document.subfiles.length < document.subfileCount) capped++
      if (document.models.length < document.modelCount) capped++

      for (const model of document.models) {
        materials += model.materialCount
        shapes += model.shapeCount
        vertexBuffers += model.vertexBufferCount
        vertices += model.vertexCount
        bones += model.boneCount
        for (const material of model.materials) textureRefs += material.textureCount
        if (model.shapes.length < model.shapeCount) capped++
        if (model.materials.length < model.materialCount) capped++
      }

      for (const file of document.externalFiles) {
        const label = file.magic === '' ? `(empty, ${file.size} bytes)` : file.magic
        externalMagics.set(label, (externalMagics.get(label) ?? 0) + 1)
        externalNames.set(file.name, (externalNames.get(file.name) ?? 0) + 1)
      }

      if (samples.length < 5 && document.models.length > 0) {
        const model = document.models[0]!
        samples.push(
          `${document.name} v${document.version}: model ${JSON.stringify(model.name)} ` +
            `${model.shapeCount} shapes, ${model.materialCount} materials, ` +
            `${model.vertexBufferCount} vertex buffers, ${model.vertexCount} vertices, ` +
            `${model.boneCount} bones` +
            (model.materials[0]
              ? `, first material ${JSON.stringify(model.materials[0].name)} -> ` +
                model.materials[0].textures.map((t) => JSON.stringify(t)).join(', ')
              : '')
        )
      }
    } catch (cause) {
      failures.push(`${path}: ${(cause as Error).message}`)
    }
  }

  const ratio = files === 0 ? '0' : ((parsed / files) * 100).toFixed(2)
  console.log(`BFRES files found: ${files}`)
  console.log(`parsed cleanly:    ${parsed} / ${files}  (${ratio}%)`)
  console.log(`models:            ${models}`)
  console.log(`materials:         ${materials}`)
  console.log(`shapes:            ${shapes}`)
  console.log(`vertex buffers:    ${vertexBuffers}`)
  console.log(`vertices:          ${vertices}`)
  console.log(`bones:             ${bones}`)
  console.log(`texture refs:      ${textureRefs}`)
  console.log(`lists truncated:   ${capped}`)
  console.log('versions seen:')
  for (const [version, count] of [...versions].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${version}: ${count}`)
  }
  console.log('data alignment:')
  for (const [alignment, count] of [...alignments].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${alignment} bytes: ${count}`)
  }
  console.log('subfile kinds seen:')
  for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${count}`)
  }
  console.log('embedded (external) files:')
  for (const [magic, count] of [...externalMagics].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${magic}: ${count}`)
  }
  for (const [name, count] of [...externalNames].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  name ${JSON.stringify(name)}: ${count}`)
  }
  if (failures.length > 0) {
    console.log(`failures (${failures.length}):`)
    for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`)
  }
  console.log('samples:')
  for (const sample of samples) console.log(`  ${sample}`)

  if (parsed !== files) process.exitCode = 1
}

void main()
