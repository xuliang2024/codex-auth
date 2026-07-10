import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "run-macos-dev-app.mjs",
);

test("macOS development runner launches through the product display name", {
  skip: process.platform !== "darwin",
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-runner-"));
  const executable = path.join(directory, "test-executable");

  try {
    fs.symlinkSync("/bin/echo", executable);
    const result = spawnSync(process.execPath, [runner, executable, "runner-ok"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "runner-ok");
    assert.equal(
      fs.existsSync(
        path.join(directory, ".accounts-for-codex-dev", "Accounts for Codex.app"),
      ),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
