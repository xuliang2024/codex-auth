import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the retired Electron implementation is absent", () => {
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "desktop")),
    false,
    "Remove the retired root desktop/ directory; desktop-tauri/ is the only desktop implementation.",
  );
});
