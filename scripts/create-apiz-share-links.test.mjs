import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApizExportPayload,
  extractApiKeys,
  keyFingerprint,
  parseArgs,
} from "./create-apiz-share-links.mjs";

test("extractApiKeys extracts unique sk keys in first-seen order", () => {
  const keys = extractApiKeys(`
    first sk-0297508b0e736ab8c86885a7dd11472d3fb6a8e4980f920df07d91c9adb18265
    duplicate sk-0297508b0e736ab8c86885a7dd11472d3fb6a8e4980f920df07d91c9adb18265
    second sk-0db237f9abcdef0123456789abcdef0123456789abcdef0123456789abcdef01
  `);

  assert.deepEqual(keys, [
    "sk-0297508b0e736ab8c86885a7dd11472d3fb6a8e4980f920df07d91c9adb18265",
    "sk-0db237f9abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
  ]);
});

test("buildApizExportPayload creates a single provider account export", () => {
  const apiKey = "sk-test-provider-key-1234567890";
  const payload = buildApizExportPayload(apiKey, {
    now: new Date("2026-07-07T00:00:00.000Z"),
  });

  assert.equal(payload.type, "codex-auth-accounts");
  assert.equal(payload.version, 1);
  assert.equal(payload.registry.accounts.length, 1);

  const account = payload.registry.accounts[0];
  assert.equal(account.email, "codex.apiz.ai");
  assert.equal(account.alias, "apiz");
  assert.equal(account.auth_mode, "provider");
  assert.equal(account.provider.id, "apiz");
  assert.equal(account.provider.base_url, "https://codex.apiz.ai");
  assert.equal(account.provider.model, "gpt-5.6-sol");
  assert.equal(account.provider.model_reasoning_effort, "medium");
  assert.equal(payload.registry.active_account_key, account.account_key);
  assert.deepEqual(payload.auths[account.account_key], { OPENAI_API_KEY: apiKey });

  const publicPayload = JSON.stringify(payload.registry);
  assert.equal(publicPayload.includes(apiKey), false);
});

test("keyFingerprint does not expose the API key", () => {
  const apiKey = "sk-test-provider-key-1234567890";
  const fingerprint = keyFingerprint(apiKey);

  assert.match(fingerprint, /^[0-9a-f]{8}\.\.\.[0-9a-f]{6}$/);
  assert.equal(fingerprint.includes(apiKey), false);
});

test("parseArgs accepts the expected CLI options", () => {
  const args = parseArgs([
    "keys.txt",
    "--out",
    "links.txt",
    "--ttl-days",
    "14",
    "--note",
    "APIZ",
    "--model",
    "gpt-5.5",
  ]);

  assert.equal(args.inputPath, "keys.txt");
  assert.equal(args.outPath, "links.txt");
  assert.equal(args.ttlDays, 14);
  assert.equal(args.note, "APIZ");
  assert.equal(args.model, "gpt-5.5");
});
