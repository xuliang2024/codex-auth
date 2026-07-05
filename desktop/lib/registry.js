// Native (CLI-free) port of the codex-auth registry operations: switch,
// remove, API-provider login and the managed config.toml provider blocks.
// File formats and side effects mirror the Zig implementation in src/registry.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CURRENT_SCHEMA_VERSION = 5;
const MAX_BACKUPS = 5;
const FILE_MODE = 0o600;

// ---------- paths ----------

export function accountsDir(codexHome) {
  return path.join(codexHome, "accounts");
}

export function registryPath(codexHome) {
  return path.join(accountsDir(codexHome), "registry.json");
}

export function activeAuthPath(codexHome) {
  return path.join(codexHome, "auth.json");
}

export function accountAuthPath(codexHome, accountKey) {
  const fileKey = Buffer.from(accountKey, "utf8").toString("base64url");
  return path.join(accountsDir(codexHome), `${fileKey}.auth.json`);
}

function ensureAccountsDir(codexHome) {
  fs.mkdirSync(accountsDir(codexHome), { recursive: true, mode: 0o700 });
}

// ---------- backups (auth.json.bak.*, registry.json.bak.*, config.toml.bak.*) ----------

function backupTimestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function makeBackupPath(dir, baseName) {
  const base = `${baseName}.bak.${backupTimestamp()}`;
  for (let attempt = 0; ; attempt += 1) {
    const name = attempt === 0 ? base : `${base}.${attempt}`;
    const candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function pruneBackups(dir, baseName, max = MAX_BACKUPS) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(baseName) || !entry.name.includes(".bak.")) continue;
    try {
      backups.push({ name: entry.name, mtime: fs.statSync(path.join(dir, entry.name)).mtimeMs });
    } catch {
      // ignore races
    }
  }
  backups.sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(max)) {
    try {
      fs.unlinkSync(path.join(dir, old.name));
    } catch {
      // best effort
    }
  }
}

function backupFileIfChanged(codexHome, filePath, baseName, newContent) {
  if (!fs.existsSync(filePath)) return;
  try {
    if (newContent !== null && fs.readFileSync(filePath, "utf8") === newContent) return;
  } catch {
    // unreadable file still gets backed up below
  }
  ensureAccountsDir(codexHome);
  const dir = accountsDir(codexHome);
  const backup = makeBackupPath(dir, baseName);
  fs.copyFileSync(filePath, backup);
  fs.chmodSync(backup, FILE_MODE);
  pruneBackups(dir, baseName);
}

// ---------- registry load/save ----------

export function loadRegistry(codexHome) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(registryPath(codexHome), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        schema_version: CURRENT_SCHEMA_VERSION,
        active_account_key: null,
        previous_active_account_key: null,
        active_account_activated_at_ms: null,
        interval_seconds: 60,
        accounts: [],
      };
    }
    throw err;
  }
  data.accounts = Array.isArray(data.accounts) ? data.accounts : [];
  if (data.active_account_key === undefined) data.active_account_key = null;
  if (data.previous_active_account_key === undefined) data.previous_active_account_key = null;
  if (data.active_account_activated_at_ms === undefined) data.active_account_activated_at_ms = null;
  if (typeof data.interval_seconds !== "number") data.interval_seconds = 60;
  return data;
}

export function saveRegistry(codexHome, reg) {
  reg.schema_version = CURRENT_SCHEMA_VERSION;
  ensureAccountsDir(codexHome);
  const out = {
    schema_version: reg.schema_version,
    active_account_key: reg.active_account_key ?? null,
    previous_active_account_key: reg.previous_active_account_key ?? null,
    active_account_activated_at_ms: reg.active_account_activated_at_ms ?? null,
    interval_seconds: reg.interval_seconds ?? 60,
    accounts: reg.accounts,
  };
  const data = JSON.stringify(out, null, 2);
  const filePath = registryPath(codexHome);
  try {
    if (fs.readFileSync(filePath, "utf8") === data) {
      fs.chmodSync(filePath, FILE_MODE);
      return;
    }
  } catch {
    // missing or unreadable — write fresh below
  }
  backupFileIfChanged(codexHome, filePath, "registry.json", data);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: FILE_MODE });
  fs.renameSync(tmp, filePath);
}

// ---------- auth.json helpers ----------

export function decodeJwtClaims(jwt) {
  const parts = String(jwt ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const KNOWN_PLANS = ["free", "go", "plus", "prolite", "pro", "team", "business", "enterprise", "edu"];

// Mirrors src/auth/auth.zig parseAuthInfoData for the fields the app needs.
export function parseAuthData(auth) {
  if (!auth || typeof auth !== "object") return null;
  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) {
    return { authMode: "apikey", openaiApiKey: auth.OPENAI_API_KEY.trim(), recordKey: null };
  }
  const idToken = auth.tokens?.id_token;
  const claims = decodeJwtClaims(idToken);
  if (!claims) return null;
  const authClaims = claims["https://api.openai.com/auth"] ?? {};

  let accountId = typeof auth.tokens?.account_id === "string" && auth.tokens.account_id ? auth.tokens.account_id : null;
  if (!accountId) {
    accountId = typeof authClaims.chatgpt_account_id === "string" && authClaims.chatgpt_account_id
      ? authClaims.chatgpt_account_id
      : null;
  }
  if (!accountId && Array.isArray(authClaims.organizations)) {
    const orgs = authClaims.organizations.filter((o) => o && typeof o.id === "string" && o.id);
    accountId = (orgs.find((o) => o.is_default === true) ?? orgs[0])?.id ?? null;
  }
  const userId = (typeof authClaims.chatgpt_user_id === "string" && authClaims.chatgpt_user_id)
    ? authClaims.chatgpt_user_id
    : (typeof authClaims.user_id === "string" && authClaims.user_id ? authClaims.user_id : null);
  if (!accountId || !userId) return null;

  const rawPlan = typeof authClaims.chatgpt_plan_type === "string" ? authClaims.chatgpt_plan_type.toLowerCase() : null;
  return {
    authMode: "chatgpt",
    email: typeof claims.email === "string" ? claims.email.toLowerCase() : null,
    chatgptAccountId: accountId,
    chatgptUserId: userId,
    recordKey: `${userId}::${accountId}`,
    plan: rawPlan ? (KNOWN_PLANS.includes(rawPlan) ? rawPlan : "unknown") : null,
  };
}

function readAuthFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: FILE_MODE });
  fs.chmodSync(filePath, FILE_MODE);
}

// ---------- account key / record helpers ----------

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function providerAccountKey(host, apiKey) {
  return `provider::${host}::${sha256Hex(apiKey)}`;
}

export function apiKeyAccountName(apiKey) {
  const hex = sha256Hex(apiKey);
  return `sk-${hex.slice(0, 5)}***${hex.slice(-4)}`;
}

export function findAccountIndexByKey(reg, accountKey) {
  const idx = reg.accounts.findIndex((a) => a.account_key === accountKey);
  return idx >= 0 ? idx : null;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Mirrors registry.setActiveAccountKey: records the previous key (only when
// it still exists), stamps activation time and last_used_at.
function setActiveAccountKey(reg, accountKey, { preservePrevious = false } = {}) {
  if (reg.active_account_key === accountKey) return;
  if (!preservePrevious) {
    reg.previous_active_account_key =
      reg.active_account_key && findAccountIndexByKey(reg, reg.active_account_key) !== null
        ? reg.active_account_key
        : null;
  }
  reg.active_account_key = accountKey;
  reg.active_account_activated_at_ms = Date.now();
  const account = reg.accounts.find((a) => a.account_key === accountKey);
  if (account) account.last_used_at = nowSeconds();
}

// ---------- config.toml managed provider blocks (port of provider_toml.zig) ----------

const HEAD_BEGIN = "# >>> codex-auth provider (do not edit) >>>";
const HEAD_END = "# <<< codex-auth provider <<<";
const TAIL_BEGIN = "# >>> codex-auth provider tables (do not edit) >>>";
const TAIL_END = "# <<< codex-auth provider tables <<<";
const DISABLED_PREFIX = "#codex-auth:disabled# ";
const INCOMPATIBLE_PREFIX = "#codex-auth:incompatible# ";
const MANAGED_TOP_LEVEL_KEYS = new Set([
  "model_provider",
  "model",
  "review_model",
  "model_reasoning_effort",
  "disable_response_storage",
]);

function configPath(codexHome) {
  return path.join(codexHome, "config.toml");
}

function isMarkerLine(line, marker) {
  return line.trim() === marker;
}

function stripManagedRegions(content) {
  const out = [];
  let inRegion = false;
  let endMarker = "";
  let removedAny = false;
  for (const line of content.split("\n")) {
    if (inRegion) {
      if (isMarkerLine(line, endMarker)) inRegion = false;
      continue;
    }
    if (isMarkerLine(line, HEAD_BEGIN)) {
      inRegion = true;
      endMarker = HEAD_END;
      removedAny = true;
      continue;
    }
    if (isMarkerLine(line, TAIL_BEGIN)) {
      inRegion = true;
      endMarker = TAIL_END;
      removedAny = true;
      continue;
    }
    out.push(line);
  }
  return removedAny ? out.join("\n") : null;
}

function topLevelKeyOf(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("[")) return null;
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  return line.slice(0, eq).trim();
}

function disableConflictingLines(content) {
  const out = [];
  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) inTopLevel = false;
    const key = inTopLevel ? topLevelKeyOf(line) : null;
    if (key === "model_provider") {
      out.push(INCOMPATIBLE_PREFIX + line);
    } else if (key !== null && MANAGED_TOP_LEVEL_KEYS.has(key)) {
      out.push(DISABLED_PREFIX + line);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

function restoreDisabledLines(content) {
  return content
    .split("\n")
    .map((line) => (line.startsWith(DISABLED_PREFIX) ? line.slice(DISABLED_PREFIX.length) : line))
    .join("\n");
}

function quarantineForeignProviderLines(content) {
  const out = [];
  let changed = false;
  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) inTopLevel = false;
    if (inTopLevel && topLevelKeyOf(line) === "model_provider") {
      out.push(INCOMPATIBLE_PREFIX + line);
      changed = true;
    } else {
      out.push(line);
    }
  }
  return changed ? out.join("\n") : null;
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function providerHeadBlock(provider) {
  const lines = [HEAD_BEGIN, `model_provider = ${tomlString(provider.id)}`];
  if (provider.model) {
    lines.push(`model = ${tomlString(provider.model)}`);
    lines.push(`review_model = ${tomlString(provider.model)}`);
  }
  if (provider.model_reasoning_effort) {
    lines.push(`model_reasoning_effort = ${tomlString(provider.model_reasoning_effort)}`);
  }
  lines.push("disable_response_storage = true", HEAD_END, "");
  return lines.join("\n");
}

function providerTailBlock(provider) {
  return [
    TAIL_BEGIN,
    `[model_providers.${provider.id}]`,
    `name = ${tomlString(provider.id)}`,
    `base_url = ${tomlString(provider.base_url)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    TAIL_END,
    "",
  ].join("\n");
}

function applyProviderBlocks(content, provider) {
  const stripped = stripManagedRegions(content) ?? content;
  const userContent = disableConflictingLines(stripped);
  let out = providerHeadBlock(provider);
  const trimmedUser = userContent.replace(/^\n+|\n+$/g, "");
  if (trimmedUser.length > 0) out += `\n${trimmedUser}\n`;
  out += `\n${providerTailBlock(provider)}`;
  return out;
}

function removeProviderBlocks(content) {
  const stripped = stripManagedRegions(content);
  const hadRegions = stripped !== null;
  const hadDisabled = content.includes(DISABLED_PREFIX);
  const restored = hadRegions || hadDisabled ? restoreDisabledLines(stripped ?? content) : content;
  const quarantined = quarantineForeignProviderLines(restored);
  if (!hadRegions && !hadDisabled && quarantined === null) return null;
  const result = quarantined ?? restored;
  const trimmed = result.replace(/^\n+|\n+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

function syncConfigForAccount(codexHome, provider) {
  const filePath = configPath(codexHome);
  let existing = "";
  let exists = false;
  try {
    existing = fs.readFileSync(filePath, "utf8");
    exists = true;
  } catch {
    // no config yet
  }
  let newContent;
  if (provider) {
    newContent = applyProviderBlocks(existing, provider);
  } else {
    if (!exists) return;
    newContent = removeProviderBlocks(existing);
    if (newContent === null) return;
  }
  if (newContent === existing) return;
  backupFileIfChanged(codexHome, filePath, "config.toml", newContent);
  fs.writeFileSync(filePath, newContent);
}

// ---------- switch (port of registry.activateAccountByKey) ----------

export function activateAccountByKey(codexHome, reg, accountKey) {
  const idx = findAccountIndexByKey(reg, accountKey);
  if (idx === null) throw new Error("Account not found in registry.");
  const src = accountAuthPath(codexHome, accountKey);
  if (!fs.existsSync(src)) throw new Error("Stored auth snapshot for this account is missing.");

  const dest = activeAuthPath(codexHome);
  const srcContent = fs.readFileSync(src, "utf8");
  backupFileIfChanged(codexHome, dest, "auth.json", srcContent);
  writePrivateFile(dest, srcContent);
  setActiveAccountKey(reg, accountKey);
  syncConfigForAccount(codexHome, reg.accounts[idx].provider ?? null);
}

export function switchAccount(codexHome, accountKey) {
  const reg = loadRegistry(codexHome);
  activateAccountByKey(codexHome, reg, accountKey);
  saveRegistry(codexHome, reg);
  return reg;
}

// ---------- remove (port of removeSelectedAccountsAndPersist) ----------

function usageScoreAt(usage, now) {
  const resolveWindow = (minutes, fallbackPrimary) => {
    if (!usage) return null;
    if (usage.primary?.window_minutes === minutes) return usage.primary;
    if (usage.secondary?.window_minutes === minutes) return usage.secondary;
    return fallbackPrimary ? usage.primary ?? null : usage.secondary ?? null;
  };
  const remaining = (win) => {
    if (!win || typeof win.used_percent !== "number") return null;
    if (typeof win.resets_at === "number" && win.resets_at <= now) return 100;
    return Math.max(0, Math.min(100, Math.floor(100 - win.used_percent)));
  };
  const rem5h = remaining(resolveWindow(300, true));
  const remWeek = remaining(resolveWindow(10080, false));
  if (rem5h !== null && remWeek !== null) return Math.min(rem5h, remWeek);
  if (rem5h !== null) return rem5h;
  if (remWeek !== null) return remWeek;
  return null;
}

function selectBestRemainingAccountKey(reg, removedKeys) {
  const now = nowSeconds();
  let best = null;
  let bestScore = -2;
  let bestSeen = -1;
  for (const account of reg.accounts) {
    if (removedKeys.has(account.account_key)) continue;
    const score = usageScoreAt(account.last_usage, now) ?? -1;
    const seen = account.last_usage_at ?? -1;
    if (score > bestScore || (score === bestScore && seen > bestSeen)) {
      best = account.account_key;
      bestScore = score;
      bestSeen = seen;
    }
  }
  return best;
}

function deleteMatchingAuthBackups(codexHome, removedKeys) {
  const dir = accountsDir(codexHome);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith("auth.json.bak.")) continue;
    const filePath = path.join(dir, name);
    const info = parseAuthData(readAuthFile(filePath));
    if (info?.recordKey && removedKeys.has(info.recordKey)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // best effort
      }
    }
  }
}

export function removeAccount(codexHome, accountKey) {
  const reg = loadRegistry(codexHome);
  const idx = findAccountIndexByKey(reg, accountKey);
  if (idx === null) throw new Error("Account not found in registry.");
  const removedKeys = new Set([accountKey]);
  const removedHadProvider = reg.accounts[idx].provider != null;

  const activeKey =
    reg.active_account_key && findAccountIndexByKey(reg, reg.active_account_key) !== null
      ? reg.active_account_key
      : null;
  const activeRemoved = activeKey === accountKey;

  // Only rewrite auth.json when it demonstrably belongs to the removed
  // active account (record key match) or is already gone.
  const authPath = activeAuthPath(codexHome);
  const authMissing = !fs.existsSync(authPath);
  const authRecordKey = authMissing ? null : parseAuthData(readAuthFile(authPath))?.recordKey ?? null;
  const allowAuthFileUpdate = activeKey
    ? activeRemoved && (authMissing || authRecordKey === activeKey)
    : authMissing;

  if (activeRemoved) {
    const replacementKey = selectBestRemainingAccountKey(reg, removedKeys);
    if (replacementKey) {
      if (allowAuthFileUpdate) {
        const src = accountAuthPath(codexHome, replacementKey);
        if (fs.existsSync(src)) {
          writePrivateFile(authPath, fs.readFileSync(src, "utf8"));
        }
      }
      setActiveAccountKey(reg, replacementKey, { preservePrevious: true });
      const replacementIdx = findAccountIndexByKey(reg, replacementKey);
      syncConfigForAccount(codexHome, reg.accounts[replacementIdx].provider ?? null);
    }
  }

  deleteMatchingAuthBackups(codexHome, removedKeys);

  if (reg.active_account_key && removedKeys.has(reg.active_account_key)) {
    reg.active_account_key = null;
    reg.active_account_activated_at_ms = null;
    if (removedHadProvider) syncConfigForAccount(codexHome, null);
  }
  if (reg.previous_active_account_key && removedKeys.has(reg.previous_active_account_key)) {
    reg.previous_active_account_key = null;
  }

  try {
    fs.unlinkSync(accountAuthPath(codexHome, accountKey));
  } catch {
    // snapshot may already be gone
  }
  reg.accounts.splice(idx, 1);

  if (reg.accounts.length === 0 && allowAuthFileUpdate) {
    try {
      fs.unlinkSync(authPath);
    } catch {
      // already gone
    }
  }

  saveRegistry(codexHome, reg);
  return reg;
}

// ---------- account upsert / login persistence ----------

function recordFreshness(record) {
  return Math.max(record.created_at ?? 0, record.last_used_at ?? 0, record.last_usage_at ?? 0);
}

// Port of registry.upsertAccount + mergeAccountRecord, with the desktop
// niceties of carrying over alias and usage data on re-login.
export function upsertAccount(reg, record) {
  const idx = findAccountIndexByKey(reg, record.account_key);
  if (idx === null) {
    reg.accounts.push(record);
    return;
  }
  const dest = reg.accounts[idx];
  if (recordFreshness(record) >= recordFreshness(dest)) {
    if (!record.alias && dest.alias) record.alias = dest.alias;
    if (record.account_name == null && dest.account_name != null) record.account_name = dest.account_name;
    if (record.provider == null && dest.provider != null) record.provider = dest.provider;
    if (record.last_usage == null && dest.last_usage != null) {
      record.last_usage = dest.last_usage;
      record.last_usage_at = dest.last_usage_at;
    }
    reg.accounts[idx] = record;
  } else {
    if (record.alias && !dest.alias) dest.alias = record.alias;
    if (dest.account_name == null && record.account_name != null) dest.account_name = record.account_name;
    if (dest.plan == null) dest.plan = record.plan;
    if (dest.auth_mode == null) dest.auth_mode = record.auth_mode;
    // Provider settings come from an explicit re-login: incoming wins.
    if (record.provider != null) dest.provider = record.provider;
  }
}

function baseAccountRecord(fields) {
  return {
    account_key: fields.account_key,
    chatgpt_account_id: fields.chatgpt_account_id ?? "",
    chatgpt_user_id: fields.chatgpt_user_id ?? "",
    email: fields.email ?? "",
    alias: fields.alias ?? "",
    account_name: fields.account_name ?? null,
    plan: fields.plan ?? null,
    auth_mode: fields.auth_mode,
    created_at: nowSeconds(),
    last_used_at: null,
    last_usage: null,
    last_usage_at: null,
    last_local_rollout: null,
    provider: fields.provider ?? null,
  };
}

/// Persists a completed browser OAuth login (port of workflows/login.zig
/// handleLogin for the ChatGPT path). Returns the updated registry.
export function persistChatgptLogin(codexHome, tokens) {
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: undefined,
    },
    last_refresh: new Date().toISOString(),
  };
  const info = parseAuthData(auth);
  if (!info || info.authMode !== "chatgpt") {
    throw new Error("Sign-in completed but the returned identity token was missing account details.");
  }
  auth.tokens.account_id = info.chatgptAccountId;
  const serialized = JSON.stringify(auth, null, 2) + "\n";

  const reg = loadRegistry(codexHome);
  ensureAccountsDir(codexHome);

  const authPath = activeAuthPath(codexHome);
  backupFileIfChanged(codexHome, authPath, "auth.json", serialized);
  writePrivateFile(authPath, serialized);
  writePrivateFile(accountAuthPath(codexHome, info.recordKey), serialized);

  upsertAccount(reg, baseAccountRecord({
    account_key: info.recordKey,
    chatgpt_account_id: info.chatgptAccountId,
    chatgpt_user_id: info.chatgptUserId,
    email: info.email ?? "",
    plan: info.plan,
    auth_mode: "chatgpt",
  }));
  setActiveAccountKey(reg, info.recordKey);
  syncConfigForAccount(codexHome, null);
  saveRegistry(codexHome, reg);
  return { reg, email: info.email };
}

// ---------- API provider login (port of handleApiLogin) ----------

export function normalizeProviderBaseUrl(raw) {
  let trimmed = String(raw ?? "").trim();
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) return null;
  trimmed = trimmed.replace(/\/+$/, "");
  const schemeLen = trimmed.startsWith("https://") ? 8 : 7;
  if (trimmed.length === schemeLen) return null;
  return trimmed;
}

export function providerHostFromBaseUrl(baseUrl) {
  const rest = baseUrl.slice(baseUrl.indexOf("://") + 3);
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(0, slash);
}

// Provider ids become TOML bare keys, so restrict them to [a-z0-9_-].
export function sanitizeProviderId(raw) {
  let out = "";
  for (const ch of String(raw)) {
    if (/[a-z0-9_-]/.test(ch)) out += ch;
    else if (/[A-Z]/.test(ch)) out += ch.toLowerCase();
    else if (ch === "." || ch === ":") out += "-";
  }
  return out.length > 0 ? out : null;
}

export function addProviderAccount(codexHome, { baseUrl, apiKey, name, model }) {
  const normalizedUrl = normalizeProviderBaseUrl(baseUrl);
  if (!normalizedUrl) throw new Error("Enter a full endpoint URL such as https://codex.example.com");
  const trimmedKey = String(apiKey ?? "").trim();
  if (!trimmedKey) throw new Error("API key is required.");
  const host = providerHostFromBaseUrl(normalizedUrl);
  const providerId = sanitizeProviderId(name || host);
  if (!providerId) throw new Error("The provider name contains no usable characters.");

  const provider = {
    id: providerId,
    base_url: normalizedUrl,
    model: model ? String(model).trim() || null : null,
    model_reasoning_effort: null,
  };
  const recordKey = providerAccountKey(host, trimmedKey);

  const reg = loadRegistry(codexHome);
  ensureAccountsDir(codexHome);
  writePrivateFile(
    accountAuthPath(codexHome, recordKey),
    JSON.stringify({ OPENAI_API_KEY: trimmedKey }, null, 2) + "\n",
  );

  upsertAccount(reg, baseAccountRecord({
    account_key: recordKey,
    email: host,
    alias: name || "",
    account_name: apiKeyAccountName(trimmedKey),
    auth_mode: "provider",
    provider,
  }));
  activateAccountByKey(codexHome, reg, recordKey);
  saveRegistry(codexHome, reg);
  return reg;
}
