import assert from "node:assert/strict";
import test from "node:test";

import { parseShareUrl, shareExportUrl, sharePageUrl } from "./share.js";

test("parseShareUrl accepts raw uuid and known URL shapes", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(parseShareUrl(id), id);
  assert.equal(parseShareUrl(`https://codexhub.uk/share/${id}`), id);
  assert.equal(parseShareUrl(`https://codexhub.uk/v1/shares/${id}/export`), id);
  assert.equal(parseShareUrl("https://example.com/share/not-a-uuid"), null);
  assert.equal(parseShareUrl(""), null);
});

test("share URL helpers build canonical endpoints", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(sharePageUrl(id, "https://codexhub.uk/"), `https://codexhub.uk/share/${id}`);
  assert.equal(
    shareExportUrl(id, "https://codexhub.uk"),
    `https://codexhub.uk/v1/shares/${id}/export`,
  );
});

test("fetchShareExport maps HTTP statuses to errors", async () => {
  const { fetchShareExport } = await import("./share.js");
  const id = "550e8400-e29b-41d4-a716-446655440000";

  const notFound = await fetchShareExport(sharePageUrl(id), async () => ({ status: 404, ok: false }));
  assert.equal(notFound.ok, false);
  assert.match(notFound.error, /not found/i);

  const expired = await fetchShareExport(sharePageUrl(id), async () => ({ status: 410, ok: false }));
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/i);

  const ok = await fetchShareExport(sharePageUrl(id), async () => ({
    status: 200,
    ok: true,
    async json() {
      return {
        type: "codex-auth-accounts",
        version: 1,
        registry: { accounts: [{ account_key: "a1", email: "a@example.com" }] },
        auths: { a1: { tokens: { access_token: "x" } } },
      };
    },
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.shareId, id);
});

test("uploadShare forwards server errors", async () => {
  const { uploadShare } = await import("./share.js");
  const result = await uploadShare(
    { type: "codex-auth-accounts", version: 1, registry: { accounts: [] }, auths: {} },
    {},
    async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: "export contains no accounts" };
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /no accounts/);
});
