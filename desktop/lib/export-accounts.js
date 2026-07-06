export const EXPORT_FILE_TYPE = "codex-auth-accounts";
export const EXPORT_FILE_VERSION = 1;

function scopedRegistry(registry, accountKey) {
  if (!accountKey) return registry;

  const accounts = (registry?.accounts ?? []).filter((account) => account?.account_key === accountKey);
  return {
    ...registry,
    active_account_key: registry?.active_account_key === accountKey ? accountKey : null,
    previous_active_account_key: null,
    accounts,
  };
}

export function buildExportPayload(registry, readAuthFn, opts = {}) {
  const accountKey = String(opts?.accountKey ?? "").trim() || null;
  const exportRegistry = scopedRegistry(registry, accountKey);
  const accounts = exportRegistry?.accounts ?? [];
  const auths = {};
  const missing = [];

  for (const account of accounts) {
    const auth = readAuthFn(account.account_key);
    if (auth) auths[account.account_key] = auth;
    else missing.push(account.email || account.account_key);
  }

  return {
    payload: {
      type: EXPORT_FILE_TYPE,
      version: EXPORT_FILE_VERSION,
      exported_at: new Date().toISOString(),
      registry: exportRegistry,
      auths,
    },
    missing,
    exported: Object.keys(auths).length,
  };
}
