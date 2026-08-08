import { describe, expect, it } from 'vitest'

import {
  parseSnapshotKey,
  snapshotKeyFor,
  snapshotKeyPath
} from '@shared/contract/snapshot-key'

/**
 * Recovery snapshots outlive the process that wrote them, so their key must name the
 * file rather than any handle the process minted. These check the round trip and that a
 * key from anywhere else is rejected rather than half-understood.
 */
describe('snapshot keys', () => {
  it('round-trips a loose file', () => {
    const source = { kind: 'file', path: '/games/Layout/Menu.bflyt' } as const
    expect(parseSnapshotKey(snapshotKeyFor(source))).toEqual(source)
  })

  it('round-trips an entry inside an archive', () => {
    const source = {
      kind: 'archive',
      archivePath: '/games/Layout/Menu.szs',
      entryKey: 'blyt/Menu.bflyt'
    } as const
    expect(parseSnapshotKey(snapshotKeyFor(source))).toEqual(source)
  })

  it('keeps paths containing the characters a naive separator would break on', () => {
    // ':', '#' and '|' all appear in real filenames; the separator must not be one.
    const source = {
      kind: 'archive',
      archivePath: '/games/a#b:c|d/Menu.szs',
      entryKey: 'blyt/x#y.bflyt'
    } as const
    expect(parseSnapshotKey(snapshotKeyFor(source))).toEqual(source)
  })

  it('distinguishes two entries in the same archive', () => {
    const one = snapshotKeyFor({ kind: 'archive', archivePath: '/a.szs', entryKey: 'blyt/A.bflyt' })
    const two = snapshotKeyFor({ kind: 'archive', archivePath: '/a.szs', entryKey: 'blyt/B.bflyt' })
    expect(one).not.toBe(two)
  })

  it('rejects anything it cannot read back', () => {
    // A row from an older build was keyed `doc_1`, which names nothing reopenable.
    expect(parseSnapshotKey('doc_1')).toBeNull()
    expect(parseSnapshotKey('')).toBeNull()
    expect(parseSnapshotKey('file')).toBeNull()
    expect(parseSnapshotKey('file\n')).toBeNull()
    expect(parseSnapshotKey('archive\n/a.szs')).toBeNull()
    expect(parseSnapshotKey('folder\n/a')).toBeNull()
  })

  it('points staleness checks at the file that actually exists on disk', () => {
    expect(snapshotKeyPath({ kind: 'file', path: '/a/B.bflyt' })).toBe('/a/B.bflyt')
    // For an archive entry that is the archive, not the entry inside it.
    expect(
      snapshotKeyPath({ kind: 'archive', archivePath: '/a/B.szs', entryKey: 'blyt/C.bflyt' })
    ).toBe('/a/B.szs')
  })
})
