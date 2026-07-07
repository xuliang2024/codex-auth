import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PROVIDER_MODEL,
  DEFAULT_PROVIDER_REASONING_EFFORT,
  addProviderAccount,
  registryPath,
} from "./registry.js";

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-registry-test-"));
}

test("addProviderAccount writes default model settings when model is empty", () => {
  const codexHome = makeTempHome();

  addProviderAccount(codexHome, {
    baseUrl: "https://codex.apiz.ai",
    apiKey: "sk-test-defaults",
    name: "apiz",
    model: "",
  });

  const registry = JSON.parse(fs.readFileSync(registryPath(codexHome), "utf8"));
  const active = registry.accounts.find((account) => account.account_key === registry.active_account_key);
  assert.equal(active.provider.model, DEFAULT_PROVIDER_MODEL);
  assert.equal(active.provider.model_reasoning_effort, DEFAULT_PROVIDER_REASONING_EFFORT);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /model = "gpt-5\.5"/);
  assert.match(config, /review_model = "gpt-5\.5"/);
  assert.match(config, /model_reasoning_effort = "medium"/);
});
