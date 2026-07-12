import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSource = fs.readFileSync(
  path.join(projectRoot, "renderer", "tauri-bridge.js"),
  "utf8",
);

test("Tauri bridge exposes the desktop API", async () => {
  const calls = [];
  let eventHandler = null;
  let stopped = false;
  const window = {
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          calls.push({ command, args });
          return { command, args };
        },
      },
      event: {
        listen: async (event, handler) => {
          assert.equal(event, "registry-changed");
          eventHandler = handler;
          return () => {
            stopped = true;
          };
        },
      },
    },
  };
  vm.runInNewContext(bridgeSource, {
    window,
    navigator: { platform: "MacIntel", userAgent: "test" },
  });

  assert.equal(window.codexAuth.platform, "darwin");
  await window.codexAuth.getRegistry();
  await window.codexAuth.loginApi({ baseUrl: "https://api.example.com", apiKey: "secret" });
  await window.codexAuth.testProviderAccount("provider-account");
  await window.codexAuth.testProviderAccount("provider-account", {
    apiKey: "replacement-secret",
    model: "gpt-5.6-sol",
  });
  await window.codexAuth.updateProviderAccount("provider-account", {
    apiKey: "replacement-secret",
    model: "gpt-5.6-sol",
  });
  assert.equal(JSON.stringify(calls), JSON.stringify([
    { command: "get_registry", args: undefined },
    {
      command: "login_api",
      args: { opts: { baseUrl: "https://api.example.com", apiKey: "secret" } },
    },
    {
      command: "test_provider_account",
      args: { accountKey: "provider-account" },
    },
    {
      command: "test_provider_account",
      args: {
        accountKey: "provider-account",
        opts: { apiKey: "replacement-secret", model: "gpt-5.6-sol" },
      },
    },
    {
      command: "update_provider_account",
      args: {
        accountKey: "provider-account",
        opts: { apiKey: "replacement-secret", model: "gpt-5.6-sol" },
      },
    },
  ]));

  let payload = null;
  const dispose = window.codexAuth.onRegistryChanged((value) => {
    payload = value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  eventHandler({ payload: { ok: true, data: { accounts: [] } } });
  assert.equal(
    JSON.stringify(payload),
    JSON.stringify({ ok: true, data: { accounts: [] } }),
  );
  dispose();
  assert.equal(stopped, true);
});

test("Tauri bridge fails clearly outside the Tauri runtime", () => {
  assert.throws(
    () => vm.runInNewContext(bridgeSource, {
      window: {},
      navigator: { platform: "Win32", userAgent: "test" },
    }),
    /requires the Tauri desktop runtime/,
  );
});

test("Tauri bridge preserves an explicitly injected test API", () => {
  const injectedApi = { platform: "test" };
  const window = { codexAuth: injectedApi };
  vm.runInNewContext(bridgeSource, {
    window,
    navigator: { platform: "test", userAgent: "test" },
  });
  assert.equal(window.codexAuth, injectedApi);
});
