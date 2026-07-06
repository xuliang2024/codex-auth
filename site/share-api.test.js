import assert from "node:assert/strict";
import test from "node:test";

import { handleShareRequest, internals } from "./share-api.js";

const SAMPLE_EXPORT = {
  type: internals.EXPORT_FILE_TYPE,
  version: internals.EXPORT_FILE_VERSION,
  exported_at: "2026-07-06T00:00:00.000Z",
  registry: {
    accounts: [
      {
        account_key: "acct-1",
        email: "alice@example.com",
        alias: "work",
        plan: "plus",
        auth_mode: "chatgpt",
      },
    ],
  },
  auths: {
    "acct-1": { tokens: { access_token: "token-a" } },
  },
};

class MockBucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value) {
    this.objects.set(key, value);
  }

  async get(key) {
    const value = this.objects.get(key);
    if (value == null) return null;
    return {
      body: value,
      httpEtag: `"${key}"`,
      writeHttpMetadata(headers) {
        headers.set("content-type", "application/json; charset=utf-8");
      },
      async json() {
        return JSON.parse(String(value));
      },
    };
  }
}

function mockEnv(bucket = new MockBucket(), overrides = {}) {
  return {
    SITE_BUCKET: bucket,
    SHARE_DEFAULT_TTL_DAYS: "7",
    ...overrides,
  };
}

test("maskEmail hides most of the local part", () => {
  assert.equal(internals.maskEmail("alice@example.com"), "a***@example.com");
  assert.equal(internals.maskEmail(""), "***");
});

test("parseShareIdFromPath accepts page and export URLs", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(internals.parseShareIdFromPath(`/share/${id}`), id);
  assert.equal(internals.parseShareIdFromPath(`/v1/shares/${id}/export`), id);
  assert.equal(internals.parseShareIdFromPath("/downloads/app.dmg"), null);
});

test("validateExportPayload rejects invalid payloads", () => {
  assert.throws(() => internals.validateExportPayload({ type: "other" }), /invalid/);
  assert.throws(() => internals.validateExportPayload({ ...SAMPLE_EXPORT, auths: {} }), /usable auth/);
  assert.doesNotThrow(() => internals.validateExportPayload(SAMPLE_EXPORT));
});

test("POST /v1/shares stores meta and export objects", async () => {
  const bucket = new MockBucket();
  const env = mockEnv(bucket);
  const request = new Request("https://codexhub.uk/v1/shares", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      export: SAMPLE_EXPORT,
      note: "Team backup",
      ttl_days: 7,
      exported_by_app: "codex-auth-desktop",
      exported_by_version: "0.1.2",
    }),
  });

  const response = await handleShareRequest(request, env);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.share_url, /\/share\/[0-9a-f-]{36}$/);
  assert.match(body.import_url, /\/v1\/shares\/[0-9a-f-]{36}\/export$/);

  const meta = JSON.parse(String(bucket.objects.get(`shares/${body.id}/meta.json`)));
  assert.equal(meta.account_count, 1);
  assert.equal(meta.accounts_preview[0].email_masked, "a***@example.com");
  assert.equal(meta.note, "Team backup");

  const exportPayload = JSON.parse(String(bucket.objects.get(`shares/${body.id}/export.json`)));
  assert.equal(exportPayload.share.id, body.id);
});

test("GET /v1/shares/{id}/export returns stored export", async () => {
  const bucket = new MockBucket();
  const env = mockEnv(bucket);
  const create = await handleShareRequest(
    new Request("https://codexhub.uk/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ export: SAMPLE_EXPORT }),
    }),
    env,
  );
  const created = await create.json();

  const response = await handleShareRequest(
    new Request(created.import_url, { method: "GET" }),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.type, internals.EXPORT_FILE_TYPE);
  assert.equal(payload.auths["acct-1"].tokens.access_token, "token-a");
});

test("GET /share/{id} renders HTML summary without tokens", async () => {
  const bucket = new MockBucket();
  const env = mockEnv(bucket);
  const create = await handleShareRequest(
    new Request("https://codexhub.uk/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ export: SAMPLE_EXPORT, note: "For Bob" }),
    }),
    env,
  );
  const created = await create.json();

  const response = await handleShareRequest(
    new Request(created.share_url, { method: "GET" }),
    env,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /a\*\*\*@example\.com/);
  assert.match(html, /For Bob/);
  assert.doesNotMatch(html, /token-a/);
  assert.match(html, /3 步完成/);
  assert.match(html, /账号配置导入/);
  assert.match(html, /share-summary-status/);
  assert.match(html, /可导入配置/);
  assert.match(html, /下载并打开客户端/);
  assert.match(html, /复制导入链接|copy-import-link/);
  assert.match(html, /粘贴链接并导入/);
  assert.match(html, /import-share-link\.png/);
  assert.match(html, /客户端链接导入示意图/);
});

test("expired share export returns 410", async () => {
  const bucket = new MockBucket();
  const env = mockEnv(bucket);
  const create = await handleShareRequest(
    new Request("https://codexhub.uk/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ export: SAMPLE_EXPORT, ttl_days: 1 }),
    }),
    env,
  );
  const created = await create.json();
  const meta = JSON.parse(String(bucket.objects.get(`shares/${created.id}/meta.json`)));
  meta.expires_at = "2020-01-01T00:00:00.000Z";
  await bucket.put(`shares/${created.id}/meta.json`, JSON.stringify(meta));

  const response = await handleShareRequest(
    new Request(created.import_url, { method: "GET" }),
    env,
  );
  assert.equal(response.status, 410);
});

test("POST /v1/shares stays available when legacy upload token is configured", async () => {
  const env = mockEnv(new MockBucket(), { SHARE_UPLOAD_TOKEN: "secret" });
  const response = await handleShareRequest(
    new Request("https://codexhub.uk/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ export: SAMPLE_EXPORT }),
    }),
    env,
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.ok, true);
});
