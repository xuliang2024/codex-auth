import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyImportPayload, validateImportPayload } from "./import-accounts.js";

const SAMPLE_PAYLOAD = {
  type: "codex-auth-accounts",
  version: 1,
  exported_at: "2026-07-06T00:00:00.000Z",
  registry: {
    active_account_key: "acct-1",
    previous_active_account_key: null,
    accounts: [
      {
        account_key: "acct-1",
        email: "alice@example.com",
        alias: "work",
      },
      {
        account_key: "acct-2",
        email: "bob@example.com",
      },
    ],
  },
  auths: {
    "acct-1": { tokens: { access_token: "token-a", refresh_token: "refresh-a" } },
    "acct-2": { tokens: { access_token: "token-b" } },
  },
};

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-import-test-"));
}

function accountAuthPath(codexHome, accountKey) {
  const fileKey = Buffer.from(accountKey, "utf8").toString("base64url");
  return path.join(codexHome, "accounts", `${fileKey}.auth.json`);
}

test("validateImportPayload rejects unsupported exports", () => {
  assert.equal(validateImportPayload({ type: "other" }).ok, false);
  assert.equal(validateImportPayload({ ...SAMPLE_PAYLOAD, registry: { accounts: [] } }).ok, false);
  assert.equal(validateImportPayload(SAMPLE_PAYLOAD).ok, true);
});

test("applyImportPayload writes auth files and registry", () => {
  const codexHome = makeTempHome();
  const registryPath = path.join(codexHome, "accounts", "registry.json");

  const result = applyImportPayload({
    codexHome,
    payload: SAMPLE_PAYLOAD,
    readRegistry: () => ({ ok: false }),
    registryPath,
    accountAuthPath: (accountKey) => accountAuthPath(codexHome, accountKey),
  });

  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.equal(registry.accounts.length, 2);
  assert.equal(
    JSON.parse(fs.readFileSync(accountAuthPath(codexHome, "acct-1"), "utf8")).tokens.access_token,
    "token-a",
  );
  assert.equal(registry.active_account_key, null);
});

test("applyImportPayload merges and updates existing accounts", () => {
  const codexHome = makeTempHome();
  const registryPath = path.join(codexHome, "accounts", "registry.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      active_account_key: "acct-1",
      previous_active_account_key: null,
      accounts: [{ account_key: "acct-1", email: "alice@example.com", alias: "old" }],
    }),
  );
  fs.writeFileSync(accountAuthPath(codexHome, "acct-1"), JSON.stringify({ tokens: { access_token: "old" } }));

  const result = applyImportPayload({
    codexHome,
    payload: SAMPLE_PAYLOAD,
    readRegistry: () => ({
      ok: true,
      data: JSON.parse(fs.readFileSync(registryPath, "utf8")),
    }),
    registryPath,
    accountAuthPath: (accountKey) => accountAuthPath(codexHome, accountKey),
  });

  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 1);

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.equal(registry.accounts.find((entry) => entry.account_key === "acct-1").alias, "work");
});
