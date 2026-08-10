import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'

import { compress as headlessCompress, decompress as headlessDecompress } from '@headless/compression'
import { CompressionService } from '@main/services/compression'
import { zstd } from '@main/zstd'

/**
 * One ZSTD instance per process, shared by everything that needs it.
 *
 * This is a regression test for a failure that was genuinely hard to read. The
 * app's compression service and the headless tools each had a private lazy
 * loader, and the app began hosting the headless tools in its own process — so
 * whichever initialised second re-instantiated the WASM module and replaced the
 * first's memory.
 *
 * What that looked like from the outside: `.blarc.zs` files that had opened a
 * moment ago started reporting "starts with 28 b5 2f fd, which this build does
 * not recognise" — the sniffer reading the *still-compressed* header, because the
 * decompression underneath had failed and the caller fell back to the raw bytes.
 * Nothing named ZSTD anywhere in that message.
 *
 * The codebase already knew: `selftest.ts` carries a note that a second
 * `import('@bokuweb/zstd-wasm')` in the same bundle failed for all 56,545
 * candidates it tried.
 */

const viaApp = (data: Uint8Array): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const compression = yield* CompressionService
      return (yield* compression.decompress(data)).data.length
    }).pipe(Effect.provide(CompressionService.Default))
  )

const viaHeadless = async (data: Uint8Array): Promise<number> =>
  (await headlessDecompress(data)).data.length

describe('the shared ZSTD instance', () => {
  it('hands both callers the same module', async () => {
    expect(await zstd()).toBe(await zstd())
  })

  it('survives two concurrent first calls', async () => {
    // Both see it uninitialised and would each call init() if the promise were
    // not cached alongside the module.
    const [first, second] = await Promise.all([zstd(), zstd()])
    expect(first).toBe(second)
  })

  /**
   * The actual regression: interleaved use from both paths. Before the fix the
   * second initialiser broke the first, and the symptom appeared later and
   * elsewhere.
   */
  it('lets the app and the headless tools decompress in any order', async () => {
    const original = new Uint8Array(64 * 1024)
    for (let at = 0; at < original.length; at++) original[at] = (at * 7) & 0xff

    const packed = await headlessCompress(original, 'zstd')
    // Sanity: it really is ZSTD, magic 28 b5 2f fd.
    expect([...packed.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd])

    expect(await viaApp(packed)).toBe(original.length)
    expect(await viaHeadless(packed)).toBe(original.length)
    expect(await viaApp(packed)).toBe(original.length)
    expect(await viaHeadless(packed)).toBe(original.length)
  })

  it('round-trips through the headless path', async () => {
    const original = new TextEncoder().encode('layout bytes '.repeat(500))
    const packed = await headlessCompress(original, 'zstd')
    const expanded = await headlessDecompress(packed)

    expect(expanded.compression).toBe('zstd')
    expect([...expanded.data]).toEqual([...original])
  })

  it('leaves uncompressed data alone', async () => {
    const plain = new TextEncoder().encode('FLYT not compressed')
    const result = await headlessDecompress(plain)
    expect(result.compression).toBe('none')
    expect([...result.data]).toEqual([...plain])
  })
})
