import { describe, expect, it } from 'vitest'

import { FormatParseError } from '@shared/binary/errors'
import { fromYaml, toYaml, type YamlValue } from '@shared/text/yaml'

/**
 * The text form layouts are serialized through.
 *
 * The property that matters is the round trip, and specifically the round trip of
 * *awkward* values. A serializer that handles ordinary pane names and mangles the
 * one called `Btn: "OK"` corrupts a single file in a dump of ten thousand, which
 * is the kind of bug that is found months later by a player.
 */

const roundTrip = (value: YamlValue): YamlValue => fromYaml(toYaml(value))

describe('yaml round trip', () => {
  it('carries scalars unchanged', () => {
    const value = {
      name: 'RootPane',
      width: 1280,
      alpha: 0.5,
      negative: -12,
      visible: true,
      hidden: false,
      missing: null
    }
    expect(roundTrip(value)).toEqual(value)
  })

  it('carries nested maps and lists', () => {
    const value = {
      info: { width: 1280, height: 720 },
      textures: ['A.bntx', 'B.bntx'],
      panes: [
        { name: 'One', children: [] },
        { name: 'Two', children: [{ name: 'Three', children: [] }] }
      ]
    }
    expect(roundTrip(value)).toEqual(value)
  })

  /**
   * The whole reason quoting goes through JSON. Every one of these breaks a
   * hand-rolled quoter in a different way.
   */
  it.each([
    ['a colon and a space', 'Btn: OK'],
    ['double quotes', 'say "hi"'],
    ['a newline', 'line one\nline two'],
    ['a leading dash', '- not a list'],
    ['a leading hash', '# not a comment'],
    ['a backslash', 'C:\\path\\to'],
    ['a tab', 'a\tb'],
    ['nothing at all', ''],
    ['only spaces', '   '],
    ['a word YAML would read as a boolean', 'yes'],
    ['a word YAML would read as null', 'null'],
    ['something that looks like a number', '0123'],
    ['non-ASCII', 'ボタン'],
    ['an emoji', '🎮 start']
  ])('survives a string with %s', (_why, text) => {
    expect(roundTrip({ name: text })).toEqual({ name: text })
  })

  it('keeps an awkward string usable as a key', () => {
    const value = { 'Btn: "OK"': 1, plain: 2 }
    expect(roundTrip(value)).toEqual(value)
  })

  it('keeps empty containers distinct from null', () => {
    const value = { list: [], map: {}, nothing: null }
    expect(roundTrip(value)).toEqual(value)
  })

  it('preserves key order, so a diff is about the change', () => {
    const text = toYaml({ b: 1, a: 2, c: 3 })
    expect(text.split('\n').filter(Boolean)).toEqual(['b: 1', 'a: 2', 'c: 3'])
  })

  it('emits a list of maps as a list', () => {
    expect(toYaml({ panes: [{ name: 'One' }, { name: 'Two' }] })).toBe(
      'panes:\n  - name: One\n  - name: Two\n'
    )
  })

  it('reads a list of maps back', () => {
    expect(fromYaml('panes:\n  - name: One\n    id: 1\n  - name: Two\n    id: 2\n')).toEqual({
      panes: [
        { name: 'One', id: 1 },
        { name: 'Two', id: 2 }
      ]
    })
  })

  it('ignores comments and blank lines', () => {
    expect(fromYaml('# a note\n\nname: Root\n\n# another\nwidth: 10\n')).toEqual({
      name: 'Root',
      width: 10
    })
  })

  /** A version like 8.9.0 is a string; reading it as a number would lose a component. */
  it('does not turn a dotted version into a number', () => {
    expect(fromYaml('version: 8.9.0\n')).toEqual({ version: '8.9.0' })
    expect(fromYaml('version: 8.9\n')).toEqual({ version: 8.9 })
  })

  it('fails with a line number rather than losing a field', () => {
    expect(() => fromYaml('name: Root\nthis line has no colon\n')).toThrow(FormatParseError)
  })
})
