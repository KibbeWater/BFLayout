/**
 * Parses every BYML document under a directory and reports what was found.
 *
 * There is no reference implementation to compare against, so this measures two
 * things instead: that nothing fails to parse, and what the corpus actually
 * contains — node types, versions, depths — so gaps show up as an unknown type
 * rather than as silently wrong data.
 *
 *     pnpm validate:byml <dir>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

import { countNodes, parseByml, walkByml, type BymlNode } from '@shared/formats/byml'
import { isByml } from '@shared/formats/byml/codec'

const EXTENSIONS = new Set(['.byml', '.bgyml', '.bymlt'])

function collect(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let info: ReturnType<typeof statSync>
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(path)
      else if (EXTENSIONS.has(extname(entry).toLowerCase())) found.push(path)
    }
  }
  walk(root)
  return found.sort()
}

function main(): void {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: pnpm validate:byml <dir>')
    process.exit(2)
  }

  const files = collect(root)
  console.log(`found ${files.length} BYML candidates under ${root}\n`)

  const versions = new Map<string, number>()
  const kinds = new Map<string, number>()
  const failures: string[] = []
  const notRecognised: string[] = []
  let parsed = 0
  let totalNodes = 0
  let deepest = 0
  let deepestFile = ''
  let largestNodes = 0
  let largestFile = ''

  for (const file of files) {
    let data: Uint8Array
    try {
      data = new Uint8Array(readFileSync(file))
    } catch (cause) {
      failures.push(`${file}: could not read — ${String(cause)}`)
      continue
    }

    // Files with a BYML extension that are not BYML are worth knowing about:
    // they are usually compressed, and the folder browser should sniff instead.
    if (!isByml(data)) {
      notRecognised.push(`${file} (${[...data.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')})`)
      continue
    }

    try {
      const document = parseByml(data)
      parsed++

      const key = `v${document.version} ${document.littleEndian ? 'LE' : 'BE'}`
      versions.set(key, (versions.get(key) ?? 0) + 1)

      if (document.root) {
        const nodes = countNodes(document.root)
        totalNodes += nodes
        if (nodes > largestNodes) {
          largestNodes = nodes
          largestFile = file
        }

        walkByml(document.root, (node: BymlNode, path: string) => {
          kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1)
          const depth = (path.match(/[.[]/g) ?? []).length
          if (depth > deepest) {
            deepest = depth
            deepestFile = file
          }
        })
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      failures.push(`${file}: ${message}`)
    }
  }

  console.log('=== results ===')
  console.log(`parsed:         ${parsed}/${files.length}`)
  console.log(`total nodes:    ${totalNodes.toLocaleString()}`)
  console.log(`largest:        ${largestNodes.toLocaleString()} nodes in ${largestFile}`)
  console.log(`deepest:        ${deepest} levels in ${deepestFile}`)

  console.log('\nversions:')
  for (const [key, count] of [...versions.entries()].sort()) {
    console.log(`  ${key}  x${count}`)
  }

  console.log('\nnode kinds:')
  for (const [kind, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(8)} x${count.toLocaleString()}`)
  }

  if (notRecognised.length > 0) {
    console.log(`\n${notRecognised.length} file(s) not recognised as BYML (first 10):`)
    for (const line of notRecognised.slice(0, 10)) console.log(`  ${line}`)
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s) (first 25):`)
    for (const line of failures.slice(0, 25)) console.log(`  ${line}`)
  }

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} parse failure(s)`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
