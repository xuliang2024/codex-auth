const std = @import("std");
const types = @import("../types.zig");
const common = @import("common.zig");

const OwnedFlags = struct {
    base_url: ?[]u8 = null,
    key: ?[]u8 = null,
    name: ?[]u8 = null,
    model: ?[]u8 = null,
    reasoning_effort: ?[]u8 = null,

    fn deinit(self: *OwnedFlags, allocator: std.mem.Allocator) void {
        if (self.base_url) |value| allocator.free(value);
        if (self.key) |value| allocator.free(value);
        if (self.name) |value| allocator.free(value);
        if (self.model) |value| allocator.free(value);
        if (self.reasoning_effort) |value| allocator.free(value);
        self.* = .{};
    }
};

pub fn parse(allocator: std.mem.Allocator, args: []const [:0]const u8) !types.ParseResult {
    if (args.len == 1 and common.isHelpFlag(std.mem.sliceTo(args[0], 0))) {
        return .{ .command = .{ .help = .login } };
    }

    var opts: types.LoginOptions = .{};
    var api_mode = false;
    var flags: OwnedFlags = .{};
    var flags_owned = true;
    defer if (flags_owned) flags.deinit(allocator);

    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = std.mem.sliceTo(args[i], 0);
        if (std.mem.eql(u8, arg, "--device-auth")) {
            if (opts.device_auth) return common.usageErrorResult(allocator, .login, "duplicate `--device-auth` for `login`.", .{});
            opts.device_auth = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "--api")) {
            if (api_mode) return common.usageErrorResult(allocator, .login, "duplicate `--api` for `login`.", .{});
            api_mode = true;
            continue;
        }
        if (valueFlagTarget(&flags, arg)) |slot| {
            if (slot.* != null) return common.usageErrorResult(allocator, .login, "duplicate `{s}` for `login`.", .{arg});
            if (i + 1 >= args.len) return common.usageErrorResult(allocator, .login, "`{s}` requires a value for `login`.", .{arg});
            i += 1;
            const value = std.mem.sliceTo(args[i], 0);
            if (value.len == 0) return common.usageErrorResult(allocator, .login, "`{s}` requires a non-empty value for `login`.", .{arg});
            slot.* = try allocator.dupe(u8, value);
            continue;
        }
        if (common.isHelpFlag(arg)) return common.usageErrorResult(allocator, .login, "`--help` must be used by itself for `login`.", .{});
        if (std.mem.startsWith(u8, arg, "-")) return common.usageErrorResult(allocator, .login, "unknown flag `{s}` for `login`.", .{arg});
        return common.usageErrorResult(allocator, .login, "unexpected argument `{s}` for `login`.", .{arg});
    }

    if (!api_mode) {
        if (flags.base_url != null or flags.key != null or flags.name != null or flags.model != null or flags.reasoning_effort != null) {
            return common.usageErrorResult(allocator, .login, "`--base-url`, `--key`, `--name`, `--model`, and `--reasoning-effort` require `--api` for `login`.", .{});
        }
        return .{ .command = .{ .login = opts } };
    }

    if (opts.device_auth) return common.usageErrorResult(allocator, .login, "`--device-auth` cannot be combined with `--api` for `login`.", .{});
    const base_url = flags.base_url orelse return common.usageErrorResult(allocator, .login, "`--api` requires `--base-url <url>` for `login`.", .{});
    const key = flags.key orelse return common.usageErrorResult(allocator, .login, "`--api` requires `--key <api-key>` for `login`.", .{});

    opts.api = .{
        .base_url = base_url,
        .key = key,
        .name = flags.name,
        .model = flags.model,
        .reasoning_effort = flags.reasoning_effort,
    };
    flags_owned = false;
    return .{ .command = .{ .login = opts } };
}

fn valueFlagTarget(flags: *OwnedFlags, arg: []const u8) ?*?[]u8 {
    if (std.mem.eql(u8, arg, "--base-url")) return &flags.base_url;
    if (std.mem.eql(u8, arg, "--key")) return &flags.key;
    if (std.mem.eql(u8, arg, "--name")) return &flags.name;
    if (std.mem.eql(u8, arg, "--model")) return &flags.model;
    if (std.mem.eql(u8, arg, "--reasoning-effort")) return &flags.reasoning_effort;
    return null;
}
