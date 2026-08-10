import { FormatParseError } from '@shared/binary/errors'

/**
 * A small YAML dialect, used to give binary layouts a form git can review.
 *
 * Not a general YAML implementation and not trying to be. It emits and reads back
 * exactly one shape — nested maps, lists and scalars — which is all a layout
 * document is once it is out of its binary form.
 *
 * The escaping trick is what makes it safe: any string that is not trivially
 * plain is emitted as a **JSON** string, and JSON strings are valid YAML
 * double-quoted scalars. So quoting and unquoting go through `JSON.stringify` and
 * `JSON.parse` rather than through rules hand-written here, and a pane called
 * `Btn: "OK"\n` survives a round trip instead of silently becoming three broken
 * lines. Hand-rolled quoting is exactly how a serializer corrupts one name in ten
 * thousand and nobody notices for a month.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue }

/** Strings safe to emit bare: no quoting rules to get wrong, and readable. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_.\-/]*$/

/** Bare words YAML would read back as something other than a string. */
const RESERVED = new Set([
  'true',
  'false',
  'null',
  'yes',
  'no',
  'on',
  'off',
  'y',
  'n',
  '~'
])

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    // NaN and the infinities have no round-trippable YAML spelling that this
    // reader would recover as a number, and a layout has no business holding one.
    if (!Number.isFinite(value)) return 'null'
    return String(value)
  }
  if (PLAIN.test(value) && !RESERVED.has(value.toLowerCase())) return value
  return JSON.stringify(value)
}

function isRecord(value: YamlValue): value is { readonly [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A guard rather than `!Array.isArray(…) && !isRecord(…)`.
 *
 * `Array.isArray` does not narrow a `readonly T[]` out of a union, so the
 * negative form leaves the compiler still believing a container might reach
 * `scalar` — and silencing that with a cast is how a container ends up emitted as
 * `[object Object]`.
 */
function isScalar(value: YamlValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object'
}

/**
 * Emits a document.
 *
 * Key order is the object's own, deliberately: the writers below emit fields in a
 * fixed order, and preserving it keeps a diff between two versions of a layout
 * about what changed rather than about how the serializer felt.
 */
export function toYaml(value: YamlValue, indent = 0): string {
  const pad = '  '.repeat(indent)

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`
    let out = ''
    for (const item of value) {
      if (isRecord(item) || Array.isArray(item)) {
        const body = toYaml(item, indent + 1)
        // The dash replaces the first two spaces of the child's indentation, so a
        // list of maps reads as a list rather than as a map of one key.
        out += `${pad}-${body.slice(pad.length + 1)}`
      } else {
        out += `${pad}- ${scalar(item)}\n`
      }
    }
    return out
  }

  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return `${pad}{}\n`
    let out = ''
    for (const key of keys) {
      const child = value[key]!
      if (isScalar(child)) {
        out += `${pad}${scalar(key)}: ${scalar(child)}\n`
      } else if (isRecord(child)) {
        out +=
          Object.keys(child).length === 0
            ? `${pad}${scalar(key)}: {}\n`
            : `${pad}${scalar(key)}:\n${toYaml(child, indent + 1)}`
      } else {
        out +=
          child.length === 0
            ? `${pad}${scalar(key)}: []\n`
            : `${pad}${scalar(key)}:\n${toYaml(child, indent + 1)}`
      }
    }
    return out
  }

  // Everything else was handled above; this is the bare-scalar document.
  return `${pad}${scalar(isScalar(value) ? value : null)}\n`
}

interface Line {
  readonly indent: number
  readonly text: string
  readonly number: number
}

function parseScalar(raw: string, line: number): YamlValue {
  const text = raw.trim()
  if (text === '' || text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === '[]') return []
  if (text === '{}') return {}

  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as YamlValue
    } catch {
      throw new FormatParseError({
        format: 'yaml',
        offset: line,
        message: `line ${line}: ${text} is not a readable quoted string`
      })
    }
  }

  // Numbers only when the whole token is one; a version like 8.9.0 stays a string.
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return Number(text)
  return text
}

/**
 * Reads back what `toYaml` produced.
 *
 * Line- and indentation-based, with no support for flow collections, anchors,
 * multi-document files or block scalars — none of which the emitter produces. A
 * file it cannot read fails with a line number rather than quietly yielding a
 * document with a field missing.
 */
export function fromYaml(source: string): YamlValue {
  const lines: Line[] = []
  source.split(/\r?\n/).forEach((raw, index) => {
    const withoutComment = raw.replace(/^(\s*)#.*$/, '$1')
    if (withoutComment.trim() === '') return
    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trim(),
      number: index + 1
    })
  })

  if (lines.length === 0) return null

  let at = 0

  const parseBlock = (indent: number): YamlValue => {
    const first = lines[at]!
    if (first.text.startsWith('- ') || first.text === '-') return parseList(indent)
    return parseMap(indent)
  }

  const parseList = (indent: number): YamlValue[] => {
    const items: YamlValue[] = []
    while (at < lines.length && lines[at]!.indent === indent && lines[at]!.text.startsWith('-')) {
      const line = lines[at]!
      const rest = line.text.slice(1).trim()
      at += 1

      if (rest === '') {
        items.push(at < lines.length && lines[at]!.indent > indent ? parseBlock(lines[at]!.indent) : null)
        continue
      }

      /*
       * `- key: value` starts a map whose first key shares the dash's line. Its
       * body is indented past the dash, so the map is re-read from a synthetic
       * line at that deeper indent.
       */
      if (/^[^:]+:(\s|$)/.test(rest)) {
        const inner = indent + 2
        lines.splice(at, 0, { indent: inner, text: rest, number: line.number })
        items.push(parseMap(inner))
        continue
      }

      items.push(parseScalar(rest, line.number))
    }
    return items
  }

  const parseMap = (indent: number): { [key: string]: YamlValue } => {
    const out: { [key: string]: YamlValue } = {}
    while (at < lines.length && lines[at]!.indent === indent) {
      const line = lines[at]!
      if (line.text.startsWith('- ')) break

      const colon = findKeyEnd(line.text, line.number)
      const key = String(parseScalar(line.text.slice(0, colon), line.number))
      const rest = line.text.slice(colon + 1).trim()
      at += 1

      if (rest !== '') {
        out[key] = parseScalar(rest, line.number)
        continue
      }
      out[key] =
        at < lines.length && lines[at]!.indent > indent ? parseBlock(lines[at]!.indent) : null
    }
    return out
  }

  const result = parseBlock(lines[0]!.indent)
  if (at < lines.length) {
    throw new FormatParseError({
      format: 'yaml',
      offset: lines[at]!.number,
      message: `line ${lines[at]!.number}: unexpected indentation`
    })
  }
  return result
}

/** The colon that separates a key from its value, skipping any inside quotes. */
function findKeyEnd(text: string, line: number): number {
  if (text.startsWith('"')) {
    for (let at = 1; at < text.length; at++) {
      if (text[at] === '\\') {
        at += 1
        continue
      }
      if (text[at] === '"') {
        if (text[at + 1] !== ':') break
        return at + 1
      }
    }
    throw new FormatParseError({
      format: 'yaml',
      offset: line,
      message: `line ${line}: quoted key is not closed, or is not followed by a colon`
    })
  }

  const colon = text.indexOf(':')
  if (colon < 0) {
    throw new FormatParseError({
      format: 'yaml',
      offset: line,
      message: `line ${line}: expected "key: value"`
    })
  }
  return colon
}
