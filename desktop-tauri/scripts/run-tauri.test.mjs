import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "run-tauri.mjs",
);

test("Tauri launcher uses the cross-platform JavaScript CLI entry", () => {
  const result = spawnSync(process.execPath, [launcher, "--version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^tauri-cli \d+\.\d+\.\d+\s*$/);
});
