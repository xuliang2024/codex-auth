const { contextBridge } = require("electron");

const now = Math.floor(Date.now() / 1000);

const mockRegistry = {
  schema_version: 5,
  active_account_key: "user-demo::11111111-1111-1111-1111-111111111111",
  accounts: [
    {
      account_key: "user-demo::11111111-1111-1111-1111-111111111111",
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
        model: "gpt-5.5",
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

contextBridge.exposeInMainWorld("codexAuth", {
  platform: process.platform,
  getAppVersion: async () => "0.1.1",
  getRegistry: async () => ({ ok: true, data: mockRegistry }),
  getAnnouncements: async () => ({ ok: true, announcements: [] }),
  openAnnouncementUrl: async () => ({ ok: true }),
  switchAccount: async () => ({ ok: false }),
  checkAccounts: async () => ({ ok: true, statuses: {}, registry: { ok: true, data: mockRegistry } }),
  refreshAccountUsage: async () => ({ ok: false }),
  loginStart: async () => ({ ok: false }),
  loginApi: async () => ({ ok: false }),
  testApiEndpoint: async () => ({ ok: false }),
  testProviderAccount: async () => ({ ok: false }),
  loginCancel: async () => ({ ok: false }),
  removeAccount: async () => ({ ok: false }),
  exportAccounts: async () => ({ ok: false }),
  importAccounts: async () => ({ ok: false }),
  onRegistryChanged: () => () => {},
});
