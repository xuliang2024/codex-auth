const std = @import("std");
const cli = @import("../cli/root.zig");
const io_util = @import("../core/io_util.zig");
const registry = @import("../registry/root.zig");

pub fn handleConfig(allocator: std.mem.Allocator, codex_home: []const u8, opts: cli.types.ConfigOptions) !void {
    switch (opts) {
        .live => |live_opts| try handleLiveCommand(allocator, codex_home, live_opts),
        .fix => try handleFixCommand(allocator, codex_home),
    }
}

/// Reconciles `config.toml` with the active account: re-applies the managed
/// provider blocks for provider accounts, or removes them and quarantines
/// unmanaged `model_provider` overrides for ChatGPT/API-key accounts.
fn handleFixCommand(allocator: std.mem.Allocator, codex_home: []const u8) !void {
    var reg = try registry.loadRegistry(allocator, codex_home);
    defer reg.deinit(allocator);
    if (try registry.syncActiveAccountFromAuth(allocator, codex_home, &reg)) {
        try registry.saveRegistry(allocator, codex_home, &reg);
    }

    const config_path = try registry.provider_toml.configPath(allocator, codex_home);
    defer allocator.free(config_path);
    const before = try readFileOrEmpty(allocator, config_path);
    defer allocator.free(before);

    var provider: ?*const registry.ProviderConfig = null;
    if (reg.active_account_key) |active_key| {
        if (registry.findAccountIndexByAccountKey(&reg, active_key)) |idx| {
            if (reg.accounts.items[idx].provider) |*p| provider = p;
        }
    }
    try registry.provider_toml.syncConfigForAccount(allocator, codex_home, provider);

    const after = try readFileOrEmpty(allocator, config_path);
    defer allocator.free(after);

    var stdout: io_util.Stdout = undefined;
    stdout.init();
    const out = stdout.out();
    if (std.mem.eql(u8, before, after)) {
        try out.writeAll("config.toml already matches the active account; nothing to fix.\n");
    } else if (provider != null) {
        try out.writeAll("config.toml fixed: managed provider blocks re-applied for the active provider account.\n");
    } else {
        try out.writeAll("config.toml fixed: managed provider blocks removed and incompatible `model_provider` overrides commented out.\n");
    }
    try out.flush();
}

fn readFileOrEmpty(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const bytes = registry.readFileIfExists(allocator, path) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => null,
    };
    return bytes orelse try allocator.dupe(u8, "");
}

fn handleLiveCommand(allocator: std.mem.Allocator, codex_home: []const u8, opts: cli.types.LiveOptions) !void {
    var reg = try registry.loadRegistry(allocator, codex_home);
    defer reg.deinit(allocator);
    reg.live.interval_seconds = opts.interval_seconds;
    try registry.saveRegistry(allocator, codex_home, &reg);

    var stdout: io_util.Stdout = undefined;
    stdout.init();
    const out = stdout.out();
    try out.print("Live refresh interval: {d}s\n", .{opts.interval_seconds});
    try out.flush();
}
