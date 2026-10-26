# Changelog

## 0.1.2

- Negotiate documented ML registration replies and query the watch identity.
- Preserve compressed GFDI sequence numbers in acknowledgements.
- Use the safe 20-byte legacy ML fragment limit and reject reliable MLR explicitly.
- Correct CLOSE_ALL field alignment and skip unavailable optional telemetry services.
- Pin local Zig builds to the declared compiler.

## 0.1.1

- Add native Zig session negotiation, telemetry events and read-only file-transfer state.
- Verify file offsets and rolling checksums before advancing download cursors.
- Publish portable package archives through GitHub Releases.

## 0.1.0

- Add allocation-free Zig CRC, COBS, GFDI and telemetry codecs.
- Add portable TypeScript bindings and optional Zig WebAssembly codec.
- Add read-only historical FIT downloads with rolling CRC checks and bounded transfers.
- Credit garmin-ble and Gadgetbridge protocol research.
- Document experimental status and Enduro 3 hardware validation requirements.
