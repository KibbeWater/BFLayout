/**
 * Maps which bytes of a `prt1` section the parser actually claims.
 *
 * A part pane's data is reached entirely through offsets, so a short re-encode does not
 * point at a field the way a linear section would — it means some block was never read.
 * Rather than guess which, this walks the property table, marks every byte the parser
 * accounts for, and prints the ranges left over with a hex dump. The gaps are the answer.
 *
 *     pnpm diag:prt1 <archive> <layout-substring> [property-index]
 */
import { readFileSync } from 'node:fs'

import { BinaryReader } from '@shared/binary/reader'
import { detectCompression } from '@shared/formats/compression'
import { decompressYaz0 } from '@shared/formats/yaz0'
import { isBflyt } from '@shared/formats/bflyt'
import { parseSarc } from '@shared/formats/sarc'

interface Property {
  index: number
  name: string
  usageFlag: number
  basicUsageFlag: number
  materialUsageFlag: number
  propertyOffset: number
  second: number
  panelInfoOffset: number
}

function hexDump(bytes: Uint8Array, base: number): string {
  const lines: string[] = []
  for (let at = 0; at < bytes.length; at += 16) {
    const row = bytes.subarray(at, at + 16)
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const text = [...row].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('')
    lines.push(`    ${(base + at).toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${text}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const [, , archivePath, wanted, only] = process.argv
  if (!archivePath || !wanted) {
    console.error('usage: pnpm diag:prt1 <archive> <layout-substring> [property-index]')
    process.exit(1)
  }

  const zstd = await import('@bokuweb/zstd-wasm')
  await zstd.init()

  const raw = new Uint8Array(readFileSync(archivePath))
  const kind = detectCompression(raw)
  const data =
    kind === 'zstd'
      ? new Uint8Array(zstd.decompress(raw))
      : kind === 'yaz0'
        ? decompressYaz0(raw)
        : raw

  const entry = parseSarc(data).entries.find((candidate) => (candidate.name ?? '').includes(wanted))
  if (!entry || !isBflyt(entry.data)) {
    console.error('no matching layout entry')
    process.exit(1)
  }

  const bytes = entry.data
  const reader = new BinaryReader(bytes, { littleEndian: false })
  reader.skip(4)
  reader.littleEndian = reader.u16be() === 0xfffe
  const headerSize = reader.u16()
  reader.skip(4)
  reader.skip(4)
  const sectionCount = reader.u16()

  reader.seek(headerSize)
  let index = 0
  for (let i = 0; i < sectionCount && reader.tell() + 8 <= bytes.length; i++) {
    const start = reader.tell()
    const signature = reader.fixedString(4)
    const size = reader.u32()
    if (signature !== 'prt1') {
      reader.seek(start + size)
      continue
    }

    if (only !== undefined && Number(only) !== index) {
      index++
      reader.seek(start + size)
      continue
    }

    // Section-relative coverage: one flag per byte, so gaps are exact.
    const claimed = new Uint8Array(size)
    const claim = (at: number, length: number, why: string): void => {
      for (let k = at; k < Math.min(size, at + length); k++) claimed[k] = 1
      void why
    }

    claim(0, 8, 'section header')
    // The pane's common fields, then the part header.
    const commonStart = 8
    reader.seek(start + commonStart)
    const flag = reader.u8()
    reader.skip(3)
    const paneName = reader.fixedString(0x18)
    reader.skip(8)
    reader.skip(4 * 3 + 4 * 3 + 4 * 2) // translate, rotate, scale
    reader.skip(8) // width, height
    claim(commonStart, reader.tell() - (start + commonStart), 'common pane fields')

    const propertyCount = reader.u32()
    const magnify = [reader.f32(), reader.f32()]
    claim(reader.tell() - start - 12, 12, 'part header')

    const properties: Property[] = []
    for (let p = 0; p < propertyCount; p++) {
      const at = reader.tell() - start
      const name = reader.fixedString(0x18)
      const usageFlag = reader.u8()
      const basicUsageFlag = reader.u8()
      const materialUsageFlag = reader.u8()
      reader.skip(1)
      properties.push({
        index: p,
        name,
        usageFlag,
        basicUsageFlag,
        materialUsageFlag,
        propertyOffset: reader.u32(),
        second: reader.u32(),
        panelInfoOffset: reader.u32()
      })
      claim(at, 0x18 + 4 + 12, 'property header')
    }

    const nameAt = reader.tell() - start
    const externalLayoutName = reader.cstring()
    claim(nameAt, (reader.tell() - start - nameAt + 3) & ~3, 'external layout name')

    console.log(`\nprt1 #${index}  pane=${paneName} flag=0x${flag.toString(16)} size=${size}`)
    console.log(`  magnify=${magnify.join(',')}  properties=${propertyCount}  external=${externalLayoutName}`)

    for (const property of properties) {
      let overrideNote = 'none'
      if (property.propertyOffset > 0) {
        const at = property.propertyOffset
        const overrideSignature = reader.at(start + at, () => reader.fixedString(4))
        const overrideSize = reader.at(start + at + 4, () => reader.u32())
        overrideNote = `${overrideSignature} size=${overrideSize} at 0x${at.toString(16)}`
        if (overrideSize >= 8 && at + overrideSize <= size) {
          claim(at, overrideSize, 'override section')
        }
      }
      if (property.panelInfoOffset > 0) claim(property.panelInfoOffset, 52, 'panelInfo')

      console.log(
        `  [${property.index}] ${property.name.padEnd(24)} usage=${property.usageFlag}/${property.basicUsageFlag}/${property.materialUsageFlag} ` +
          `override=${overrideNote} second=0x${property.second.toString(16)} panelInfo=0x${property.panelInfoOffset.toString(16)}`
      )
    }

    // Everything nobody claimed, run-length encoded.
    let at = 0
    let unclaimed = 0
    while (at < size) {
      if (claimed[at] === 1) {
        at++
        continue
      }
      let to = at
      while (to < size && claimed[to] === 0) to++
      // Trailing alignment padding is expected; only report runs worth explaining.
      const run = bytes.subarray(start + at, start + to)
      const allZero = run.every((byte) => byte === 0)
      console.log(
        `  UNCLAIMED 0x${at.toString(16)}..0x${to.toString(16)} (${to - at} bytes${allZero ? ', all zero' : ''})`
      )
      if (!allZero) console.log(hexDump(run, at))
      unclaimed += to - at
      at = to
    }
    console.log(`  unclaimed total: ${unclaimed} bytes of ${size}`)

    index++
    reader.seek(start + size)
  }
}

void main()
