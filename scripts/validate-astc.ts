/**
 * Checks the ASTC decoder against Arm's astcenc, which is the reference
 * implementation for this format.
 *
 * Vectors are produced outside the repo by encoding known images with
 * `astcenc -cl` and decoding them back with `astcenc -dl`, so each vector is a
 * pair of (compressed file, what the reference decoder makes of it). Point this
 * script at that directory:
 *
 *     pnpm validate:astc <dir>
 *
 * where <dir> holds `manifest.txt` lines of `<tag> <blockW>x<blockH> <w>x<h>`
 * alongside `<tag>.astc` and `<tag>.raw`.
 *
 * Byte-exactness is the bar. ASTC decoding is defined in exact integer
 * arithmetic, so anything short of an exact match is a bug in our port rather
 * than a rounding difference.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { decodeAstc } from '@shared/formats/bntx/astc'

interface Vector {
  readonly tag: string
  readonly blockWidth: number
  readonly blockHeight: number
  readonly width: number
  readonly height: number
}

function parseManifest(dir: string): Vector[] {
  const text = readFileSync(join(dir, 'manifest.txt'), 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [tag, block, size] = line.split(' ')
      const [blockWidth, blockHeight] = block!.split('x').map(Number)
      const [width, height] = size!.split('x').map(Number)
      return { tag: tag!, blockWidth: blockWidth!, blockHeight: blockHeight!, width: width!, height: height! }
    })
}

function main(): void {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: pnpm validate:astc <vector-dir>')
    process.exit(2)
  }

  const vectors = parseManifest(dir)
  const deltas = new Map<number, number>()
  const imperfect: string[] = []
  let exact = 0
  let comparedBytes = 0
  let differingBytes = 0

  for (const vector of vectors) {
    const astc = readFileSync(join(dir, `${vector.tag}.astc`))
    const reference = readFileSync(join(dir, `${vector.tag}.raw`))
    // 16-byte .astc header: magic, block dimensions, then image dimensions.
    const payload = new Uint8Array(astc.subarray(16))

    const result = decodeAstc(
      vector.width,
      vector.height,
      vector.blockWidth,
      vector.blockHeight,
      payload
    )

    if (result.failedBlocks > 0) {
      imperfect.push(
        `${vector.tag}: ${result.failedBlocks}/${result.totalBlocks} blocks failed — ${result.firstError}`
      )
      continue
    }

    let mismatched = 0
    let worst = 0
    for (let i = 0; i < reference.length; i++) {
      const delta = result.rgba[i]! - reference[i]!
      if (delta === 0) continue
      mismatched++
      if (Math.abs(delta) > worst) worst = Math.abs(delta)
      deltas.set(delta, (deltas.get(delta) ?? 0) + 1)
      if (process.env['ASTC_SAMPLES'] && mismatched <= 8) {
        console.log(
          `  sample ${vector.tag} byte ${i} (px ${Math.floor(i / 4)} ch ${i % 4}): ours ${result.rgba[i]}, reference ${reference[i]}`
        )
      }
    }

    comparedBytes += reference.length
    differingBytes += mismatched

    if (mismatched === 0) exact++
    else imperfect.push(`${vector.tag}: ${mismatched}/${reference.length} bytes differ, worst ${worst}`)
  }

  console.log(`byte-exact vectors: ${exact}/${vectors.length}`)
  console.log(`differing bytes:    ${differingBytes}/${comparedBytes}`)
  if (deltas.size > 0) {
    const sorted = [...deltas.entries()].sort((a, b) => a[0] - b[0])
    console.log('deltas:', sorted.map(([delta, count]) => `${delta}x${count}`).join(' '))
  }

  if (imperfect.length > 0) {
    console.log(`\n${imperfect.length} imperfect vectors (first 30):`)
    for (const line of imperfect.slice(0, 30)) console.log(`  ${line}`)
    process.exit(1)
  }

  console.log('\nevery vector matched the reference decoder exactly.')
}

main()
