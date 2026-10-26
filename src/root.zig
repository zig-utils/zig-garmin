//! Garmin wire primitives. No allocator, OS APIs, or external dependencies.
const std = @import("std");
pub const Error = error{ NoSpace, Malformed, Checksum, TooLarge };
pub const max_frame = 65535;

pub fn crc16(bytes: []const u8, seed: u16) u16 {
    var crc = seed;
    for (bytes) |byte| {
        crc ^= byte;
        for (0..8) |_| crc = if (crc & 1 != 0) (crc >> 1) ^ 0xa001 else crc >> 1;
    }
    return crc;
}

/// COBS including Garmin's opening and closing zero delimiters.
pub fn encode(input: []const u8, out: []u8) Error![]u8 {
    if (out.len < 3) return error.NoSpace;
    out[0] = 0;
    var code_at: usize = 1;
    var pos: usize = 2;
    var code: u8 = 1;
    for (input) |byte| {
        if (pos >= out.len) return error.NoSpace;
        if (byte == 0) {
            out[code_at] = code;
            code_at = pos;
            pos += 1;
            code = 1;
        } else {
            out[pos] = byte;
            pos += 1;
            code += 1;
            if (code == 255) {
                out[code_at] = code;
                code_at = pos;
                if (pos >= out.len) return error.NoSpace;
                pos += 1;
                code = 1;
            }
        }
    }
    if (pos >= out.len) return error.NoSpace;
    out[code_at] = code;
    out[pos] = 0;
    return out[0 .. pos + 1];
}

pub fn decode(input: []const u8, out: []u8) Error![]u8 {
    if (input.len < 3 or input[0] != 0 or input[input.len - 1] != 0) return error.Malformed;
    var pos: usize = 1;
    var written: usize = 0;
    while (pos < input.len - 1) {
        const code = input[pos];
        if (code == 0) return error.Malformed;
        pos += 1;
        const count: usize = code - 1;
        if (pos + count > input.len - 1) return error.Malformed;
        if (written + count > out.len) return error.NoSpace;
        for (input[pos .. pos + count]) |byte| {
            if (byte == 0) return error.Malformed;
            out[written] = byte;
            written += 1;
        }
        pos += count;
        if (code != 255 and pos < input.len - 1) {
            if (written >= out.len) return error.NoSpace;
            out[written] = 0;
            written += 1;
        }
    }
    return out[0..written];
}

pub fn frame(kind: u16, payload: []const u8, out: []u8) Error![]u8 {
    if (payload.len > max_frame - 6) return error.TooLarge;
    const size = payload.len + 6;
    if (out.len < size) return error.NoSpace;
    std.mem.writeInt(u16, out[0..2], @intCast(size), .little);
    std.mem.writeInt(u16, out[2..4], kind, .little);
    @memcpy(out[4 .. size - 2], payload);
    std.mem.writeInt(u16, out[size - 2 ..][0..2], crc16(out[0 .. size - 2], 0), .little);
    return out[0..size];
}

pub const Message = struct { kind: u16, payload: []const u8 };
pub fn parse(bytes: []const u8) Error!Message {
    if (bytes.len < 6 or bytes.len > max_frame or std.mem.readInt(u16, bytes[0..2], .little) != bytes.len) return error.Malformed;
    if (crc16(bytes, 0) != 0) return error.Checksum;
    return .{ .kind = std.mem.readInt(u16, bytes[2..4], .little), .payload = bytes[4 .. bytes.len - 2] };
}

pub const Service = enum(u16) { gfdi = 1, registration = 4, heart_rate = 6, steps = 7, calories = 8, intensity = 10, rr_interval = 12, stress = 13, accelerometer = 16, spo2 = 19, body_battery = 20, respiration = 21 };
pub const Reading = struct { values: [10]f64 = @splat(0), count: usize = 0 };
fn uint(bytes: []const u8, offset: usize, comptime T: type) T {
    return std.mem.readInt(T, bytes[offset..][0..@sizeOf(T)], .little);
}
pub fn telemetry(service: Service, bytes: []const u8) Error!Reading {
    var r: Reading = .{};
    const size: usize = switch (service) {
        .heart_rate => 3,
        .steps, .calories => 8,
        .intensity => 4,
        .rr_interval => 2,
        .accelerometer => 16,
        .stress, .spo2, .body_battery, .respiration => 1,
        else => return error.Malformed,
    };
    if (bytes.len < size) return error.Malformed;
    switch (service) {
        .heart_rate => {
            r.values[0] = @floatFromInt(bytes[1]);
            r.values[1] = @floatFromInt(bytes[2]);
            r.count = 2;
        },
        .steps, .calories => {
            r.values[0] = @floatFromInt(uint(bytes, 0, u32));
            r.values[1] = @floatFromInt(uint(bytes, 4, u32));
            r.count = 2;
        },
        .intensity => {
            r.values[0] = @floatFromInt(uint(bytes, 0, u16));
            r.values[1] = @floatFromInt(uint(bytes, 2, u16));
            r.count = 2;
        },
        .rr_interval => {
            r.values[0] = @floatFromInt(uint(bytes, 0, u16));
            r.count = 1;
        },
        .accelerometer => {
            r.values[0] = @floatFromInt(uint(bytes, 0, u16));
            for (0..9) |i| {
                const bit = i * 12;
                const offset = 2 + bit / 8;
                const word: u16 = @as(u16, bytes[offset]) | (@as(u16, bytes[offset + 1]) << 8);
                const raw: u12 = @truncate(word >> @as(u4, @intCast(bit % 8)));
                const signed: i12 = @bitCast(raw);
                r.values[i + 1] = @floatFromInt(signed);
            }
            r.count = 10;
        },
        .stress, .body_battery => {
            const signed: i8 = @bitCast(bytes[0]);
            if (signed < 0 or signed > 100) return error.Malformed;
            r.values[0] = @floatFromInt(signed);
            r.count = 1;
        },
        .spo2 => {
            if (bytes[0] == 0 or bytes[0] > 100) return error.Malformed;
            r.values[0] = @floatFromInt(bytes[0]);
            r.count = 1;
        },
        .respiration => {
            if (bytes[0] == 0 or bytes[0] >= 128) return error.Malformed;
            r.values[0] = @floatFromInt(bytes[0]);
            r.count = 1;
        },
        else => return error.Malformed,
    }
    return r;
}

test "CRC known vector and incremental seed" {
    try std.testing.expectEqual(@as(u16, 0xbb3d), crc16("123456789", 0));
    try std.testing.expectEqual(crc16("123456789", 0), crc16("56789", crc16("1234", 0)));
}
test "COBS zeroes, 254-byte blocks, malformed and bounded outputs" {
    var input: [1024]u8 = undefined;
    var encoded: [1100]u8 = undefined;
    var decoded: [1024]u8 = undefined;
    for (0..1025) |len| {
        for (input[0..len], 0..) |*byte, i| byte.* = @truncate(i);
        const wire = try encode(input[0..len], &encoded);
        try std.testing.expectEqualSlices(u8, input[0..len], try decode(wire, &decoded));
    }
    try std.testing.expectError(error.Malformed, decode(&.{ 0, 4, 1, 0 }, &decoded));
    try std.testing.expectError(error.NoSpace, encode("a", encoded[0..2]));
}
test "GFDI rejects corruption and incorrect size" {
    var buffer: [64]u8 = undefined;
    const bytes = try frame(5030, &.{ 16, 0 }, &buffer);
    try std.testing.expectEqual(@as(u16, 5030), (try parse(bytes)).kind);
    buffer[4] ^= 1;
    try std.testing.expectError(error.Checksum, parse(bytes));
    try std.testing.expectError(error.Malformed, parse(bytes[0 .. bytes.len - 1]));
}
test "telemetry preserves RR intervals rather than inventing RMSSD" {
    const reading = try telemetry(.rr_interval, &.{ 0xe8, 3 });
    try std.testing.expectEqual(@as(f64, 1000), reading.values[0]);
    try std.testing.expectError(error.Malformed, telemetry(.spo2, &.{255}));
    try std.testing.expectError(error.Malformed, telemetry(.stress, &.{255}));
    try std.testing.expectError(error.Malformed, telemetry(.steps, &.{1}));
}
