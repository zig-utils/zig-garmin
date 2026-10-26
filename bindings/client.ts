import type { Codec, Message } from './codec'
import { parseMessage, portableCodec } from './codec'

export const garminUuid = (value: number): string => `6a4e${value.toString(16).padStart(4, '0')}-667b-11e3-949a-0800200c9a66`
export const GARMIN_BLE: { services: string[], channels: { service: string, notify: string, write: string }[] } = {
  services: [garminUuid(0x2800)],
  channels: Array.from({ length: 5 }, (_, i) => ({ service: garminUuid(0x2800), notify: garminUuid(0x2810 + i), write: garminUuid(0x2820 + i) })),
}
export const GARMIN_SERVICES = { heartRate: 6, steps: 7, calories: 8, intensityMinutes: 10, rrInterval: 12, stress: 13, accelerometer: 16, spo2: 19, bodyBattery: 20, respiration: 21 } as const
export interface GarminReading { service: number, timestamp: number, values: number[] }
/** Transport reads must retain every notification, reject on disconnect/overflow,
 * and cancel a pending read when close() is called. maxWrite includes routing. */
export interface GarminTransport {
  maxWrite: number
  write(bytes: Uint8Array): Promise<void>
  read(timeoutMs: number): Promise<Uint8Array>
  close(): Promise<void>
}
export interface GarminDirectoryEntry { index: number, dataType: number, subType: number, number: number, flags: number, size: number, timestamp: number }
export interface GarminFile { entry: GarminDirectoryEntry, bytes: Uint8Array }
export function directory(bytes: Uint8Array): GarminDirectoryEntry[] {
  if (bytes.length % 16 !== 0 || bytes.length > 16 * 65535) throw new Error('Invalid Garmin directory')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: GarminDirectoryEntry[] = []
  const seen = new Set<number>()
  for (let at = 0; at < bytes.length; at += 16) {
    const index = view.getUint16(at, true)
    if (!index || seen.has(index)) throw new Error('Duplicate Garmin directory index')
    seen.add(index)
    entries.push({ index, dataType: bytes[at + 2]!, subType: bytes[at + 3]!, number: view.getUint16(at + 4, true), flags: bytes[at + 7]!, size: view.getUint32(at + 8, true), timestamp: (view.getUint32(at + 12, true) + 631065600) * 1000 })
  }
  return entries
}
export function parseTelemetry(service: number, bytes: Uint8Array, timestamp = Date.now()): GarminReading | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let values: number[]
  switch (service) {
    case 6: if (bytes.length < 3 || !bytes[1] || bytes[1] === 255) return null; values = [bytes[1]!, ...(bytes[2]! > 0 && bytes[2]! < 255 ? [bytes[2]!] : [])]; break
    case 7: case 8: if (bytes.length < 8) return null; values = [view.getUint32(0, true), view.getUint32(4, true)]; break
    case 10: if (bytes.length < 4) return null; values = [view.getUint16(0, true), view.getUint16(2, true)]; break
    case 12: if (bytes.length < 2) return null; values = [view.getUint16(0, true)]; if (!values[0] || values[0] === 65535) return null; break
    case 13: case 20: if (!bytes.length || bytes[0]! > 100) return null; values = [bytes[0]!]; break
    case 19: if (!bytes.length || !bytes[0] || bytes[0] > 100) return null; values = [bytes[0]]; break
    case 21: if (!bytes.length || !bytes[0] || bytes[0] >= 128) return null; values = [bytes[0]]; break
    case 16:
      if (bytes.length < 16) return null
      values = [view.getUint16(0, true)]
      for (let i = 0; i < 9; i++) {
        const bit = i * 12
        const raw = (view.getUint16(2 + Math.floor(bit / 8), true) >>> (bit % 8)) & 4095
        values.push(raw >= 2048 ? raw - 4096 : raw)
      }
      break
    default: return null
  }
  return { service, timestamp, values }
}
const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** A serial session. No background timers or hidden pairing/reset/auth changes.
 * Legacy GFDI/ML supported; reliable MLR-only firmware fails explicitly. */
export class GarminBleClient {
  private handles = new Map<number, number>()
  private refused = new Set<number>()
  private partial: number[] = []
  private messages: Message[] = []
  private readings: GarminReading[] = []
  private opened = false
  private busy = false
  private closed = false
  unitId: string | null = null
  constructor(private transport: GarminTransport, private codec: Codec = portableCodec) {
    if (!Number.isInteger(transport.maxWrite) || transport.maxWrite < 20 || transport.maxWrite > 65535) throw new Error('Invalid Bluetooth write size')
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy || this.closed) throw new Error(this.closed ? 'Garmin session closed' : 'Garmin operation already running')
    this.busy = true
    try { return await run() }
    catch (error) { await this.close(); throw error }
    finally { this.busy = false }
  }
  private async write(handle: number, payload: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Garmin session closed')
    if (handle < 0 || handle > 127) throw new Error('Invalid Garmin handle')
    for (let at = 0; at < payload.length; at += Math.min(20, this.transport.maxWrite) - 1) {
      const chunk = payload.subarray(at, at + Math.min(20, this.transport.maxWrite) - 1)
      await this.transport.write(Uint8Array.of(handle, ...chunk))
    }
  }
  private async send(type: number, payload = new Uint8Array(), sequence?: number): Promise<void> {
    const handle = this.handles.get(1)
    if (handle === undefined) throw new Error('Garmin GFDI channel unavailable')
    await this.write(handle, this.codec.encode(this.codec.frame(sequence === undefined ? type : ((128 | sequence) << 8) | (type - 5000), payload)))
  }
  private async receive(timeoutMs: number): Promise<void> {
    const packet = await this.transport.read(timeoutMs)
    if (this.closed) throw new Error('Garmin session closed')
    if (packet.length < 2 || packet.length > 65535) throw new Error('Invalid Garmin notification')
    if (packet[0] === 0) {
      if (packet[1] === 1) {
        if (packet.length < 13 || packet.length > 16) throw new Error('Invalid Garmin registration response')
        const service = viewOf(packet).getUint16(10, true)
        if (packet[12] !== 0) { this.refused.add(service); return }
        if (packet.length < 14 || packet[13]! > 127 || !packet[13] || (packet[14] ?? 0) !== 0) throw new Error('Garmin requires an unsupported transport')
        const handle = packet[13]!
        if ([...this.handles.entries()].some(([other, assigned]) => other !== service && assigned === handle)) throw new Error('Garmin reused an active handle')
        this.handles.set(service, handle)
      }
      else if (packet[1] === 6) this.messages.push({ type: -1, payload: new Uint8Array() })
      return
    }
    if (packet[0]! & 128) throw new Error('Garmin reliable MLR transport is not supported by this session')
    const handle = packet[0]!
    const service = [...this.handles.entries()].find(([, assigned]) => assigned === handle)?.[0]
    if (service === undefined) return
    if (service === 4) {
      if (packet[1] === 3 && packet.length >= 10) this.unitId = String(viewOf(packet).getUint32(6, true))
      return
    }
    if (service !== 1) {
      const reading = parseTelemetry(service, packet.subarray(1))
      if (reading) { if (this.readings.length >= 4096) this.readings.shift(); this.readings.push(reading) }
      return
    }
    for (const byte of packet.subarray(1)) {
      if (byte === 0) {
        if (this.partial.length) {
          const decoded = this.codec.decode(Uint8Array.of(0, ...this.partial, 0))
          this.partial = []
          const message = parseMessage(decoded, this.codec)
          await this.reflex(message)
          if (this.messages.length >= 128) throw new Error('Garmin message queue overflow')
          this.messages.push(message)
        }
      }
      else {
        this.partial.push(byte)
        if (this.partial.length > 65800) throw new Error('Garmin frame overflow')
      }
    }
  }
  private async reflex(message: Message): Promise<void> {
    const p = message.payload
    if (message.type === 5024 && p.length >= 12) this.unitId = String(viewOf(p).getUint32(4, true))
    if (message.type === 5052) {
      const out = new Uint8Array(23)
      const v = viewOf(out)
      v.setUint16(0, 5052, true)
      v.setUint32(7, Math.floor(Date.now() / 1000) - 631065600, true)
      v.setInt32(11, -new Date().getTimezoneOffset() * 60, true)
      await this.send(5000, out, message.sequence)
    }
    else if (message.type === 5043 || message.type === 5044) {
      if (p.length < 14 || viewOf(p).getUint32(10, true) !== p.length - 14) throw new Error('Invalid Garmin protobuf envelope')
      const ack = new Uint8Array(11)
      const v = viewOf(ack)
      v.setUint16(0, message.type, true)
      v.setUint16(3, viewOf(p).getUint16(0, true), true)
      v.setUint32(5, viewOf(p).getUint32(2, true), true)
      // Acknowledge receipt, explicitly decline unsupported protobuf services.
      ack[10] = 1
      await this.send(5000, ack, message.sequence)
    }
    else if (![5000, 5004].includes(message.type)) {
      const ack = new Uint8Array(3)
      viewOf(ack).setUint16(0, message.type, true)
      // ACK known informational messages; NAK unknown requests.
      ack[2] = [5024, 5030].includes(message.type) ? 0 : 1
      await this.send(5000, ack, message.sequence)
    }
  }
  private async wait(test: (message: Message) => boolean, timeoutMs = 15000): Promise<Message> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const index = this.messages.findIndex(test)
      if (index >= 0) return this.messages.splice(index, 1)[0]!
      // Informational pushes have already been handled; never let them fill the queue.
      this.messages = this.messages.filter(m => [-1, 5000, 5004].includes(m.type))
      await this.receive(Math.max(1, end - Date.now()))
    }
    throw new Error('Garmin response timed out')
  }
  private async register(service: number): Promise<number> {
    const payload = new Uint8Array(12)
    payload[1] = 2 // client ID, uint64 LE
    viewOf(payload).setUint16(9, service, true)
    await this.write(0, payload)
    const end = Date.now() + 10000
    while (!this.handles.has(service)) {
      if (this.refused.has(service)) throw Object.assign(new Error(`Garmin service ${service} is unavailable`), { code: 'UNSUPPORTED_SERVICE' })
      if (Date.now() >= end) throw new Error('Garmin service registration timed out')
      await this.receive(Math.max(1, end - Date.now()))
    }
    return this.handles.get(service)!
  }
  open(): Promise<void> {
    return this.exclusive(async () => {
      if (this.opened) return
      const reset = new Uint8Array(11)
      reset[0] = 5; reset[1] = 2
      await this.write(0, reset)
      await this.wait(m => m.type === -1)
      const registration = await this.register(4)
      await this.write(registration, Uint8Array.of(3))
      const identityDeadline = Date.now() + 10000
      while (this.unitId === null) {
        if (Date.now() >= identityDeadline) throw new Error('Garmin identity timed out')
        await this.receive(Math.max(1, identityDeadline - Date.now()))
      }
      await this.register(1)
      await this.send(5030, Uint8Array.of(16, 0))
      this.opened = true
    })
  }
  private async download(index: number, limit: number): Promise<Uint8Array> {
    this.messages = this.messages.filter(m => m.type !== 5004 && !(m.type === 5000 && m.payload.length >= 2 && viewOf(m.payload).getUint16(0, true) === 5002))
    const request = new Uint8Array(13)
    viewOf(request).setUint16(0, index, true)
    request[6] = 1 // NEW, zero offset, CRC seed and requested size (entire file).
    await this.send(5002, request)
    const status = await this.wait(m => m.type === 5000 && m.payload.length >= 2 && viewOf(m.payload).getUint16(0, true) === 5002)
    if (status.payload.length !== 8 || status.payload[2] !== 0 || status.payload[3] !== 0) throw new Error('Garmin declined file download')
    const size = viewOf(status.payload).getUint32(4, true)
    if (size > limit) throw new Error('Garmin file exceeds download limit')
    const out = new Uint8Array(size)
    let offset = 0
    let crc = 0
    while (offset < size) {
      const message = await this.wait(m => m.type === 5004)
      const { payload } = message
      if (payload.length < 8) throw new Error('Invalid Garmin file chunk')
      const v = viewOf(payload)
      const at = v.getUint32(3, true)
      const chunk = payload.subarray(7)
      if (at !== offset || chunk.length > size - offset) throw new Error('Garmin file offset mismatch')
      const nextCrc = this.codec.crc(chunk, crc)
      if (nextCrc !== v.getUint16(1, true)) throw new Error('Garmin file checksum mismatch')
      out.set(chunk, offset)
      crc = nextCrc
      offset += chunk.length
      const ack = new Uint8Array(8)
      viewOf(ack).setUint16(0, 5004, true)
      viewOf(ack).setUint32(4, offset, true)
      await this.send(5000, ack, message.sequence)
    }
    return out
  }
  /** Downloads never archive/delete/flag watch files; Connect can still sync them. */
  sync(options: { seen?: (entry: GarminDirectoryEntry) => boolean, onFile: (file: GarminFile) => Promise<void>, maxFiles?: number, maxBytes?: number }): Promise<{ files: number, remaining: number }> {
    return this.exclusive(async () => {
      if (!this.opened) throw new Error('Open Garmin before syncing')
      const maxFiles = options.maxFiles ?? 64
      const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
      if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 1024 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) throw new Error('Invalid Garmin sync limits')
      const entries = directory(await this.download(0, 1024 * 1024)).filter(e => e.dataType === 128 && [4, 32, 44, 49, 68, 73].includes(e.subType) && !options.seen?.(e)).sort((a, b) => b.timestamp - a.timestamp)
      let files = 0
      let total = 0
      for (const entry of entries.slice(0, maxFiles)) {
        if (entry.size > maxBytes - total) break
        const bytes = await this.download(entry.index, Math.min(16 * 1024 * 1024, maxBytes - total))
        if (bytes.length !== entry.size) throw new Error('Garmin file changed during sync')
        await options.onFile({ entry, bytes })
        total += bytes.length
        files++
      }
      await this.send(5030, Uint8Array.of(0, 0))
      return { files, remaining: entries.length - files }
    })
  }
  collect(services: number[] = Object.values(GARMIN_SERVICES), durationMs = 10000): Promise<GarminReading[]> {
    return this.exclusive(async () => {
      if (!this.opened || durationMs < 1 || durationMs > 60000 || services.some(s => !Object.values<number>(GARMIN_SERVICES).includes(s))) throw new Error('Invalid Garmin telemetry request')
      this.readings = []
      const started: number[] = []
      try {
        for (const service of new Set(services)) {
          try {
            const handle = this.handles.get(service) ?? await this.register(service)
            await this.write(handle, Uint8Array.of(1))
            started.push(handle)
          }
          catch (error) { if ((error as { code?: string }).code !== 'UNSUPPORTED_SERVICE') throw error }
        }
        const end = Date.now() + durationMs
        while (Date.now() < end) {
          try { await this.receive(Math.min(1000, end - Date.now())) }
          catch (error) { if ((error as { code?: string }).code !== 'TIMEOUT') throw error }
        }
        return this.readings.slice()
      }
      finally { for (const handle of started) if (!this.closed) await this.write(handle, Uint8Array.of(0)) }
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.opened = false
    this.partial = []; this.messages = []; this.handles.clear(); this.refused.clear()
    await this.transport.close()
  }
}
