import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { isBflyt, parseBflyt } from '@shared/formats/bflyt'
import {
  checkFile,
  compare,
  editPane,
  findPane,
  identify,
  listArchive,
  readLayout,
  renderWithTextures,
  resolveTarget,
  searchTree,
  summarizePane,
  text,
  writeLayout
} from '@headless/engine'

/**
 * `bflayout` — the editor's codecs, without the editor.
 *
 * Modding a game this size is full of work that is repetitive rather than
 * interesting: the same change across five hundred layouts, a check over
 * everything before a release, a diff in CI. None of that wants a window, and
 * doing it by hand in the app is how people stop doing it at all.
 *
 * Everything here runs on `src/shared`, which the purity gate keeps free of both
 * Node and DOM — so these commands and the app cannot disagree about what a file
 * says.
 */

const USAGE = `bflayout — headless tools for BFLYT layouts and the archives they ship in

  bflayout info <file>...                       what a file is, by magic
  bflayout list <archive>                       entries in a SARC/SZS
  bflayout tree <file> [--entry NAME]           the pane hierarchy
  bflayout render <file> [--entry NAME] -o out.png [--max 1024] [--only PANE]
  bflayout set <file> --pane NAME [edits] [--entry NAME] [-o out]
  bflayout text <file> [--entry NAME] [-o out.yaml]     layout to reviewable text
  bflayout apply <file> --from text.yaml [--entry NAME] [-o out]
  bflayout check <path>...                      parse everything and report
  bflayout diff <before> <after> [--entry NAME] what changed, structurally
  bflayout search <folder> <query> [--kind K] [--limit N]

Edits for \`set\`:
  --translate X,Y,Z   --size W,H   --scale X,Y   --rotate X,Y,Z
  --alpha 0-255       --visible true|false      --text "…"

Notes:
  Yaz0 (.szs) and ZSTD (.zs) are both read and written. An archive is saved back
  with the compression it arrived with.
`

interface Args {
  readonly command: string
  readonly positional: string[]
  readonly flags: Record<string, string | boolean>
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let at = 0; at < argv.length; at++) {
    const item = argv[at]!
    if (!item.startsWith('-')) {
      positional.push(item)
      continue
    }
    const name = item.replace(/^--?/, '')
    const next = argv[at + 1]
    if (next !== undefined && !next.startsWith('-')) {
      flags[name] = next
      at += 1
    } else {
      flags[name] = true
    }
  }

  return { command: positional.shift() ?? 'help', positional, flags }
}

const numbers = (value: string): number[] =>
  value.split(',').map((part) => {
    const parsed = Number(part.trim())
    if (!Number.isFinite(parsed)) throw new Error(`"${part}" is not a number`)
    return parsed
  })

function flagString(flags: Args['flags'], name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const entry = flagString(args.flags, 'entry')
  const output = flagString(args.flags, 'o') ?? flagString(args.flags, 'output')

  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0

    case 'info': {
      requireAtLeast(args.positional, 1, 'info needs at least one file')
      for (const path of args.positional) {
        const found = await identify(path)
        process.stdout.write(
          `${found.format.padEnd(8)} ${String(found.size).padStart(9)}  ${basename(found.path)}  ${found.detail}\n`
        )
      }
      return 0
    }

    case 'list': {
      requireAtLeast(args.positional, 1, 'list needs an archive')
      const target = await resolveTarget(args.positional[0]!)
      if (!target.archive) throw new Error(`${basename(target.path)} is not an archive`)
      for (const item of listArchive(target.archive)) {
        process.stdout.write(
          `${item.format.padEnd(8)} ${String(item.size).padStart(9)}  ${item.name}\n`
        )
      }
      return 0
    }

    case 'tree': {
      requireAtLeast(args.positional, 1, 'tree needs a file')
      const document = await readLayout(args.positional[0]!, entry)
      process.stdout.write(
        `${document.info.name}  ${document.info.width}×${document.info.height}\n`
      )
      if (document.rootPane) printTree(summarizePane(document.rootPane), 0)
      return 0
    }

    case 'render': {
      requireAtLeast(args.positional, 1, 'render needs a file')
      if (!output) throw new Error('render needs -o to say where the PNG goes')

      const document = await readLayout(args.positional[0]!, entry)
      const only = flagString(args.flags, 'only')
      const max = flagString(args.flags, 'max')
      const result = await renderWithTextures(args.positional[0]!, document, {
        ...(max ? { maxSize: Number(max) } : {}),
        ...(only ? { only } : {}),
        showInvisible: args.flags['show-invisible'] === true
      })

      await writeFile(resolve(output), result.png)
      process.stdout.write(`${result.width}×${result.height} → ${output}\n`)
      for (const caveat of result.caveats) process.stdout.write(`  note: ${caveat}\n`)
      return 0
    }

    case 'set': {
      requireAtLeast(args.positional, 1, 'set needs a file')
      const paneName = flagString(args.flags, 'pane')
      if (!paneName) throw new Error('set needs --pane to say which pane')

      const target = await resolveTarget(args.positional[0]!, entry)
      if (!isBflyt(target.bytes)) throw new Error('that is not a layout')
      const { document } = parseBflyt(target.bytes)

      const pane = findPane(document, paneName)
      if (!pane) {
        throw new Error(
          `no pane called ${paneName}. Run \`bflayout tree\` on this file to see the names.`
        )
      }

      const translate = flagString(args.flags, 'translate')
      const size = flagString(args.flags, 'size')
      const scale = flagString(args.flags, 'scale')
      const rotate = flagString(args.flags, 'rotate')
      const alpha = flagString(args.flags, 'alpha')
      const visible = flagString(args.flags, 'visible')
      const value = flagString(args.flags, 'text')

      const changed = editPane(pane, {
        ...(translate ? { translate: numbers(translate) as [number, number, number] } : {}),
        ...(size ? { size: numbers(size) as [number, number] } : {}),
        ...(scale ? { scale: numbers(scale) as [number, number] } : {}),
        ...(rotate ? { rotate: numbers(rotate) as [number, number, number] } : {}),
        ...(alpha ? { alpha: Number(alpha) } : {}),
        ...(visible ? { visible: visible === 'true' } : {}),
        ...(value !== undefined ? { text: value } : {})
      })

      const written = await writeLayout(target, document, output)
      process.stdout.write(`${paneName}: ${changed.join(', ')}\n→ ${written.path}\n`)
      return 0
    }

    case 'text': {
      requireAtLeast(args.positional, 1, 'text needs a file')
      const document = await readLayout(args.positional[0]!, entry)
      const yaml = text.layoutToText(document)
      if (output) {
        await writeFile(resolve(output), yaml)
        process.stdout.write(`→ ${output}\n`)
      } else {
        process.stdout.write(yaml)
      }
      return 0
    }

    case 'apply': {
      requireAtLeast(args.positional, 1, 'apply needs the file to write into')
      const from = flagString(args.flags, 'from')
      if (!from) throw new Error('apply needs --from to say which text document to read')

      const target = await resolveTarget(args.positional[0]!, entry)
      const document = text.layoutFromText(await readFile(resolve(from), 'utf8'))
      const written = await writeLayout(target, document, output)
      process.stdout.write(`applied ${from} → ${written.path} (${written.bytes} bytes)\n`)
      return 0
    }

    case 'check': {
      requireAtLeast(args.positional, 1, 'check needs at least one file')
      let errors = 0
      let warnings = 0

      for (const path of args.positional) {
        const result = await checkFile(path)
        process.stdout.write(`${basename(path)}  ${result.format}\n`)
        for (const note of result.notes) {
          if (note.level === 'error') errors += 1
          if (note.level === 'warning') warnings += 1
          process.stdout.write(`  ${note.level}: ${note.message}\n`)
        }
      }

      process.stdout.write(`\n${errors} error(s), ${warnings} warning(s)\n`)
      // A non-zero exit is what makes this usable as a CI gate.
      return errors > 0 ? 1 : 0
    }

    case 'diff': {
      requireAtLeast(args.positional, 2, 'diff needs two files')
      const before = await readLayout(args.positional[0]!, entry)
      const after = await readLayout(args.positional[1]!, entry)
      const changes = compare.diffLayouts(before, after)

      process.stdout.write(`${compare.summarizeChanges(changes)}\n`)
      for (const change of changes) {
        process.stdout.write(`  ${change.target}: ${change.detail}\n`)
      }
      return changes.length > 0 ? 1 : 0
    }

    case 'search': {
      requireAtLeast(args.positional, 2, 'search needs a folder and something to look for')
      const kind = flagString(args.flags, 'kind')
      const limit = flagString(args.flags, 'limit')

      const hits = await searchTree(args.positional[0]!, args.positional[1]!, {
        ...(kind ? { kinds: [kind] } : {}),
        ...(limit ? { limit: Number(limit) } : {})
      })

      for (const hit of hits) {
        const where = hit.entry ? `${basename(hit.path)}:${hit.entry}` : basename(hit.path)
        process.stdout.write(
          `${hit.kind.padEnd(16)} ${hit.name}${hit.detail ? `  (${hit.detail})` : ''}  — ${where}\n`
        )
      }
      if (hits.length === 0) process.stdout.write('nothing matched\n')
      return 0
    }

    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`)
      return 2
  }
}

function requireAtLeast(values: readonly string[], count: number, message: string): void {
  if (values.length < count) throw new Error(message)
}

function printTree(pane: ReturnType<typeof summarizePane>, depth: number): void {
  const pad = '  '.repeat(depth)
  const flags = [
    pane.visible ? null : 'hidden',
    pane.alpha === 255 ? null : `alpha ${pane.alpha}`,
    pane.text !== undefined ? `"${pane.text.slice(0, 40)}"` : null,
    pane.part ? `→ ${pane.part}` : null
  ].filter(Boolean)

  process.stdout.write(
    `${pad}${pane.kind}  ${pane.name}  ${pane.size[0]}×${pane.size[1]} @ ${pane.translate.join(', ')}` +
      `${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}\n`
  )
  for (const child of pane.children) printTree(child, depth + 1)
}

/**
 * Errors are printed and exited on, not thrown at the user.
 *
 * A stack trace is the wrong answer for "that file does not exist"; every failure
 * this can hit is a mistake in the command, and the message already says what to
 * do about it.
 */
main()
  .then((code) => process.exit(code))
  .catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exit(1)
  })
