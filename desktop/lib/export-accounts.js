export const EXPORT_FILE_TYPE = "codex-auth-accounts";
export const EXPORT_FILE_VERSION = 1;

export function buildExportPayload(registry, readAuthFn) {
  const accounts = registry?.accounts ?? [];
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
      registry,
      auths,
    },
    missing,
    exported: Object.keys(auths).length,
  };
}
