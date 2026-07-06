import assert from "node:assert/strict";
import test from "node:test";

const BASE = process.env.SHARE_TEST_BASE || "http://127.0.0.1:8799";

const SAMPLE_EXPORT = {
  type: "codex-auth-accounts",
  version: 1,
  exported_at: new Date().toISOString(),
  registry: {
    accounts: [
      {
        account_key: "acct-integration",
        email: "integration@example.com",
        alias: "phase1",
        plan: "plus",
        auth_mode: "chatgpt",
      },
    ],
  },
  auths: {
    "acct-integration": { tokens: { access_token: "integration-token" } },
  },
};

test("integration: create share, fetch export, render page", async (t) => {
  const create = await fetch(`${BASE}/v1/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      export: SAMPLE_EXPORT,
      note: "Phase 1 integration test",
      ttl_days: 7,
    }),
  });
  const createText = await create.text();
  assert.equal(create.status, 201, createText);
  const created = JSON.parse(createText);
  assert.equal(created.ok, true);

  const importUrl = `${BASE}/v1/shares/${created.id}/export`;
  const shareUrl = `${BASE}/share/${created.id}`;

  const exportResponse = await fetch(importUrl);
  assert.equal(exportResponse.status, 200);
  const payload = await exportResponse.json();
  assert.equal(payload.auths["acct-integration"].tokens.access_token, "integration-token");

  const pageResponse = await fetch(shareUrl);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /i\*\*\*@example\.com/);
  assert.match(html, /Phase 1 integration test/);
  assert.doesNotMatch(html, /integration-token/);
});

test("integration: unknown share returns 404", async () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const response = await fetch(`${BASE}/v1/shares/${id}/export`);
  assert.equal(response.status, 404);
});
