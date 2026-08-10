import { describe, expect, it } from 'vitest'

import { crc32, readZip, writeZip } from '@main/zip'

/**
 * The container mods ship in.
 *
 * The checksum test is the one that earns its place. This reader opens archives
 * other people built and downloaded over the internet, and a truncated file that
 * installs cleanly and then corrupts a game asset is a far worse outcome than a
 * refused import.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('zip', () => {
  it('round-trips entries', () => {
    const entries = [
      { name: 'romfs/Layout/Menu.szs', data: encoder.encode('archive bytes') },
      { name: 'manifest.json', data: encoder.encode('{"name":"test"}') }
    ]

    const read = readZip(writeZip(entries))
    expect(read.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name))
    expect(decoder.decode(read[0]!.data)).toBe('archive bytes')
  })

  it('carries binary data through unchanged', () => {
    const data = new Uint8Array(4096)
    for (let at = 0; at < data.length; at++) data[at] = (at * 31 + (at >> 4)) & 0xff

    const read = readZip(writeZip([{ name: 'blob.bin', data }]))
    expect([...read[0]!.data]).toEqual([...data])
  })

  it('handles an empty file', () => {
    const read = readZip(writeZip([{ name: 'empty.bin', data: new Uint8Array(0) }]))
    expect(read[0]!.data).toHaveLength(0)
  })

  /** Already-compressed game assets deflate to something larger; storing is correct. */
  it('stores rather than deflates when compression does not help', () => {
    const random = new Uint8Array(2048)
    // A pseudo-random pattern with no structure for deflate to find.
    let seed = 12345
    for (let at = 0; at < random.length; at++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      random[at] = seed & 0xff
    }

    const zipped = writeZip([{ name: 'noise.bin', data: random }])
    expect(readZip(zipped)[0]!.data).toEqual(random)
    // Storing means the payload is not larger than the input plus the record overhead.
    expect(zipped.length).toBeLessThan(random.length + 512)
  })

  it('compresses what compresses', () => {
    const repetitive = encoder.encode('the same line over and over\n'.repeat(500))
    const zipped = writeZip([{ name: 'repeat.txt', data: repetitive }])
    expect(zipped.length).toBeLessThan(repetitive.length / 4)
    expect(readZip(zipped)[0]!.data).toEqual(repetitive)
  })

  it('is byte-reproducible, so an unchanged mod repackages identically', () => {
    const entries = [{ name: 'a.txt', data: encoder.encode('hello') }]
    expect([...writeZip(entries)]).toEqual([...writeZip(entries)])
  })

  it('refuses a damaged archive rather than installing it', () => {
    const zipped = writeZip([{ name: 'a.txt', data: encoder.encode('hello world') }])
    // Corrupt a byte inside the stored payload.
    const damaged = new Uint8Array(zipped)
    damaged[40] = damaged[40]! ^ 0xff

    expect(() => readZip(damaged)).toThrow(/checksum|damaged/)
  })

  it('refuses something that is not a zip at all', () => {
    expect(() => readZip(encoder.encode('not a zip'))).toThrow(/not a zip/)
  })

  it('computes the standard CRC-32', () => {
    // The canonical check value for "123456789".
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
  })
})
