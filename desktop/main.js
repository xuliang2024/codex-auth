import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as registryOps from "./lib/registry.js";
import { startBrowserLogin } from "./lib/oauth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ICON_PATH = path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
const DOCK_ICON_PATH = path.join(__dirname, "build", "icon.png");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const REGISTRY_PATH = path.join(CODEX_HOME, "accounts", "registry.json");

let mainWindow = null;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 620,
    minHeight: 480,
    title: "Codex Auth",
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
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("get-registry", () => readRegistry());
ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("switch-account", (_event, accountKey) => {
  try {
    registryOps.switchAccount(CODEX_HOME, String(accountKey ?? ""));
    return { ok: true, registry: readRegistry() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    response = await fetch(TOKEN_ENDPOINT, {
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
  return fetch(USAGE_ENDPOINT, {
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
  if (!status.ok) return { ok: false, expired: status.expired, error: status.error };
  const persisted = persistUsages([{ accountKey, usage: status.usage }]);
  if (!persisted.ok) return { ok: false, expired: false, error: persisted.error };
  return { ok: true, expired: false, registry: { ok: true, data: persisted.data } };
});

const CHECK_CONCURRENCY = 4;

// Refreshes usage for every account and returns per-account validity so the
// UI can flag expired sessions.
ipcMain.handle("check-accounts", async () => {
  const current = readRegistry();
  if (!current.ok) return { ok: false, error: current.error };

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
  return {
    ok: true,
    statuses,
    registry: persisted.ok ? { ok: true, data: persisted.data } : readRegistry(),
  };
});

let activeLogin = null;

// Native browser OAuth (PKCE) sign-in — no external CLI involved.
ipcMain.handle("login-start", async () => {
  if (activeLogin) return { ok: false, error: "A login is already in progress." };
  let flow;
  try {
    flow = await startBrowserLogin();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  activeLogin = flow;
  shell.openExternal(flow.authUrl);
  const result = await flow.promise;
  activeLogin = null;
  if (result.cancelled) return { ok: false, cancelled: true };
  if (result.error) return { ok: false, error: result.error };
  try {
    registryOps.persistChatgptLogin(CODEX_HOME, result.tokens);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, registry: readRegistry() };
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
    response = await fetch(`${normalized}/responses`, {
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

ipcMain.handle("test-api-endpoint", (_event, opts) =>
  testApiEndpoint({
    baseUrl: String(opts?.baseUrl ?? "").trim(),
    apiKey: String(opts?.apiKey ?? "").trim(),
    model: String(opts?.model ?? "").trim(),
  }));

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
  if (!options.ok) return options;
  return testApiEndpoint(options);
});

// The renderer orchestrates the pre-add endpoint test (via
// "test-api-endpoint") and shows its own confirmation UI, so this handler
// only performs the add itself.
ipcMain.handle("login-api", (_event, opts) => {
  const baseUrl = String(opts?.baseUrl ?? "").trim();
  const apiKey = String(opts?.apiKey ?? "").trim();
  const name = String(opts?.name ?? "").trim();
  const model = String(opts?.model ?? "").trim();
  if (!baseUrl || !apiKey) return { ok: false, error: "Endpoint URL and API key are required." };
  try {
    registryOps.addProviderAccount(CODEX_HOME, { baseUrl, apiKey, name, model });
    return { ok: true, registry: readRegistry() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("login-cancel", () => {
  if (!activeLogin) return { ok: false };
  activeLogin.cancel();
  return { ok: true };
});

// Confirmation happens in the renderer's themed modal before this is called.
ipcMain.handle("remove-account", (_event, accountKey) => {
  try {
    registryOps.removeAccount(CODEX_HOME, String(accountKey ?? ""));
    return { ok: true, registry: readRegistry() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- account import / export (JSON migration) ----------

const EXPORT_FILE_TYPE = "codex-auth-accounts";
const EXPORT_FILE_VERSION = 1;

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

ipcMain.handle("export-accounts", async () => {
  const current = readRegistry();
  if (!current.ok) return { ok: false, error: current.error };
  const accounts = current.data.accounts ?? [];
  if (accounts.length === 0) return { ok: false, error: "No accounts to export." };

  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: "Export accounts",
    defaultPath: path.join(app.getPath("downloads"), `codex-auth-accounts-${stamp}.json`),
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };

  const auths = {};
  const missing = [];
  for (const account of accounts) {
    const auth = readAccountAuth(account.account_key, current.data.active_account_key);
    if (auth) auths[account.account_key] = auth;
    else missing.push(account.email || account.account_key);
  }

  const payload = {
    type: EXPORT_FILE_TYPE,
    version: EXPORT_FILE_VERSION,
    exported_at: new Date().toISOString(),
    registry: current.data,
    auths,
  };
  try {
    fs.writeFileSync(picked.filePath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `Failed to write export file: ${err.message}` };
  }
  return { ok: true, path: picked.filePath, exported: Object.keys(auths).length, missing };
});

ipcMain.handle("import-accounts", async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Import accounts",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(picked.filePaths[0], "utf8"));
  } catch (err) {
    return { ok: false, error: `Cannot read the file: ${err.message}` };
  }
  if (payload?.type !== EXPORT_FILE_TYPE || !Array.isArray(payload?.registry?.accounts)) {
    return { ok: false, error: "This file is not a codex-auth account export." };
  }
  if (typeof payload.version === "number" && payload.version > EXPORT_FILE_VERSION) {
    return { ok: false, error: "This export was created by a newer app version." };
  }

  const incoming = payload.registry.accounts.filter(
    (a) => a && typeof a.account_key === "string" && a.account_key.length > 0,
  );
  if (incoming.length === 0) return { ok: false, error: "The export file contains no accounts." };

  const accountsDir = path.join(CODEX_HOME, "accounts");
  try {
    fs.mkdirSync(accountsDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Cannot create ${accountsDir}: ${err.message}` };
  }

  // Merge into the existing registry (imported entries win on conflicts).
  // When no registry exists yet, start from the imported one but leave no
  // account active — switching runs through the CLI, which also writes the
  // live auth.json.
  const current = readRegistry();
  const base = current.ok
    ? current.data
    : { ...payload.registry, active_account_key: null, previous_active_account_key: null, accounts: [] };
  const existing = base.accounts ?? [];

  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const account of incoming) {
    const auth = payload.auths?.[account.account_key];
    if (!auth || typeof auth !== "object") {
      skipped += 1;
      continue;
    }
    try {
      const serialized = JSON.stringify(auth, null, 2) + "\n";
      fs.writeFileSync(accountAuthPath(account.account_key), serialized, { mode: 0o600 });
      // Keep the live auth.json in sync when the imported account is the
      // one codex is currently using.
      if (account.account_key === base.active_account_key) {
        fs.writeFileSync(path.join(CODEX_HOME, "auth.json"), serialized, { mode: 0o600 });
      }
    } catch (err) {
      return { ok: false, error: `Failed to write auth for ${account.email || account.account_key}: ${err.message}` };
    }
    const index = existing.findIndex((a) => a.account_key === account.account_key);
    if (index >= 0) {
      existing[index] = account;
      updated += 1;
    } else {
      existing.push(account);
      added += 1;
    }
  }
  if (added === 0 && updated === 0) {
    return { ok: false, error: "No account in the file had usable auth data." };
  }

  base.accounts = existing;
  try {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(base, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `Failed to save registry: ${err.message}` };
  }
  return { ok: true, added, updated, skipped, registry: readRegistry() };
});

app.whenReady().then(() => {
  setDockIcon();
  createWindow();
  watchRegistry();
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
});
