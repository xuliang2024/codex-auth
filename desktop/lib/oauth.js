// Browser OAuth (PKCE) login flow against auth.openai.com — a native port of
// what `codex login` does, so the app needs no external CLI. Runs a local
// callback server on the port OpenAI registered for the Codex client (1455).
import crypto from "node:crypto";
import http from "node:http";
import { proxyFetch } from "./net-fetch.js";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PORT = 1455;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Accounts for Codex</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0d1017; color: #e6e9ef;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { text-align: center; }
  .check { font-size: 42px; color: #4ade80; }
  p { color: #9aa3b2; }
</style></head>
<body><div class="card"><div class="check">&#10003;</div>
<h2>Sign-in complete</h2><p>You can close this tab and return to Accounts for Codex.</p>
</div></body></html>`;

function b64url(buffer) {
  return buffer.toString("base64url");
}

function htmlResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function formatOAuthErrorDetail(body) {
  if (!body) return "";
  if (typeof body === "string") return body.trim();
  if (typeof body !== "object") return String(body);
  if (typeof body.error_description === "string" && body.error_description.trim()) {
    return body.error_description.trim();
  }
  if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
  if (body.error && typeof body.error === "object") {
    const nested = body.error.message || body.error.code || body.error.type;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    try {
      return JSON.stringify(body.error);
    } catch {
      return "[object Object]";
    }
  }
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function tokenExchangeHint(response) {
  if (response.headers.get("cf-mitigated") === "challenge") {
    return " Cloudflare blocked the token request. Check VPN/proxy settings for auth.openai.com.";
  }
  if (response.status === 403) {
    return " The app could not reach auth.openai.com through your network proxy. Ensure system proxy settings allow this domain.";
  }
  return "";
}

// Asks a previous login server (ours or the codex CLI's) to shut down so the
// port frees up, mirroring codex's /cancel retry behavior.
function requestCancelOnPort() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/cancel", timeout: 2000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function listenWithRetry(server) {
  return new Promise((resolve, reject) => {
    let retried = false;
    const tryListen = () => {
      server.once("error", async (err) => {
        if (err.code === "EADDRINUSE" && !retried) {
          retried = true;
          await requestCancelOnPort();
          setTimeout(tryListen, 300);
          return;
        }
        reject(err.code === "EADDRINUSE"
          ? new Error(`Port ${PORT} is in use by another login flow. Close it and try again.`)
          : err);
      });
      server.listen(PORT, "127.0.0.1", () => {
        server.removeAllListeners("error");
        resolve();
      });
    };
    tryListen();
  });
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await proxyFetch(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err.name === "AbortError"
      ? "Token exchange timed out after 30 seconds."
      : `Token exchange transport failed: ${err.message}`;
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = formatOAuthErrorDetail(await response.json());
    } catch {
      try {
        detail = (await response.text()).trim().slice(0, 240);
      } catch {
        // body is only used for diagnostics
      }
    }
    const hint = tokenExchangeHint(response);
    throw new Error(`Token exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}${hint}`);
  }
  const body = await response.json();
  if (!body.id_token || !body.access_token) {
    throw new Error("Token exchange response was missing tokens.");
  }
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? "",
  };
}

/// Starts the login flow. Returns { authUrl, cancel, promise }.
/// The promise resolves with { cancelled: true } or { tokens }.
export async function startBrowserLogin() {
  const codeVerifier = b64url(crypto.randomBytes(64));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(32));

  const authUrl = `${ISSUER}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  }).toString()}`;

  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  let callbackInFlight = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/auth/callback") {
      if (callbackInFlight) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        htmlResponse(res, 400, "<h2>State mismatch</h2><p>Restart the sign-in from Accounts for Codex.</p>");
        finish({ error: "Login callback state mismatch — try again." });
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        const desc = url.searchParams.get("error_description") || url.searchParams.get("error") || "missing authorization code";
        htmlResponse(res, 400, `<h2>Sign-in failed</h2><p>${desc}</p>`);
        finish({ error: `Sign-in failed: ${desc}` });
        return;
      }
      callbackInFlight = true;
      try {
        const tokens = await exchangeCodeForTokens(code, codeVerifier);
        res.writeHead(302, { Location: `http://localhost:${PORT}/success` });
        res.end();
        finish({ tokens });
      } catch (err) {
        htmlResponse(res, 500, `<h2>Sign-in failed</h2><p>${err.message}</p>`);
        finish({ error: err.message });
      } finally {
        callbackInFlight = false;
      }
    } else if (url.pathname === "/success") {
      htmlResponse(res, 200, SUCCESS_HTML);
    } else if (url.pathname === "/cancel") {
      res.writeHead(200);
      res.end("Login cancelled");
      finish({ cancelled: true });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  let finished = false;
  let timeoutTimer = null;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    // Keep the server alive briefly so the /success page can still be served.
    setTimeout(() => server.close(), result.tokens ? 5000 : 100).unref?.();
    settle(result);
  };

  await listenWithRetry(server);
  timeoutTimer = setTimeout(() => finish({ error: "Sign-in timed out after 10 minutes." }), LOGIN_TIMEOUT_MS);

  return {
    authUrl,
    cancel: () => finish({ cancelled: true }),
    promise,
  };
}
