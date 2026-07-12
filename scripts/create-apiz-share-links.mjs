#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CURRENT_SCHEMA_VERSION = 5;
const EXPORT_FILE_TYPE = "codex-auth-accounts";
const EXPORT_FILE_VERSION = 1;
const DEFAULT_PROVIDER_MODEL = "gpt-5.6-sol";
const DEFAULT_PROVIDER_REASONING_EFFORT = "medium";
const DEFAULT_SHARE_API_BASE = "https://codexhub.uk";
const DEFAULT_PROVIDER_BASE_URL = "https://codex.apiz.ai";
const DEFAULT_PROVIDER_ID = "apiz";
const DEFAULT_TTL_DAYS = 7;
const KEY_RE = /sk-[A-Za-z0-9_-]{8,}/g;

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function providerAccountKey(host, apiKey) {
  return `provider::${host}::${sha256Hex(apiKey)}`;
}

function apiKeyAccountName(apiKey) {
  const hex = sha256Hex(apiKey);
  return `sk-${hex.slice(0, 5)}***${hex.slice(-4)}`;
}

function usage() {
  return `Usage:
  node scripts/create-apiz-share-links.mjs <keys.txt> [--out <share-links.txt>]

Options:
  --out <path>              Output file. Defaults to <input>.share-links.txt.
  --ttl-days <days>         Share link TTL in days. Defaults to 7.
  --note <text>             Optional note shown on the public share page.
  --share-api-base <url>    Share service base URL. Defaults to https://codexhub.uk.
  --provider-base-url <url> Provider endpoint stored in each import. Defaults to https://codex.apiz.ai.
  --provider-id <id>        Provider id stored in config.toml. Defaults to apiz.
  --model <name>            Provider model. Defaults to ${DEFAULT_PROVIDER_MODEL}.
  --help                    Show this help text.
`;
}

function normalizeBaseUrl(raw) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(value)) {
    throw new Error(`Invalid base URL: ${raw}`);
  }
  return value;
}

function providerHostFromBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.host;
}

export function extractApiKeys(text) {
  const keys = [];
  const seen = new Set();
  for (const match of String(text ?? "").matchAll(KEY_RE)) {
    const key = match[0].trim();
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function keyFingerprint(apiKey) {
  const hex = crypto.createHash("sha256").update(apiKey, "utf8").digest("hex");
  return `${hex.slice(0, 8)}...${hex.slice(-6)}`;
}

export function buildApizExportPayload(apiKey, opts = {}) {
  const providerBaseUrl = normalizeBaseUrl(opts.providerBaseUrl ?? DEFAULT_PROVIDER_BASE_URL);
  const providerId = String(opts.providerId ?? DEFAULT_PROVIDER_ID).trim() || DEFAULT_PROVIDER_ID;
  const providerHost = providerHostFromBaseUrl(providerBaseUrl);
  const model = String(opts.model ?? DEFAULT_PROVIDER_MODEL).trim() || DEFAULT_PROVIDER_MODEL;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const accountKey = providerAccountKey(providerHost, apiKey);
  const createdAt = Math.floor(now.getTime() / 1000);

  const account = {
    account_key: accountKey,
    chatgpt_account_id: "",
    chatgpt_user_id: "",
    email: providerHost,
    alias: providerId,
    account_name: apiKeyAccountName(apiKey),
    plan: null,
    auth_mode: "provider",
    created_at: createdAt,
    last_used_at: null,
    last_usage: null,
    last_usage_at: null,
    last_local_rollout: null,
    provider: {
      id: providerId,
      base_url: providerBaseUrl,
      model,
      model_reasoning_effort: DEFAULT_PROVIDER_REASONING_EFFORT,
    },
  };

  return {
    type: EXPORT_FILE_TYPE,
    version: EXPORT_FILE_VERSION,
    exported_at: now.toISOString(),
    registry: {
      schema_version: CURRENT_SCHEMA_VERSION,
      active_account_key: accountKey,
      previous_active_account_key: null,
      active_account_activated_at_ms: null,
      interval_seconds: 60,
      accounts: [account],
    },
    auths: {
      [accountKey]: {
        OPENAI_API_KEY: apiKey,
      },
    },
  };
}

async function createShare(exportPayload, opts) {
  const shareApiBase = normalizeBaseUrl(opts.shareApiBase ?? DEFAULT_SHARE_API_BASE);
  const response = await fetch(`${shareApiBase}/v1/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      export: exportPayload,
      note: opts.note ?? null,
      ttl_days: opts.ttlDays ?? DEFAULT_TTL_DAYS,
      exported_by_app: "codex-auth-apiz-share-script",
      exported_by_version: null,
    }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep the error below generic when the response is not JSON.
  }

  if (!response.ok) {
    throw new Error(body?.error || `Share upload failed with HTTP ${response.status}`);
  }
  if (!body?.share_url) {
    throw new Error("Share upload succeeded but the response did not include share_url.");
  }
  return body;
}

function defaultOutPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.share-links.txt`);
}

function parsePositiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    inputPath: null,
    outPath: null,
    ttlDays: DEFAULT_TTL_DAYS,
    note: null,
    shareApiBase: DEFAULT_SHARE_API_BASE,
    providerBaseUrl: DEFAULT_PROVIDER_BASE_URL,
    providerId: DEFAULT_PROVIDER_ID,
    model: DEFAULT_PROVIDER_MODEL,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value.`);
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--out" || arg === "-o") {
      args.outPath = next();
    } else if (arg === "--ttl-days") {
      args.ttlDays = parsePositiveInteger(next(), "--ttl-days");
    } else if (arg === "--note") {
      args.note = next();
    } else if (arg === "--share-api-base") {
      args.shareApiBase = next();
    } else if (arg === "--provider-base-url") {
      args.providerBaseUrl = next();
    } else if (arg === "--provider-id") {
      args.providerId = next();
    } else if (arg === "--model") {
      args.model = next();
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!args.inputPath) {
      args.inputPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.inputPath) {
    process.stderr.write(usage());
    return 2;
  }

  const inputPath = path.resolve(args.inputPath);
  const outPath = path.resolve(args.outPath ?? defaultOutPath(inputPath));
  const text = fs.readFileSync(inputPath, "utf8");
  const keys = extractApiKeys(text);
  if (keys.length === 0) {
    throw new Error("No API keys were found in the input file.");
  }

  process.stdout.write(`Loaded ${keys.length} unique API key(s).\n`);

  const links = [];
  for (let index = 0; index < keys.length; index += 1) {
    const apiKey = keys[index];
    const fingerprint = keyFingerprint(apiKey);
    const payload = buildApizExportPayload(apiKey, args);
    try {
      const share = await createShare(payload, args);
      links.push(share.share_url);
      process.stdout.write(`Created ${index + 1}/${keys.length}: ${fingerprint} -> ${share.share_url}\n`);
    } catch (error) {
      process.stderr.write(`Failed ${index + 1}/${keys.length}: ${fingerprint}: ${error.message}\n`);
      throw error;
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${links.join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(`Wrote ${links.length} share link(s) to ${outPath}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
