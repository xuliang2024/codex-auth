import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as registryOps from "./lib/registry.js";
import { startBrowserLogin } from "./lib/oauth.js";
import { proxyFetch } from "./lib/net-fetch.js";
import { buildExportPayload } from "./lib/export-accounts.js";
import { applyImportPayload } from "./lib/import-accounts.js";
import { fetchShareExport, uploadShare } from "./lib/share.js";
import {
  buildRegistrySnapshot,
  flushTelemetry,
  initTelemetry,
  shutdownTelemetry,
  trackResult,
  trackTelemetry,
} from "./lib/telemetry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ICON_PATH = path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
const DOCK_ICON_PATH = path.join(__dirname, "build", "icon.png");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const REGISTRY_PATH = path.join(CODEX_HOME, "accounts", "registry.json");
const ANNOUNCEMENTS_ENDPOINT = process.env.CODEX_AUTH_ANNOUNCEMENTS_ENDPOINT || "https://codex-auth-telemetry.xuliang2022.workers.dev/v1/announcements";
const ANNOUNCEMENTS_FALLBACK_TTL_SECONDS = 300;
const MAX_ANNOUNCEMENT_TITLE_LENGTH = 80;
const MAX_ANNOUNCEMENT_BODY_LENGTH = 260;
const MAX_ANNOUNCEMENT_URL_LENGTH = 2048;

let mainWindow = null;
const announcementCache = new Map();

function setDockIcon() {
  if (process.platform === "darwin" && fs.existsSync(DOCK_ICON_PATH)) {
    app.dock?.setIcon(DOCK_ICON_PATH);
  }
}

function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.code === "ENOENT" ? "registry.json not found. Add accounts with `codex-auth login` first." : String(err) };
  }
}

let watcher = null;
let watchDebounce = null;

function watchRegistry() {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) return;
  try {
    watcher = fs.watch(dir, (eventType, filename) => {
      if (filename && filename !== "registry.json") return;
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("registry-changed", readRegistry());
        }
      }, 200);
    });
  } catch {
    // watching is best-effort; the UI still has manual refresh
  }
}

function installContextMenu(window) {
  window.webContents.on("context-menu", (_event, params) => {
    const editFlags = params.editFlags ?? {};
    const hasSelection = Boolean(params.selectionText);
    if (!params.isEditable && !hasSelection) return;

    const template = params.isEditable
      ? [
          { role: "undo", enabled: editFlags.canUndo },
          { role: "redo", enabled: editFlags.canRedo },
          { type: "separator" },
          { role: "cut", enabled: editFlags.canCut },
          { role: "copy", enabled: editFlags.canCopy || hasSelection },
          { role: "paste", enabled: editFlags.canPaste },
          { type: "separator" },
          { role: "selectAll", enabled: editFlags.canSelectAll },
        ]
      : [
          { role: "copy", enabled: editFlags.canCopy || hasSelection },
          { type: "separator" },
          { role: "selectAll", enabled: editFlags.canSelectAll },
        ];

    Menu.buildFromTemplate(template).popup({ window });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 620,
    minHeight: 480,
    title: "Accounts for Codex",
    icon: APP_ICON_PATH,
    // Frameless-style titlebar is macOS-only; Windows/Linux keep the native frame.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    backgroundColor: "#0d1017",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  installContextMenu(mainWindow);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("get-registry", () => readRegistry());
ipcMain.handle("get-app-version", () => app.getVersion());

function compactText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeExternalUrl(value) {
  const text = compactText(value, MAX_ANNOUNCEMENT_URL_LENGTH);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeAnnouncement(raw) {
  const body = compactText(raw?.body, MAX_ANNOUNCEMENT_BODY_LENGTH);
  if (!body) return null;
  return {
    id: typeof raw?.id === "number" || typeof raw?.id === "string" ? raw.id : null,
    title: compactText(raw?.title, MAX_ANNOUNCEMENT_TITLE_LENGTH),
    body,
    url: normalizeExternalUrl(raw?.url),
    priority: typeof raw?.priority === "number" ? raw.priority : Number(raw?.priority) || 0,
  };
}

function normalizeLocale(value) {
  const text = compactText(value, 32).toLowerCase();
  if (!text) return "en";
  return text.split(/[-_]/, 1)[0].replace(/[^a-z0-9]/g, "") || "en";
}

function announcementCacheKey({ locale, platform, version }) {
  return `${locale}:${platform}:${version}`;
}

async function fetchAnnouncements(opts = {}) {
  const locale = normalizeLocale(opts.locale || app.getLocale());
  const platform = process.platform;
  const version = app.getVersion();
  const cacheKey = announcementCacheKey({ locale, platform, version });
  const cached = announcementCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  try {
    const url = new URL(ANNOUNCEMENTS_ENDPOINT);
    url.searchParams.set("app", "codex-auth-desktop");
    url.searchParams.set("version", version);
    url.searchParams.set("platform", platform);
    url.searchParams.set("locale", locale);
    const response = await proxyFetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `codex-auth-desktop/${version}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return cached?.payload ?? { ok: false, error: `Announcement API returned HTTP ${response.status}`, announcements: [] };
    }
    const body = await response.json();
    const ttlSeconds = Number.isFinite(body?.ttl_seconds)
      ? Math.min(3600, Math.max(60, Math.trunc(body.ttl_seconds)))
      : ANNOUNCEMENTS_FALLBACK_TTL_SECONDS;
    const announcements = Array.isArray(body?.announcements)
      ? body.announcements.map(normalizeAnnouncement).filter(Boolean)
      : [];
    const payload = { ok: true, announcements, ttl_seconds: ttlSeconds };
    announcementCache.set(cacheKey, {
      expiresAt: Date.now() + ttlSeconds * 1000,
      payload,
    });
    return payload;
  } catch (err) {
    return cached?.payload ?? {
      ok: false,
      error: `Announcement request failed: ${err.name === "TimeoutError" ? "timed out" : err.message}`,
      announcements: [],
    };
  }
}

ipcMain.handle("get-announcements", (_event, opts) => fetchAnnouncements(opts));

ipcMain.handle("open-announcement-url", async (_event, url) => {
  const normalized = normalizeExternalUrl(url);
  if (!normalized) {
    const result = { ok: false, error: "Announcement link is not a valid web URL." };
    trackResult(CODEX_HOME, "open_announcement", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
  try {
    await shell.openExternal(normalized);
    const result = { ok: true };
    trackResult(CODEX_HOME, "open_announcement", result, buildRegistrySnapshot(readRegistry()));
    return result;
  } catch (err) {
    const result = { ok: false, error: `Could not open announcement link: ${err.message}` };
    trackResult(CODEX_HOME, "open_announcement", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
});

ipcMain.handle("switch-account", (_event, accountKey) => {
  let result;
  try {
    registryOps.switchAccount(CODEX_HOME, String(accountKey ?? ""));
    result = { ok: true, registry: readRegistry() };
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  trackResult(CODEX_HOME, "switch_account", result, buildRegistrySnapshot(result.registry ?? readRegistry()));
  return result;
});

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
// Official Codex CLI OAuth client id (same one embedded in stored id_token aud)
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function accountAuthPath(accountKey) {
  const fileKey = Buffer.from(accountKey, "utf8").toString("base64url");
  return path.join(CODEX_HOME, "accounts", `${fileKey}.auth.json`);
}

async function refreshAuthTokens(authPath, auth) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (!refreshToken) return { ok: false, error: "no refresh token stored" };

  let response;
  try {
    response = await proxyFetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!response.ok) return { ok: false, error: `token refresh returned HTTP ${response.status}` };

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "token refresh response was not JSON" };
  }
  if (!body.access_token) return { ok: false, error: "token refresh response had no access token" };

  auth.tokens.access_token = body.access_token;
  if (body.id_token) auth.tokens.id_token = body.id_token;
  if (body.refresh_token) auth.tokens.refresh_token = body.refresh_token;
  auth.last_refresh = new Date().toISOString();
  try {
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n");
  } catch (err) {
    return { ok: false, error: `failed to save refreshed tokens: ${err.message}` };
  }
  return { ok: true };
}

function fetchUsage(accessToken, accountId) {
  return proxyFetch(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "codex-auth-desktop/0.1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });
}

function parseUsageWindow(win) {
  if (!win || typeof win !== "object") return null;
  if (typeof win.used_percent !== "number") return null;
  return {
    used_percent: win.used_percent,
    window_minutes: typeof win.limit_window_seconds === "number" && win.limit_window_seconds > 0
      ? Math.ceil(win.limit_window_seconds / 60)
      : null,
    resets_at: typeof win.reset_at === "number" ? win.reset_at : null,
  };
}

// Fetches live usage for one account and reports whether its stored auth is
// expired (token rejected and refresh impossible). Does not touch registry.json.
async function fetchAccountUsageStatus(accountKey) {
  // The active account's live tokens are in auth.json; its snapshot under
  // accounts/ can hold an older, already-rotated refresh token.
  const registryNow = readRegistry();
  const isActive = registryNow.ok && registryNow.data.active_account_key === accountKey;
  const activeAuthPath = path.join(CODEX_HOME, "auth.json");
  const authPath = isActive && fs.existsSync(activeAuthPath) ? activeAuthPath : accountAuthPath(accountKey);
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch (err) {
    return { ok: false, expired: true, error: `Cannot read stored auth for this account: ${err.code === "ENOENT" ? "auth snapshot not found" : err.message}` };
  }
  const accountId = auth?.tokens?.account_id;
  if (!auth?.tokens?.access_token || !accountId) {
    if (auth?.OPENAI_API_KEY) return { ok: false, expired: false, error: "API-key account — usage is not available." };
    return { ok: false, expired: true, error: "Stored auth is missing an access token." };
  }

  let response;
  try {
    response = await fetchUsage(auth.tokens.access_token, accountId);
    if (response.status === 401) {
      const refreshed = await refreshAuthTokens(authPath, auth);
      if (!refreshed.ok) {
        return { ok: false, expired: true, error: `Session expired — sign in again with Add Account. (${refreshed.error})` };
      }
      response = await fetchUsage(auth.tokens.access_token, accountId);
      if (response.status === 401 || response.status === 403) {
        return { ok: false, expired: true, error: `Usage API rejected the refreshed session (HTTP ${response.status}).` };
      }
    }
  } catch (err) {
    return { ok: false, expired: false, error: `Usage request failed: ${err.name === "TimeoutError" ? "timed out" : err.message}` };
  }
  if (!response.ok) {
    return { ok: false, expired: false, error: `Usage API returned HTTP ${response.status}` };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, expired: false, error: "Usage API returned an unparseable response." };
  }

  const usage = {
    primary: parseUsageWindow(body?.rate_limit?.primary_window),
    secondary: parseUsageWindow(body?.rate_limit?.secondary_window),
    credits: body?.credits && typeof body.credits === "object"
      ? {
          has_credits: body.credits.has_credits === true,
          unlimited: body.credits.unlimited === true,
          balance: typeof body.credits.balance === "string" && body.credits.balance ? body.credits.balance : null,
        }
      : null,
    plan_type: typeof body?.plan_type === "string" ? body.plan_type.toLowerCase() : null,
  };
  if (!usage.primary && !usage.secondary) {
    return { ok: false, expired: false, error: "Usage API response contained no rate limit data." };
  }

  return { ok: true, expired: false, usage };
}

function persistUsages(entries) {
  const current = readRegistry();
  if (!current.ok) return current;
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const { accountKey, usage } of entries) {
    const account = current.data.accounts?.find((a) => a.account_key === accountKey);
    if (!account) continue;
    account.last_usage = usage;
    account.last_usage_at = now;
    changed = true;
  }
  if (changed) {
    try {
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify(current.data, null, 2) + "\n");
    } catch (err) {
      return { ok: false, error: `Failed to save registry: ${err.message}` };
    }
  }
  return { ok: true, data: current.data };
}

ipcMain.handle("refresh-account-usage", async (_event, accountKey) => {
  const status = await fetchAccountUsageStatus(accountKey);
  if (!status.ok) {
    const result = { ok: false, expired: status.expired, error: status.error };
    trackResult(CODEX_HOME, "refresh_usage", result, { ...buildRegistrySnapshot(readRegistry()), expired: status.expired === true });
    return result;
  }
  const persisted = persistUsages([{ accountKey, usage: status.usage }]);
  if (!persisted.ok) {
    const result = { ok: false, expired: false, error: persisted.error };
    trackResult(CODEX_HOME, "refresh_usage", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
  const result = { ok: true, expired: false, registry: { ok: true, data: persisted.data } };
  trackResult(CODEX_HOME, "refresh_usage", result, buildRegistrySnapshot(result.registry));
  return result;
});

const CHECK_CONCURRENCY = 4;

// Refreshes usage for every account and returns per-account validity so the
// UI can flag expired sessions.
ipcMain.handle("check-accounts", async () => {
  const current = readRegistry();
  if (!current.ok) {
    const result = { ok: false, error: current.error };
    trackResult(CODEX_HOME, "check_accounts", result);
    return result;
  }

  const targets = (current.data.accounts ?? []).filter((a) => a.auth_mode !== "apikey" && a.auth_mode !== "provider");
  const statuses = {};
  const usages = [];
  const queue = [...targets];

  const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const account = queue.shift();
      const status = await fetchAccountUsageStatus(account.account_key);
      statuses[account.account_key] = {
        ok: status.ok,
        expired: status.expired === true,
        error: status.error ?? null,
      };
      if (status.ok) usages.push({ accountKey: account.account_key, usage: status.usage });
    }
  });
  await Promise.all(workers);

  const persisted = persistUsages(usages);
  const result = {
    ok: true,
    statuses,
    registry: persisted.ok ? { ok: true, data: persisted.data } : readRegistry(),
  };
  const expired_count = Object.values(statuses).filter((status) => status.expired).length;
  trackResult(CODEX_HOME, "check_accounts", result, {
    ...buildRegistrySnapshot(result.registry),
    checked_count: targets.length,
    expired_count,
  });
  return result;
});

let activeLogin = null;

// Native browser OAuth (PKCE) sign-in — no external CLI involved.
ipcMain.handle("login-start", async () => {
  trackTelemetry(CODEX_HOME, "add_account_start", buildRegistrySnapshot(readRegistry()));
  if (activeLogin) {
    const result = { ok: false, error: "A login is already in progress." };
    trackResult(CODEX_HOME, "add_account", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
  let flow;
  try {
    flow = await startBrowserLogin();
  } catch (err) {
    const result = { ok: false, error: err.message };
    trackResult(CODEX_HOME, "add_account", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
  activeLogin = flow;
  shell.openExternal(flow.authUrl);
  const result = await flow.promise;
  activeLogin = null;
  if (result.cancelled) {
    const cancelled = { ok: false, cancelled: true };
    trackResult(CODEX_HOME, "add_account", cancelled, buildRegistrySnapshot(readRegistry()));
    return cancelled;
  }
  if (result.error) {
    const failed = { ok: false, error: result.error };
    trackResult(CODEX_HOME, "add_account", failed, buildRegistrySnapshot(readRegistry()));
    return failed;
  }
  try {
    registryOps.persistChatgptLogin(CODEX_HOME, result.tokens);
  } catch (err) {
    const failed = { ok: false, error: err.message };
    trackResult(CODEX_HOME, "add_account", failed, buildRegistrySnapshot(readRegistry()));
    return failed;
  }
  const added = { ok: true, registry: readRegistry() };
  trackResult(CODEX_HOME, "add_account", added, buildRegistrySnapshot(added.registry));
  return added;
});

const TEST_DEFAULT_MODEL = "gpt-5.5";

// Sends a minimal Responses API request to the endpoint to verify that the
// URL is reachable and the key is accepted.
async function testApiEndpoint({ baseUrl, apiKey, model }) {
  const normalized = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(normalized)) {
    return { ok: false, error: "Enter a full endpoint URL such as https://codex.example.com" };
  }
  if (!apiKey) return { ok: false, error: "Enter the API key first." };

  let response;
  try {
    response = await proxyFetch(`${normalized}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || TEST_DEFAULT_MODEL,
        input: "Reply with the single word: ok",
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const reason = err.name === "TimeoutError" ? "request timed out after 45s" : err.cause?.code || err.message;
    return { ok: false, error: `Cannot reach endpoint: ${reason}` };
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // body is only used for diagnostics
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, error: `Authentication failed (HTTP ${response.status}) — check the API key.` };
  }
  if (response.status === 404) {
    return { ok: false, status: response.status, error: "Endpoint responded with HTTP 404 — check the URL (the /responses path was not found)." };
  }
  if (!response.ok) {
    const snippet = bodyText.replace(/\s+/g, " ").slice(0, 160);
    return { ok: false, status: response.status, error: `Endpoint returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}` };
  }

  let reply = null;
  let respondedModel = null;
  try {
    const body = JSON.parse(bodyText);
    respondedModel = typeof body?.model === "string" ? body.model : null;
    const message = Array.isArray(body?.output) ? body.output.find((o) => o?.type === "message") : null;
    const text = Array.isArray(message?.content) ? message.content.find((c) => c?.type === "output_text") : null;
    if (typeof text?.text === "string") reply = text.text.trim().slice(0, 80);
  } catch {
    // non-JSON 200 responses still count as reachable
  }
  return { ok: true, status: response.status, model: respondedModel, reply };
}

ipcMain.handle("test-api-endpoint", async (_event, opts) => {
  const result = await testApiEndpoint({
    baseUrl: String(opts?.baseUrl ?? "").trim(),
    apiKey: String(opts?.apiKey ?? "").trim(),
    model: String(opts?.model ?? "").trim(),
  });
  trackResult(CODEX_HOME, "test_api_endpoint", result, {
    ...buildRegistrySnapshot(readRegistry()),
    status: result.status ?? null,
  });
  return result;
});

function readStoredProviderTestOptions(accountKey) {
  const current = readRegistry();
  if (!current.ok) return current;

  const normalizedKey = String(accountKey ?? "");
  const account = current.data.accounts?.find((item) => item.account_key === normalizedKey);
  if (!account || account.auth_mode !== "provider" || !account.provider?.base_url) {
    return { ok: false, error: "API provider account not found." };
  }

  const snapshotPath = accountAuthPath(normalizedKey);
  const activePath = path.join(CODEX_HOME, "auth.json");
  const authPaths = current.data.active_account_key === normalizedKey
    ? [snapshotPath, activePath]
    : [snapshotPath];

  let auth = null;
  for (const authPath of authPaths) {
    try {
      auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      break;
    } catch {
      // The active auth file is a safe fallback when a snapshot is missing.
    }
  }

  const apiKey = String(auth?.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    return { ok: false, error: "The stored API key is missing. Add this API provider account again." };
  }

  return {
    ok: true,
    baseUrl: account.provider.base_url,
    apiKey,
    model: String(account.provider.model ?? "").trim(),
  };
}

ipcMain.handle("test-provider-account", async (_event, accountKey) => {
  const options = readStoredProviderTestOptions(accountKey);
  if (!options.ok) {
    trackResult(CODEX_HOME, "test_provider_account", options, buildRegistrySnapshot(readRegistry()));
    return options;
  }
  const result = await testApiEndpoint(options);
  trackResult(CODEX_HOME, "test_provider_account", result, {
    ...buildRegistrySnapshot(readRegistry()),
    status: result.status ?? null,
  });
  return result;
});

// The renderer orchestrates the pre-add endpoint test (via
// "test-api-endpoint") and shows its own confirmation UI, so this handler
// only performs the add itself.
ipcMain.handle("login-api", (_event, opts) => {
  const baseUrl = String(opts?.baseUrl ?? "").trim();
  const apiKey = String(opts?.apiKey ?? "").trim();
  const name = String(opts?.name ?? "").trim();
  const model = String(opts?.model ?? "").trim();
  if (!baseUrl || !apiKey) {
    const result = { ok: false, error: "Endpoint URL and API key are required." };
    trackResult(CODEX_HOME, "add_api", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
  try {
    registryOps.addProviderAccount(CODEX_HOME, { baseUrl, apiKey, name, model });
    const result = { ok: true, registry: readRegistry() };
    trackResult(CODEX_HOME, "add_api", result, buildRegistrySnapshot(result.registry));
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    trackResult(CODEX_HOME, "add_api", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
});

ipcMain.handle("login-cancel", () => {
  if (!activeLogin) return { ok: false };
  activeLogin.cancel();
  return { ok: true };
});

// Confirmation happens in the renderer's themed modal before this is called.
ipcMain.handle("remove-account", (_event, accountKey) => {
  let result;
  try {
    registryOps.removeAccount(CODEX_HOME, String(accountKey ?? ""));
    result = { ok: true, registry: readRegistry() };
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  trackResult(CODEX_HOME, "remove_account", result, buildRegistrySnapshot(result.registry ?? readRegistry()));
  return result;
});

// ---------- account import / export (JSON migration) ----------

function readAccountAuth(accountKey, activeKey) {
  // Prefer the live auth.json for the active account; its snapshot under
  // accounts/ can hold an older, already-rotated refresh token.
  const paths = accountKey === activeKey
    ? [path.join(CODEX_HOME, "auth.json"), accountAuthPath(accountKey)]
    : [accountAuthPath(accountKey)];
  for (const authPath of paths) {
    try {
      return JSON.parse(fs.readFileSync(authPath, "utf8"));
    } catch {
      // fall through to the snapshot
    }
  }
  return null;
}

function normalizeExportAccountKey(opts) {
  if (typeof opts === "string") return opts.trim();
  return String(opts?.accountKey ?? "").trim();
}

function resolveExportTarget(current, opts) {
  const accounts = current.data.accounts ?? [];
  if (accounts.length === 0) return { ok: false, error: "No accounts to export." };

  const accountKey = normalizeExportAccountKey(opts);
  if (!accountKey) {
    return { ok: true, accountKey: null, account: null, scope: "all" };
  }

  const account = accounts.find((item) => item?.account_key === accountKey);
  if (!account) return { ok: false, error: "Account not found." };
  return { ok: true, accountKey, account, scope: "single" };
}

function exportTargetLabel(target) {
  return target.account?.email || target.account?.alias || target.accountKey || "accounts";
}

function exportFileSlug(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "account";
}

function buildTargetExport(current, target) {
  return buildExportPayload(
    current.data,
    (accountKey) => readAccountAuth(accountKey, current.data.active_account_key),
    { accountKey: target.accountKey },
  );
}

ipcMain.handle("export-accounts", async (_event, opts = {}) => {
  const current = readRegistry();
  if (!current.ok) {
    const result = { ok: false, error: current.error };
    trackResult(CODEX_HOME, "export_accounts", result);
    return result;
  }

  const target = resolveExportTarget(current, opts);
  if (!target.ok) {
    const result = { ok: false, error: target.error };
    trackResult(CODEX_HOME, "export_accounts", result, buildRegistrySnapshot(current));
    return result;
  }

  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const basename = target.scope === "single"
    ? `codex-auth-account-${exportFileSlug(exportTargetLabel(target))}-${stamp}.json`
    : `codex-auth-accounts-${stamp}.json`;
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: target.scope === "single" ? "Export account" : "Export accounts",
    defaultPath: path.join(app.getPath("downloads"), basename),
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (picked.canceled || !picked.filePath) {
    const result = { ok: false, cancelled: true };
    trackResult(CODEX_HOME, "export_accounts", result, {
      ...buildRegistrySnapshot(current),
      export_scope: target.scope,
    });
    return result;
  }

  const built = buildTargetExport(current, target);
  if (built.exported === 0) {
    const result = {
      ok: false,
      error: target.scope === "single"
        ? "No usable auth data found for this account."
        : "No accounts had usable auth data to export.",
    };
    trackResult(CODEX_HOME, "export_accounts", result, {
      ...buildRegistrySnapshot(current),
      export_scope: target.scope,
    });
    return result;
  }

  try {
    fs.writeFileSync(picked.filePath, JSON.stringify(built.payload, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    const result = { ok: false, error: `Failed to write export file: ${err.message}` };
    trackResult(CODEX_HOME, "export_accounts", result, {
      ...buildRegistrySnapshot(current),
      export_scope: target.scope,
    });
    return result;
  }
  const result = { ok: true, path: picked.filePath, exported: built.exported, missing: built.missing, scope: target.scope };
  trackResult(CODEX_HOME, "export_accounts", result, {
    ...buildRegistrySnapshot(current),
    export_scope: target.scope,
    exported_count: result.exported,
    missing_count: built.missing.length,
  });
  return result;
});

ipcMain.handle("export-accounts-share", async (_event, opts = {}) => {
  const current = readRegistry();
  if (!current.ok) {
    const result = { ok: false, error: current.error };
    trackResult(CODEX_HOME, "export_accounts_share", result);
    return result;
  }

  const target = resolveExportTarget(current, opts);
  if (!target.ok) {
    const result = { ok: false, error: target.error };
    trackResult(CODEX_HOME, "export_accounts_share", result, buildRegistrySnapshot(current));
    return result;
  }

  const built = buildTargetExport(current, target);
  if (built.exported === 0) {
    const result = {
      ok: false,
      error: target.scope === "single"
        ? "No usable auth data found for this account."
        : "No accounts had usable auth data to export.",
    };
    trackResult(CODEX_HOME, "export_accounts_share", result, {
      ...buildRegistrySnapshot(current),
      export_scope: target.scope,
    });
    return result;
  }

  const shareResult = await uploadShare(
    built.payload,
    {
      note: opts.note,
      ttlDays: opts.ttlDays,
      exportedByApp: "codex-auth-desktop",
      exportedByVersion: app.getVersion(),
    },
    proxyFetch,
  );
  if (!shareResult.ok) {
    trackResult(CODEX_HOME, "export_accounts_share", shareResult, {
      ...buildRegistrySnapshot(current),
      export_scope: target.scope,
    });
    return shareResult;
  }

  const result = {
    ok: true,
    shareUrl: shareResult.shareUrl,
    importUrl: shareResult.importUrl,
    expiresAt: shareResult.expiresAt,
    exported: built.exported,
    missing: built.missing,
    scope: target.scope,
  };
  trackResult(CODEX_HOME, "export_accounts_share", result, {
    ...buildRegistrySnapshot(current),
    export_scope: target.scope,
    exported_count: built.exported,
    missing_count: built.missing.length,
  });
  return result;
});

function importPayloadFromDisk(filePath) {
  try {
    return { ok: true, payload: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (err) {
    return { ok: false, error: `Cannot read the file: ${err.message}` };
  }
}

function finishImportResult(result, source) {
  if (!result.ok) {
    trackResult(CODEX_HOME, source, result, buildRegistrySnapshot(readRegistry()));
    return result;
  }
  const wrapped = { ...result, registry: readRegistry() };
  trackResult(CODEX_HOME, source, wrapped, {
    ...buildRegistrySnapshot(wrapped.registry),
    added_count: result.added,
    updated_count: result.updated,
    skipped_count: result.skipped,
  });
  return wrapped;
}

ipcMain.handle("import-accounts", async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Import accounts",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    const result = { ok: false, cancelled: true };
    trackResult(CODEX_HOME, "import_accounts", result, buildRegistrySnapshot(readRegistry()));
    return result;
  }

  const loaded = importPayloadFromDisk(picked.filePaths[0]);
  if (!loaded.ok) {
    trackResult(CODEX_HOME, "import_accounts", loaded, buildRegistrySnapshot(readRegistry()));
    return loaded;
  }

  return finishImportResult(
    applyImportPayload({
      codexHome: CODEX_HOME,
      payload: loaded.payload,
      readRegistry,
      registryPath: REGISTRY_PATH,
      accountAuthPath,
    }),
    "import_accounts",
  );
});

ipcMain.handle("import-accounts-from-url", async (_event, opts = {}) => {
  const fetched = await fetchShareExport(opts.url, proxyFetch);
  if (!fetched.ok) {
    trackResult(CODEX_HOME, "import_accounts_from_url", fetched, buildRegistrySnapshot(readRegistry()));
    return fetched;
  }

  return finishImportResult(
    applyImportPayload({
      codexHome: CODEX_HOME,
      payload: fetched.payload,
      readRegistry,
      registryPath: REGISTRY_PATH,
      accountAuthPath,
    }),
    "import_accounts_from_url",
  );
});

app.whenReady().then(() => {
  setDockIcon();
  initTelemetry({ codexHome: CODEX_HOME, appVersion: app.getVersion(), locale: app.getLocale() });
  createWindow();
  watchRegistry();
  trackTelemetry(CODEX_HOME, "app_start", buildRegistrySnapshot(readRegistry()));
  flushTelemetry(CODEX_HOME);
  app.on("activate", () => {
    setDockIcon();
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("quit", () => {
  watcher?.close();
  activeLogin?.cancel();
  shutdownTelemetry(CODEX_HOME);
});
