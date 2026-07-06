const EXPORT_FILE_TYPE = "codex-auth-accounts";
const EXPORT_FILE_VERSION = 1;
const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 30;
const MAX_NOTE_LENGTH = 200;
const SHARE_STYLESHEET_HREF = "/styles.css?v=share-ui-20260706-link-import";
const SHARE_IMPORT_IMAGE_SRC = "/assets/import-share-link.png?v=20260706";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

function textResponse(message, status = 400) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactString(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function isValidUuid(id) {
  return UUID_RE.test(String(id ?? ""));
}

function maskEmail(email) {
  const text = compactString(email, 320);
  const at = text.indexOf("@");
  if (at <= 0) return "***";
  return `${text.slice(0, 1)}***${text.slice(at)}`;
}

function normalizeTtlDays(raw, fallback = DEFAULT_TTL_DAYS) {
  const numeric = Number(raw ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(MAX_TTL_DAYS, Math.trunc(numeric)));
}

function sharePrefix(id) {
  return `shares/${id}`;
}

function expiresAtFromDays(ttlDays) {
  return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) <= Date.now();
}

function validateExportPayload(exportPayload) {
  if (!isObject(exportPayload)) throw new Error("export must be an object");
  if (exportPayload.type !== EXPORT_FILE_TYPE) throw new Error("export type is invalid");
  if (typeof exportPayload.version === "number" && exportPayload.version > EXPORT_FILE_VERSION) {
    throw new Error("export version is too new");
  }
  const accounts = exportPayload.registry?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("export contains no accounts");
  const auths = exportPayload.auths;
  if (!isObject(auths)) throw new Error("export auths must be an object");

  let usable = 0;
  for (const account of accounts) {
    if (!account || typeof account.account_key !== "string" || account.account_key.length === 0) continue;
    const auth = auths[account.account_key];
    if (auth && typeof auth === "object") usable += 1;
  }
  if (usable === 0) throw new Error("export contains no usable auth data");
}

function buildAccountsPreview(exportPayload) {
  return (exportPayload.registry?.accounts ?? [])
    .filter((account) => account && typeof account.account_key === "string")
    .map((account) => ({
      email_masked: maskEmail(account.email),
      alias: compactString(account.alias, 80) || null,
      plan: compactString(account.plan, 40) || null,
      auth_mode: compactString(account.auth_mode, 32) || null,
    }));
}

function buildShareMeta(id, exportPayload, { note, ttlDays, exportedByApp, exportedByVersion }) {
  return {
    id,
    created_at: new Date().toISOString(),
    expires_at: expiresAtFromDays(ttlDays),
    export_version: EXPORT_FILE_VERSION,
    account_count: buildAccountsPreview(exportPayload).length,
    accounts_preview: buildAccountsPreview(exportPayload),
    note: compactString(note, MAX_NOTE_LENGTH) || null,
    password_protected: false,
    exported_by_app: compactString(exportedByApp, 64) || null,
    exported_by_version: compactString(exportedByVersion, 32) || null,
  };
}

function enrichExportPayload(exportPayload, id, note) {
  return {
    ...exportPayload,
    share: {
      id,
      note: compactString(note, MAX_NOTE_LENGTH) || null,
      created_at: new Date().toISOString(),
    },
  };
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > maxBytes) throw new Error("request body is too large");

  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error("request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function publicOrigin(request) {
  const url = new URL(request.url);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function parseShareIdFromPath(pathname) {
  const pageMatch = pathname.match(/^\/share\/([^/]+)\/?$/);
  if (pageMatch) return pageMatch[1];

  const exportMatch = pathname.match(/^\/v1\/shares\/([^/]+)\/export\/?$/);
  if (exportMatch) return exportMatch[1];

  return null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function renderSharePage(meta, origin) {
  const importUrl = `${origin}/v1/shares/${meta.id}/export`;
  const accountCount = escapeHtml(String(meta.account_count));
  const createdAt = escapeHtml(formatDateTime(meta.created_at));
  const expiresAt = escapeHtml(formatDateTime(meta.expires_at));
  const noteBlock = meta.note
    ? `<div class="share-note">
          <span>分享备注</span>
          <p>${escapeHtml(meta.note)}</p>
        </div>`
    : "";
  const rows = (meta.accounts_preview ?? [])
    .map(
      (account) => `
        <tr>
          <td data-label="邮箱"><span class="share-email">${escapeHtml(account.email_masked)}</span></td>
          <td data-label="别名">${escapeHtml(account.alias || "—")}</td>
          <td data-label="套餐"><span class="share-chip">${escapeHtml(account.plan || "—")}</span></td>
          <td data-label="类型"><span class="share-chip share-chip-soft">${escapeHtml(account.auth_mode || "—")}</span></td>
        </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Codex 账号配置分享 | Codex Hub</title>
    <meta name="description" content="通过 Codex 账号管家导入分享的账号配置。">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="${SHARE_STYLESHEET_HREF}">
  </head>
  <body class="share-body">
    <header class="site-header" aria-label="主导航">
      <a class="brand" href="/" aria-label="Codex 账号管家首页">
        <img class="brand-icon" src="/favicon.svg" width="48" height="48" alt="" aria-hidden="true">
        <span>Codex 账号管家</span>
      </a>
      <nav class="nav-links" aria-label="站点链接">
        <a href="/#downloads">下载客户端</a>
        <a href="/">首页</a>
      </nav>
    </header>

    <main class="share-page share-shell">
      <section class="share-hero" aria-labelledby="share-title">
        <div class="share-hero-copy">
          <p class="eyebrow">配置分享</p>
          <h1 id="share-title">
            <span>账号配置</span>
            <span>已准备好导入</span>
          </h1>
          <p class="hero-lede">
            <span>该分享包含 ${accountCount} 个账号。</span>
            <span>完整凭证只会通过客户端导入接口获取。</span>
          </p>
          ${noteBlock}
        </div>

        <aside class="share-import-card" aria-label="分享状态">
          <div class="share-card-top">
            <img class="share-card-icon" src="/favicon.svg" width="44" height="44" alt="" aria-hidden="true">
            <div>
              <span class="card-kicker">Share ready</span>
              <strong>可导入配置</strong>
            </div>
          </div>
          <div class="share-count">
            <span>${accountCount}</span>
            <p>个账号摘要</p>
          </div>
          <div class="share-date-stack">
            <div>
              <span>创建时间</span>
              <strong>${createdAt}</strong>
            </div>
            <div>
              <span>失效时间</span>
              <strong>${expiresAt}</strong>
            </div>
          </div>
        </aside>
      </section>

      <div class="share-main-grid">
        <section class="share-panel share-summary-panel" aria-labelledby="share-summary-title">
          <div class="share-panel-heading">
            <div>
              <p class="eyebrow">账号摘要</p>
              <h2 id="share-summary-title">即将导入的账号</h2>
            </div>
            <span class="share-panel-badge">${accountCount} 个账号</span>
          </div>
          <p class="share-panel-copy">邮箱已打码显示。完整凭证仅可通过客户端获取，网页不会展示 token 或会话数据。</p>
          <div class="share-table-wrap">
            <table class="share-table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>别名</th>
                  <th>套餐</th>
                  <th>类型</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <p class="share-meta">创建于 ${createdAt} · 过期于 ${expiresAt}</p>
        </section>

        <aside class="share-panel share-actions-panel" aria-labelledby="share-actions-title">
          <p class="eyebrow">下一步</p>
          <h2 id="share-actions-title">在客户端中导入</h2>
          <div class="hero-actions">
            <a class="button button-primary" href="/#downloads" data-primary-download>下载桌面客户端</a>
            <button type="button" class="button button-secondary" id="copy-import-link">复制导入链接</button>
          </div>
          <div class="share-import-guide" aria-label="客户端导入步骤">
            <ol>
              <li>复制本页导入链接。</li>
              <li>打开客户端，选择「导入分享链接」，粘贴后点击「导入」。</li>
            </ol>
            <a class="share-import-shot" href="${SHARE_IMPORT_IMAGE_SRC}" aria-label="查看客户端链接导入示意图">
              <img src="${SHARE_IMPORT_IMAGE_SRC}" width="1280" height="772" alt="Codex 账号管家客户端中从分享链接导入的弹窗截图" loading="lazy">
            </a>
          </div>
          <div class="share-warning">
            <strong>请谨慎保管此链接</strong>
            <p>
              它包含可导入的账号凭证，到期后会自动失效。导入后建议在 OpenAI 账户设置中检查活跃会话。
            </p>
          </div>
        </aside>
      </div>
    </main>

    <footer class="site-footer">
      <p>Codex Hub · 配置分享</p>
    </footer>
    <script src="/downloads.js" defer></script>
    <script>
      (() => {
        const importUrl = ${JSON.stringify(importUrl)};
        const button = document.getElementById("copy-import-link");
        button?.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(importUrl);
            button.textContent = "已复制";
            setTimeout(() => { button.textContent = "复制导入链接"; }, 1800);
          } catch {
            window.prompt("复制此导入链接：", importUrl);
          }
        });
      })();
    </script>
  </body>
</html>`;
}

async function readShareMeta(bucket, id) {
  const object = await bucket.get(`${sharePrefix(id)}/meta.json`);
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
}

async function handleCreateShare(request, env) {
  if (!env.SITE_BUCKET) {
    return jsonResponse({ ok: false, error: "share storage is not configured" }, 500);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message }, 400);
  }

  try {
    validateExportPayload(body.export);
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message }, 400);
  }

  const id = crypto.randomUUID();
  const ttlDays = normalizeTtlDays(body.ttl_days, normalizeTtlDays(env.SHARE_DEFAULT_TTL_DAYS, DEFAULT_TTL_DAYS));
  const meta = buildShareMeta(id, body.export, {
    note: body.note,
    ttlDays,
    exportedByApp: body.exported_by_app,
    exportedByVersion: body.exported_by_version,
  });
  const exportPayload = enrichExportPayload(body.export, id, body.note);

  await env.SITE_BUCKET.put(`${sharePrefix(id)}/meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { expires_at: meta.expires_at },
  });
  await env.SITE_BUCKET.put(`${sharePrefix(id)}/export.json`, JSON.stringify(exportPayload), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { expires_at: meta.expires_at },
  });

  const origin = publicOrigin(request);
  return jsonResponse({
    ok: true,
    id,
    share_url: `${origin}/share/${id}`,
    import_url: `${origin}/v1/shares/${id}/export`,
    expires_at: meta.expires_at,
  }, 201);
}

async function handleShareExport(request, env, id) {
  if (!isValidUuid(id)) return jsonResponse({ ok: false, error: "invalid share id" }, 400);
  if (!env.SITE_BUCKET) return jsonResponse({ ok: false, error: "share storage is not configured" }, 500);

  const meta = await readShareMeta(env.SITE_BUCKET, id);
  if (!meta) return jsonResponse({ ok: false, error: "share not found" }, 404);
  if (isExpired(meta.expires_at)) return jsonResponse({ ok: false, error: "share expired" }, 410);

  const object = await env.SITE_BUCKET.get(`${sharePrefix(id)}/export.json`);
  if (!object) return jsonResponse({ ok: false, error: "share export missing" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(object.body, { headers });
}

async function handleSharePage(request, env, id) {
  if (!isValidUuid(id)) return htmlResponse(renderNotFoundPage(), 404);
  if (!env.SITE_BUCKET) return textResponse("share storage is not configured", 500);

  const meta = await readShareMeta(env.SITE_BUCKET, id);
  if (!meta) return htmlResponse(renderNotFoundPage(), 404);
  if (isExpired(meta.expires_at)) return htmlResponse(renderExpiredPage(meta), 410);

  return htmlResponse(renderSharePage(meta, publicOrigin(request)));
}

function renderNotFoundPage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>分享不存在 | Codex Hub</title>
    <link rel="stylesheet" href="${SHARE_STYLESHEET_HREF}">
  </head>
  <body class="share-body">
    <main class="share-page share-status-page">
      <h1>分享不存在</h1>
      <p>该链接无效，或分享已被删除。</p>
      <a class="button button-primary" href="/">返回首页</a>
    </main>
  </body>
</html>`;
}

function renderExpiredPage(meta) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>分享已过期 | Codex Hub</title>
    <link rel="stylesheet" href="${SHARE_STYLESHEET_HREF}">
  </head>
  <body class="share-body">
    <main class="share-page share-status-page">
      <h1>分享已过期</h1>
      <p>此分享链接已于 ${escapeHtml(formatDateTime(meta.expires_at))} 过期。请联系分享方重新导出。</p>
      <a class="button button-primary" href="/#downloads">下载客户端</a>
    </main>
  </body>
</html>`;
}

export async function handleShareRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/v1/shares" && request.method === "POST") {
    return handleCreateShare(request, env);
  }

  if (pathname === "/v1/shares" && request.method !== "POST") {
    return textResponse("Method not allowed", 405);
  }

  const id = parseShareIdFromPath(pathname);
  if (!id) return null;

  if (pathname.startsWith("/v1/shares/") && pathname.endsWith("/export")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method not allowed", 405);
    }
    return handleShareExport(request, env, id);
  }

  if (pathname.startsWith("/share/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method not allowed", 405);
    }
    return handleSharePage(request, env, id);
  }

  return null;
}

export const internals = {
  EXPORT_FILE_TYPE,
  EXPORT_FILE_VERSION,
  MAX_BODY_BYTES,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  buildAccountsPreview,
  buildShareMeta,
  enrichExportPayload,
  escapeHtml,
  expiresAtFromDays,
  isExpired,
  isValidUuid,
  maskEmail,
  normalizeTtlDays,
  parseShareIdFromPath,
  renderSharePage,
  sharePrefix,
  validateExportPayload,
};
