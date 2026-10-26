//! Read-only file sync state. Storage and transport are supplied by the host.
const std = @import("std");
const wire = @import("root.zig");
pub const Entry = struct {
    index: u16,
    data_type: u8,
    sub_type: u8,
    number: u16,
    flags: u8,
    size: u32,
    timestamp: u32,
    pub fn isHealth(self: Entry) bool {
        if (self.data_type != 128) return false;
        return switch (self.sub_type) {
            4, 32, 44, 49, 68, 73 => true,
            else => false,
        };
    }
};
pub const Directory = struct {
    bytes: []const u8,
    at: usize = 0,
    pub fn init(bytes: []const u8) wire.Error!Directory {
        if (bytes.len % 16 != 0 or bytes.len > 16 * 65535) return error.Malformed;
        return .{ .bytes = bytes };
    }
    pub fn next(self: *Directory) wire.Error!?Entry {
        if (self.at == self.bytes.len) return null;
        const b = self.bytes[self.at..][0..16];
        self.at += 16;
        const entry: Entry = .{ .index = std.mem.readInt(u16, b[0..2], .little), .data_type = b[2], .sub_type = b[3], .number = std.mem.readInt(u16, b[4..6], .little), .flags = b[7], .size = std.mem.readInt(u32, b[8..12], .little), .timestamp = std.mem.readInt(u32, b[12..16], .little) };
        if (entry.index == 0) return error.Malformed;
        return entry;
    }
};
/// Allocated by the host only after accepting a bounded download status.
pub const Download = struct {
    buffer: []u8,
    offset: usize = 0,
    crc: u16 = 0,
    pub fn init(buffer: []u8, size: u32, limit: usize) wire.Error!Download {
        if (size > limit or size > buffer.len) return error.TooLarge;
        return .{ .buffer = buffer[0..size] };
    }
    pub fn request(index: u16, out: []u8) wire.Error![]u8 {
        if (out.len < 13) return error.NoSpace;
        @memset(out[0..13], 0);
        std.mem.writeInt(u16, out[0..2], index, .little);
        out[6] = 1;
        return out[0..13];
    }
    /// Consume a FILE_TRANSFER_DATA payload. Returns the status payload to ACK.
    pub fn accept(self: *Download, payload: []const u8, ack: []u8) wire.Error![]u8 {
        if (payload.len < 8 or ack.len < 8) return error.Malformed;
        const offset = std.mem.readInt(u32, payload[3..7], .little);
        const chunk = payload[7..];
        if (offset != self.offset or chunk.len > self.buffer.len - self.offset) return error.Malformed;
        const crc = wire.crc16(chunk, self.crc);
        if (crc != std.mem.readInt(u16, payload[1..3], .little)) return error.Checksum;
        @memcpy(self.buffer[self.offset..][0..chunk.len], chunk);
        self.offset += chunk.len;
        self.crc = crc;
        @memset(ack[0..8], 0);
        std.mem.writeInt(u16, ack[0..2], 5004, .little);
        std.mem.writeInt(u32, ack[4..8], @intCast(self.offset), .little);
        return ack[0..8];
    }
    pub fn complete(self: Download) bool {
        return self.offset == self.buffer.len;
    }
};

test "download verifies CRC/offset before advancing or acknowledging" {
    var storage: [16]u8 = undefined;
    var ack: [8]u8 = undefined;
    var download = try Download.init(&storage, 3, 16);
    var payload = [_]u8{ 0, 0, 0, 0, 0, 0, 0, 1, 2, 3 };
    std.mem.writeInt(u16, payload[1..3], wire.crc16(payload[7..], 0), .little);
    payload[3] = 1;
    try std.testing.expectError(error.Malformed, download.accept(&payload, &ack));
    try std.testing.expectEqual(@as(usize, 0), download.offset);
    payload[3] = 0;
    payload[1] ^= 1;
    try std.testing.expectError(error.Checksum, download.accept(&payload, &ack));
    payload[1] ^= 1;
    _ = try download.accept(&payload, &ack);
    try std.testing.expect(download.complete());
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, download.buffer);
    try std.testing.expectError(error.Malformed, download.accept(&payload, &ack));
}
