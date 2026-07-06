const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_PROPERTIES_BYTES = 4096;
const MAX_STRING_VALUE_LENGTH = 256;
const MAX_ANNOUNCEMENTS = 10;
const ANNOUNCEMENT_TTL_SECONDS = 300;
const MAX_ANNOUNCEMENT_TITLE_LENGTH = 80;
const MAX_ANNOUNCEMENT_BODY_LENGTH = 260;
const MAX_ANNOUNCEMENT_URL_LENGTH = 2048;

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const SENSITIVE_KEY_PATTERN = /(^|[_-])(email|secret|password|token|api[_-]?key|access[_-]?token|refresh[_-]?token|account[_-]?key|account[_-]?id|path|url|endpoint)([_-]|$)/i;
const EMAIL_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const URL_VALUE_PATTERN = /\bhttps?:\/\/\S+/i;
const TOKEN_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/i;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function textResponse(message, status = 400, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": "content-type, x-telemetry-token, x-announcement-token",
    "access-control-max-age": "86400",
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactString(value, maxLength = MAX_STRING_VALUE_LENGTH) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function compactTarget(value, fallback = "all") {
  const text = compactString(value, 32).toLowerCase();
  if (!text) return fallback;
  return text.replace(/[^a-z0-9_.:-]/g, "_").slice(0, 32) || fallback;
}

function validateIdentifier(value, field, maxLength = 80) {
  const text = compactString(value, maxLength);
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function looksSensitiveString(value) {
  return EMAIL_VALUE_PATTERN.test(value) || URL_VALUE_PATTERN.test(value) || TOKEN_VALUE_PATTERN.test(value);
}

function sanitizeProperties(value, path = []) {
  if (value == null) return null;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item, index) => sanitizeProperties(item, path.concat(String(index))));
  }

  if (isObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw new Error(`properties contains sensitive key ${path.concat(key).join(".")}`);
      }
      out[compactString(key, 80)] = sanitizeProperties(entry, path.concat(key));
    }
    return out;
  }

  if (typeof value === "string") {
    if (looksSensitiveString(value)) {
      throw new Error(`properties contains sensitive string at ${path.join(".") || "root"}`);
    }
    return compactString(value);
  }

  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return null;
}

function validateEvent(raw) {
  if (!isObject(raw)) throw new Error("event must be an object");
  const name = validateIdentifier(raw.name, "event.name", 80);
  const time = typeof raw.time === "number" && Number.isFinite(raw.time) ? Math.trunc(raw.time) : null;
  const properties = sanitizeProperties(isObject(raw.properties) ? raw.properties : {});
  const propertiesJson = JSON.stringify(properties);
  if (new TextEncoder().encode(propertiesJson).length > MAX_PROPERTIES_BYTES) {
    throw new Error("event properties are too large");
  }
  return { name, time, propertiesJson };
}

function validatePayload(raw) {
  if (!isObject(raw)) throw new Error("payload must be an object");
  if (!Array.isArray(raw.events) || raw.events.length === 0) throw new Error("events must be a non-empty array");
  if (raw.events.length > MAX_EVENTS_PER_REQUEST) throw new Error(`events cannot contain more than ${MAX_EVENTS_PER_REQUEST} items`);

  return {
    installId: validateIdentifier(raw.install_id, "install_id", 80),
    app: validateIdentifier(raw.app || "codex-auth-desktop", "app", 64),
    appVersion: compactString(raw.app_version, 32) || null,
    platform: compactString(raw.platform, 32) || null,
    locale: compactString(raw.locale, 16) || null,
    events: raw.events.map(validateEvent),
  };
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) throw new Error("request body is too large");

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Error("request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function isAuthorized(request, env) {
  const token = env.TELEMETRY_INGEST_TOKEN;
  if (!token) return true;
  return request.headers.get("x-telemetry-token") === token;
}

function isAnnouncementAdminAuthorized(request, env) {
  const token = env.ANNOUNCEMENT_ADMIN_TOKEN || env.TELEMETRY_INGEST_TOKEN;
  if (!token) return false;
  return request.headers.get("x-announcement-token") === token || request.headers.get("x-telemetry-token") === token;
}

async function persistEvents(env, payload, receivedAt) {
  const installStmt = env.TELEMETRY_DB.prepare(`
    INSERT INTO telemetry_installs (
      install_id, app, app_version, platform, locale, first_seen_at, last_seen_at, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(install_id) DO UPDATE SET
      app = excluded.app,
      app_version = excluded.app_version,
      platform = excluded.platform,
      locale = excluded.locale,
      last_seen_at = excluded.last_seen_at,
      event_count = telemetry_installs.event_count + excluded.event_count
  `).bind(
    payload.installId,
    payload.app,
    payload.appVersion,
    payload.platform,
    payload.locale,
    receivedAt,
    receivedAt,
    payload.events.length,
  );

  const eventStmts = payload.events.map((event) =>
    env.TELEMETRY_DB.prepare(`
      INSERT INTO telemetry_events (
        install_id, app, app_version, platform, locale, event_name, event_time, received_at, properties_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      payload.installId,
      payload.app,
      payload.appVersion,
      payload.platform,
      payload.locale,
      event.name,
      event.time,
      receivedAt,
      event.propertiesJson,
    ));

  await env.TELEMETRY_DB.batch([installStmt, ...eventStmts]);
}

async function handleTelemetry(request, env) {
  if (!env.TELEMETRY_DB) return jsonResponse({ ok: false, error: "telemetry database is not configured" }, 500);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  let payload;
  try {
    payload = validatePayload(await readJsonBody(request));
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message }, 400);
  }

  const receivedAt = new Date().toISOString();
  await persistEvents(env, payload, receivedAt);
  return jsonResponse({ ok: true, accepted: payload.events.length });
}

async function queryFirst(env, sql, params = []) {
  const result = await env.TELEMETRY_DB.prepare(sql).bind(...params).first();
  return result ?? {};
}

async function queryAll(env, sql, params = []) {
  const result = await env.TELEMETRY_DB.prepare(sql).bind(...params).all();
  return Array.isArray(result?.results) ? result.results : [];
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function handleTelemetrySummary(_request, env) {
  if (!env.TELEMETRY_DB) return jsonResponse({ ok: false, error: "telemetry database is not configured" }, 500);

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const last14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [
    installTotals,
    eventTotals,
    events24h,
    eventsByName,
    installsByVersion,
    eventsByDay,
    recentEvents,
    latestSnapshot,
  ] = await Promise.all([
    queryFirst(env, "SELECT COUNT(*) AS total_installs, MAX(last_seen_at) AS last_seen_at FROM telemetry_installs"),
    queryFirst(env, "SELECT COUNT(*) AS total_events, MAX(received_at) AS last_event_at FROM telemetry_events"),
    queryFirst(env, "SELECT COUNT(*) AS events_24h FROM telemetry_events WHERE received_at >= ?", [last24h]),
    queryAll(env, `
      SELECT event_name, COUNT(*) AS count
      FROM telemetry_events
      GROUP BY event_name
      ORDER BY count DESC, event_name ASC
      LIMIT 20
    `),
    queryAll(env, `
      SELECT COALESCE(app_version, 'unknown') AS app_version, COUNT(*) AS count
      FROM telemetry_installs
      GROUP BY COALESCE(app_version, 'unknown')
      ORDER BY count DESC, app_version ASC
      LIMIT 20
    `),
    queryAll(env, `
      SELECT substr(received_at, 1, 10) AS day, COUNT(*) AS count
      FROM telemetry_events
      WHERE received_at >= ?
      GROUP BY substr(received_at, 1, 10)
      ORDER BY day ASC
    `, [last14d]),
    queryAll(env, `
      SELECT event_name, app_version, platform, locale, received_at, properties_json
      FROM telemetry_events
      ORDER BY id DESC
      LIMIT 20
    `),
    queryFirst(env, `
      SELECT app_version, platform, locale, received_at, properties_json
      FROM telemetry_events
      WHERE event_name = 'app_start'
      ORDER BY id DESC
      LIMIT 1
    `),
  ]);

  return jsonResponse({
    ok: true,
    generated_at: now.toISOString(),
    totals: {
      installs: Number(installTotals.total_installs ?? 0),
      events: Number(eventTotals.total_events ?? 0),
      events_24h: Number(events24h.events_24h ?? 0),
      last_seen_at: installTotals.last_seen_at ?? null,
      last_event_at: eventTotals.last_event_at ?? null,
    },
    events_by_name: eventsByName.map((row) => ({
      event_name: String(row.event_name ?? "unknown"),
      count: Number(row.count ?? 0),
    })),
    installs_by_version: installsByVersion.map((row) => ({
      app_version: String(row.app_version ?? "unknown"),
      count: Number(row.count ?? 0),
    })),
    events_by_day: eventsByDay.map((row) => ({
      day: String(row.day ?? ""),
      count: Number(row.count ?? 0),
    })).filter((row) => row.day),
    latest_account_snapshot: latestSnapshot?.received_at
      ? {
          app_version: latestSnapshot.app_version ?? null,
          platform: latestSnapshot.platform ?? null,
          locale: latestSnapshot.locale ?? null,
          received_at: latestSnapshot.received_at,
          properties: safeJsonObject(latestSnapshot.properties_json),
        }
      : null,
    recent_events: recentEvents.map((row) => ({
      event_name: String(row.event_name ?? "unknown"),
      app_version: row.app_version ?? null,
      platform: row.platform ?? null,
      locale: row.locale ?? null,
      received_at: row.received_at ?? null,
      properties: safeJsonObject(row.properties_json),
    })),
  });
}

function parseVersion(value) {
  const base = compactString(value, 32).replace(/^v/i, "").split("-", 1)[0];
  if (!base) return null;
  const parts = base.split(".").map((part) => {
    if (!/^\d+$/.test(part)) return null;
    return Number(part);
  });
  if (parts.some((part) => part === null)) return null;
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    const diff = a[index] - b[index];
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionMatches(row, clientVersion) {
  const client = parseVersion(clientVersion);
  const minVersion = parseVersion(row.min_version);
  const maxVersion = parseVersion(row.max_version);
  if ((minVersion || maxVersion) && !client) return false;
  if (minVersion && compareVersions(client, minVersion) < 0) return false;
  if (maxVersion && compareVersions(client, maxVersion) > 0) return false;
  return true;
}

function normalizeHttpUrl(value) {
  const text = compactString(value, MAX_ANNOUNCEMENT_URL_LENGTH);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function nullableCompactString(value, maxLength) {
  const text = compactString(value, maxLength);
  return text || null;
}

function normalizeIsoDate(value, field) {
  const text = compactString(value, 64);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

function normalizePriority(value) {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(-100000, Math.min(100000, Math.trunc(numeric)));
}

function normalizeAnnouncement(row, clientVersion) {
  if (!versionMatches(row, clientVersion)) return null;
  const title = compactString(row.title, MAX_ANNOUNCEMENT_TITLE_LENGTH);
  const body = compactString(row.body, MAX_ANNOUNCEMENT_BODY_LENGTH);
  if (!body) return null;
  return {
    id: typeof row.id === "number" ? row.id : Number(row.id) || null,
    title,
    body,
    url: normalizeHttpUrl(row.link_url),
    priority: typeof row.priority === "number" ? row.priority : Number(row.priority) || 0,
  };
}

function validateAnnouncementPayload(raw) {
  if (!isObject(raw)) throw new Error("announcement must be an object");
  const id = raw.id == null ? null : Number(raw.id);
  if (id !== null && (!Number.isInteger(id) || id <= 0)) throw new Error("id must be a positive integer");
  const title = compactString(raw.title, MAX_ANNOUNCEMENT_TITLE_LENGTH);
  const body = compactString(raw.body, MAX_ANNOUNCEMENT_BODY_LENGTH);
  if (!body) throw new Error("body is required");

  let linkUrl = null;
  const rawUrl = raw.link_url ?? raw.url;
  if (rawUrl != null && compactString(rawUrl, MAX_ANNOUNCEMENT_URL_LENGTH)) {
    linkUrl = normalizeHttpUrl(rawUrl);
    if (!linkUrl) throw new Error("url must be an http or https URL");
  }

  return {
    id,
    title,
    body,
    linkUrl,
    locale: compactTarget(raw.locale),
    platform: compactTarget(raw.platform),
    minVersion: nullableCompactString(raw.min_version, 32),
    maxVersion: nullableCompactString(raw.max_version, 32),
    priority: normalizePriority(raw.priority),
    startsAt: normalizeIsoDate(raw.starts_at, "starts_at"),
    endsAt: normalizeIsoDate(raw.ends_at, "ends_at"),
    enabled: raw.enabled === false || raw.enabled === 0 ? 0 : 1,
  };
}

async function handleAnnouncements(request, env) {
  if (!env.TELEMETRY_DB) return jsonResponse({ ok: false, error: "announcement database is not configured" }, 500);

  const url = new URL(request.url);
  const locale = compactTarget(url.searchParams.get("locale"));
  const platform = compactTarget(url.searchParams.get("platform"));
  const version = compactString(url.searchParams.get("version"), 32);
  const now = new Date().toISOString();

  const query = `
    SELECT id, title, body, link_url, locale, platform, min_version, max_version, priority, starts_at, ends_at
    FROM announcements
    WHERE enabled = 1
      AND (starts_at IS NULL OR starts_at <= ?)
      AND (ends_at IS NULL OR ends_at > ?)
      AND (locale = 'all' OR locale = ?)
      AND (platform = 'all' OR platform = ?)
    ORDER BY priority DESC, created_at DESC, id DESC
    LIMIT 25
  `;

  let rows;
  try {
    const result = await env.TELEMETRY_DB.prepare(query).bind(now, now, locale, platform).all();
    rows = Array.isArray(result?.results) ? result.results : [];
  } catch (error) {
    return jsonResponse({ ok: false, error: `announcement query failed: ${error.message}` }, 500);
  }

  const announcements = rows
    .map((row) => normalizeAnnouncement(row, version))
    .filter(Boolean)
    .slice(0, MAX_ANNOUNCEMENTS);

  return jsonResponse(
    { ok: true, announcements, ttl_seconds: ANNOUNCEMENT_TTL_SECONDS },
    200,
    { "cache-control": `public, max-age=${ANNOUNCEMENT_TTL_SECONDS}` },
  );
}

async function handleAnnouncementWrite(request, env) {
  if (!env.TELEMETRY_DB) return jsonResponse({ ok: false, error: "announcement database is not configured" }, 500);
  if (!isAnnouncementAdminAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  let announcement;
  try {
    announcement = validateAnnouncementPayload(await readJsonBody(request));
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message }, 400);
  }

  const now = new Date().toISOString();
  try {
    if (announcement.id) {
      await env.TELEMETRY_DB.prepare(`
        UPDATE announcements
        SET title = ?, body = ?, link_url = ?, locale = ?, platform = ?,
            min_version = ?, max_version = ?, priority = ?, starts_at = ?,
            ends_at = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        announcement.title,
        announcement.body,
        announcement.linkUrl,
        announcement.locale,
        announcement.platform,
        announcement.minVersion,
        announcement.maxVersion,
        announcement.priority,
        announcement.startsAt,
        announcement.endsAt,
        announcement.enabled,
        now,
        announcement.id,
      ).run();
      return jsonResponse({ ok: true, id: announcement.id });
    }

    const result = await env.TELEMETRY_DB.prepare(`
      INSERT INTO announcements (
        title, body, link_url, locale, platform, min_version, max_version,
        priority, starts_at, ends_at, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      announcement.title,
      announcement.body,
      announcement.linkUrl,
      announcement.locale,
      announcement.platform,
      announcement.minVersion,
      announcement.maxVersion,
      announcement.priority,
      announcement.startsAt,
      announcement.endsAt,
      announcement.enabled,
      now,
      now,
    ).run();
    return jsonResponse({ ok: true, id: result?.meta?.last_row_id ?? null }, 201);
  } catch (error) {
    return jsonResponse({ ok: false, error: `announcement write failed: ${error.message}` }, 500);
  }
}

function routeNotFound() {
  return jsonResponse({ ok: false, error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "codex-auth-telemetry" });
    }

    if (url.pathname === "/v1/telemetry/events" && request.method === "POST") {
      return handleTelemetry(request, env);
    }

    if (url.pathname === "/v1/telemetry/events") {
      return textResponse("Method not allowed", 405, { allow: "POST, OPTIONS" });
    }

    if (url.pathname === "/v1/telemetry/summary" && request.method === "GET") {
      return handleTelemetrySummary(request, env);
    }

    if (url.pathname === "/v1/telemetry/summary") {
      return textResponse("Method not allowed", 405, { allow: "GET, OPTIONS" });
    }

    if (url.pathname === "/v1/announcements" && request.method === "GET") {
      return handleAnnouncements(request, env);
    }

    if (url.pathname === "/v1/announcements" && request.method === "POST") {
      return handleAnnouncementWrite(request, env);
    }

    if (url.pathname === "/v1/announcements") {
      return textResponse("Method not allowed", 405, { allow: "GET, POST, OPTIONS" });
    }

    return routeNotFound();
  },
};

export const internals = {
  safeJsonObject,
  normalizeAnnouncement,
  parseVersion,
  sanitizeProperties,
  validateAnnouncementPayload,
  validatePayload,
};
