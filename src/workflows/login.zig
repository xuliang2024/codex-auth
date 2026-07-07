const std = @import("std");
const cli = @import("../cli/root.zig");
const registry = @import("../registry/root.zig");
const auth = @import("../auth/auth.zig");
const me_api = @import("../api/me.zig");
const account_names = @import("account_names.zig");
const app_runtime = @import("../core/runtime.zig");

const defaultAccountFetcher = account_names.defaultAccountFetcher;
const refreshAccountNamesAfterLogin = account_names.refreshAccountNamesAfterLogin;

fn loginScratchCodexHomeAlloc(allocator: std.mem.Allocator, codex_home: []const u8) ![]u8 {
    const stamp = std.Io.Timestamp.now(app_runtime.io(), .real).toMilliseconds();
    const name = try std.fmt.allocPrint(allocator, "login-{d}", .{stamp});
    defer allocator.free(name);
    return try std.fs.path.join(allocator, &[_][]const u8{ codex_home, "accounts", name });
}

pub fn handleLogin(allocator: std.mem.Allocator, codex_home: []const u8, opts: cli.types.LoginOptions) !void {
    var reg = try registry.loadRegistry(allocator, codex_home);
    defer reg.deinit(allocator);
    if (reg.accounts.items.len > 0) {
        _ = try registry.syncActiveAccountFromAuth(allocator, codex_home, &reg);
    }

    if (opts.api) |api_opts| {
        return handleApiLogin(allocator, codex_home, &reg, api_opts);
    }

    try registry.ensureAccountsDir(allocator, codex_home);
    const login_codex_home = try loginScratchCodexHomeAlloc(allocator, codex_home);
    defer allocator.free(login_codex_home);
    defer std.Io.Dir.cwd().deleteTree(app_runtime.io(), login_codex_home) catch {};
    try registry.ensurePrivateDir(login_codex_home);

    try cli.login.runCodexLogin(opts, login_codex_home);
    const login_auth_path = try registry.activeAuthPath(allocator, login_codex_home);
    defer allocator.free(login_auth_path);

    const auth_path = try registry.activeAuthPath(allocator, codex_home);
    defer allocator.free(auth_path);
    try registry.copyManagedFile(login_auth_path, auth_path);

    const info = try auth.parseAuthInfo(allocator, auth_path);
    defer info.deinit(allocator);

    if (info.auth_mode == .apikey) {
        const api_key = info.openai_api_key orelse return error.MissingOpenAIAPIKey;
        var me = try me_api.fetchMeForApiKey(allocator, api_key);
        defer me.deinit(allocator);

        const record_key = try registry.apiKeyAccountKeyAlloc(allocator, me.user_id, api_key);
        defer allocator.free(record_key);
        const dest = try registry.accountAuthPath(allocator, codex_home, record_key);
        defer allocator.free(dest);

        try registry.ensureAccountsDir(allocator, codex_home);
        try registry.copyManagedFile(auth_path, dest);

        const record = try registry.accountFromApiKeyMe(allocator, "", &info, &me);
        try registry.upsertAccount(allocator, &reg, record);
        try registry.setActiveAccountKey(allocator, &reg, record_key);
        try registry.saveRegistry(allocator, codex_home, &reg);
        return;
    }

    const email = info.email orelse return error.MissingEmail;
    _ = email;
    const record_key = info.record_key orelse return error.MissingChatgptUserId;
    const dest = try registry.accountAuthPath(allocator, codex_home, record_key);
    defer allocator.free(dest);

    try registry.ensureAccountsDir(allocator, codex_home);
    try registry.copyManagedFile(auth_path, dest);

    const record = try registry.accountFromAuth(allocator, "", &info);
    try registry.upsertAccount(allocator, &reg, record);
    try registry.setActiveAccountKey(allocator, &reg, record_key);
    _ = try refreshAccountNamesAfterLogin(allocator, &reg, &info, defaultAccountFetcher);
    try registry.saveRegistry(allocator, codex_home, &reg);
}

pub fn normalizeProviderBaseUrlAlloc(allocator: std.mem.Allocator, raw: []const u8) ![]u8 {
    var trimmed = std.mem.trim(u8, raw, &std.ascii.whitespace);
    if (!std.mem.startsWith(u8, trimmed, "https://") and !std.mem.startsWith(u8, trimmed, "http://")) {
        return error.InvalidProviderBaseUrl;
    }
    while (trimmed.len > 0 and trimmed[trimmed.len - 1] == '/') {
        trimmed = trimmed[0 .. trimmed.len - 1];
    }
    const scheme_len = if (std.mem.startsWith(u8, trimmed, "https://")) "https://".len else "http://".len;
    if (trimmed.len == scheme_len) return error.InvalidProviderBaseUrl;
    return try allocator.dupe(u8, trimmed);
}

pub fn providerHostFromBaseUrl(base_url: []const u8) []const u8 {
    const scheme_end = std.mem.indexOf(u8, base_url, "://").? + "://".len;
    const rest = base_url[scheme_end..];
    const end = std.mem.indexOfScalar(u8, rest, '/') orelse rest.len;
    return rest[0..end];
}

/// Provider ids become TOML bare keys (`[model_providers.<id>]`), so restrict
/// them to `A-Za-z0-9_-`.
pub fn sanitizeProviderIdAlloc(allocator: std.mem.Allocator, raw: []const u8) ![]u8 {
    var out = try allocator.alloc(u8, raw.len);
    var len: usize = 0;
    for (raw) |ch| {
        switch (ch) {
            'a'...'z', '0'...'9', '_', '-' => {
                out[len] = ch;
                len += 1;
            },
            'A'...'Z' => {
                out[len] = std.ascii.toLower(ch);
                len += 1;
            },
            '.', ':' => {
                out[len] = '-';
                len += 1;
            },
            else => {},
        }
    }
    if (len == 0) {
        allocator.free(out);
        return error.InvalidProviderName;
    }
    const result = try allocator.dupe(u8, out[0..len]);
    allocator.free(out);
    return result;
}

fn providerAuthJsonAlloc(allocator: std.mem.Allocator, api_key: []const u8) ![]u8 {
    const AuthOut = struct { OPENAI_API_KEY: []const u8 };
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try std.json.Stringify.value(AuthOut{ .OPENAI_API_KEY = api_key }, .{ .whitespace = .indent_2 }, &out.writer);
    try out.writer.writeAll("\n");
    return try out.toOwnedSlice();
}

fn handleApiLogin(
    allocator: std.mem.Allocator,
    codex_home: []const u8,
    reg: *registry.Registry,
    api_opts: cli.types.ApiLoginOptions,
) !void {
    const base_url = normalizeProviderBaseUrlAlloc(allocator, api_opts.base_url) catch {
        try cli.output.printApiLoginInvalidBaseUrlError(api_opts.base_url);
        return error.InvalidProviderBaseUrl;
    };
    defer allocator.free(base_url);
    const host = providerHostFromBaseUrl(base_url);

    const api_key = std.mem.trim(u8, api_opts.key, &std.ascii.whitespace);
    if (api_key.len == 0) return error.MissingOpenAIAPIKey;

    const id_source = api_opts.name orelse host;
    const provider_id = sanitizeProviderIdAlloc(allocator, id_source) catch {
        try cli.output.printApiLoginInvalidNameError(id_source);
        return error.InvalidProviderName;
    };
    defer allocator.free(provider_id);

    const model = api_opts.model orelse registry.default_provider_model;
    const reasoning_effort = api_opts.reasoning_effort orelse registry.default_provider_reasoning_effort;
    var provider = registry.ProviderConfig{
        .id = try allocator.dupe(u8, provider_id),
        .base_url = try allocator.dupe(u8, base_url),
        .model = try registry.cloneOptionalStringAlloc(allocator, model),
        .model_reasoning_effort = try registry.cloneOptionalStringAlloc(allocator, reasoning_effort),
    };
    var provider_owned = true;
    defer if (provider_owned) registry.freeProviderConfig(allocator, &provider);

    const record_key = try registry.providerAccountKeyAlloc(allocator, host, api_key);
    defer allocator.free(record_key);

    const auth_json = try providerAuthJsonAlloc(allocator, api_key);
    defer allocator.free(auth_json);

    const dest = try registry.accountAuthPath(allocator, codex_home, record_key);
    defer allocator.free(dest);
    try registry.ensureAccountsDir(allocator, codex_home);
    try registry.writeFile(dest, auth_json);

    const alias = api_opts.name orelse "";
    var record = try registry.accountFromProvider(allocator, alias, host, api_key, provider);
    provider_owned = false;
    var record_owned = true;
    errdefer if (record_owned) registry.freeAccountRecord(allocator, &record);
    try registry.upsertAccount(allocator, reg, record);
    record_owned = false;

    try registry.activateAccountByKey(allocator, codex_home, reg, record_key);
    try registry.saveRegistry(allocator, codex_home, reg);
    try cli.output.printApiLoginSuccess(host, provider_id, base_url);
}
