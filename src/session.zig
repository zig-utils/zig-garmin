const std = @import("std");
const wire = @import("root.zig");
pub const Event = union(enum) { closed, registered: struct { service: u16, handle: u8 }, message: wire.Message, reading: struct { service: wire.Service, reading: wire.Reading } };
/// A bounded, transport-independent legacy GFDI/ML receiver. Event data is
/// borrowed until the callback returns. The host owns deadlines and retries.
pub const Session = struct {
    handles: [128]?u16 = @splat(null),
    encoded: [66000]u8 = undefined,
    decoded: [65535]u8 = undefined,
    used: usize = 0,
    pub fn reset(self: *Session) void {
        self.handles = @splat(null);
        self.used = 0;
    }
    pub fn closeAll(out: []u8) wire.Error![]u8 {
        if (out.len < 13) return error.NoSpace;
        @memset(out[0..13], 0);
        out[1] = 5;
        out[4] = 2;
        return out[0..13];
    }
    pub fn register(service: wire.Service, out: []u8) wire.Error![]u8 {
        if (out.len < 13) return error.NoSpace;
        @memset(out[0..13], 0);
        out[2] = 2;
        std.mem.writeInt(u16, out[10..12], @backingInt(service), .little);
        return out[0..13];
    }
    pub fn stream(self: Session, service: wire.Service, enabled: bool, out: []u8) wire.Error![]u8 {
        if (out.len < 2) return error.NoSpace;
        for (self.handles, 0..) |assigned, i| if (assigned == @backingInt(service)) {
            out[0] = @intCast(i);
            out[1] = @intFromBool(enabled);
            return out[0..2];
        };
        return error.Malformed;
    }
    pub fn accept(self: *Session, packet: []const u8, context: anytype, callback: anytype) !void {
        if (packet.len < 2 or packet.len > 4096) return error.Malformed;
        if (packet[0] == 0) {
            if (packet[1] == 6) {
                self.reset();
                try callback(context, Event.closed);
                return;
            }
            if (packet[1] != 1) return;
            if (packet.len != 14 or packet[12] != 0 or packet[13] == 0 or packet[13] > 127) return error.Malformed;
            const service = std.mem.readInt(u16, packet[10..12], .little);
            const handle = packet[13];
            if (self.handles[handle] != null and self.handles[handle] != service) return error.Malformed;
            for (&self.handles) |*assigned| {
                if (assigned.* == service) assigned.* = null;
            }
            self.handles[handle] = service;
            try callback(context, Event{ .registered = .{ .service = service, .handle = handle } });
            return;
        }
        const handle = if (packet[0] & 128 != 0) (packet[0] >> 4) & 7 else packet[0];
        const code = self.handles[handle] orelse return error.Malformed;
        if (code != 1) {
            const service = std.enums.fromInt(wire.Service, code) orelse return error.Malformed;
            const reading = wire.telemetry(service, packet[1..]) catch return;
            try callback(context, Event{ .reading = .{ .service = service, .reading = reading } });
            return;
        }
        for (packet[1..]) |byte| {
            if (byte == 0) {
                if (self.used == 0) continue;
                self.encoded[0] = 0;
                self.encoded[self.used + 1] = 0;
                const bytes = try wire.decode(self.encoded[0 .. self.used + 2], &self.decoded);
                self.used = 0;
                try callback(context, Event{ .message = try wire.parse(bytes) });
            } else {
                if (self.used >= self.encoded.len - 2) {
                    self.used = 0;
                    return error.TooLarge;
                }
                self.used += 1;
                self.encoded[self.used] = byte;
            }
        }
    }
};
test "session negotiates handles and decodes live telemetry" {
    const Host = struct {
        count: u32 = 0,
        fn event(self: *@This(), item: Event) !void {
            if (item == .reading) {
                try std.testing.expectEqual(@as(f64, 72), item.reading.reading.values[0]);
                self.count += 1;
            }
        }
    };
    var host: Host = .{};
    var session: Session = .{};
    var response = [_]u8{ 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 2 };
    try session.accept(&response, &host, Host.event);
    try session.accept(&.{ 0xa0, 0, 72, 51 }, &host, Host.event);
    try std.testing.expectEqual(@as(u32, 1), host.count);
}
