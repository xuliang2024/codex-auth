import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TELEMETRY_ENDPOINT = process.env.CODEX_AUTH_TELEMETRY_ENDPOINT || "https://codex-auth-telemetry.xuliang2022.workers.dev/v1/telemetry/events";
const FILE_MODE = 0o600;
const MAX_QUEUE_EVENTS = 200;
const FLUSH_INTERVAL_MS = 30_000;

let state = null;
let queue = [];
let flushTimer = null;
let flushing = false;

function telemetryDir(codexHome) {
  return path.join(codexHome, "accounts");
}

function statePath(codexHome) {
  return path.join(telemetryDir(codexHome), "telemetry.json");
}

function queuePath(codexHome) {
  return path.join(telemetryDir(codexHome), "telemetry-queue.json");
}

function ensureDir(codexHome) {
  fs.mkdirSync(telemetryDir(codexHome), { recursive: true, mode: 0o700 });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: FILE_MODE });
  fs.chmodSync(filePath, FILE_MODE);
}

function loadState(codexHome) {
  if (state) return state;
  ensureDir(codexHome);
  const existing = readJson(statePath(codexHome), null);
  state = {
    enabled: existing?.enabled !== false,
    install_id: typeof existing?.install_id === "string" && existing.install_id
      ? existing.install_id
      : crypto.randomUUID(),
    created_at: typeof existing?.created_at === "number" ? existing.created_at : Math.floor(Date.now() / 1000),
  };
  writeJson(statePath(codexHome), state);
  const existingQueue = readJson(queuePath(codexHome), []);
  queue = Array.isArray(existingQueue) ? existingQueue.slice(-MAX_QUEUE_EVENTS) : [];
  return state;
}

function saveQueue(codexHome) {
  ensureDir(codexHome);
  writeJson(queuePath(codexHome), queue.slice(-MAX_QUEUE_EVENTS));
}

function countBy(items, pick) {
  const counts = {};
  for (const item of items) {
    const key = String(pick(item) || "unknown").toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 40);
    counts[key || "unknown"] = (counts[key || "unknown"] ?? 0) + 1;
  }
  return counts;
}

export function buildRegistrySnapshot(registryResult) {
  const registry = registryResult?.ok ? registryResult.data : registryResult;
  const accounts = Array.isArray(registry?.accounts) ? registry.accounts : [];
  return {
    account_count: accounts.length,
    auth_mode_counts: countBy(accounts, (account) => account.auth_mode || "chatgpt"),
    plan_counts: countBy(accounts, (account) =>
      account.auth_mode === "provider"
        ? "api"
        : (account.last_usage?.plan_type || account.plan || "unknown")),
  };
}

export function classifyError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (!message) return "unknown_error";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("network") || message.includes("fetch") || message.includes("cannot reach")) return "network_error";
  if (message.includes("401") || message.includes("403") || message.includes("authentication")) return "auth_error";
  if (message.includes("expired")) return "session_expired";
  if (message.includes("cancel")) return "cancelled";
  if (message.includes("not found") || message.includes("enoent")) return "not_found";
  return "operation_error";
}

export function initTelemetry({ codexHome, appVersion, locale }) {
  loadState(codexHome);
  state.app_version = appVersion;
  state.locale = locale;
}

export function trackTelemetry(codexHome, name, properties = {}) {
  const current = loadState(codexHome);
  if (!current.enabled) return;
  queue.push({
    name,
    time: Math.floor(Date.now() / 1000),
    properties,
  });
  queue = queue.slice(-MAX_QUEUE_EVENTS);
  saveQueue(codexHome);
  scheduleFlush(codexHome);
}

export function trackResult(codexHome, baseName, result, properties = {}) {
  if (result?.cancelled) {
    trackTelemetry(codexHome, `${baseName}_cancelled`, properties);
    return;
  }
  if (result?.ok) {
    trackTelemetry(codexHome, `${baseName}_success`, properties);
    return;
  }
  trackTelemetry(codexHome, `${baseName}_fail`, {
    ...properties,
    error_kind: classifyError(result?.error || result?.stderr),
  });
}

function scheduleFlush(codexHome) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushTelemetry(codexHome);
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export async function flushTelemetry(codexHome) {
  const current = loadState(codexHome);
  if (!current.enabled || flushing || queue.length === 0) return { ok: true, sent: 0 };
  flushing = true;
  const events = queue.slice(0, 50);
  try {
    const response = await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: current.install_id,
        app: "codex-auth-desktop",
        app_version: current.app_version ?? null,
        platform: process.platform,
        locale: current.locale ?? null,
        events,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, sent: 0 };
    queue = queue.slice(events.length);
    saveQueue(codexHome);
    return { ok: true, sent: events.length };
  } catch {
    return { ok: false, sent: 0 };
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush(codexHome);
  }
}

export function shutdownTelemetry(codexHome) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  saveQueue(codexHome);
}

export const internals = {
  countBy,
  statePath,
  queuePath,
  telemetryDir,
  userAgentPlatform: () => `${process.platform}/${os.arch()}`,
};
