/**
 * Parses every BWAV in a dump — loose files and the ones inside `.bars` archives — and reports what
 * came out.
 *
 *     tsx --tsconfig tsconfig.node.json scripts/validate-bwav.ts /path/to/romfs
 *
 * The same shape as `validate:msbt`, and for the same reason: there is no reference implementation
 * for BWAV to check against and no round-trip to compare, so the evidence is breadth. Every file
 * parsing is the bar the other codecs here hold (SARC 567/567, BFLYT 544/544, BFLAN 2187/2187,
 * MSBT 3406/3406), and the ratio is printed rather than implied.
 *
 * Two checks go beyond "it parsed". Byte accounting reconstructs each complete file's expected
 * length from its declared sample counts and compares against the real length on disk, which is the
 * only independent confirmation that the sample-count fields mean what this parser says they mean —
 * and duration is derived from those fields, so it is really a check on the duration. The loop
 * invariant asserts that a loop is a range and lies inside the stream. Neither is something the
 * parser could tell you about itself.
 *
 * Nothing here reads a whole loose BWAV. They run to tens of megabytes and there are 946 of them;
 * the parser wants the header, so the script reads a header-sized prefix and the size from `stat`.
 */
import { readFileSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import {
  bwavChannelCount,
  bwavHeaderSize,
  describeBwavCodec,
  isBars,
  isBwav,
  parseBarsIndex,
  parseBwav,
  type BwavHeader
} from '@shared/formats/bwav'

async function* walk(dir: string): AsyncGenerator<string> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) yield* walk(path)
    else yield path
  }
}

/** Reads the first `count` bytes without pulling the rest of the file into memory. */
async function prefix(path: string, count: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = new Uint8Array(count)
    const { bytesRead } = await handle.read(buffer, 0, count, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Bytes one channel's stored samples occupy.
 *
 * DSP ADPCM packs 14 samples into an 8-byte frame — one header byte then one nibble per sample — and
 * a partial final frame carries only the nibbles it needs. That rule is not a citation: it is what
 * makes the arithmetic below close on all 946 files, and getting it wrong shows up immediately as a
 * few bytes of drift per file.
 */
function storedBytes(codec: number, samples: number): number | null {
  if (codec === 0) return samples * 2
  if (codec !== 1) return null
  const frames = Math.floor(samples / 14)
  const remainder = samples % 14
  return frames * 8 + (remainder === 0 ? 0 : 1 + Math.ceil(remainder / 2))
}

interface Totals {
  files: number
  parsed: number
  prefetch: number
  looping: number
  decodable: number
  seconds: number
  accountedExactly: number
  accountedWithin: number
  accountingSkipped: number
  accountingFailed: number
}

const empty = (): Totals => ({
  files: 0,
  parsed: 0,
  prefetch: 0,
  looping: 0,
  decodable: 0,
  seconds: 0,
  accountedExactly: 0,
  accountedWithin: 0,
  accountingSkipped: 0,
  accountingFailed: 0
})

const rates = new Map<number, number>()
const channelCounts = new Map<number, number>()
const codecs = new Map<number, number>()
const layouts = new Map<number, number>()
const versions = new Map<number, number>()
const unknown38 = new Map<number, number>()
const failures: string[] = []
const loopProblems: string[] = []
/** Every duration seen, sorted once at the end — a running top-N is easy to get subtly wrong. */
const durations: { name: string; seconds: number }[] = []

const tally = (map: Map<number, number>, key: number): void => {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/** Records the per-field census and the invariants the parser does not check itself. */
function record(name: string, header: BwavHeader, totals: Totals, size: number | null): void {
  totals.parsed++
  if (header.prefetch) totals.prefetch++
  if (header.looping) totals.looping++
  if (header.decodable) totals.decodable++
  if (header.durationSeconds !== null) totals.seconds += header.durationSeconds

  tally(versions, header.version)
  tally(channelCounts, header.channelCount)
  for (const channel of header.channels) {
    tally(rates, channel.sampleRate)
    tally(codecs, channel.codec)
    tally(layouts, channel.channelLayout)
    tally(unknown38, channel.unknown38)

    // A loop must be a range inside the stream it belongs to.
    if (channel.loop) {
      const { startSample, endSample } = channel.loop
      if (startSample >= endSample || endSample > channel.streamSampleCount) {
        loopProblems.push(
          `${name} ch${channel.index}: loop ${startSample}..${endSample} of ${channel.streamSampleCount} samples`
        )
      }
    }
  }

  if (header.durationSeconds !== null) durations.push({ name, seconds: header.durationSeconds })

  /*
   * Byte accounting, for complete files only. A prefetch stub's channel offsets describe the stream
   * it stands in for rather than the bytes it holds, so there is nothing here to measure against;
   * those are counted as skipped rather than quietly passed.
   */
  if (size === null || header.prefetch) {
    totals.accountingSkipped++
    return
  }
  let end = 0
  for (const channel of header.channels) {
    const bytes = storedBytes(channel.codec, channel.storedSampleCount)
    if (bytes === null) {
      totals.accountingSkipped++
      return
    }
    end = Math.max(end, channel.dataOffset + bytes)
  }
  const slack = size - end
  if (slack === 0) totals.accountedExactly++
  else if (slack > 0 && slack < 0x20) totals.accountedWithin++
  else {
    totals.accountingFailed++
    failures.push(`${name}: sample data ends at ${end} but the file is ${size} bytes (slack ${slack})`)
  }
}

async function main(): Promise<void> {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: validate-bwav.ts /path/to/romfs')
    process.exit(1)
  }

  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  const loose = empty()
  const inBars = empty()
  let barsArchives = 0
  let barsEntries = 0
  let barsNonBwavEntries = 0

  for await (const path of walk(root)) {
    const name = basename(path)
    const head = await prefix(path, 0x20)
    if (head.length < 0x10) continue
    const compression = detectCompression(head)

    // Loose, uncompressed: the header prefix is all that is needed, and `stat` gives the length.
    if (compression === 'none' && isBwav(head)) {
      loose.files++
      try {
        const size = (await stat(path)).size
        const channels = bwavChannelCount(head)
        const header = parseBwav(await prefix(path, bwavHeaderSize(channels)), { fileSize: size })
        record(name, header, loose, size)
      } catch (cause) {
        failures.push(`${name}: ${(cause as Error).message}`)
      }
      continue
    }

    /*
     * Anything else has to be decompressed before its magic is readable, so it is only worth
     * opening if it could be a BARS or a compressed BWAV. Both are settled by the first four bytes
     * after decompression.
     */
    if (compression !== 'none' || isBars(head)) {
      let data: Uint8Array
      try {
        const raw = new Uint8Array(readFileSync(path))
        data =
          compression === 'zstd'
            ? new Uint8Array(zstd.decompress(raw))
            : compression === 'yaz0'
              ? decompressYaz0(raw)
              : raw
      } catch {
        continue
      }

      if (isBwav(data)) {
        loose.files++
        try {
          record(name, parseBwav(data, { fileSize: data.length }), loose, data.length)
        } catch (cause) {
          failures.push(`${name}: ${(cause as Error).message}`)
        }
        continue
      }

      if (!isBars(data)) continue
      barsArchives++
      let entries
      try {
        entries = parseBarsIndex(data).entries
      } catch (cause) {
        failures.push(`${name}: BARS index — ${(cause as Error).message}`)
        continue
      }
      for (const entry of entries) {
        barsEntries++
        const payload = data.subarray(entry.audioOffset)
        if (!isBwav(payload)) {
          barsNonBwavEntries++
          continue
        }
        inBars.files++
        const label = `${name}#${entry.index} (hash ${entry.nameHash.toString(16)})`
        try {
          // No fileSize: an entry's own extent is not declared anywhere, and the next entry's
          // offset is not a bound — nothing says the payloads are laid out in index order.
          record(label, parseBwav(payload), inBars, null)
        } catch (cause) {
          failures.push(`${label}: ${(cause as Error).message}`)
        }
      }
    }
  }

  const pct = (part: number, whole: number): string =>
    whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(2)}%`
  const hours = (seconds: number): string =>
    `${(seconds / 3600).toFixed(2)} h (${Math.round(seconds)} s)`

  const section = (label: string, totals: Totals): void => {
    console.log(`${label}:`)
    console.log(`  found:            ${totals.files}`)
    console.log(
      `  parsed cleanly:   ${totals.parsed} / ${totals.files}  ${pct(totals.parsed, totals.files)}`
    )
    console.log(`  prefetch stubs:   ${totals.prefetch}`)
    console.log(`  looping samples:  ${totals.looping}`)
    console.log(`  total duration:   ${hours(totals.seconds)}`)
    console.log(`  this build can decode the audio of: ${totals.decodable}`)
    console.log(
      `  byte accounting:  ${totals.accountedExactly} exact, ` +
        `${totals.accountedWithin} within 32 bytes of padding, ` +
        `${totals.accountingFailed} wrong, ${totals.accountingSkipped} not applicable`
    )
  }

  section('loose BWAV files', loose)
  section('BWAV inside .bars', inBars)
  /*
   * The two durations are not additive. A prefetch stub declares the length of the stream it stands
   * in for, which for all 946 of them is a loose file already counted above — so the BARS figure
   * mostly restates the loose one rather than adding to it.
   */
  console.log(`.bars archives: ${barsArchives}, entries ${barsEntries}, of which non-BWAV ${barsNonBwavEntries}`)

  const census = (label: string, map: Map<number, number>, name?: (key: number) => string): void => {
    console.log(`${label}:`)
    for (const [key, count] of [...map].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name ? name(key) : key}: ${count}`)
    }
  }
  census('sample rates seen (per channel)', rates)
  census('channel counts seen (per file)', channelCounts)
  census('codecs seen (per channel)', codecs, (codec) => `${codec} — ${describeBwavCodec(codec)}`)
  census('channel layout field seen (per channel)', layouts)
  census('version seen (per file)', versions)
  census('unidentified u32 at +0x38 (per channel)', unknown38)

  durations.sort((a, b) => b.seconds - a.seconds)
  console.log('longest and shortest streams:')
  for (const entry of durations.slice(0, 3)) console.log(`  ${entry.name}: ${entry.seconds.toFixed(2)} s`)
  for (const entry of durations.slice(-2)) console.log(`  ${entry.name}: ${entry.seconds.toFixed(3)} s`)

  console.log(`loop invariant violations: ${loopProblems.length}`)
  for (const problem of loopProblems.slice(0, 10)) console.log(`  ${problem}`)

  console.log(`failures: ${failures.length}`)
  for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`)
  if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`)

  const total = loose.files + inBars.files
  const parsed = loose.parsed + inBars.parsed
  console.log(`\nBWAV headers parsed: ${parsed} / ${total}  ${pct(parsed, total)}`)
  if (parsed !== total || failures.length > 0) process.exitCode = 1
}

void main()
