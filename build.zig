const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const mod = b.addModule("garmin", .{ .root_source_file = b.path("src/root.zig"), .target = target, .optimize = optimize });
    const lib = b.addLibrary(.{ .name = "garmin", .root_module = mod, .linkage = .static });
    b.installArtifact(lib);
    const tests = b.addTest(.{ .root_module = mod });
    const run = b.addRunArtifact(tests);
    b.step("test", "Test protocol boundaries and wire vectors").dependOn(&run.step);
    const wasm = b.addExecutable(.{ .name = "garmin", .root_module = b.createModule(.{ .root_source_file = b.path("src/wasm.zig"), .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding }), .optimize = .ReleaseSmall }) });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    const install = b.addInstallArtifact(wasm, .{});
    b.step("wasm", "Build the portable codec").dependOn(&install.step);
}
