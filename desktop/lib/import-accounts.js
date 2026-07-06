import fs from "node:fs";
import path from "node:path";

import { EXPORT_FILE_TYPE, EXPORT_FILE_VERSION } from "./export-accounts.js";

export function validateImportPayload(payload) {
  if (payload?.type !== EXPORT_FILE_TYPE || !Array.isArray(payload?.registry?.accounts)) {
    return { ok: false, error: "This file is not a codex-auth account export." };
  }
  if (typeof payload.version === "number" && payload.version > EXPORT_FILE_VERSION) {
    return { ok: false, error: "This export was created by a newer app version." };
  }

  const incoming = payload.registry.accounts.filter(
    (account) => account && typeof account.account_key === "string" && account.account_key.length > 0,
  );
  if (incoming.length === 0) {
    return { ok: false, error: "The export file contains no accounts." };
  }

  return { ok: true, incoming };
}

export function applyImportPayload({
  codexHome,
  payload,
  readRegistry,
  registryPath,
  accountAuthPath,
}) {
  const validation = validateImportPayload(payload);
  if (!validation.ok) return validation;

  const incoming = validation.incoming;
  const accountsDir = path.join(codexHome, "accounts");
  try {
    fs.mkdirSync(accountsDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Cannot create ${accountsDir}: ${err.message}` };
  }

  const current = readRegistry();
  const base = current.ok
    ? current.data
    : { ...payload.registry, active_account_key: null, previous_active_account_key: null, accounts: [] };
  const existing = base.accounts ?? [];

  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const account of incoming) {
    const auth = payload.auths?.[account.account_key];
    if (!auth || typeof auth !== "object") {
      skipped += 1;
      continue;
    }
    try {
      const serialized = JSON.stringify(auth, null, 2) + "\n";
      fs.writeFileSync(accountAuthPath(account.account_key), serialized, { mode: 0o600 });
      if (account.account_key === base.active_account_key) {
        fs.writeFileSync(path.join(codexHome, "auth.json"), serialized, { mode: 0o600 });
      }
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write auth for ${account.email || account.account_key}: ${err.message}`,
      };
    }
    const index = existing.findIndex((entry) => entry.account_key === account.account_key);
    if (index >= 0) {
      existing[index] = account;
      updated += 1;
    } else {
      existing.push(account);
      added += 1;
    }
  }

  if (added === 0 && updated === 0) {
    return { ok: false, error: "No account in the file had usable auth data." };
  }

  base.accounts = existing;
  try {
    fs.writeFileSync(registryPath, JSON.stringify(base, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `Failed to save registry: ${err.message}` };
  }

  return { ok: true, added, updated, skipped, registryData: base };
}
