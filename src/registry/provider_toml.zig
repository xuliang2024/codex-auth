//! Manages the codex-auth owned regions of `config.toml` that route Codex to
//! a custom API provider (endpoint + key). Only text between the marker
//! comments is ever touched; everything else in the file is preserved.
const std = @import("std");
const app_runtime = @import("../core/runtime.zig");
const common = @import("common.zig");
const clean = @import("clean.zig");

const ProviderConfig = common.ProviderConfig;

pub const head_begin_marker = "# >>> codex-auth provider (do not edit) >>>";
pub const head_end_marker = "# <<< codex-auth provider <<<";
pub const tail_begin_marker = "# >>> codex-auth provider tables (do not edit) >>>";
pub const tail_end_marker = "# <<< codex-auth provider tables <<<";

pub const config_file_name = "config.toml";

/// Prefix used to comment out user-defined top-level keys that would clash
/// with the managed head block. Lines carrying this prefix are restored when
/// the managed blocks are removed.
pub const disabled_line_prefix = "#codex-auth:disabled# ";

pub fn configPath(allocator: std.mem.Allocator, codex_home: []const u8) ![]u8 {
    return try std.fs.path.join(allocator, &[_][]const u8{ codex_home, config_file_name });
}

fn isMarkerLine(line: []const u8, marker: []const u8) bool {
    return std.mem.eql(u8, std.mem.trim(u8, line, " \t\r"), marker);
}

/// Returns `content` with both managed regions removed, or null when no
/// managed region was present.
pub fn stripManagedRegionsAlloc(allocator: std.mem.Allocator, content: []const u8) !?[]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    var removed_any = false;
    var in_region = false;
    var end_marker: []const u8 = "";
    var it = std.mem.splitScalar(u8, content, '\n');
    var first = true;
    while (it.next()) |line| {
        if (in_region) {
            if (isMarkerLine(line, end_marker)) in_region = false;
            continue;
        }
        if (isMarkerLine(line, head_begin_marker)) {
            in_region = true;
            end_marker = head_end_marker;
            removed_any = true;
            continue;
        }
        if (isMarkerLine(line, tail_begin_marker)) {
            in_region = true;
            end_marker = tail_end_marker;
            removed_any = true;
            continue;
        }
        if (!first) try out.writer.writeAll("\n");
        try out.writer.writeAll(line);
        first = false;
    }

    if (!removed_any) {
        out.deinit();
        return null;
    }
    return try out.toOwnedSlice();
}

/// Top-level keys that the managed head block may define. Any of these
/// defined by the user outside managed regions would make the merged file an
/// invalid TOML document (duplicate keys), so they are commented out while a
/// provider is active and restored afterwards.
const managed_top_level_keys = [_][]const u8{
    "model_provider",
    "model",
    "review_model",
    "model_reasoning_effort",
    "disable_response_storage",
};

fn isConflictingTopLevelLine(raw_line: []const u8) bool {
    const line = std.mem.trim(u8, raw_line, " \t\r");
    if (line.len == 0 or line[0] == '#' or line[0] == '[') return false;
    const eq = std.mem.indexOfScalar(u8, line, '=') orelse return false;
    const key = std.mem.trim(u8, line[0..eq], " \t");
    for (managed_top_level_keys) |managed_key| {
        if (std.mem.eql(u8, key, managed_key)) return true;
    }
    return false;
}

/// Re-enables lines previously commented out with `disabled_line_prefix`.
pub fn restoreDisabledLinesAlloc(allocator: std.mem.Allocator, content: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    var it = std.mem.splitScalar(u8, content, '\n');
    var first = true;
    while (it.next()) |line| {
        if (!first) try out.writer.writeAll("\n");
        first = false;
        if (std.mem.startsWith(u8, line, disabled_line_prefix)) {
            try out.writer.writeAll(line[disabled_line_prefix.len..]);
        } else {
            try out.writer.writeAll(line);
        }
    }
    return try out.toOwnedSlice();
}

/// Comments out user-defined top-level scalar lines (before the first
/// `[table]` header) that would duplicate keys from the managed head block.
fn disableConflictingLinesAlloc(allocator: std.mem.Allocator, content: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    var it = std.mem.splitScalar(u8, content, '\n');
    var first = true;
    var in_top_level = true;
    while (it.next()) |line| {
        if (!first) try out.writer.writeAll("\n");
        first = false;
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len > 0 and trimmed[0] == '[') in_top_level = false;
        if (in_top_level and isConflictingTopLevelLine(line)) {
            try out.writer.writeAll(disabled_line_prefix);
        }
        try out.writer.writeAll(line);
    }
    return try out.toOwnedSlice();
}

fn writeTomlString(writer: *std.Io.Writer, value: []const u8) !void {
    try writer.writeAll("\"");
    for (value) |ch| {
        switch (ch) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            else => try writer.writeByte(ch),
        }
    }
    try writer.writeAll("\"");
}

fn writeHeadBlock(writer: *std.Io.Writer, provider: *const ProviderConfig) !void {
    try writer.writeAll(head_begin_marker);
    try writer.writeAll("\nmodel_provider = ");
    try writeTomlString(writer, provider.id);
    if (provider.model) |model| {
        try writer.writeAll("\nmodel = ");
        try writeTomlString(writer, model);
        try writer.writeAll("\nreview_model = ");
        try writeTomlString(writer, model);
    }
    if (provider.model_reasoning_effort) |effort| {
        try writer.writeAll("\nmodel_reasoning_effort = ");
        try writeTomlString(writer, effort);
    }
    try writer.writeAll("\ndisable_response_storage = true\n");
    try writer.writeAll(head_end_marker);
    try writer.writeAll("\n");
}

fn writeTailBlock(writer: *std.Io.Writer, provider: *const ProviderConfig) !void {
    try writer.writeAll(tail_begin_marker);
    try writer.print("\n[model_providers.{s}]", .{provider.id});
    try writer.writeAll("\nname = ");
    try writeTomlString(writer, provider.id);
    try writer.writeAll("\nbase_url = ");
    try writeTomlString(writer, provider.base_url);
    try writer.writeAll("\nwire_api = \"responses\"");
    try writer.writeAll("\nrequires_openai_auth = true\n");
    try writer.writeAll(tail_end_marker);
    try writer.writeAll("\n");
}

/// Builds the new `config.toml` content with the managed head block at the
/// top and the provider table block at the end. Conflicting user-defined
/// top-level keys are commented out (and restored on removal).
pub fn applyProviderBlocksAlloc(
    allocator: std.mem.Allocator,
    content: []const u8,
    provider: *const ProviderConfig,
) ![]u8 {
    const stripped_owned = try stripManagedRegionsAlloc(allocator, content);
    defer if (stripped_owned) |value| allocator.free(value);
    const user_content = try disableConflictingLinesAlloc(allocator, stripped_owned orelse content);
    defer allocator.free(user_content);

    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try writeHeadBlock(&out.writer, provider);

    const trimmed_user = std.mem.trim(u8, user_content, "\n");
    if (trimmed_user.len > 0) {
        try out.writer.writeAll("\n");
        try out.writer.writeAll(trimmed_user);
        try out.writer.writeAll("\n");
    }

    try out.writer.writeAll("\n");
    try writeTailBlock(&out.writer, provider);

    return try out.toOwnedSlice();
}

/// Returns content with managed regions removed and previously disabled user
/// lines restored, or null when nothing needs to change.
pub fn removeProviderBlocksAlloc(allocator: std.mem.Allocator, content: []const u8) !?[]u8 {
    const stripped_owned = try stripManagedRegionsAlloc(allocator, content);
    defer if (stripped_owned) |value| allocator.free(value);
    const had_regions = stripped_owned != null;
    const had_disabled = std.mem.indexOf(u8, content, disabled_line_prefix) != null;
    if (!had_regions and !had_disabled) return null;

    const restored = try restoreDisabledLinesAlloc(allocator, stripped_owned orelse content);
    errdefer allocator.free(restored);

    const trimmed = std.mem.trim(u8, restored, "\n");
    if (trimmed.len == 0) {
        allocator.free(restored);
        return try allocator.dupe(u8, "");
    }
    if (trimmed.len + 1 == restored.len and std.mem.startsWith(u8, restored, trimmed)) {
        return restored;
    }
    const normalized = try std.fmt.allocPrint(allocator, "{s}\n", .{trimmed});
    allocator.free(restored);
    return normalized;
}

fn writeConfigFile(path: []const u8, data: []const u8) !void {
    var file = try std.Io.Dir.cwd().createFile(app_runtime.io(), path, .{ .truncate = true });
    defer file.close(app_runtime.io());
    try file.writeStreamingAll(app_runtime.io(), data);
}

fn backupConfigIfExists(allocator: std.mem.Allocator, codex_home: []const u8, config_path: []const u8) !void {
    if (!(try clean.fileExists(config_path))) return;
    const dir = try clean.backupDir(allocator, codex_home);
    defer allocator.free(dir);
    try common.ensureAccountsDir(allocator, codex_home);
    const backup = try clean.makeBackupPath(allocator, dir, config_file_name);
    defer allocator.free(backup);
    try common.copyFile(config_path, backup);
    try clean.pruneBackups(allocator, dir, config_file_name, common.max_backups);
}

/// Rewrites `config.toml` so the given provider is active.
pub fn applyProviderToConfigFile(
    allocator: std.mem.Allocator,
    codex_home: []const u8,
    provider: *const ProviderConfig,
) !void {
    const path = try configPath(allocator, codex_home);
    defer allocator.free(path);

    const existing = (try clean.readFileIfExists(allocator, path)) orelse try allocator.dupe(u8, "");
    defer allocator.free(existing);

    const new_content = try applyProviderBlocksAlloc(allocator, existing, provider);
    defer allocator.free(new_content);
    if (std.mem.eql(u8, existing, new_content)) return;
    try backupConfigIfExists(allocator, codex_home, path);
    try writeConfigFile(path, new_content);
}

/// Removes the managed provider regions from `config.toml` (used when the
/// active account is not a provider account). No-op when nothing is managed.
pub fn removeProviderFromConfigFile(allocator: std.mem.Allocator, codex_home: []const u8) !void {
    const path = try configPath(allocator, codex_home);
    defer allocator.free(path);

    const existing = (try clean.readFileIfExists(allocator, path)) orelse return;
    defer allocator.free(existing);

    const new_content = (try removeProviderBlocksAlloc(allocator, existing)) orelse return;
    defer allocator.free(new_content);
    if (std.mem.eql(u8, existing, new_content)) return;

    try backupConfigIfExists(allocator, codex_home, path);
    try writeConfigFile(path, new_content);
}

/// Reconciles `config.toml` with the account being activated.
pub fn syncConfigForAccount(
    allocator: std.mem.Allocator,
    codex_home: []const u8,
    provider: ?*const ProviderConfig,
) !void {
    if (provider) |value| {
        try applyProviderToConfigFile(allocator, codex_home, value);
    } else {
        try removeProviderFromConfigFile(allocator, codex_home);
    }
}
