# Acknowledgements and provenance

Inspired by gwerneckp/garmin-ble (https://github.com/gwerneckp/garmin-ble),
which demonstrates direct Garmin live telemetry without the Garmin Health SDK,
and the Gadgetbridge community's Garmin protocol research:
https://gadgetbridge.org/internals/specifics/garmin-protocol/.

Those projects deserve credit for documenting Garmin's protocol and proving
that direct access is possible. garmin-ble is AGPL-3.0; Gadgetbridge is AGPL-3.0.
They are research references, not dependencies bundled with this package.

This package contains newly authored Zig and TypeScript implementations.
It uses observed wire facts (UUIDs, numeric message/service identifiers, field
layouts, CRC parameters, and COBS framing); it does not vendor their Python,
Java, generated protobuf code, or schemas. No clean-room certification is
claimed. The MIT license applies to this repository's original implementation.

Garmin, Garmin Connect, Enduro, and Body Battery are Garmin trademarks. This
project is independent of Garmin and is not endorsed by Garmin.
