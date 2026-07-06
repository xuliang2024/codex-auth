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

test("buildExportPayload can scope the export to one account", () => {
  const registry = {
    active_account_key: "a1",
    previous_active_account_key: "a2",
    accounts: [
      { account_key: "a1", email: "a@example.com" },
      { account_key: "a2", email: "b@example.com" },
    ],
  };

  const built = buildExportPayload(
    registry,
    (key) => ({ tokens: { access_token: key } }),
    { accountKey: "a2" },
  );

  assert.equal(built.exported, 1);
  assert.deepEqual(built.missing, []);
  assert.deepEqual(built.payload.registry.accounts, [{ account_key: "a2", email: "b@example.com" }]);
  assert.equal(built.payload.registry.active_account_key, null);
  assert.equal(built.payload.registry.previous_active_account_key, null);
  assert.deepEqual(Object.keys(built.payload.auths), ["a2"]);
});

test("buildExportPayload keeps active account only when exporting that account", () => {
  const registry = {
    active_account_key: "a1",
    previous_active_account_key: "a2",
    accounts: [
      { account_key: "a1", email: "a@example.com" },
      { account_key: "a2", email: "b@example.com" },
    ],
  };

  const built = buildExportPayload(
    registry,
    (key) => ({ tokens: { access_token: key } }),
    { accountKey: "a1" },
  );

  assert.equal(built.payload.registry.active_account_key, "a1");
  assert.equal(built.payload.registry.previous_active_account_key, null);
  assert.deepEqual(Object.keys(built.payload.auths), ["a1"]);
});
