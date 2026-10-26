/** Portable codec for native JS hosts without WebAssembly. The Zig/WASM codec
 * implements the same contract and is verified against these wire vectors. */
export interface Codec {
  crc(bytes: Uint8Array, seed?: number): number
  encode(bytes: Uint8Array): Uint8Array
  decode(bytes: Uint8Array): Uint8Array
  frame(type: number, payload: Uint8Array): Uint8Array
}
export function crc16(bytes: Uint8Array, seed = 0): number {
  let crc = seed
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc
}
export function cobsEncode(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 65535) throw new Error('Frame too large')
  const out = [0, 0]
  let at = 1
  let code = 1
  for (const byte of bytes) {
    if (byte === 0) { out[at] = code; at = out.length; out.push(0); code = 1 }
    else {
      out.push(byte)
      if (++code === 255) { out[at] = code; at = out.length; out.push(0); code = 1 }
    }
  }
  out[at] = code
  out.push(0)
  return Uint8Array.from(out)
}
export function cobsDecode(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 3 || bytes.length > 65800 || bytes[0] !== 0 || bytes[bytes.length - 1] !== 0) throw new Error('Invalid COBS frame')
  const out: number[] = []
  let at = 1
  while (at < bytes.length - 1) {
    const code = bytes[at++]!
    if (!code || at + code - 1 > bytes.length - 1) throw new Error('Truncated COBS frame')
    for (let i = 1; i < code; i++) {
      const byte = bytes[at++]!
      if (!byte) throw new Error('Invalid COBS payload')
      out.push(byte)
    }
    if (code !== 255 && at < bytes.length - 1) out.push(0)
  }
  return Uint8Array.from(out)
}
export function gfdiFrame(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > 65529 || !Number.isInteger(type) || type < 0 || type > 65535) throw new Error('Invalid GFDI frame')
  const out = new Uint8Array(payload.length + 6)
  const view = new DataView(out.buffer)
  view.setUint16(0, out.length, true)
  view.setUint16(2, type, true)
  out.set(payload, 4)
  view.setUint16(out.length - 2, crc16(out.subarray(0, -2)), true)
  return out
}
export const portableCodec: Codec = { crc: crc16, encode: cobsEncode, decode: cobsDecode, frame: gfdiFrame }
export interface Message { type: number, payload: Uint8Array }
export function parseMessage(bytes: Uint8Array, codec: Codec = portableCodec): Message {
  if (bytes.length < 6 || bytes.length > 65535 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true) !== bytes.length) throw new Error('Invalid GFDI length')
  if (codec.crc(bytes) !== 0) throw new Error('GFDI checksum mismatch')
  return { type: new DataView(bytes.buffer, bytes.byteOffset).getUint16(2, true), payload: bytes.slice(4, -2) }
}
