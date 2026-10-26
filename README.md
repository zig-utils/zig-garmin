# zig-garmin

Garmin GFDI Bluetooth protocol primitives in Zig, with a dependency-free TypeScript session client for mobile and browser hosts. Initial hardware target: Garmin Enduro 3.

## Status

Experimental. Wire vectors, simulated transfers and failure cases are tested. Real Enduro 3 pairing, firmware compatibility, and coexistence with Garmin Connect still require hardware validation. This is not a claim of parity with Garmin Connect or the Garmin Health SDK.

Implemented:

- Zig CRC-16/ARC, Garmin COBS, GFDI frame validation and telemetry decoding.
- Native Zig session events, service registration, streaming controls, directory iteration and verified download assembly (`session` and `transfer` modules).
- Zig static library and embedded WASM codec; native JS fallback for JavaScriptCore hosts without WebAssembly.
- GFDI/ML service registration, live HR, RR intervals, steps, calories, intensity, stress, SpO2, Body Battery, respiration and packed accelerometer decoding.
- Read-only historical directory and FIT downloads, rolling CRC and offset verification, bounded buffers, per-file checkpoints supplied by the consumer.
- Explicit timeouts, teardown and failures. A consumer can reconnect and resume from files it has durably accepted.

Not implemented: reliable MLR, proprietary authentication, full protobuf services, notifications/media control, device settings, destructive file commands. Firmware requiring these paths fails instead of accepting incomplete files. Raw RR intervals are not nightly RMSSD/HRV status. Available historical data depends on the watch and firmware.

## Build

Pinned development compiler: Zig 0.17.0-dev.1441+d5181a9c9.

```sh
zig build
zig build test
bun run build
bun test ./test
```

No external runtime dependencies. The optional changelog CLI is the first-party `zig-utils/zig-changelog`, declared in `deps.yaml`.

## Zig

Add an immutable release archive to `build.zig.zon`, then import the `garmin` module. `src/root.zig` exposes allocation-free `crc16`, `encode`, `decode`, `frame`, `parse`, and `telemetry` functions; callers supply output buffers.

## TypeScript

The npm-format package is `@zig-utils/garmin`; releases contain a package tarball for installation without an npm account.

```ts
import { GarminBleClient, createGarminCodec } from '@zig-utils/garmin'

// Host owns explicit pairing, permissions, and a lossless notification queue.
const client = new GarminBleClient(transport, await createGarminCodec())
try {
  await client.open()
  await client.sync({
    seen: entry => archive.has(entry),
    onFile: async file => { await archive.accept(file) },
  })
}
finally { await client.close() }
```

`GarminTransport` supplies `maxWrite`, `write(bytes)`, `read(timeoutMs)`, and `close()`. Reads must queue notifications before the next read, reject overflow/disconnect, and be cancelled by close. No third-party Bluetooth library is needed: use the platform's native GATT APIs. `ts-watches/garmin-bluetooth` supplies the Craft adapter. Automatic radio retries belong to the application; protocol failures close the session and only acknowledged files are checkpointed.

Credit: [garmin-ble](https://github.com/gwerneckp/garmin-ble) and [Gadgetbridge](https://gadgetbridge.org/internals/specifics/garmin-protocol/) made independent Garmin interoperability practical. See [NOTICE.md](NOTICE.md).
