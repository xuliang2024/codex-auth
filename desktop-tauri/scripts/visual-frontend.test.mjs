import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("visual regression frontend injects its fixture before application startup", () => {
  const result = spawnSync(process.execPath, ["scripts/prepare-visual-frontend.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const visualIndex = fs.readFileSync(
    path.join(projectRoot, "visual-frontend-dist", "renderer", "index.html"),
    "utf8",
  );
  const fixtureIndex = visualIndex.indexOf('src="visual-fixture.js"');
  const i18nIndex = visualIndex.indexOf('src="i18n.js"');
  const bridgeIndex = visualIndex.indexOf('src="tauri-bridge.js"');
  assert.ok(fixtureIndex >= 0);
  assert.ok(fixtureIndex < i18nIndex);
  assert.ok(i18nIndex < bridgeIndex);

  const productionIndex = fs.readFileSync(
    path.join(projectRoot, "renderer", "index.html"),
    "utf8",
  );
  assert.equal(productionIndex.includes("visual-fixture.js"), false);
});
