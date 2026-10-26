import type { Codec } from './codec'
import { portableCodec } from './codec'
import { wasmBytes } from './wasm-bytes'
/** Native JavaScriptCore may lack WebAssembly. Never require Node or a WebView. */
export async function createGarminCodec(options: { requireWasm?: boolean } = {}): Promise<Codec> {
  const wasm = (globalThis as any).WebAssembly
  if (!wasm) {
    if (options.requireWasm) throw new Error('WebAssembly unavailable')
    return portableCodec
  }
  const { instance } = await wasm.instantiate(Uint8Array.from(wasmBytes), {})
  const api = instance.exports
  const put = (bytes: Uint8Array): void => {
    if (bytes.length > 66000) throw new Error('Codec input too large')
    new Uint8Array(api.memory.buffer, api.input_ptr(), bytes.length).set(bytes)
  }
  const result = (size: number): Uint8Array => {
    if (size < 0) throw new Error('Invalid Garmin codec input')
    return new Uint8Array(api.memory.buffer, api.output_ptr(), size).slice()
  }
  return {
    crc(bytes, seed = 0) { put(bytes); return api.crc16(bytes.length, seed) },
    encode(bytes) { put(bytes); return result(api.cobs_encode(bytes.length)) },
    decode(bytes) { put(bytes); return result(api.cobs_decode(bytes.length)) },
    frame(type, bytes) { if (!Number.isInteger(type) || type < 0 || type > 65535) throw new Error('Invalid GFDI type'); put(bytes); return result(api.gfdi_frame(type, bytes.length)) },
  }
}
