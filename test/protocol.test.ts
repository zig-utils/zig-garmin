import { describe, expect, test } from 'bun:test'
import { GarminBleClient, cobsDecode, cobsEncode, crc16, createGarminCodec, directory, gfdiFrame, parseMessage, parseTelemetry, portableCodec } from '../bindings'
import type { GarminTransport } from '../bindings'

test('Zig WASM and native JS match independently specified wire vectors', async () => {
  const zig = await createGarminCodec({ requireWasm: true })
  expect(zig.crc(new TextEncoder().encode('123456789'))).toBe(0xbb3d)
  for (const length of [0, 1, 253, 254, 255, 508, 1024, 65529]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i & 255)
    expect(zig.encode(bytes)).toEqual(cobsEncode(bytes))
    expect(zig.decode(zig.encode(bytes))).toEqual(bytes)
    expect(zig.frame(5030, bytes)).toEqual(gfdiFrame(5030, bytes))
  }
  expect(() => zig.decode(Uint8Array.of(0, 4, 1, 0))).toThrow()
  expect(() => cobsDecode(Uint8Array.of(0, 4, 1, 0))).toThrow()
  const corrupt = gfdiFrame(5030, Uint8Array.of(16, 0)); corrupt[4] ^= 1
  expect(() => parseMessage(corrupt)).toThrow('checksum')
})
test('sensor sentinels are missing, RR is not nightly HRV', () => {
  expect(parseTelemetry(12, Uint8Array.of(0xe8, 3))?.values).toEqual([1000])
  expect(parseTelemetry(19, Uint8Array.of(255))).toBeNull()
  expect(parseTelemetry(13, Uint8Array.of(255))).toBeNull()
  expect(parseTelemetry(7, Uint8Array.of(1))).toBeNull()
})
class Watch implements GarminTransport {
  maxWrite = 65535
  queue: Uint8Array[] = []
  closed = false
  downloads: number[] = []
  corrupt = false
  badOffset = false
  drop = false
  archived = false
  tx: number[] = []
  compressed = false
  sequences: Array<number | undefined> = []
  entry = new Uint8Array(16)
  file = Uint8Array.of(1, 2, 0, 4, 5)
  constructor() {
    const v = new DataView(this.entry.buffer)
    v.setUint16(0, 42, true); this.entry[2] = 128; this.entry[3] = 32
    v.setUint32(8, this.file.length, true); v.setUint32(12, 100, true)
  }
  push(type: number, payload: Uint8Array) {
    const wire = cobsEncode(gfdiFrame(this.compressed ? (141 << 8) | (type - 5000) : type, payload))
    // Coalesced frames and fragmentation both occur on actual BLE links.
    this.queue.push(Uint8Array.of(1, ...wire.slice(0, 4)))
    this.queue.push(Uint8Array.of(1, ...wire.slice(4)))
  }
  async write(bytes: Uint8Array) {
    expect(bytes.length).toBeLessThanOrEqual(20)
    if (!bytes[0]) {
      if (bytes[1] === 5) {
        expect([...bytes]).toEqual([0, 5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        this.queue.push(Uint8Array.of(0, 6))
      }
      else {
        const reply = new Uint8Array(16)
        reply[1] = 1
        reply.set(bytes.slice(10, 12), 10)
        reply[13] = bytes[10] === 4 ? 2 : 1
        reply[15] = 1
        this.queue.push(reply)
      }
      return
    }
    if (bytes[0] === 2) {
      this.queue.push(Uint8Array.of(2, 3, 0, 0, 0, 0, 0xd2, 4, 0, 0))
      return
    }
    this.tx.push(...bytes.slice(1))
    if (this.tx.length < 3 || this.tx[this.tx.length - 1] !== 0) return
    const message = parseMessage(cobsDecode(Uint8Array.from(this.tx)))
    this.tx = []
    if (message.type === 5000) this.sequences.push(message.sequence)
    if (message.type === 5008) this.archived = true
    if (message.type !== 5002) return
    const index = new DataView(message.payload.buffer).getUint16(0, true)
    this.downloads.push(index)
    const data = index === 0 ? this.entry : this.file
    const status = new Uint8Array(8)
    const s = new DataView(status.buffer); s.setUint16(0, 5002, true); s.setUint32(4, data.length, true)
    this.push(5000, status)
    if (this.drop && index !== 0) return
    const payload = new Uint8Array(data.length + 7)
    const p = new DataView(payload.buffer)
    p.setUint16(1, crc16(data) ^ (this.corrupt && index !== 0 ? 1 : 0), true)
    p.setUint32(3, this.badOffset && index !== 0 ? 1 : 0, true); payload.set(data, 7)
    this.push(5004, payload)
  }
  async read() {
    const next = this.queue.shift()
    if (!next) throw Object.assign(new Error('Link lost'), { code: 'DISCONNECTED' })
    return next
  }
  async close() { this.closed = true }
}
describe('historical transfers', () => {
  test('verifies fragmented files, retains watch data and supports replay deduplication', async () => {
    const watch = new Watch(); const client = new GarminBleClient(watch, portableCodec)
    await client.open()
    expect(client.unitId).toBe('1234')
    const saved: Uint8Array[] = []
    expect(await client.sync({ onFile: async f => { saved.push(f.bytes) } })).toEqual({ files: 1, remaining: 0 })
    expect(saved).toEqual([watch.file]); expect(watch.archived).toBe(false)
    expect(await client.sync({ seen: e => e.index === 42, onFile: async () => { throw new Error('Duplicate') } })).toEqual({ files: 0, remaining: 0 })
    expect(watch.downloads).toEqual([0, 42, 0])
    await client.close(); expect(watch.closed).toBe(true)
  })
  for (const fault of ['corrupt', 'badOffset', 'drop'] as const) {
    test(`${fault} never delivers a partial file`, async () => {
      const watch = new Watch(); watch[fault] = true
      const client = new GarminBleClient(watch); await client.open()
      let delivered = false
      await expect(client.sync({ onFile: async () => { delivered = true } })).rejects.toThrow()
      expect(delivered).toBe(false); expect(watch.closed).toBe(true)
    })
  }
  test('directory and byte limits reject hostile input', async () => {
    expect(() => directory(Uint8Array.of(1))).toThrow()
    const watch = new Watch(); const client = new GarminBleClient(watch); await client.open()
    const result = await client.sync({ maxBytes: 1, onFile: async () => { throw new Error('Over budget') } })
    expect(result).toEqual({ files: 0, remaining: 1 })
  })
})

test('documented compressed GFDI captures retain response sequence numbers', () => {
  const message = parseMessage(Uint8Array.from([0x09, 0, 0x08, 0x98, 0x28, 0x01, 0x10, 0xd7, 0xf5]))
  expect(message.type).toBe(5008)
  expect(message.sequence).toBe(24)
})

test('compressed watch requests receive ACKs using the same sequence', async () => {
  const watch = new Watch()
  watch.compressed = true
  const client = new GarminBleClient(watch)
  await client.open()
  await client.sync({ onFile: async () => {} })
  expect(watch.sequences).toEqual([13, 13])
  await client.close()
})
