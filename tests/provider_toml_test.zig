const std = @import("std");
const fs = @import("codex_auth").core.compat_fs;
const registry = @import("codex_auth").registry;
const provider_toml = registry.provider_toml;
const fixtures = @import("support/fixtures.zig");

fn testProvider(allocator: std.mem.Allocator) !registry.ProviderConfig {
    return .{
        .id = try allocator.dupe(u8, "apiz"),
        .base_url = try allocator.dupe(u8, "https://codex.apiz.ai"),
        .model = try allocator.dupe(u8, "gpt-5.5"),
        .model_reasoning_effort = try allocator.dupe(u8, "xhigh"),
    };
}

test "applyProviderBlocksAlloc renders head and tail blocks on empty content" {
    const gpa = std.testing.allocator;
    var provider = try testProvider(gpa);
    defer registry.freeProviderConfig(gpa, &provider);

    const content = try provider_toml.applyProviderBlocksAlloc(gpa, "", &provider);
    defer gpa.free(content);

    try std.testing.expect(std.mem.indexOf(u8, content, provider_toml.head_begin_marker) != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "model_provider = \"apiz\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "model = \"gpt-5.5\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "review_model = \"gpt-5.5\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "model_reasoning_effort = \"xhigh\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "disable_response_storage = true") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "[model_providers.apiz]") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "base_url = \"https://codex.apiz.ai\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "wire_api = \"responses\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, content, "requires_openai_auth = true") != null);

    // Head block scalars must appear before the provider table.
    const provider_line = std.mem.indexOf(u8, content, "model_provider = ").?;
    const table_line = std.mem.indexOf(u8, content, "[model_providers.apiz]").?;
    try std.testing.expect(provider_line < table_line);
}

test "applyProviderBlocksAlloc preserves user content and is idempotent" {
    const gpa = std.testing.allocator;
    var provider = try testProvider(gpa);
    defer registry.freeProviderConfig(gpa, &provider);

    const user_config = "# my notes\n[tui]\nnotifications = true\n";
    const first_content = try provider_toml.applyProviderBlocksAlloc(gpa, user_config, &provider);
    defer gpa.free(first_content);

    try std.testing.expect(std.mem.indexOf(u8, first_content, "# my notes") != null);
    try std.testing.expect(std.mem.indexOf(u8, first_content, "[tui]") != null);

    const second_content = try provider_toml.applyProviderBlocksAlloc(gpa, first_content, &provider);
    defer gpa.free(second_content);

    try std.testing.expectEqualStrings(first_content, second_content);
}

test "removeProviderBlocksAlloc strips managed regions and keeps user content" {
    const gpa = std.testing.allocator;
    var provider = try testProvider(gpa);
    defer registry.freeProviderConfig(gpa, &provider);

    const user_config = "[tui]\nnotifications = true\n";
    const applied_content = try provider_toml.applyProviderBlocksAlloc(gpa, user_config, &provider);
    defer gpa.free(applied_content);

    const removed = (try provider_toml.removeProviderBlocksAlloc(gpa, applied_content)).?;
    defer gpa.free(removed);

    try std.testing.expectEqualStrings(user_config, removed);
    try std.testing.expect(try provider_toml.removeProviderBlocksAlloc(gpa, user_config) == null);
}

test "applyProviderBlocksAlloc comments out conflicting keys and remove restores them" {
    const gpa = std.testing.allocator;
    var provider = try testProvider(gpa);
    defer registry.freeProviderConfig(gpa, &provider);

    const user_config = "model = \"gpt-6\"\nmodel_reasoning_effort = \"low\"\nservice_tier = \"default\"\n\n[profiles.x]\nmodel = \"inside-table-ok\"\n";
    const applied = try provider_toml.applyProviderBlocksAlloc(gpa, user_config, &provider);
    defer gpa.free(applied);

    // Conflicting user lines are disabled, not deleted; table entries and
    // non-conflicting scalars stay untouched.
    try std.testing.expect(std.mem.indexOf(u8, applied, "#codex-auth:disabled# model = \"gpt-6\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "#codex-auth:disabled# model_reasoning_effort = \"low\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "#codex-auth:disabled# service_tier") == null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "\nservice_tier = \"default\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "#codex-auth:disabled# model = \"inside-table-ok\"") == null);

    // Managed head block still provides its own values.
    try std.testing.expect(std.mem.indexOf(u8, applied, "model = \"gpt-5.5\"") != null);

    const removed = (try provider_toml.removeProviderBlocksAlloc(gpa, applied)).?;
    defer gpa.free(removed);
    try std.testing.expectEqualStrings(user_config, removed);
}

test "applyProviderBlocksAlloc avoids existing provider table conflicts" {
    const gpa = std.testing.allocator;
    var provider = try testProvider(gpa);
    defer registry.freeProviderConfig(gpa, &provider);

    const user_config =
        \\[model_providers.apiz]
        \\name = "user apiz"
        \\base_url = "https://user.example.com"
        \\
        \\[model_providers.apiz-codex-auth]
        \\name = "user reserved"
        \\base_url = "https://reserved.example.com"
        \\
    ;
    const applied = try provider_toml.applyProviderBlocksAlloc(gpa, user_config, &provider);
    defer gpa.free(applied);

    try std.testing.expect(std.mem.indexOf(u8, applied, "model_provider = \"apiz-codex-auth-2\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "[model_providers.apiz-codex-auth-2]") != null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "[model_providers.apiz]\nname = \"user apiz\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "[model_providers.apiz-codex-auth]\nname = \"user reserved\"") != null);

    const second = try provider_toml.applyProviderBlocksAlloc(gpa, applied, &provider);
    defer gpa.free(second);
    try std.testing.expectEqualStrings(applied, second);

    const removed = (try provider_toml.removeProviderBlocksAlloc(gpa, applied)).?;
    defer gpa.free(removed);
    try std.testing.expectEqualStrings(user_config, removed);
}

test "removeProviderBlocksAlloc quarantines unmanaged model_provider overrides" {
    const gpa = std.testing.allocator;

    const user_config = "model_provider = \"OpenAI\"\nmodel = \"gpt-5.5\"\n\n[model_providers.OpenAI]\nname = \"OpenAI\"\nbase_url = \"https://relay.example.com\"\nrequires_openai_auth = true\n";
    const removed = (try provider_toml.removeProviderBlocksAlloc(gpa, user_config)).?;
    defer gpa.free(removed);

    // The routing override is commented out permanently; other keys stay.
    try std.testing.expect(std.mem.indexOf(u8, removed, "#codex-auth:incompatible# model_provider = \"OpenAI\"") != null);
    try std.testing.expect(std.mem.startsWith(u8, removed, "#codex-auth:incompatible# ") or std.mem.indexOf(u8, removed, "\nmodel_provider = ") == null);
    try std.testing.expect(std.mem.indexOf(u8, removed, "\nmodel = \"gpt-5.5\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, removed, "[model_providers.OpenAI]") != null);

    // A second pass is a no-op.
    try std.testing.expect(try provider_toml.removeProviderBlocksAlloc(gpa, removed) == null);
}

test "applyProviderBlocksAlloc quarantines foreign model_provider and remove keeps it disabled" {
    const gpa = std.testing.allocator;
    var provider = try testProvider(gpa);
    defer registry.freeProviderConfig(gpa, &provider);

    const user_config = "model_provider = \"OpenAI\"\nservice_tier = \"default\"\n";
    const applied = try provider_toml.applyProviderBlocksAlloc(gpa, user_config, &provider);
    defer gpa.free(applied);

    try std.testing.expect(std.mem.indexOf(u8, applied, "#codex-auth:incompatible# model_provider = \"OpenAI\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, applied, "model_provider = \"apiz\"") != null);

    const removed = (try provider_toml.removeProviderBlocksAlloc(gpa, applied)).?;
    defer gpa.free(removed);

    // The foreign override is never restored, unlike restorable disabled keys.
    try std.testing.expect(std.mem.indexOf(u8, removed, "#codex-auth:incompatible# model_provider = \"OpenAI\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, removed, "model_provider = \"apiz\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, removed, "\nservice_tier = \"default\"") != null or std.mem.startsWith(u8, removed, "service_tier"));
}

test "registry save/load round-trips provider accounts" {
    const gpa = std.testing.allocator;
    var tmp = fs.tmpDir(.{});
    defer tmp.cleanup();
    const home = try tmp.dir.realpathAlloc(gpa, ".");
    defer gpa.free(home);

    {
        var reg = fixtures.makeEmptyRegistry();
        defer reg.deinit(gpa);

        const provider = try testProvider(gpa);
        var record = try registry.accountFromProvider(gpa, "apiz", "codex.apiz.ai", "sk-test-key", provider);
        var record_owned = true;
        errdefer if (record_owned) registry.freeAccountRecord(gpa, &record);
        try registry.upsertAccount(gpa, &reg, record);
        record_owned = false;
        try registry.saveRegistry(gpa, home, &reg);
    }

    var loaded = try registry.loadRegistry(gpa, home);
    defer loaded.deinit(gpa);

    try std.testing.expectEqual(@as(usize, 1), loaded.accounts.items.len);
    const rec = &loaded.accounts.items[0];
    try std.testing.expectEqual(registry.AuthMode.provider, rec.auth_mode.?);
    try std.testing.expectEqualStrings("codex.apiz.ai", rec.email);
    try std.testing.expect(std.mem.startsWith(u8, rec.account_key, "provider::codex.apiz.ai::"));
    const provider = rec.provider.?;
    try std.testing.expectEqualStrings("apiz", provider.id);
    try std.testing.expectEqualStrings("https://codex.apiz.ai", provider.base_url);
    try std.testing.expectEqualStrings("gpt-5.5", provider.model.?);
    try std.testing.expectEqualStrings("xhigh", provider.model_reasoning_effort.?);
}

test "activateAccountByKey applies and removes provider config.toml blocks" {
    const gpa = std.testing.allocator;
    var tmp = fs.tmpDir(.{});
    defer tmp.cleanup();
    const home = try tmp.dir.realpathAlloc(gpa, ".");
    defer gpa.free(home);

    try tmp.dir.writeFile(.{ .sub_path = "config.toml", .data = "[tui]\nnotifications = true\n" });

    var reg = fixtures.makeEmptyRegistry();
    defer reg.deinit(gpa);

    // ChatGPT account with a stored snapshot.
    try fixtures.appendAccount(gpa, &reg, "user@example.com", "", .pro);
    const chatgpt_key = try fixtures.accountKeyForEmailAlloc(gpa, "user@example.com");
    defer gpa.free(chatgpt_key);
    const chatgpt_auth = try fixtures.authJsonWithEmailPlan(gpa, "user@example.com", "pro");
    defer gpa.free(chatgpt_auth);
    const chatgpt_snapshot_path = try registry.accountAuthPath(gpa, home, chatgpt_key);
    defer gpa.free(chatgpt_snapshot_path);
    try registry.ensureAccountsDir(gpa, home);
    try registry.writeFile(chatgpt_snapshot_path, chatgpt_auth);

    // Provider account with a stored snapshot.
    const provider = try testProvider(gpa);
    var record = try registry.accountFromProvider(gpa, "apiz", "codex.apiz.ai", "sk-test-key", provider);
    var record_owned = true;
    errdefer if (record_owned) registry.freeAccountRecord(gpa, &record);
    const provider_key = try gpa.dupe(u8, record.account_key);
    defer gpa.free(provider_key);
    try registry.upsertAccount(gpa, &reg, record);
    record_owned = false;
    const provider_snapshot_path = try registry.accountAuthPath(gpa, home, provider_key);
    defer gpa.free(provider_snapshot_path);
    try registry.writeFile(provider_snapshot_path, "{\"OPENAI_API_KEY\": \"sk-test-key\"}\n");

    // Switch to the provider account: config.toml gains the managed blocks.
    try registry.activateAccountByKey(gpa, home, &reg, provider_key);
    {
        const config = try fixtures.readFileAlloc(gpa, try configPathBuf(&config_path_buf, home));
        defer gpa.free(config);
        try std.testing.expect(std.mem.indexOf(u8, config, "model_provider = \"apiz\"") != null);
        try std.testing.expect(std.mem.indexOf(u8, config, "[model_providers.apiz]") != null);
        try std.testing.expect(std.mem.indexOf(u8, config, "[tui]") != null);

        const auth = try fixtures.readFileAlloc(gpa, try authPathBuf(&auth_path_buf, home));
        defer gpa.free(auth);
        try std.testing.expect(std.mem.indexOf(u8, auth, "sk-test-key") != null);
    }

    // Switch back to the ChatGPT account: managed blocks disappear.
    try registry.activateAccountByKey(gpa, home, &reg, chatgpt_key);
    {
        const config = try fixtures.readFileAlloc(gpa, try configPathBuf(&config_path_buf, home));
        defer gpa.free(config);
        try std.testing.expect(std.mem.indexOf(u8, config, "model_provider") == null);
        try std.testing.expect(std.mem.indexOf(u8, config, "[model_providers.apiz]") == null);
        try std.testing.expect(std.mem.indexOf(u8, config, "[tui]") != null);

        const auth = try fixtures.readFileAlloc(gpa, try authPathBuf(&auth_path_buf, home));
        defer gpa.free(auth);
        try std.testing.expect(std.mem.indexOf(u8, auth, "sk-test-key") == null);
    }
}

test "activateAccountByKey quarantines unmanaged model_provider override for chatgpt account" {
    const gpa = std.testing.allocator;
    var tmp = fs.tmpDir(.{});
    defer tmp.cleanup();
    const home = try tmp.dir.realpathAlloc(gpa, ".");
    defer gpa.free(home);

    // A hand-written config that reroutes every account to a relay endpoint.
    try tmp.dir.writeFile(.{ .sub_path = "config.toml", .data = "model_provider = \"OpenAI\"\n\n[model_providers.OpenAI]\nname = \"OpenAI\"\nbase_url = \"https://relay.example.com\"\nrequires_openai_auth = true\n" });

    var reg = fixtures.makeEmptyRegistry();
    defer reg.deinit(gpa);

    try fixtures.appendAccount(gpa, &reg, "user@example.com", "", .pro);
    const chatgpt_key = try fixtures.accountKeyForEmailAlloc(gpa, "user@example.com");
    defer gpa.free(chatgpt_key);
    const chatgpt_auth = try fixtures.authJsonWithEmailPlan(gpa, "user@example.com", "pro");
    defer gpa.free(chatgpt_auth);
    const chatgpt_snapshot_path = try registry.accountAuthPath(gpa, home, chatgpt_key);
    defer gpa.free(chatgpt_snapshot_path);
    try registry.ensureAccountsDir(gpa, home);
    try registry.writeFile(chatgpt_snapshot_path, chatgpt_auth);

    try registry.activateAccountByKey(gpa, home, &reg, chatgpt_key);

    const config = try fixtures.readFileAlloc(gpa, try configPathBuf(&config_path_buf, home));
    defer gpa.free(config);
    try std.testing.expect(std.mem.indexOf(u8, config, "#codex-auth:incompatible# model_provider = \"OpenAI\"") != null);
    try std.testing.expect(std.mem.startsWith(u8, config, "#codex-auth:incompatible# "));
}

var config_path_buf: [std.fs.max_path_bytes]u8 = undefined;
var auth_path_buf: [std.fs.max_path_bytes]u8 = undefined;

fn configPathBuf(buf: []u8, home: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf, "{s}/config.toml", .{home});
}

fn authPathBuf(buf: []u8, home: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf, "{s}/auth.json", .{home});
}

test "findProviderAccountIndexByApiKey matches by key hash" {
    const gpa = std.testing.allocator;
    var reg = fixtures.makeEmptyRegistry();
    defer reg.deinit(gpa);

    try fixtures.appendAccount(gpa, &reg, "user@example.com", "", .pro);
    const provider = try testProvider(gpa);
    var record = try registry.accountFromProvider(gpa, "apiz", "codex.apiz.ai", "sk-test-key", provider);
    var record_owned = true;
    errdefer if (record_owned) registry.freeAccountRecord(gpa, &record);
    try registry.upsertAccount(gpa, &reg, record);
    record_owned = false;

    const idx = (try registry.findProviderAccountIndexByApiKey(gpa, &reg, "sk-test-key")).?;
    try std.testing.expectEqual(registry.AuthMode.provider, reg.accounts.items[idx].auth_mode.?);
    try std.testing.expect((try registry.findProviderAccountIndexByApiKey(gpa, &reg, "sk-other-key")) == null);
}
