import assert from "node:assert/strict";
import test from "node:test";

import { buildExportPayload } from "./export-accounts.js";

test("buildExportPayload collects auths and missing accounts", () => {
  const registry = {
    accounts: [
      { account_key: "a1", email: "a@example.com" },
      { account_key: "a2", email: "b@example.com" },
    ],
  };
  const built = buildExportPayload(registry, (key) => (key === "a1" ? { tokens: { access_token: "x" } } : null));
  assert.equal(built.exported, 1);
  assert.deepEqual(built.missing, ["b@example.com"]);
  assert.equal(built.payload.type, "codex-auth-accounts");
  assert.equal(built.payload.auths.a1.tokens.access_token, "x");
});
