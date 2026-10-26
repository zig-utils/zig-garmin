const core = @import("root.zig");
var input: [66000]u8 = undefined;
var output: [66000]u8 = undefined;
export fn input_ptr() [*]u8 {
    return &input;
}
export fn output_ptr() [*]u8 {
    return &output;
}
export fn crc16(len: u32, seed: u16) u32 {
    if (len > input.len) return 0xffffffff;
    return core.crc16(input[0..len], seed);
}
export fn cobs_encode(len: u32) i32 {
    if (len > input.len) return -1;
    const bytes = core.encode(input[0..len], &output) catch return -1;
    return @intCast(bytes.len);
}
export fn cobs_decode(len: u32) i32 {
    if (len > input.len) return -1;
    const bytes = core.decode(input[0..len], &output) catch return -1;
    return @intCast(bytes.len);
}
export fn gfdi_frame(kind: u16, len: u32) i32 {
    if (len > input.len) return -1;
    const bytes = core.frame(kind, input[0..len], &output) catch return -1;
    return @intCast(bytes.len);
}
