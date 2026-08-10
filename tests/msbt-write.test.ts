import { describe, expect, it } from 'vitest'

import { FormatWriteError } from '@shared/binary/errors'
import { msbtLabelHash, parseMsbt, writeMsbt, type MsbtDocument } from '@shared/formats/msbt'
import {
  replaceInDocument,
  runsFromText,
  setMessageText
} from '@shared/formats/msbt/editing'

/**
 * Writing message tables.
 *
 * The stakes here are different from the other codecs. A layout that re-encodes
 * imperfectly draws wrong and you see it; a message table that re-encodes
 * imperfectly loses a variable substitution buried in string 2,847 of 3,406, and
 * nobody sees it until a player does. So the tests that matter are about what
 * survives, not about what can be written.
 */

function build(sections: { signature: string; body: number[] }[], encoding: 0 | 1): Uint8Array {
  const out: number[] = []
  const u16 = (value: number): void => {
    out.push(value & 0xff, (value >> 8) & 0xff)
  }
  const u32 = (value: number): void => {
    u16(value & 0xffff)
    u16((value >>> 16) & 0xffff)
  }

  for (const character of 'MsgStdBn') out.push(character.charCodeAt(0))
  out.push(0xff, 0xfe)
  out.push(0, 0)
  out.push(encoding, 3)
  u16(sections.length)
  out.push(0, 0)
  const sizeAt = out.length
  u32(0)
  while (out.length < 0x20) out.push(0)

  for (const section of sections) {
    for (const character of section.signature) out.push(character.charCodeAt(0))
    u32(section.body.length)
    for (let index = 0; index < 8; index++) out.push(0)
    out.push(...section.body)
    while (out.length % 16 !== 0) out.push(0xab)
  }

  const bytes = new Uint8Array(out)
  new DataView(bytes.buffer).setUint32(sizeAt, bytes.length, true)
  return bytes
}

const u32Into = (body: number[], value: number): void => {
  body.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
}

/** `LBL1` with the real hash bucketing, so a rewrite has something to reproduce. */
function labelSection(labels: { name: string; index: number }[], groupCount: number): number[] {
  const body: number[] = []
  const buckets: { name: string; index: number }[][] = Array.from(
    { length: groupCount },
    () => []
  )
  for (const label of labels) buckets[msbtLabelHash(label.name, groupCount)]!.push(label)

  u32Into(body, groupCount)
  let cursor = 4 + groupCount * 8
  const offsets: number[] = []
  for (const bucket of buckets) {
    offsets.push(cursor)
    for (const entry of bucket) cursor += 1 + entry.name.length + 4
  }
  for (let at = 0; at < groupCount; at++) {
    u32Into(body, buckets[at]!.length)
    u32Into(body, offsets[at]!)
  }
  for (const bucket of buckets) {
    for (const entry of bucket) {
      body.push(entry.name.length)
      for (const character of entry.name) body.push(character.charCodeAt(0))
      u32Into(body, entry.index)
    }
  }
  return body
}

/** `TXT2` where a string may carry an inline command with a payload. */
function textSection(strings: readonly (string | number[])[]): number[] {
  const encoded = strings.map((value) => {
    if (typeof value !== 'string') return value
    const bytes: number[] = []
    for (const character of value) {
      const code = character.charCodeAt(0)
      bytes.push(code & 0xff, (code >> 8) & 0xff)
    }
    bytes.push(0, 0)
    return bytes
  })

  const body: number[] = []
  u32Into(body, encoded.length)
  let cursor = 4 + encoded.length * 4
  for (const bytes of encoded) {
    u32Into(body, cursor)
    cursor += bytes.length
  }
  for (const bytes of encoded) body.push(...bytes)
  return body
}

/** UTF-16 units for a string, with no terminator. */
function units(value: string): number[] {
  const out: number[] = []
  for (const character of value) {
    const code = character.charCodeAt(0)
    out.push(code & 0xff, (code >> 8) & 0xff)
  }
  return out
}

/**
 * `Hello ` + a `0x0E` command (group 1, type 4, two payload bytes) + `!`.
 *
 * This is the shape that makes writing dangerous: the payload is the variable id,
 * and it is not recoverable from the placeholder the editor shows.
 */
const commandString = (): number[] => [
  ...units('Hello '),
  0x0e,
  0x00,
  0x01,
  0x00, // group 1
  0x04,
  0x00, // type 4
  0x02,
  0x00, // payload size
  0xbe,
  0xef, // the payload itself
  ...units('!'),
  0,
  0
]

function sample(): MsbtDocument {
  return parseMsbt(
    build(
      [
        {
          signature: 'LBL1',
          body: labelSection(
            [
              { name: 'Greeting', index: 0 },
              { name: 'Farewell', index: 1 }
            ],
            101
          )
        },
        { signature: 'ATR1', body: [7, 7, 7, 7] },
        { signature: 'TXT2', body: textSection([commandString(), 'Goodbye']) }
      ],
      1
    )
  )
}

describe('writeMsbt', () => {
  it('round-trips a table through a write unchanged', () => {
    const document = sample()
    const reparsed = parseMsbt(writeMsbt(document))

    expect(reparsed.messages.map((message) => message.text)).toEqual(
      document.messages.map((message) => message.text)
    )
    expect(reparsed.messages.map((message) => message.label)).toEqual(['Greeting', 'Farewell'])
    expect(reparsed.sections).toEqual(document.sections)
  })

  /**
   * The failure this whole design exists to prevent. The editor shows `{n:1.4}`;
   * the file holds two bytes of payload the placeholder cannot express. A writer
   * that worked from the display string would emit eight literal characters and
   * the variable would be gone.
   */
  it('keeps an inline command payload byte for byte', () => {
    const reparsed = parseMsbt(writeMsbt(sample()))
    const command = reparsed.messages[0]!.runs.find((run) => run.kind === 'command')

    expect(command).toMatchObject({ group: 1, type: 4, payload: [0xbe, 0xef] })
  })

  /** ATR1 is per-string data whose meaning is game-specific; dropping it loses attributes. */
  it('replays a section it does not model', () => {
    const reparsed = parseMsbt(writeMsbt(sample()))
    const atr1 = reparsed.rawSections.find((section) => section.signature === 'ATR1')
    expect(atr1?.data).toEqual([7, 7, 7, 7])
  })

  it('puts every label back in the bucket it came from', () => {
    const document = sample()
    const reparsed = parseMsbt(writeMsbt(document))
    expect(reparsed.labelGroupCount).toBe(document.labelGroupCount)
  })
})

describe('editing a message', () => {
  it('replaces the text and leaves the command where the placeholder went', () => {
    const document = sample()
    const before = document.messages[0]!.text
    expect(before).toBe('Hello {n:1.4}!')

    const edited = setMessageText(document, 0, 'Oi {n:1.4}, hello')
    const reparsed = parseMsbt(writeMsbt(edited))

    expect(reparsed.messages[0]!.text).toBe('Oi {n:1.4}, hello')
    expect(reparsed.messages[0]!.runs.find((run) => run.kind === 'command')).toMatchObject({
      payload: [0xbe, 0xef]
    })
  })

  /** Moving a substitution to a different place in the sentence is the job. */
  it('lets a placeholder move', () => {
    const edited = setMessageText(sample(), 0, '{n:1.4} says hello')
    expect(edited.messages[0]!.runs[0]).toMatchObject({ kind: 'command', type: 4 })
  })

  it('lets a placeholder be dropped', () => {
    const edited = setMessageText(sample(), 0, 'Hello!')
    expect(edited.messages[0]!.runs.some((run) => run.kind === 'command')).toBe(false)
  })

  /**
   * Refused rather than guessed. An invented command has no payload, and emitting
   * an empty one produces a file the game reads and misdraws — which is worse than
   * not saving.
   */
  it('refuses a placeholder the message never had', () => {
    expect(() => setMessageText(sample(), 0, 'Hello {n:9.9}!')).toThrow(FormatWriteError)
  })

  it('is a no-op when the text is unchanged, so a dirty flag stays honest', () => {
    const document = sample()
    expect(setMessageText(document, 0, document.messages[0]!.text)).toBe(document)
  })
})

describe('replaceInDocument', () => {
  it('reports what changed rather than only how much', () => {
    const result = replaceInDocument(sample(), 'Goodbye', 'Farewell')

    expect(result.changed).toBe(1)
    expect(result.examples).toEqual([
      { label: 'Farewell', before: 'Goodbye', after: 'Farewell' }
    ])
    expect(result.document.messages[1]!.text).toBe('Farewell')
  })

  it('treats a plain string as literal, not as a pattern', () => {
    // As a regular expression this matches "Goodbye"; as the literal string
    // someone typed, it matches nothing.
    expect(replaceInDocument(sample(), 'G.odbye', 'x').changed).toBe(0)
    expect(replaceInDocument(sample(), /G.odbye/, 'x').changed).toBe(1)
  })

  /**
   * A period is an ordinary character in a placeholder, so a literal search for
   * one finds `{n:1.4}`. That is correct and it is also the trap the examples in
   * the summary exist for — a batch edit that reports only a count is one nobody
   * can check.
   */
  it('will match inside a placeholder, which is why the summary shows examples', () => {
    const result = replaceInDocument(sample(), '.', '!')
    expect(result.changed).toBe(1)
    expect(result.examples[0]?.before).toBe('Hello {n:1.4}!')
  })

  it('takes a regular expression when one is wanted', () => {
    const result = replaceInDocument(sample(), /^Good/, 'Great')
    expect(result.document.messages[1]!.text).toBe('Greatbye')
  })
})

describe('runsFromText', () => {
  it('splits text around placeholders', () => {
    const original = sample().messages[0]!.runs
    const runs = runsFromText(original, 'a{n:1.4}b')
    expect(runs.map((run) => run.kind)).toEqual(['text', 'command', 'text'])
  })

  it('reuses a payload when a placeholder is repeated', () => {
    const original = sample().messages[0]!.runs
    const runs = runsFromText(original, '{n:1.4}{n:1.4}')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual(runs[1])
  })
})
