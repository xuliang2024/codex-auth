import { app, BrowserWindow, ipcMain } from "electron";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const REGISTRY_PATH = path.join(CODEX_HOME, "accounts", "registry.json");

// GUI apps on macOS don't inherit the shell PATH, so common install
// locations for the codex-auth binary must be appended manually.
const EXTRA_PATHS = process.platform === "win32"
  ? []
  : ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
const CLI_ENV = {
  ...process.env,
  PATH: [process.env.PATH, ...EXTRA_PATHS].filter(Boolean).join(path.delimiter),
};

// On Windows an npm global install exposes codex-auth as a .cmd shim, which
// execFile/spawn refuse to run without a shell. Resolve the real .exe from
// the platform package next to the shim (or directly on PATH) instead, so
// user-supplied arguments never pass through cmd.exe quoting.
function resolveCliCommand() {
  if (process.platform !== "win32") return "codex-auth";
  const dirs = (CLI_ENV.PATH || "").split(path.delimiter).filter(Boolean);
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  const platformPackage = `codex-auth-win32-${process.arch}`;
  for (const dir of dirs) {
    const exe = path.join(dir, "codex-auth.exe");
    if (fs.existsSync(exe)) return exe;
    if (fs.existsSync(path.join(dir, "codex-auth.cmd"))) {
      const packagedExe = path.join(dir, "node_modules", "@loongphy", platformPackage, "bin", "codex-auth.exe");
      if (fs.existsSync(packagedExe)) return packagedExe;
    }
  }
  // Fall back to the bare name; a failed launch surfaces the install hint.
  return "codex-auth";
}
const CLI_COMMAND = resolveCliCommand();

let mainWindow = null;

function runCli(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(CLI_COMMAND, args, { env: CLI_ENV, timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        error: error ? (error.code === "ENOENT" ? "codex-auth CLI not found. Install with: npm i -g @loongphy/codex-auth" : error.message) : null,
      });
    });
  });
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

ipcMain.handle("switch-account", async (_event, email) => {
  const result = await runCli(["switch", email]);
  if (result.ok) result.registry = readRegistry();
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

let loginChild = null;

ipcMain.handle("login-start", async () => {
  if (loginChild) return { ok: false, error: "A login is already in progress." };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      // `codex-auth login` runs `codex login`, which opens the browser and
      // blocks until the OAuth callback completes or the process is killed.
      child = spawn(CLI_COMMAND, ["login"], { env: CLI_ENV });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
      return;
    }
    loginChild = child;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      loginChild = null;
      resolve({
        ok: false,
        error: err.code === "ENOENT" ? "codex-auth CLI not found. Install with: npm i -g @loongphy/codex-auth" : err.message,
      });
    });
    child.on("exit", (code, signal) => {
      loginChild = null;
      if (signal) {
        resolve({ ok: false, cancelled: true });
        return;
      }
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        error: code === 0 ? null : `login exited with code ${code}`,
        registry: readRegistry(),
      });
    });
  });
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

// The renderer orchestrates the pre-add endpoint test (via
// "test-api-endpoint") and shows its own confirmation UI, so this handler
// only performs the add itself.
ipcMain.handle("login-api", async (_event, opts) => {
  const baseUrl = String(opts?.baseUrl ?? "").trim();
  const apiKey = String(opts?.apiKey ?? "").trim();
  const name = String(opts?.name ?? "").trim();
  const model = String(opts?.model ?? "").trim();
  if (!baseUrl || !apiKey) return { ok: false, error: "Endpoint URL and API key are required." };

  const args = ["login", "--api", "--base-url", baseUrl, "--key", apiKey];
  if (name) args.push("--name", name);
  if (model) args.push("--model", model);
  const result = await runCli(args);
  if (result.ok) result.registry = readRegistry();
  return result;
});

ipcMain.handle("login-cancel", () => {
  if (!loginChild) return { ok: false };
  loginChild.kill("SIGTERM");
  return { ok: true };
});

// Confirmation happens in the renderer's themed modal before this is called.
ipcMain.handle("remove-account", async (_event, email) => {
  const result = await runCli(["remove", email]);
  if (result.ok) result.registry = readRegistry();
  return result;
});

app.whenReady().then(() => {
  createWindow();
  watchRegistry();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("quit", () => {
  watcher?.close();
  loginChild?.kill("SIGTERM");
});
