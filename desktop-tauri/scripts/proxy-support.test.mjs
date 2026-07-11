import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const cargoToml = fs.readFileSync(
  path.join(scriptsDir, "..", "src-tauri", "Cargo.toml"),
  "utf8",
);

test("Tauri OAuth supports explicit SOCKS proxy configurations", () => {
  const reqwestDependency = cargoToml
    .split("\n")
    .find((line) => line.startsWith("reqwest = "));

  assert.ok(reqwestDependency, "reqwest dependency is missing");
  assert.match(reqwestDependency, /features\s*=\s*\[[^\]]*"socks"/);
});
