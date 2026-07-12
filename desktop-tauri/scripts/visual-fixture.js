(() => {
  const now = 1_800_000_000;
  const activeAccountKey = "user-demo::11111111-1111-1111-1111-111111111111";
  const registry = {
    schema_version: 5,
    active_account_key: activeAccountKey,
    accounts: [
      {
        account_key: activeAccountKey,
        chatgpt_account_id: "11111111-1111-1111-1111-111111111111",
        chatgpt_user_id: "user-demo",
        email: "alice@example.com",
        alias: "personal",
        plan: "pro",
        auth_mode: "chatgpt",
        created_at: now - 86400 * 30,
        last_used_at: now - 120,
        last_usage_at: now - 120,
        last_usage: {
          primary: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_at: now + 7_200,
          },
          secondary: {
            used_percent: 18,
            limit_window_seconds: 604_800,
            reset_at: now + 86_400,
          },
          plan_type: "pro",
          credits: { has_credits: true, unlimited: false, balance: "12.50" },
        },
      },
      {
        account_key: "provider::codex.example.com::a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3",
        chatgpt_account_id: "",
        chatgpt_user_id: "",
        email: "codex.example.com",
        alias: "relay",
        plan: null,
        auth_mode: "provider",
        created_at: now - 86400 * 7,
        last_used_at: null,
        last_usage_at: null,
        provider: {
          id: "relay",
          base_url: "https://codex.example.com",
          wire_api: "responses",
          requires_openai_auth: true,
          model: "gpt-5.6-sol",
        },
      },
      {
        account_key: "user-work::22222222-2222-2222-2222-222222222222",
        chatgpt_account_id: "22222222-2222-2222-2222-222222222222",
        chatgpt_user_id: "user-work",
        email: "work@company.com",
        alias: "work",
        plan: "plus",
        auth_mode: "chatgpt",
        created_at: now - 86400 * 14,
        last_used_at: now - 3600,
        last_usage_at: now - 3600,
        last_usage: {
          primary: {
            used_percent: 76,
            limit_window_seconds: 18_000,
            reset_at: now + 5_400,
          },
          secondary: {
            used_percent: 54,
            limit_window_seconds: 604_800,
            reset_at: now + 172_800,
          },
          plan_type: "plus",
        },
      },
    ],
  };

  Date.now = () => now * 1000;
  localStorage.setItem("codex-auth-language", "en");
  localStorage.setItem("codex-auth-view-mode", "list");

  const platformText = String(navigator.platform || navigator.userAgent || "").toLowerCase();
  const platform = platformText.includes("mac")
    ? "darwin"
    : platformText.includes("win")
      ? "win32"
      : "linux";
  const registryResult = () => ({ ok: true, data: JSON.parse(JSON.stringify(registry)) });
  const unsupported = async () => ({ ok: false, cancelled: true });

  window.codexAuth = {
    platform,
    getAppVersion: async () => "0.2.2",
    getRegistry: async () => registryResult(),
    getAnnouncements: async () => ({ ok: true, announcements: [] }),
    openAnnouncementUrl: unsupported,
    openCodexDownload: unsupported,
    switchAccount: unsupported,
    checkAccounts: async () => ({
      ok: true,
      statuses: {},
      registry: registryResult(),
    }),
    refreshAccountUsage: unsupported,
    loginStart: unsupported,
    loginApi: unsupported,
    testApiEndpoint: unsupported,
    testProviderAccount: unsupported,
    updateProviderAccount: unsupported,
    loginCancel: unsupported,
    removeAccount: unsupported,
    exportAccounts: unsupported,
    exportAccountsShare: unsupported,
    importAccounts: unsupported,
    importAccountsFromUrl: unsupported,
    onRegistryChanged: () => () => {},
  };

  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
  document.head.append(style);

  const markReady = () => {
    if (document.querySelectorAll(".account-card").length !== 3) return;
    if (document.getElementById("app-version")?.textContent !== "v0.2.2") return;
    document.documentElement.dataset.visualReady = "true";
    document.title = "Accounts for Codex Visual Test Ready";
    observer.disconnect();
  };
  const observer = new MutationObserver(markReady);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  queueMicrotask(markReady);
})();
