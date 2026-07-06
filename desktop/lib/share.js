export const SHARE_API_BASE = process.env.CODEX_AUTH_SHARE_API_BASE || "https://codexhub.uk";

const SHARE_PAGE_RE = /\/share\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;
const SHARE_EXPORT_RE = /\/v1\/shares\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/export/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseShareUrl(rawUrl) {
  const text = String(rawUrl ?? "").trim();
  if (!text) return null;

  if (UUID_RE.test(text)) return text.toLowerCase();

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const exportMatch = url.pathname.match(SHARE_EXPORT_RE);
  if (exportMatch) return exportMatch[1].toLowerCase();

  const pageMatch = url.pathname.match(SHARE_PAGE_RE);
  if (pageMatch) return pageMatch[1].toLowerCase();

  return null;
}

export function shareExportUrl(id, base = SHARE_API_BASE) {
  return `${base.replace(/\/+$/, "")}/v1/shares/${id}/export`;
}

export function sharePageUrl(id, base = SHARE_API_BASE) {
  return `${base.replace(/\/+$/, "")}/share/${id}`;
}

export async function uploadShare(exportPayload, opts = {}, fetchFn = fetch) {
  const headers = { "content-type": "application/json" };

  const response = await fetchFn(`${SHARE_API_BASE.replace(/\/+$/, "")}/v1/shares`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      export: exportPayload,
      note: opts.note ?? null,
      ttl_days: opts.ttlDays ?? 7,
      exported_by_app: opts.exportedByApp ?? "codex-auth-desktop",
      exported_by_version: opts.exportedByVersion ?? null,
    }),
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      error: body?.error || `Share upload failed (HTTP ${response.status}).`,
    };
  }

  return {
    ok: true,
    id: body.id,
    shareUrl: body.share_url,
    importUrl: body.import_url,
    expiresAt: body.expires_at,
  };
}

export async function fetchShareExport(rawUrl, fetchFn = fetch) {
  const id = parseShareUrl(rawUrl);
  if (!id) return { ok: false, error: "Invalid share link." };

  const response = await fetchFn(shareExportUrl(id));
  if (response.status === 404) return { ok: false, error: "Share not found." };
  if (response.status === 410) return { ok: false, error: "Share link has expired." };
  if (!response.ok) return { ok: false, error: `Failed to download share (HTTP ${response.status}).` };

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { ok: false, error: `Invalid share payload: ${err.message}` };
  }

  return { ok: true, payload, shareId: id };
}
