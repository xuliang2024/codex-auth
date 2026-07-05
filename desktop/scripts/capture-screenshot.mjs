import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.join(__dirname, "..");
const outputPath = path.join(desktopRoot, "..", "docs", "assets", "desktop-app.png");

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

const mockCodexHome = path.join(os.tmpdir(), "codex-auth-screenshot-home", ".codex");
fs.mkdirSync(path.join(mockCodexHome, "accounts"), { recursive: true });
fs.writeFileSync(
  path.join(mockCodexHome, "accounts", "registry.json"),
  `${JSON.stringify(mockRegistry, null, 2)}\n`,
);
process.env.CODEX_HOME = mockCodexHome;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 860,
    height: 720,
    show: false,
    backgroundColor: "#0d1017",
    webPreferences: {
      preload: path.join(__dirname, "screenshot-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(desktopRoot, "renderer", "index.html"));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = await win.webContents.executeJavaScript(
      'document.querySelectorAll(".account-card").length',
    );
    if (count >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await win.webContents.executeJavaScript(`
    localStorage.setItem("codex-auth-language", "en");
    document.getElementById("lang-select").value = "en";
    document.getElementById("lang-select").dispatchEvent(new Event("change"));
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, image.toPNG());
  app.quit();
});

app.on("window-all-closed", () => app.quit());
