(() => {
  // The deterministic visual test injects its own API before this script runs.
  if (window.codexAuth) return;

  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen) {
    throw new Error("Accounts for Codex requires the Tauri desktop runtime.");
  }

  const { invoke } = tauri.core;
  const { listen } = tauri.event;
  const platformText = String(navigator.platform || navigator.userAgent || "").toLowerCase();
  const platform = platformText.includes("mac")
    ? "darwin"
    : platformText.includes("win")
      ? "win32"
      : "linux";

  const call = (command, args) => invoke(command, args);

  window.codexAuth = {
    platform,
    getAppVersion: () => call("get_app_version"),
    getRegistry: () => call("get_registry"),
    getAnnouncements: (opts) => call("get_announcements", { opts }),
    openAnnouncementUrl: (url) => call("open_announcement_url", { url }),
    openCodexDownload: () => call("open_codex_download"),
    switchAccount: (accountKey) => call("switch_account", { accountKey }),
    checkAccounts: () => call("check_accounts"),
    refreshAccountUsage: (accountKey) => call("refresh_account_usage", { accountKey }),
    loginStart: () => call("login_start"),
    loginApi: (opts) => call("login_api", { opts }),
    testApiEndpoint: (opts) => call("test_api_endpoint", { opts }),
    testProviderAccount: (accountKey, opts) => call(
      "test_provider_account",
      opts === undefined ? { accountKey } : { accountKey, opts },
    ),
    updateProviderAccount: (accountKey, opts) => call("update_provider_account", { accountKey, opts }),
    loginCancel: () => call("login_cancel"),
    removeAccount: (accountKey) => call("remove_account", { accountKey }),
    exportAccounts: (opts) => call("export_accounts", { opts }),
    exportAccountsShare: (opts) => call("export_accounts_share", { opts }),
    importAccounts: () => call("import_accounts"),
    importAccountsFromUrl: (opts) => call("import_accounts_from_url", { opts }),
    onRegistryChanged: (callback) => {
      let disposed = false;
      let unlisten = null;
      listen("registry-changed", (event) => {
        if (!disposed) callback(event.payload);
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
})();
