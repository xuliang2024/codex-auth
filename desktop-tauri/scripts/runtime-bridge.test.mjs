import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSource = fs.readFileSync(
  path.resolve(projectRoot, "..", "desktop", "renderer", "runtime-bridge.js"),
  "utf8",
);

test("Tauri bridge preserves the Electron-facing desktop API", async () => {
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
  assert.equal(JSON.stringify(calls), JSON.stringify([
    { command: "get_registry", args: undefined },
    {
      command: "login_api",
      args: { opts: { baseUrl: "https://api.example.com", apiKey: "secret" } },
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

test("bridge does not replace the Electron preload API", () => {
  const existing = { platform: "win32" };
  const window = { codexAuth: existing, __TAURI__: { core: {}, event: {} } };
  vm.runInNewContext(bridgeSource, {
    window,
    navigator: { platform: "Win32", userAgent: "test" },
  });
  assert.equal(window.codexAuth, existing);
});
