import { describe, expect, it } from 'vitest'

import { BinaryReadError } from '@shared/binary/errors'
import { BinaryReader } from '@shared/binary/reader'
import { BinaryWriter } from '@shared/binary/writer'

describe('BinaryReader', () => {
  it('reads scalars in both byte orders', () => {
    const data = new Uint8Array([0x12, 0x34, 0x00, 0x00, 0x80, 0x3f])

    const le = new BinaryReader(data, { littleEndian: true })
    expect(le.u16()).toBe(0x3412)
    expect(le.f32()).toBeCloseTo(1.0)

    const be = new BinaryReader(data, { littleEndian: false })
    expect(be.u16()).toBe(0x1234)
  })

  it('honours a mid-stream endianness flip, as the layout formats require', () => {
    // Big-endian magic and BOM, then little-endian payload.
    const data = new Uint8Array([0xff, 0xfe, 0x34, 0x12])
    const reader = new BinaryReader(data, { littleEndian: false })
    expect(reader.u16be()).toBe(0xfffe)
    reader.littleEndian = true
    expect(reader.u16()).toBe(0x1234)
  })

  it('trims fixed-width names at the first NUL', () => {
    const data = new Uint8Array(8)
    for (const [i, ch] of [...'RootPane'].slice(0, 4).entries()) data[i] = ch.charCodeAt(0)
    const reader = new BinaryReader(data)
    expect(reader.fixedString(8)).toBe('Root')
    expect(reader.tell()).toBe(8)
  })

  it('decodes UTF-16 text in the active byte order and drops the terminator', () => {
    const writer = new BinaryWriter({ littleEndian: true })
    writer.utf16String('Hi')
    const bytes = writer.toBytes()

    expect(new BinaryReader(bytes, { littleEndian: true }).utf16String(bytes.length)).toBe('Hi')

    const beWriter = new BinaryWriter({ littleEndian: false })
    beWriter.utf16String('Hi')
    const beBytes = beWriter.toBytes()
    expect(new BinaryReader(beBytes, { littleEndian: false }).utf16String(beBytes.length)).toBe(
      'Hi'
    )
  })

  it('reports the offset and shortfall when a read runs past the end', () => {
    const reader = new BinaryReader(new Uint8Array(2))
    reader.u8()
    try {
      reader.u32()
      expect.unreachable('expected a BinaryReadError')
    } catch (error) {
      expect(error).toBeInstanceOf(BinaryReadError)
      const e = error as BinaryReadError
      expect(e.offset).toBe(1)
      expect(e.length).toBe(4)
      expect(e.available).toBe(1)
    }
  })

  it('restores the cursor after a positioned read', () => {
    const reader = new BinaryReader(new Uint8Array([1, 2, 3, 4]))
    reader.u8()
    expect(reader.at(3, () => reader.u8())).toBe(4)
    expect(reader.tell()).toBe(1)
  })
})

describe('BinaryWriter', () => {
  it('backpatches deferred fields', () => {
    const writer = new BinaryWriter()
    const size = writer.defer('u32')
    writer.bytes(new Uint8Array([1, 2, 3, 4]))
    size.set(writer.tell())

    const reader = new BinaryReader(writer.toBytes())
    expect(reader.u32()).toBe(8)
  })

  it('fills pointer fields relative to a base', () => {
    const writer = new BinaryWriter()
    const base = writer.tell()
    const pointer = writer.defer('u32')
    writer.zeros(12)
    pointer.fillFrom(base)

    const reader = new BinaryReader(writer.toBytes())
    expect(reader.u32()).toBe(16)
  })

  it('writes a section whose recorded size includes its own 8-byte header', () => {
    const writer = new BinaryWriter()
    writer.section('lyt1', () => {
      writer.f32(1280)
      writer.f32(720)
    })

    const reader = new BinaryReader(writer.toBytes())
    expect(reader.fixedString(4)).toBe('lyt1')
    expect(reader.u32()).toBe(16)
    expect(reader.f32()).toBe(1280)
    expect(reader.f32()).toBe(720)
  })

  it('pads sections to a 4-byte boundary', () => {
    const writer = new BinaryWriter()
    writer.section('usd1', () => writer.u8(1))
    expect(writer.toBytes().length).toBe(12)
  })

  it('grows past its initial capacity without corrupting earlier writes', () => {
    const writer = new BinaryWriter({ capacity: 8 })
    const patch = writer.defer('u32')
    writer.bytes(new Uint8Array(5000).fill(0xab))
    patch.set(0xdeadbeef)

    const bytes = writer.toBytes()
    expect(bytes.length).toBe(5004)
    const reader = new BinaryReader(bytes)
    expect(reader.u32()).toBe(0xdeadbeef)
    expect(bytes[5003]).toBe(0xab)
  })

  it('seeking backwards then forwards preserves the intervening bytes', () => {
    const writer = new BinaryWriter()
    writer.bytes(new Uint8Array([1, 2, 3, 4]))
    writer.seek(1)
    writer.u8(0x99)
    writer.seek(4)
    expect([...writer.toBytes()]).toEqual([1, 0x99, 3, 4])
  })
})

describe('utf16 fields', () => {
  /**
   * Layouts reserve a text buffer larger than the string in it, so everything
   * after the terminator is padding. Treating it as text appended dozens of NUL
   * characters to every such pane, which is how this was found.
   */
  it('stops at the terminator inside an over-sized buffer', () => {
    const bytes = new Uint8Array(20)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 0x0041, true) // A
    view.setUint16(2, 0x0042, true) // B
    // Remaining 16 bytes stay zero.
    const reader = new BinaryReader(bytes)
    expect(reader.utf16String(20)).toBe('AB')
    // The cursor still advances by the whole field.
    expect(reader.tell()).toBe(20)
  })

  it('reads a string that exactly fills its field', () => {
    const bytes = new Uint8Array(4)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 0x0041, true)
    view.setUint16(2, 0x0042, true)
    expect(new BinaryReader(bytes).utf16String(4)).toBe('AB')
  })
})
